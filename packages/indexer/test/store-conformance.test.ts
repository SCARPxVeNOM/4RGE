import { afterAll, describe, expect, test } from 'vitest';
import { StepStatus, ZERO_BYTES32, type Hex } from '@0gflow/core';
import { MemoryStore } from '../src/memory-store.js';
import { PostgresStore } from '../src/postgres-store.js';
import type { Store, StepRow } from '../src/store.js';

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
