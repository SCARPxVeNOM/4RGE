/**
 * Public read-only API over the index — spec §8.2.
 *
 * "Public, read-only, no wallet connection required."
 *
 * Everything served here is derived from public chain data, and every response
 * carries enough for the client to check it rather than trust it: receipts
 * come with the fields they were hashed from, so the browser can fold the
 * chain root itself and compare against the sealed value. An explorer that
 * only shows a green tick is asking to be believed, which is the opposite of
 * what this project is for.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import {
  foldChainRoot,
  statusSucceeded,
  StepStatus,
  ZERO_BYTES32,
  type Hex,
  type Receipt,
} from '@0gflow/core';
import type { Store } from '@0gflow/indexer';
import type { Network } from '@0gflow/config';
import { preflight, PreflightError } from './preflight.js';

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

export interface ServerOptions {
  readonly store: Store;
  readonly network: Network;
  /** Where the verifier tells people to fetch traces from. */
  readonly traceBaseUrl?: string;
  /**
   * Pays for schema storage during a browser publish. Absent disables only
   * that step; see `preflight.ts` for what it does and does not buy.
   */
  readonly storageKey?: string | undefined;
}

/**
 * How often one caller may ask this service to probe an agent and pay for a
 * storage write.
 *
 * Everything else here is a read of an index. This one endpoint makes outbound
 * requests and spends a balance, so it is the one that needs a limit at all.
 * In-memory and per-process: this is a single service, and a limiter that
 * needed its own datastore would be a worse trade than one that resets on
 * deploy.
 */
const PREFLIGHT_LIMIT = 5;
const PREFLIGHT_WINDOW_MS = 10 * 60_000;

const STATUS_NAME: Record<number, string> = {
  [StepStatus.Ok]: 'ok',
  [StepStatus.Failed]: 'failed',
  [StepStatus.Skipped]: 'skipped',
  [StepStatus.Unattested]: 'unattested',
};

/**
 * The command that checks this run on someone else's machine.
 *
 * Galileo is the verifier's default, so it is the one network that needs no
 * prefix; naming it anyway would be noise on the majority of installs. Every
 * other network must be named, because the alternative is a reader running our
 * suggested command and being told that good evidence has failed.
 */
export function verifyCommand(runId: string, network: string): string {
  const prefix = network === 'galileo' ? '' : `ZG_NETWORK=${network} `;
  return `${prefix}npx @0gflow/verify ${runId}`;
}

function serialise(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serialise);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialise(v)]));
  }
  return value;
}

