#!/usr/bin/env node
/**
 * Indexer CLI — spec §8.1.
 *
 *   DATABASE_URL=postgres://… pnpm --filter @0gflow/indexer index
 *   … index --once     backfill to head and exit
 *   … index --memory   run against an in-memory store (no database)
 *
 * Backfills from the deployment block recorded in @0gflow/config, then polls.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { networkFromEnv, requireAddress } from '@0gflow/config';
import { catchUp } from './ingest.js';
import { probeAgents } from './health.js';
import { MemoryStore } from './memory-store.js';
import { PostgresStore } from './postgres-store.js';
import { JsonRpcChainReader } from './rpc.js';
import type { Store } from './store.js';

/** Galileo finalises quickly; 32 blocks is a deliberately conservative margin. */
const FINALITY_DEPTH = Number(process.env['ZG_FINALITY_DEPTH'] ?? 32);
const POLL_MS = Number(process.env['ZG_POLL_MS'] ?? 5_000);
/**
 * Agent endpoints are probed far less often than logs are scanned. An agent
 * is not expected to change availability every few seconds, and probing on the
 * log cadence would be a lot of traffic aimed at other people's servers.
 */
const HEALTH_MS = Number(process.env['ZG_HEALTH_MS'] ?? 120_000);

/**
 * One Postgres schema per network.
 *
 * The index has no chain column: a run row records a runId, a chain root and
 * block numbers, none of which say which chain they came from. Point a single
 * index at two networks and the directory silently mixes them — a mainnet run
 * and a testnet run sitting in one list, indistinguishable, on a site whose
 * entire claim is that you can check where a number came from. That is a worse
 * failure than showing nothing.
 *
 * Separating by schema also means the cursor is per-network, which matters
 * mechanically: Galileo's head is around 50M and Aristotle's is around 43M, so
 * a shared cursor would ask one chain for a block range that ends before it
 * starts, and eth_getLogs would refuse.
 *
 * Galileo keeps `public` so an existing deployment is untouched by this change.
 */
function schemaFor(network: { name: string }): string {
  return network.name === 'galileo' ? 'public' : network.name;
}

export async function main(argv: readonly string[]): Promise<number> {
  const once = argv.includes('--once');
  const useMemory = argv.includes('--memory');
  const network = networkFromEnv();
  // --v2 indexes the marketplace deployment. v1 stays the default so an
  // existing indexer keeps serving the runs it already has.
  const useV2 = argv.includes('--v2');
  // v1 is the default so an existing indexer keeps serving the runs it has.
  // On a chain where v1 was never deployed there is nothing to keep serving,
  // so v2 is the only sensible reading of "index this network".
  const contract = useV2 || network.contracts.executionReceipts === null
    ? requireAddress(network, 'executionReceiptsV2')
    : requireAddress(network, 'executionReceipts');
  const adapterRegistry = network.contracts.agentAdapterRegistryV2 ?? undefined;
  const agentReputation = network.contracts.agentReputation ?? undefined;
  // Following v2 means starting where v2 was deployed. Using v1's block would
  // scan 1.4M blocks over which the contracts did not exist.
  // Start where the contract being followed was deployed. Starting at zero
  // would scan tens of millions of empty blocks while the directory sits
  // empty and looks broken.
  const followingV2 = useV2 || network.contracts.executionReceipts === null;
  const deploymentBlock = BigInt(
    (followingV2 ? (network.deploymentBlockV2 ?? network.deploymentBlock) : network.deploymentBlock) ?? 0,
  );

  let store: Store;
  if (useMemory) {
    store = new MemoryStore();
  } else {
    const url = process.env['DATABASE_URL'];
    if (url === undefined) {
      console.error('DATABASE_URL is not set. Pass --memory to run without a database.');
      return 2;
    }
    const pg = new PostgresStore(url, schemaFor(network));
    await pg.migrate();
    store = pg;
  }

  const chain = new JsonRpcChainReader(network.rpcUrl);

  console.log(`0G Flow indexer`);
  console.log(`  network   ${network.displayName} (${network.chainId})`);
  console.log(`  contract  ${contract}`);
  console.log(`  registry  ${adapterRegistry ?? 'not configured — no agent directory'}`);
  console.log(`  bonds     ${agentReputation ?? 'not configured — no agent bonds'}`);
  console.log(`  store     ${useMemory ? 'memory' : 'postgres'}`);
  console.log(`  from      block ${deploymentBlock}`);
  console.log(`  finality  ${FINALITY_DEPTH} blocks\n`);

  const pass = async () => {
    const results = await catchUp({
      store,
      chain,
      contract,
      ...(adapterRegistry === undefined ? {} : { adapterRegistry }),
      ...(agentReputation === undefined ? {} : { agentReputation }),
      deploymentBlock,
      finalityDepth: FINALITY_DEPTH,
      onProgress: (r) => {
        if (r.steps > 0 || r.seals > 0 || r.listings > 0 || r.bonds > 0 || r.reorgedFrom !== null) {
          const reorg = r.reorgedFrom === null ? '' : `  REORG from ${r.reorgedFrom}`;
          console.log(
            `  ${r.scannedFrom}–${r.scannedTo}  ${r.steps} step(s)  ${r.seals} seal(s)  ${r.listings} listing(s)  ${r.bonds} bond event(s)${reorg}`,
          );
        }
      },
    });
    return results;
  };

  await pass();
  const stats = await store.stats();
  console.log(
    `\n  indexed: ${stats.runs} run(s), ${stats.steps} step(s), ${stats.agents} agent(s) — cursor at block ${stats.cursor}`,
  );

  if (once) {
    await store.close?.();
    return 0;
  }

  console.log(`\n  following head, polling every ${POLL_MS}ms (ctrl-c to stop)`);
  console.log(`  probing agent endpoints every ${HEALTH_MS}ms`);

  let lastHealth = 0;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));

    if (Date.now() - lastHealth >= HEALTH_MS) {
      lastHealth = Date.now();
      try {
        const health = await probeAgents({ store });
        if (health.probed > 0) {
          console.log(`  health: ${health.healthy}/${health.probed} listed agents answered`);
        }
      } catch (error) {
        // Probing other people's servers is the least important thing this
        // process does, and it must never stop it following the chain.
        console.error(`  ! health probe: ${(error as Error).message}`);
      }
    }

    try {
      await pass();
    } catch (error) {
      // Keep following: a transient RPC failure must not end the process, or
      // the index silently stops updating while looking healthy.
      console.error(`  ! ${(error as Error).message}`);
    }
  }
}

/**
 * Whether this module is the program being run, rather than imported.
 *
 * Compared as resolved real paths. npm's bin shim execs through
 * `node_modules/.bin/../@0gflow/<pkg>/dist/cli.js`, a symlinked install
 * resolves somewhere else again, and a relative invocation is shorter still —
 * all the same file under different names. Matching on the *shape* of the path,
 * which this used to do, silently ran nothing the moment that shape changed.
 * Running nothing and exiting 0 is the worst failure available to a CLI.
 */
function isEntrypoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`\n✗ ${(error as Error).message}`);
      process.exitCode = 1;
    });
}
