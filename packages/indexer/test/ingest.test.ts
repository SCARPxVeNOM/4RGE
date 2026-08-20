import { describe, expect, test } from 'vitest';
import { StepStatus, type Hex } from '@0gflow/core';
import { MemoryStore } from '../src/memory-store.js';
import { catchUp, ingestRange, type ChainReader, type RawLogWithBlock } from '../src/ingest.js';
import { STEP_ANCHORED_TOPIC, RUN_SEALED_TOPIC } from '@0gflow/verify/decode';

/**
 * §8.1 ingestion.
 *
 * The interesting behaviour is not "rows get written" — it is what happens
 * when the chain changes its mind. A reorg replaces blocks that were already
 * indexed, and an indexer that appends blindly ends up serving receipts that
 * no longer exist on chain, which is worse than serving nothing.
 */

const RUN_ID = `0x${'22'.repeat(32)}` as Hex;
const FLOW_ID = `0x${'11'.repeat(32)}` as Hex;
const CONTRACT = '0x741a36faba40ee71223539a5a062fdedc8574e30';

const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');

function stepLog(
  stepIndex: number,
  blockNumber: number,
  blockHash: string,
  status = StepStatus.Ok,
  runId: Hex = RUN_ID,
): RawLogWithBlock {
  return {
    address: CONTRACT,
    topics: [STEP_ANCHORED_TOPIC, FLOW_ID, runId, `0x${word(stepIndex)}`],
    data:
      '0x' +
      word(1) +
      `${'33'.repeat(32)}` +
      `${'44'.repeat(32)}` +
      `${'55'.repeat(32)}` +
      `${'00'.repeat(32)}` +
      word(100) +
      word(101) +
      word(status),
    blockNumber: `0x${blockNumber.toString(16)}`,
    blockHash,
    transactionHash: `0x${'ab'.repeat(31)}${stepIndex.toString(16).padStart(2, '0')}`,
    logIndex: `0x${stepIndex.toString(16)}`,
  };
}

function sealLog(blockNumber: number, blockHash: string, chainRoot: string, outcome = 0): RawLogWithBlock {
  return {
    address: CONTRACT,
    topics: [RUN_SEALED_TOPIC, RUN_ID],
    data: '0x' + chainRoot.replace(/^0x/, '') + word(2) + word(outcome),
    blockNumber: `0x${blockNumber.toString(16)}`,
    blockHash,
    transactionHash: `0x${'ef'.repeat(32)}`,
    logIndex: '0x0',
  };
}

class FakeChain implements ChainReader {
  constructor(
    public logs: RawLogWithBlock[],
    public head = 100,
    public blockHashes = new Map<number, string>(),
  ) {}

  async getBlockNumber() { return BigInt(this.head); }

  async getLogs(fromBlock: bigint, toBlock: bigint) {
    return this.logs.filter((l) => {
      const n = BigInt(l.blockNumber);
      return n >= fromBlock && n <= toBlock;
    });
  }

  async getBlockHash(blockNumber: bigint) {
    return this.blockHashes.get(Number(blockNumber)) ?? `0xblock${blockNumber}`;
  }
}

const FINALITY = 5;

describe('backfill', () => {
  test('ingests receipts and a seal from a range', async () => {
    const store = new MemoryStore();
    const chain = new FakeChain([
      stepLog(0, 10, '0xaaa'),
      stepLog(1, 11, '0xbbb'),
      sealLog(12, '0xccc', `0x${'99'.repeat(32)}`),
    ]);

    await ingestRange({ store, chain, contract: CONTRACT, from: 0n, to: 20n, finalityDepth: FINALITY });

    const run = await store.getRun(RUN_ID);
    expect(run).not.toBeNull();
    expect(run!.stepCount).toBe(2);
    expect(run!.sealed).toBe(true);
    expect(run!.chainRoot).toBe(`0x${'99'.repeat(32)}`);
  });

  test('records the block a receipt came from, so a reorg can undo it', async () => {
    const store = new MemoryStore();
    const chain = new FakeChain([stepLog(0, 10, '0xaaa')]);
    await ingestRange({ store, chain, contract: CONTRACT, from: 0n, to: 20n, finalityDepth: FINALITY });

    const steps = await store.getSteps(RUN_ID);
    expect(steps[0]!.blockNumber).toBe(10n);
    expect(steps[0]!.blockHash).toBe('0xaaa');
  });

  test('advances the cursor only to the last block it actually scanned', async () => {
    const store = new MemoryStore();
    const chain = new FakeChain([stepLog(0, 10, '0xaaa')]);
    await ingestRange({ store, chain, contract: CONTRACT, from: 0n, to: 20n, finalityDepth: FINALITY });
    expect(await store.getCursor()).toBe(20n);
  });
});