export function createServer(options: ServerOptions): FastifyInstance {
  const { store, network } = options;
  const app = Fastify({ logger: false });
  const preflightCalls = new Map<string, number[]>();

  // Public and read-only: no wallet, no auth, no cookies, so CORS is
  // unrestricted by design rather than by oversight.
  app.addHook('onSend', async (request, reply) => {
    void reply.header('access-control-allow-origin', '*');
    // Preflight is neither public nor cacheable: it is per-caller and it
    // spends. A shared cache in front of it would serve one publisher's
    // conformance verdict to the next, which is worse than slow.
    void reply.header(
      'cache-control',
      request.url.startsWith('/api/publish/') ? 'no-store' : 'public, max-age=5',
    );
  });

  // The publish page POSTs JSON from another origin in development, which the
  // browser preflights. Answering it here keeps that from looking like the
  // endpoint being down.
  app.options('/api/publish/preflight', async (_req, reply) => {
    void reply.header('access-control-allow-methods', 'POST, OPTIONS');
    void reply.header('access-control-allow-headers', 'content-type');
    return reply.code(204).send();
  });

  app.get('/api/health', async () => {
    const stats = await store.stats();
    return serialise({
      ok: true,
      network: {
        name: network.name,
        chainId: network.chainId,
        explorer: network.explorerUrl,
        // Served so the publish page can tell a wallet which chain to add. It
        // is the network's own public RPC, deliberately not this service:
        // a wallet routing a stranger's transactions through a server named by
        // a web page is the wrong shape entirely.
        rpcUrl: network.rpcUrl,
        nativeToken: network.nativeToken,
      },
      contracts: {
        executionReceipts: network.contracts.executionReceipts,
        executionReceiptsV2: network.contracts.executionReceiptsV2,
        flowRegistry: network.contracts.flowRegistry,
        identityRegistry: network.contracts.identityRegistry,
        agentAdapterRegistryV2: network.contracts.agentAdapterRegistryV2,
        flowEscrowV2: network.contracts.flowEscrowV2,
        agentReputation: network.contracts.agentReputation,
      },
      indexed: stats,
    });
  });

  /**
   * The one write-adjacent endpoint: everything needed to publish an agent
   * that a browser cannot do for itself.
   *
   * It returns calldata-relevant facts, not calldata. The two transactions are
   * built and signed in the page by the publisher's own wallet, so this service
   * cannot list an agent, cannot redirect payment, and never holds a key
   * belonging to anyone but itself.
   */
  app.post('/api/publish/preflight', async (request, reply) => {
    const body = request.body as { endpoint?: unknown } | undefined;
    const endpoint = body?.endpoint;
    if (typeof endpoint !== 'string' || endpoint === '') {
      return reply.code(400).send({ error: 'endpoint is required' });
    }

    const caller = request.ip;
    const now = Date.now();
    const seen = (preflightCalls.get(caller) ?? []).filter((t) => now - t < PREFLIGHT_WINDOW_MS);
    if (seen.length >= PREFLIGHT_LIMIT) {
      return reply.code(429).send({
        error:
          `this endpoint probes other people's servers and pays for storage, so it is rate limited to ` +
          `${PREFLIGHT_LIMIT} publishes per ${PREFLIGHT_WINDOW_MS / 60_000} minutes. ` +
          `The CLI has no such limit: ZG_PRIVATE_KEY=0x… npx @0gflow/publish`,
      });
    }
    seen.push(now);
    preflightCalls.set(caller, seen);

    try {
      const result = await preflight(endpoint, { network, storageKey: options.storageKey });
      return serialise(result);
    } catch (error) {
      const status = error instanceof PreflightError ? error.status : 502;
      return reply.code(status).send({ error: (error as Error).message });
    }
  });

  app.get('/api/runs', async (request) => {
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(Number(query.limit ?? 25) || 25, 100);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);
    const runs = await store.listRuns(limit, offset);
    return serialise({ runs: runs.map(summarise), limit, offset });
  });

  app.get('/api/runs/:runId', async (request, reply) => {
    const { runId } = request.params as { runId: string };
    if (!HEX32.test(runId)) {
      return reply.code(400).send({ error: 'runId must be 32 bytes of hex' });
    }

    const run = await store.getRun(runId as Hex);
    if (run === null) return reply.code(404).send({ error: 'no such run' });

    const steps = await store.getSteps(runId as Hex);

    // The root the indexed receipts fold to. The client recomputes this
    // itself; serving it too makes a disagreement obvious rather than silent.
    let computedChainRoot: string | null = null;
    try {
      computedChainRoot = steps.length > 0 ? foldChainRoot(steps as unknown as Receipt[]) : null;
    } catch {
      // A gap in stepIndex means the index is incomplete for this run; say so
      // rather than serving a root folded over a partial set.
      computedChainRoot = null;
    }

    return serialise({
      run: {
        ...summarise(run),
        computedChainRoot,
        chainRootMatches:
          run.chainRoot !== null && computedChainRoot !== null
            ? run.chainRoot.toLowerCase() === computedChainRoot.toLowerCase()
            : null,
      },
      steps: steps.map((s) => ({
        ...s,
        statusName: STATUS_NAME[s.status] ?? String(s.status),
        attested: s.attestationRef !== ZERO_BYTES32,
        explorerTx: `${network.explorerUrl}/tx/${s.txHash}`,
      })),
      verification: {
        // §8.2: a copyable verification command on every run page.
        //
        // The network prefix is not decoration. The verifier defaults to
        // Galileo when ZG_NETWORK is unset, so the bare command run against a
        // mainnet run looks for its receipts on the testnet, finds none, and
        // reports FAILED — telling the reader that sound evidence is broken.
        // A command we hand someone has to work where we hand it to them.
        command: verifyCommand(runId, network.name),
        note: 'Run it yourself. This page is derived from the same public data and proves nothing on its own.',
      },
    });
  });

  app.get('/api/flows/:flowId', async (request, reply) => {
    const { flowId } = request.params as { flowId: string };
    if (!HEX32.test(flowId)) {
      return reply.code(400).send({ error: 'flowId must be 32 bytes of hex' });
    }
    const flow = await store.getFlow(flowId as Hex);
    const runs = await store.listRunsForFlow(flowId as Hex, 50);
    if (flow === null && runs.length === 0) {
      return reply.code(404).send({ error: 'no such flow' });
    }
    return serialise({ flow, runs: runs.map(summarise) });
  });

  /**
   * The marketplace directory.
   *
   * Listings come from the registry, not from anchored steps, which is the
   * whole point: an agent published a minute ago has no receipts yet, and
   * before this endpoint existed it was invisible until someone had already
   * hired it. Discovery has to come first.
   */
  app.get('/api/agents', async (request) => {
    const query = request.query as { limit?: string; offset?: string; kind?: string; active?: string };
    const limit = Math.min(Number(query.limit ?? 25) || 25, 100);
    const offset = Math.max(Number(query.offset ?? 0) || 0, 0);

    const filter: { activeOnly?: boolean; kind?: number } = {};
    // Defaults to active-only: an inactive listing is an agent whose operator
    // has said "do not hire me", and a directory that shows it by default
    // invites exactly that.
    if (query.active !== 'all') filter.activeOnly = true;
    if (query.kind !== undefined && /^\d+$/.test(query.kind)) filter.kind = Number(query.kind);

    const listings = await store.listAgentListings(limit, offset, filter);

    // Statistics per listing, so the directory can show a track record rather
    // than only a claim. An agent with none gets nulls, not zeroes: "no runs
    // yet" and "zero successes" are different statements.
    const agents = await Promise.all(
      listings.map(async (listing) => {
        const [stats, health, bond] = await Promise.all([
          store.getAgent(listing.agentId),
          store.getAgentHealth(listing.agentId),
          store.getAgentBond(listing.agentId),
        ]);
        return {
          ...listing,
          metadata: decodeMetadata(listing.metadataURI),
          // Verifiable, unlike health: the bond is folded from on-chain
          // events, so anyone can replay them to the same numbers.
          bond,
          // An observation, not a fact anyone can check — see the note on
          // AgentHealthRow. Reported with its timestamp so a reader can see
          // how old it is rather than assuming it is current.
          health,
          stepCount: stats?.stepCount ?? 0,
          okCount: stats?.okCount ?? 0,
          runCount: stats?.runCount ?? 0,
          successRate:
            stats === null || stats.stepCount === 0 ? null : stats.okCount / stats.stepCount,
        };
      }),
    );

    return serialise({
      agents,
      limit,
      offset,
      registry: network.contracts.agentAdapterRegistryV2,
    });
  });

  app.get('/api/agents/:agentId', async (request, reply) => {
    const { agentId } = request.params as { agentId: string };
    if (!/^\d+$/.test(agentId)) {
      return reply.code(400).send({ error: 'agentId must be a decimal ERC-721 token id' });
    }
    const id = BigInt(agentId);
    const listing = await store.getAgentListing(id);
    const agent = await store.getAgent(id);
    const health = await store.getAgentHealth(id);
    const bond = await store.getAgentBond(id);
    // Either is enough to have something to show. A published agent that has
    // never run has a listing and no statistics; an agent that ran before the
    // marketplace existed has statistics and no listing.
    if (agent === null && listing === null) {
      return reply.code(404).send({ error: 'no such agent' });
    }
    const runs = await store.listRunsForAgent(id, 50);

    return serialise({
      listing:
        listing === null ? null : { ...listing, metadata: decodeMetadata(listing.metadataURI) },
      health,
      bond,
      agent: {
        agentId: id,
        stepCount: 0,
        okCount: 0,
        attestedCount: 0,
        runCount: 0,
        ...agent,
        // Rates are reported alongside their denominators: "100% attested"
        // over one step is not the same claim as over a hundred.
        successRate:
          agent === null || agent.stepCount === 0 ? null : agent.okCount / agent.stepCount,
        attestationRate:
          agent === null || agent.stepCount === 0 ? null : agent.attestedCount / agent.stepCount,
        identityRegistry: network.contracts.identityRegistry,
      },
      runs: runs.map(summarise),
    });
  });

  return app;
}

