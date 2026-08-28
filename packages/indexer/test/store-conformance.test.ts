import { afterAll, describe, expect, test } from 'vitest';
import { StepStatus, ZERO_BYTES32, type Hex } from '@0gflow/core';
import { MemoryStore } from '../src/memory-store.js';
import { PostgresStore } from '../src/postgres-store.js';
import type { AgentListingRow, Store, StepRow } from '../src/store.js';

/**
 * One suite, both implementations.
 *
 * MemoryStore is what the ingestion tests run against; PostgresStore is what
 * production uses. Testing only the fast one would mean the queries that
 * actually ship are the ones nobody checked, so both are held to the same
 * behaviour here and a divergence surfaces as a failing test.
 *
 * The Postgres case skips when no database is reachable, so the suite still
 * runs on a machine with nothing installed. Set DATABASE_URL to include it:
 *
 *   docker run -d --name 0gflow-pg -e POSTGRES_PASSWORD=0gflow \
 *     -e POSTGRES_USER=0gflow -e POSTGRES_DB=0gflow -p 55432:5432 postgres:16-alpine
 *   DATABASE_URL=postgres://0gflow:0gflow@localhost:55432/0gflow pnpm test
 */

const DATABASE_URL = process.env['DATABASE_URL'];
/**
 * A dedicated schema, never `public`. Pointing this suite at a real database
 * once left a fake receipt and a cursor below the deployment block in the
 * indexed data; isolation makes that impossible rather than merely unlikely.
 */
const TEST_SCHEMA = 'indexer_conformance_test';

async function postgresAvailable(): Promise<boolean> {
  if (DATABASE_URL === undefined) return false;
  const store = new PostgresStore(DATABASE_URL, TEST_SCHEMA);
  try {
    await store.migrate();
    await store.close();
    return true;
  } catch {
    return false;
  }
}

const pgUp = await postgresAvailable();

const RUN_A = `0x${'aa'.repeat(32)}` as Hex;
const RUN_B = `0x${'bb'.repeat(32)}` as Hex;
const FLOW = `0x${'11'.repeat(32)}` as Hex;

function step(runId: Hex, stepIndex: number, over: Partial<StepRow> = {}): StepRow {
  return {
    runId,
    flowId: FLOW,
    stepIndex,
    agentId: 1n,
    inputHash: `0x${'33'.repeat(32)}`,
    outputHash: `0x${'44'.repeat(32)}`,
    traceRoot: `0x${'55'.repeat(32)}`,
    attestationRef: ZERO_BYTES32,
    startedAt: 100n,
    endedAt: 101n,
    status: StepStatus.Ok,
    txHash: `0x${'ab'.repeat(32)}`,
    blockNumber: BigInt(10 + stepIndex),
    blockHash: `0xblock${10 + stepIndex}`,
    logIndex: 0,
    ...over,
  };
}

const implementations: Array<[string, () => Promise<Store>]> = [
  ['MemoryStore', async () => new MemoryStore()],
];

if (pgUp) {
  implementations.push([
    'PostgresStore',
    async () => {
      const store = new PostgresStore(DATABASE_URL!, TEST_SCHEMA);
      await store.migrate();
      // Each case starts clean; block 0 upward is everything.
      await store.rollbackFrom(0n);
      await store.setCursor(0n);
      return store;
    },
  ]);
} else {
  test.skip('PostgresStore conformance (set DATABASE_URL and start Postgres)', () => {});
}

const opened: Store[] = [];
afterAll(async () => {
  if (pgUp) {
    const cleaner = new PostgresStore(DATABASE_URL!, TEST_SCHEMA);
    await cleaner.dropSchema();
    await cleaner.close();
  }
  for (const store of opened) await store.close?.();
});