describe('idempotency', () => {
  // Re-running a range must be a no-op. Restarts and overlapping ranges are
  // normal, and duplicate rows would inflate stepCount and break the fold.
  test('re-ingesting the same range changes nothing', async () => {
    const store = new MemoryStore();
    const chain = new FakeChain([stepLog(0, 10, '0xaaa'), stepLog(1, 11, '0xbbb')]);
    const args = { store, chain, contract: CONTRACT, from: 0n, to: 20n, finalityDepth: FINALITY };

    await ingestRange(args);
    await ingestRange(args);
    await ingestRange(args);

    expect((await store.getSteps(RUN_ID))).toHaveLength(2);
    expect((await store.getRun(RUN_ID))!.stepCount).toBe(2);
  });

  test('a later seal replaces an earlier read of the same run', async () => {
    const store = new MemoryStore();
    const chain = new FakeChain([stepLog(0, 10, '0xaaa')]);
    await ingestRange({ store, chain, contract: CONTRACT, from: 0n, to: 12n, finalityDepth: FINALITY });
    expect((await store.getRun(RUN_ID))!.sealed).toBe(false);

    chain.logs.push(sealLog(13, '0xddd', `0x${'99'.repeat(32)}`));
    await ingestRange({ store, chain, contract: CONTRACT, from: 13n, to: 20n, finalityDepth: FINALITY });
    expect((await store.getRun(RUN_ID))!.sealed).toBe(true);
  });
});

describe('reorg handling (§8.1)', () => {
  test('drops rows from blocks whose hash no longer matches', async () => {
    const store = new MemoryStore();
    // Head sits just above the affected blocks: a reorg is a property of the
    // unfinalised tail, and blocks below the finality depth are settled.
    const chain = new FakeChain([stepLog(0, 10, '0xaaa'), stepLog(1, 11, '0xbbb')], 13);
    chain.blockHashes.set(10, '0xaaa');
    chain.blockHashes.set(11, '0xbbb');
    await ingestRange({ store, chain, contract: CONTRACT, from: 0n, to: 20n, finalityDepth: FINALITY });
    expect(await store.getSteps(RUN_ID)).toHaveLength(2);

    // Block 11 is replaced: its receipt never happened on the canonical chain.
    chain.blockHashes.set(11, '0xREORGED');
    chain.logs = [stepLog(0, 10, '0xaaa')];

    const result = await ingestRange({
      store, chain, contract: CONTRACT, from: 0n, to: 20n, finalityDepth: FINALITY,
    });

    expect(result.reorgedFrom).toBe(11n);
    const steps = await store.getSteps(RUN_ID);
    expect(steps).toHaveLength(1);
    expect(steps[0]!.stepIndex).toBe(0);
  });

  test('re-ingests the replacement blocks', async () => {
    const store = new MemoryStore();
    const chain = new FakeChain([stepLog(0, 10, '0xaaa'), stepLog(1, 11, '0xbbb')], 13);
    chain.blockHashes.set(10, '0xaaa');
    chain.blockHashes.set(11, '0xbbb');
    await ingestRange({ store, chain, contract: CONTRACT, from: 0n, to: 20n, finalityDepth: FINALITY });

    // The step is re-mined in a different block with a different status.
    chain.blockHashes.set(11, '0xNEW');
    chain.logs = [stepLog(0, 10, '0xaaa'), stepLog(1, 11, '0xNEW', StepStatus.Failed)];

    await ingestRange({ store, chain, contract: CONTRACT, from: 0n, to: 20n, finalityDepth: FINALITY });

    const steps = await store.getSteps(RUN_ID);
    expect(steps).toHaveLength(2);
    expect(steps[1]!.status).toBe(StepStatus.Failed);
  });

  test('rewinds the cursor so the replaced range is rescanned', async () => {
    const store = new MemoryStore();
    const chain = new FakeChain([stepLog(0, 10, '0xaaa')], 12);
    chain.blockHashes.set(10, '0xaaa');
    await ingestRange({ store, chain, contract: CONTRACT, from: 0n, to: 20n, finalityDepth: FINALITY });

    chain.blockHashes.set(10, '0xREORGED');
    chain.logs = [];
    const result = await ingestRange({
      store, chain, contract: CONTRACT, from: 0n, to: 20n, finalityDepth: FINALITY,
    });

    expect(result.reorgedFrom).toBe(10n);
    expect(await store.getSteps(RUN_ID)).toHaveLength(0);
  });

  test('a reorg below the finality depth is deliberately not detected', async () => {
    // The explicit tradeoff behind §8.1's "tracking finality depth": blocks
    // that deep are treated as settled. Re-verifying them on every pass would
    // make the indexer O(chain). If a chain can reorg deeper than this, the
    // finality depth is set wrong — the fix is configuration, not scanning.
    const store = new MemoryStore();
    const chain = new FakeChain([stepLog(0, 10, '0xaaa')], 1000);
    chain.blockHashes.set(10, '0xaaa');
    await ingestRange({ store, chain, contract: CONTRACT, from: 0n, to: 20n, finalityDepth: FINALITY });

    chain.blockHashes.set(10, '0xREORGED');
    const result = await ingestRange({
      store, chain, contract: CONTRACT, from: 0n, to: 20n, finalityDepth: FINALITY,
    });
    expect(result.reorgedFrom).toBeNull();
  });

  test('does not re-check blocks below the finality depth', async () => {
    // Rechecking every block forever would make the indexer O(chain).
    const store = new MemoryStore();
    const chain = new FakeChain([stepLog(0, 10, '0xaaa')], 1000);
    chain.blockHashes.set(10, '0xaaa');
    await ingestRange({ store, chain, contract: CONTRACT, from: 0n, to: 900n, finalityDepth: FINALITY });

    let checked = 0;
    const counting: ChainReader = {
      getBlockNumber: () => chain.getBlockNumber(),
      getLogs: (f, t) => chain.getLogs(f, t),
      getBlockHash: (n) => {
        checked += 1;
        return chain.getBlockHash(n);
      },
    };
    await ingestRange({
      store, chain: counting, contract: CONTRACT, from: 900n, to: 950n, finalityDepth: FINALITY,
    });
    // Only the unfinalised tail is re-checked, not all 900 earlier blocks.
    expect(checked).toBeLessThanOrEqual(FINALITY + 1);
  });
});