/**
 * Reads the name and description out of a listing's metadataURI.
 *
 * `publish` writes a base64 data URI, so the common case needs no network
 * call. Anything else — ipfs://, https:// — is left as a URI for the client to
 * resolve or ignore; fetching arbitrary URLs here would let a listing make the
 * explorer's server issue requests on its behalf.
 */
function decodeMetadata(uri: string): Record<string, unknown> | null {
  const match = /^data:application\/json;base64,(.*)$/.exec(uri);
  if (match === null) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(match[1]!, 'base64').toString('utf8'));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // A listing is published by a stranger. Malformed metadata is their
    // problem, not a reason for the directory to fail.
    return null;
  }
}

function summarise(run: {
  runId: Hex;
  flowId: Hex;
  stepCount: number;
  sealed: boolean;
  chainRoot: Hex | null;
  outcome: number | null;
  firstBlock: bigint;
  lastBlock: bigint;
}) {
  return {
    ...run,
    outcomeName: run.outcome === null ? null : (STATUS_NAME[run.outcome] ?? String(run.outcome)),
    // A run is a "success" only when sealed with outcome ok, and the decision
    // of what counts as ok lives in one place (§10.3). An unsealed run is not
    // a pending success, it is simply unproven.
    succeeded: run.sealed && run.outcome !== null && statusSucceeded(run.outcome),
  };
}