describe.each(implementations)('%s', (_name, create) => {
  const make = async () => {
    const store = await create();
    opened.push(store);
    return store;
  };

  test('round-trips a step', async () => {
    const store = await make();
    await store.upsertStep(step(RUN_A, 0));
    const steps = await store.getSteps(RUN_A);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.agentId).toBe(1n);
    expect(steps[0]!.blockNumber).toBe(10n);
    expect(steps[0]!.status).toBe(StepStatus.Ok);
  });

  test('upserting the same step twice does not duplicate it', async () => {
    const store = await make();
    await store.upsertStep(step(RUN_A, 0));
    await store.upsertStep(step(RUN_A, 0, { status: StepStatus.Failed }));
    const steps = await store.getSteps(RUN_A);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.status).toBe(StepStatus.Failed);
  });

  test('preserves a uint256 agent id without overflow', async () => {
    // Agent ids are ERC-721 token ids. A BIGINT column would silently fail
    // here, which is why they are stored as NUMERIC.
    const store = await make();
    const big = 2n ** 200n + 7n;
    await store.upsertStep(step(RUN_A, 0, { agentId: big }));
    expect((await store.getSteps(RUN_A))[0]!.agentId).toBe(big);
  });

  test('aggregates a run from its steps and seal', async () => {
    const store = await make();
    await store.upsertStep(step(RUN_A, 0));
    await store.upsertStep(step(RUN_A, 1));
    expect((await store.getRun(RUN_A))!.sealed).toBe(false);

    await store.upsertSeal({
      runId: RUN_A,
      chainRoot: `0x${'99'.repeat(32)}`,
      stepCount: 2,
      outcome: 0,
      txHash: `0x${'ef'.repeat(32)}`,
      blockNumber: 12n,
      blockHash: '0xblock12',
    });

    const run = await store.getRun(RUN_A);
    expect(run!.stepCount).toBe(2);
    expect(run!.sealed).toBe(true);
    expect(run!.chainRoot).toBe(`0x${'99'.repeat(32)}`);
    expect(run!.outcome).toBe(0);
    expect(run!.lastBlock).toBe(12n);
  });

  test('returns null for an unknown run', async () => {
    const store = await make();
    expect(await store.getRun(RUN_B)).toBeNull();
  });

  test('lists runs newest first', async () => {
    const store = await make();
    await store.upsertStep(step(RUN_A, 0, { blockNumber: 10n }));
    await store.upsertStep(step(RUN_B, 0, { blockNumber: 50n }));
    const runs = await store.listRuns(10, 0);
    expect(runs[0]!.runId.toLowerCase()).toBe(RUN_B.toLowerCase());
  });

  test('paginates', async () => {
    const store = await make();
    await store.upsertStep(step(RUN_A, 0, { blockNumber: 10n }));
    await store.upsertStep(step(RUN_B, 0, { blockNumber: 50n }));
    expect(await store.listRuns(1, 0)).toHaveLength(1);
    expect(await store.listRuns(1, 1)).toHaveLength(1);
    expect(await store.listRuns(1, 2)).toHaveLength(0);
  });

  test('tracks the cursor', async () => {
    const store = await make();
    expect(await store.getCursor()).toBe(0n);
    await store.setCursor(1234n);
    expect(await store.getCursor()).toBe(1234n);
  });

  test('records and reads back block hashes', async () => {
    const store = await make();
    expect(await store.getIndexedBlockHash(10n)).toBeNull();
    await store.recordBlock(10n, '0xaaa');
    expect(await store.getIndexedBlockHash(10n)).toBe('0xaaa');
  });

  test('rollbackFrom removes rows at or above a block and rewinds the cursor', async () => {
    const store = await make();
    await store.upsertStep(step(RUN_A, 0, { blockNumber: 10n }));
    await store.upsertStep(step(RUN_A, 1, { blockNumber: 20n }));
    await store.recordBlock(20n, '0xtwenty');
    await store.setCursor(30n);

    await store.rollbackFrom(20n);

    expect(await store.getSteps(RUN_A)).toHaveLength(1);
    expect(await store.getIndexedBlockHash(20n)).toBeNull();
    expect(await store.getCursor()).toBe(19n);
  });

  test('rollbackFrom leaves the cursor alone when it is already behind', async () => {
    const store = await make();
    await store.setCursor(5n);
    await store.rollbackFrom(20n);
    expect(await store.getCursor()).toBe(5n);
  });

  test('aggregates agent participation', async () => {
    const store = await make();
    await store.upsertStep(step(RUN_A, 0));
    await store.upsertStep(step(RUN_A, 1, { status: StepStatus.Failed }));
    await store.upsertStep(step(RUN_A, 2, { attestationRef: `0x${'77'.repeat(32)}` }));

    const agent = await store.getAgent(1n);
    expect(agent!.stepCount).toBe(3);
    expect(agent!.okCount).toBe(2);
    expect(agent!.attestedCount).toBe(1);
    expect(agent!.runCount).toBe(1);
  });

  test('returns null for an agent with no steps', async () => {
    const store = await make();
    expect(await store.getAgent(999n)).toBeNull();
  });

  test('lists runs for a flow and for an agent', async () => {
    const store = await make();
    await store.upsertStep(step(RUN_A, 0));
    await store.upsertStep(step(RUN_B, 0, { agentId: 2n, blockNumber: 50n }));

    expect(await store.listRunsForFlow(FLOW, 10)).toHaveLength(2);
    const forAgent = await store.listRunsForAgent(2n, 10);
    expect(forAgent).toHaveLength(1);
    expect(forAgent[0]!.runId.toLowerCase()).toBe(RUN_B.toLowerCase());
  });

  test('reports stats', async () => {
    const store = await make();
    await store.upsertStep(step(RUN_A, 0));
    await store.setCursor(77n);
    const stats = await store.stats();
    expect(stats.runs).toBe(1);
    expect(stats.steps).toBe(1);
    expect(stats.agents).toBe(1);
    expect(stats.cursor).toBe(77n);
  });

  // -------------------------------------------------------------------------
  // Marketplace listings
  //
  // These were written for MemoryStore and mirrored into SQL by hand, and
  // until now nothing checked the mirror. The version rule in particular is
  // enforced in two very different ways -- a comparison in TypeScript and a
  // WHERE clause on an ON CONFLICT -- so it is exactly the kind of pair that
  // drifts silently.
  // -------------------------------------------------------------------------

  const listing = (agentId: bigint, over: Partial<AgentListingRow> = {}): AgentListingRow => ({
    agentId,
    owner: `0x${'aa'.repeat(20)}` as Hex,
    kind: 0,
    endpoint: `https://agents.example/${agentId}`,
    schemaRoot: `0x${'11'.repeat(32)}` as Hex,
    version: 1,
    active: true,
    payTo: `0x${'bb'.repeat(20)}` as Hex,
    signer: `0x${'cc'.repeat(20)}` as Hex,
    pricePerCall: 1_000n,
    metadataURI: 'data:application/json;base64,e30=',
    blockNumber: 100n,
    blockHash: '0xblock100',
    ...over,
  });

  test('stores and reads back every field of a listing', async () => {
    const store = await create();
    await store.upsertAgentListing(listing(7n));

    const got = await store.getAgentListing(7n);
    expect(got).not.toBeNull();
    expect(got).toMatchObject({
      agentId: 7n,
      kind: 0,
      endpoint: 'https://agents.example/7',
      version: 1,
      active: true,
      pricePerCall: 1_000n,
    });
    // Addresses are lowercased on the way in, so a caller never has to guess
    // which casing came back.
    expect(got!.signer.toLowerCase()).toBe(`0x${'cc'.repeat(20)}`);
  });

  test('an unlisted agent reads as null, not as an empty listing', async () => {
    const store = await create();
    expect(await store.getAgentListing(999n)).toBeNull();
  });

  test('a later version replaces the listing', async () => {
    const store = await create();
    await store.upsertAgentListing(listing(7n));
    await store.upsertAgentListing(
      listing(7n, { version: 2, endpoint: 'https://moved.example/7', blockNumber: 200n }),
    );

    const got = await store.getAgentListing(7n);
    expect(got!.version).toBe(2);
    expect(got!.endpoint).toBe('https://moved.example/7');
  });

  // Versions only move forward in the registry, so a lower one means a log
  // arrived out of order. Taking it would point the directory at an endpoint
  // the agent has already left.
  test('an earlier version is ignored', async () => {
    const store = await create();
    await store.upsertAgentListing(listing(7n, { version: 5, endpoint: 'https://current.example' }));
    await store.upsertAgentListing(listing(7n, { version: 2, endpoint: 'https://stale.example' }));

    const got = await store.getAgentListing(7n);
    expect(got!.version).toBe(5);
    expect(got!.endpoint).toBe('https://current.example');
  });

  test('re-applying the same version is accepted, so a replay is harmless', async () => {
    const store = await create();
    await store.upsertAgentListing(listing(7n));
    await store.upsertAgentListing(listing(7n, { endpoint: 'https://same-version.example' }));
    expect((await store.getAgentListing(7n))!.endpoint).toBe('https://same-version.example');
  });

  test('deactivation hides a listing without destroying it', async () => {
    const store = await create();
    await store.upsertAgentListing(listing(7n));
    await store.deactivateAgentListing(7n, 300n);

    const got = await store.getAgentListing(7n);
    expect(got!.active).toBe(false);
    // Still resolvable: an agent that stopped serving is not one that never
    // existed, and past receipts still name it.
    expect(got!.endpoint).toBe('https://agents.example/7');
    expect(await store.listAgentListings(10, 0, { activeOnly: true })).toHaveLength(0);
    expect(await store.listAgentListings(10, 0)).toHaveLength(1);
  });

  // The indexer may scan a window that starts after the registration, so a
  // deactivation for an agent never seen is normal, not an error.
  test('deactivating an unknown agent is a no-op', async () => {
    const store = await create();
    await expect(store.deactivateAgentListing(4242n, 300n)).resolves.toBeUndefined();
    expect(await store.getAgentListing(4242n)).toBeNull();
  });

  test('lists newest first, and paginates', async () => {
    const store = await create();
    await store.upsertAgentListing(listing(7n, { blockNumber: 100n }));
    await store.upsertAgentListing(listing(8n, { blockNumber: 200n }));
    await store.upsertAgentListing(listing(9n, { blockNumber: 300n }));

    expect((await store.listAgentListings(10, 0)).map((a) => a.agentId)).toEqual([9n, 8n, 7n]);
    expect((await store.listAgentListings(2, 0)).map((a) => a.agentId)).toEqual([9n, 8n]);
    expect((await store.listAgentListings(2, 2)).map((a) => a.agentId)).toEqual([7n]);
    expect(await store.listAgentListings(10, 99)).toHaveLength(0);
  });

  test('filters by kind', async () => {
    const store = await create();
    await store.upsertAgentListing(listing(7n, { kind: 0 }));
    await store.upsertAgentListing(listing(8n, { kind: 3, blockNumber: 200n }));

    expect((await store.listAgentListings(10, 0, { kind: 3 })).map((a) => a.agentId)).toEqual([8n]);
    expect((await store.listAgentListings(10, 0, { kind: 0 })).map((a) => a.agentId)).toEqual([7n]);
  });

  // Token ids are uint256. A BIGINT column would silently overflow anything
  // above 2^63, which is an ordinary id for a registry that hashes into it.
  test('survives a uint256 agent id', async () => {
    const store = await create();
    const huge = (1n << 256n) - 1n;
    await store.upsertAgentListing(listing(huge));

    expect((await store.getAgentListing(huge))!.agentId).toBe(huge);
    expect((await store.listAgentListings(10, 0))[0]!.agentId).toBe(huge);
  });

  test('survives a uint256 price', async () => {
    const store = await create();
    const huge = (1n << 256n) - 1n;
    await store.upsertAgentListing(listing(7n, { pricePerCall: huge }));
    expect((await store.getAgentListing(7n))!.pricePerCall).toBe(huge);
  });

  // -------------------------------------------------------------------------
  // Health observations
  //
  // The streak logic exists twice — a comparison in TypeScript and a CASE in
  // an ON CONFLICT — so it is exactly the pair that drifts silently.
  // -------------------------------------------------------------------------

  test('records a probe result', async () => {
    const store = await create();
    await store.recordAgentHealth(7n, { ok: true, latencyMs: 42, error: null, checkedAt: 1000n });

    const health = await store.getAgentHealth(7n);
    expect(health).toMatchObject({ agentId: 7n, ok: true, latencyMs: 42, consecutiveFailures: 0 });
    expect(health!.checkedAt).toBe(1000n);
  });

  test('an agent never probed has no health', async () => {
    const store = await create();
    expect(await store.getAgentHealth(999n)).toBeNull();
  });

  test('failures accumulate and a success clears the streak', async () => {
    const store = await create();
    for (const at of [1n, 2n, 3n]) {
      await store.recordAgentHealth(7n, { ok: false, latencyMs: null, error: 'refused', checkedAt: at });
    }
    expect((await store.getAgentHealth(7n))!.consecutiveFailures).toBe(3);

    await store.recordAgentHealth(7n, { ok: true, latencyMs: 10, error: null, checkedAt: 4n });
    const health = await store.getAgentHealth(7n);
    expect(health!.consecutiveFailures).toBe(0);
    expect(health!.lastError).toBeNull();
  });

  test('a failed probe records no latency', async () => {
    const store = await create();
    await store.recordAgentHealth(7n, { ok: false, latencyMs: null, error: 'timed out', checkedAt: 1n });
    expect((await store.getAgentHealth(7n))!.latencyMs).toBeNull();
  });

  // Health describes whether an HTTP endpoint answered. No chain
  // reorganisation changes that, so unlike every other table it must survive
  // a rollback — forgetting it would be forgetting something still true.
  test('a rollback leaves health alone', async () => {
    const store = await create();
    await store.recordAgentHealth(7n, { ok: true, latencyMs: 5, error: null, checkedAt: 1n });
    await store.rollbackFrom(0n);
    expect(await store.getAgentHealth(7n)).not.toBeNull();
  });

  // A reorg must forget listings written by blocks that no longer exist,
  // exactly as it forgets receipts.
  test('a rollback drops listings from the replaced blocks', async () => {
    const store = await create();
    await store.upsertAgentListing(listing(7n, { blockNumber: 100n }));
    await store.upsertAgentListing(listing(8n, { blockNumber: 500n }));

    await store.rollbackFrom(400n);

    expect(await store.getAgentListing(8n)).toBeNull();
    expect(await store.getAgentListing(7n)).not.toBeNull();
  });
});

describe('coverage', () => {
  test('reports whether Postgres was exercised', () => {
    // Visible rather than silent: a green suite that skipped the production
    // store should say so.
    if (!pgUp) {
      console.warn('  note: PostgresStore was NOT exercised (no reachable DATABASE_URL)');
    }
    expect(implementations.length).toBeGreaterThanOrEqual(1);
  });
});