describe('catchUp', () => {
  test('never scans below the deployment block', async () => {
    // A cursor below the deployment block is nonsense — a stale row, a shared
    // database, a misconfiguration — and honouring it means scanning from near
    // genesis. That is not a slow correct answer, it is minutes of wasted RPC
    // for a range where the contract did not exist.
    const store = new MemoryStore();
    await store.setCursor(77n);

    const scanned: Array<[bigint, bigint]> = [];
    const chain: ChainReader = {
      getBlockNumber: async () => 1_000_000n,
      getBlockHash: async (n) => `0xblock${n}`,
      getLogs: async (from, to) => {
        scanned.push([from, to]);
        return [];
      },
    };

    await catchUp({
      store, chain, contract: CONTRACT, deploymentBlock: 999_000n,
      finalityDepth: FINALITY, batchSize: 5_000n,
    });

    expect(scanned[0]![0]).toBe(999_000n);
    expect(scanned.length).toBeLessThan(5);
  });

  test('resumes from the cursor when it is above the deployment block', async () => {
    const store = new MemoryStore();
    await store.setCursor(999_500n);

    const scanned: Array<[bigint, bigint]> = [];
    const chain: ChainReader = {
      getBlockNumber: async () => 1_000_000n,
      getBlockHash: async (n) => `0xblock${n}`,
      getLogs: async (from, to) => {
        scanned.push([from, to]);
        return [];
      },
    };

    await catchUp({
      store, chain, contract: CONTRACT, deploymentBlock: 999_000n,
      finalityDepth: FINALITY, batchSize: 5_000n,
    });

    expect(scanned[0]![0]).toBe(999_501n);
  });
});

describe('run aggregation', () => {
  test('separates runs that share a flow', async () => {
    const other = `0x${'33'.repeat(32)}` as Hex;
    const store = new MemoryStore();
    const chain = new FakeChain([
      stepLog(0, 10, '0xaaa'),
      stepLog(0, 11, '0xbbb', StepStatus.Ok, other),
    ]);
    await ingestRange({ store, chain, contract: CONTRACT, from: 0n, to: 20n, finalityDepth: FINALITY });

    expect(await store.getSteps(RUN_ID)).toHaveLength(1);
    expect(await store.getSteps(other)).toHaveLength(1);
    expect((await store.listRuns(10, 0)).length).toBe(2);
  });

  test('lists recent runs newest first', async () => {
    const other = `0x${'33'.repeat(32)}` as Hex;
    const store = new MemoryStore();
    const chain = new FakeChain([
      stepLog(0, 10, '0xaaa'),
      stepLog(0, 30, '0xbbb', StepStatus.Ok, other),
    ]);
    await ingestRange({ store, chain, contract: CONTRACT, from: 0n, to: 40n, finalityDepth: FINALITY });

    const runs = await store.listRuns(10, 0);
    expect(runs[0]!.runId).toBe(other);
  });

  test('tracks per-agent participation and attestation rate', async () => {
    const store = new MemoryStore();
    const chain = new FakeChain([stepLog(0, 10, '0xaaa'), stepLog(1, 11, '0xbbb', StepStatus.Failed)]);
    await ingestRange({ store, chain, contract: CONTRACT, from: 0n, to: 20n, finalityDepth: FINALITY });

    const agent = await store.getAgent(1n);
    expect(agent!.stepCount).toBe(2);
    expect(agent!.okCount).toBe(1);
    // Neither step carried an attestation.
    expect(agent!.attestedCount).toBe(0);
  });
});
