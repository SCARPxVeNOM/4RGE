/**
 * `policy.minReputation` — spec §7 step 2.
 *
 * Below the bar the step is **skipped**, not failed. That is the spec's word
 * and the right one: the agent did not fail, it was never asked, because this
 * flow declined to hire it. A Failed receipt would record a fault the agent
 * never committed and drag down a record it had no chance to affect.
 *
 * The other judgement being pinned: a bar that cannot be checked is not met.
 * A misconfigured run skips every step rather than hiring blindly, which is
 * the direction to fail in.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  StepStatus,
  computeAgentRecord,
  hashJson,
  type AgentRecord,
  type Hex,
  type JsonValue,
  type Receipt,
} from '@0gflow/core';
import {
  executeRun,
  type AnchorReceipt,
  type ChainWriter,
  type ReputationSource,
  type StakeSource,
  type TraceStore,
} from '../src/execute.js';
import type { FlowPolicy, FlowSpec, StepSpec } from '../src/plan.js';

let server: Server;
let base: string;
let invocations = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      invocations += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ output: { ok: true }, attestation: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

class FakeChain implements ChainWriter {
  readonly executorAddress = '0x00000000000000000000000000000000000000e1' as Hex;
  readonly chainId = 31337;
  readonly receiptsAddress = '0x741a36faba40ee71223539a5a062fdedc8574e30' as Hex;
  readonly anchored: Receipt[] = [];
  async isFlowPublished() { return true; }
  async publishFlow() {}
  async startRun() {}
  async anchorStep(receipt: Receipt): Promise<AnchorReceipt> {
    this.anchored.push(receipt);
    return { txHash: `0x${'ab'.repeat(32)}` as Hex, blockNumber: 1n, logIndex: 0 };
  }
  async sealRun() {
    return { txHash: `0x${'ef'.repeat(32)}` as Hex, blockNumber: 2n };
  }
}

class FakeTraces implements TraceStore {
  readonly describe = 'fake';
  readonly stored: JsonValue[] = [];
  async put(trace: JsonValue) {
    this.stored.push(trace);
    return { traceRoot: hashJson(trace) as Hex };
  }
}

/** A record of `attempted` steps of which `ok` succeeded. */
const recordOf = (ok: number, attempted: number): AgentRecord =>
  computeAgentRecord(
    7n,
    Array.from({ length: attempted }, (_, i) => ({
      flowId: `0x${'11'.repeat(32)}` as Hex,
      runId: `0x${'22'.repeat(32)}` as Hex,
      stepIndex: i,
      agentId: 7n,
      inputHash: `0x${'33'.repeat(32)}` as Hex,
      outputHash: `0x${'44'.repeat(32)}` as Hex,
      traceRoot: `0x${'55'.repeat(32)}` as Hex,
      attestationRef: `0x${'00'.repeat(32)}` as Hex,
      startedAt: 1n,
      endedAt: 2n,
      status: i < ok ? StepStatus.Ok : StepStatus.Failed,
    })),
  );

const reputationOf = (record: AgentRecord | null): ReputationSource => ({
  async recordOf() {
    return record;
  },
});

const stakeOf = (amount: bigint | null): StakeSource => ({
  async stakeOf() {
    return amount;
  },
});

function flow(policy?: FlowPolicy, step: Partial<StepSpec> = {}): FlowSpec {
  return {
    version: '0gflow/1',
    name: 'policy-flow',
    inputs: {},
    steps: [{ id: 'work', agent: '7', input: { q: 'x' }, ...step }],
    ...(policy === undefined ? {} : { policy }),
  };
}

async function run(options: {
  spec: FlowSpec;
  reputation?: ReputationSource;
  stakes?: StakeSource;
}) {
  invocations = 0;
  const chain = new FakeChain();
  const traces = new FakeTraces();
  const result = await executeRun({
    spec: options.spec,
    inputs: {},
    runId: `0x${'22'.repeat(32)}` as Hex,
    chain,
    traces,
    endpointFor: () => `${base}/invoke`,
    ...(options.reputation === undefined ? {} : { reputation: options.reputation }),
    ...(options.stakes === undefined ? {} : { stakes: options.stakes }),
  });
  return { result, chain, traces, invocations };
}

describe('an agent that clears the bar', () => {
  test('is hired normally', async () => {
    const { result, invocations: calls } = await run({
      spec: flow({ minReputation: 0.9 }),
      reputation: reputationOf(recordOf(20, 20)),
    });
    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
    expect(calls).toBe(1);
  });

  test('a flow with no policy hires anyone', async () => {
    const { result } = await run({ spec: flow() });
    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
  });

  /// minReputation: 0 is the spec's own "no bar", not a bar nobody can clear.
  test('a zero threshold is no bar at all', async () => {
    const { result, invocations: calls } = await run({ spec: flow({ minReputation: 0 }) });
    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
    expect(calls).toBe(1);
  });
});

describe('an agent that does not', () => {
  /// Skipped, not failed. The agent did not fail — it was never asked.
  test('is skipped, with the reason, and never invoked', async () => {
    const { result, invocations: calls } = await run({
      spec: flow({ minReputation: 0.9 }),
      reputation: reputationOf(recordOf(10, 20)),
    });

    expect(result.steps[0]?.status).toBe(StepStatus.Skipped);
    expect(result.steps[0]?.error).toMatch(/policy: agent succeeded on 10\/20/);
    expect(calls).toBe(0);
  });

  /// §1.3: a run that declines to hire is still a well-formed, verifiable
  /// object rather than an abandoned one.
  test('the run is still sealed', async () => {
    const { result, chain } = await run({
      spec: flow({ minReputation: 0.9 }),
      reputation: reputationOf(recordOf(0, 20)),
    });
    expect(result.sealed).toBe(true);
    expect(result.succeeded).toBe(false);
    expect(chain.anchored).toHaveLength(1);
  });

  /// The sample floor doing its job through the whole stack: a perfect record
  /// over one step is not a track record.
  test('a brand-new agent does not clear a threshold on a perfect one-step record', async () => {
    const { result } = await run({
      spec: flow({ minReputation: 0.9 }),
      reputation: reputationOf(recordOf(1, 1)),
    });
    expect(result.steps[0]?.status).toBe(StepStatus.Skipped);
    expect(result.steps[0]?.error).toMatch(/too few to judge/);
  });

  test('unless the flow says how small a sample it will accept', async () => {
    const { result } = await run({
      spec: flow({ minReputation: 0.9, minSteps: 1 }),
      reputation: reputationOf(recordOf(1, 1)),
    });
    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
  });
});

describe('a bar that cannot be checked is not met', () => {
  /// A misconfigured run skips rather than hiring blindly. That is the
  /// direction to fail in.
  test('no reputation source configured', async () => {
    const { result, invocations: calls } = await run({ spec: flow({ minReputation: 0.9 }) });
    expect(result.steps[0]?.status).toBe(StepStatus.Skipped);
    expect(calls).toBe(0);
  });

  test('a source that returns nothing', async () => {
    const { result } = await run({
      spec: flow({ minReputation: 0.9 }),
      reputation: reputationOf(null),
    });
    expect(result.steps[0]?.status).toBe(StepStatus.Skipped);
    expect(result.steps[0]?.error).toMatch(/could not be read/);
  });

  test('a source that throws', async () => {
    const { result } = await run({
      spec: flow({ minReputation: 0.9 }),
      reputation: { recordOf: () => Promise.reject(new Error('rpc down')) },
    });
    expect(result.steps[0]?.status).toBe(StepStatus.Skipped);
  });
});

describe('stake', () => {
  test('a sufficient bond clears a stake bar', async () => {
    const { result } = await run({
      spec: flow({ minStake: '1000' }),
      stakes: stakeOf(5_000n),
    });
    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
  });

  test('an insufficient bond skips the step', async () => {
    const { result } = await run({
      spec: flow({ minStake: '1000' }),
      stakes: stakeOf(10n),
    });
    expect(result.steps[0]?.status).toBe(StepStatus.Skipped);
    expect(result.steps[0]?.error).toMatch(/bonded 10 wei, below the 1000 wei/);
  });

  /// Zero and "I could not find out" are different answers, and an RPC outage
  /// must not quietly hire an unbonded agent into a flow that asked for a bond.
  test('an unreadable stake skips rather than passing', async () => {
    const { result } = await run({ spec: flow({ minStake: '1000' }), stakes: stakeOf(null) });
    expect(result.steps[0]?.status).toBe(StepStatus.Skipped);
  });

  test('both bars must be cleared', async () => {
    const { result } = await run({
      spec: flow({ minReputation: 0.9, minStake: '1000' }),
      reputation: reputationOf(recordOf(20, 20)),
      stakes: stakeOf(10n),
    });
    expect(result.steps[0]?.status).toBe(StepStatus.Skipped);
  });
});

describe('a step’s own bar', () => {
  /// Replacing rather than adding: a step that states its own terms means
  /// them, and silently ANDing the flow's bar on top would make a step look
  /// more permissive than it is.
  test('replaces the flow policy rather than adding to it', async () => {
    const { result } = await run({
      // The flow demands 90%; this step accepts 50%.
      spec: flow({ minReputation: 0.9 }, { requireReputation: { minReputation: 0.5 } }),
      reputation: reputationOf(recordOf(15, 20)),
    });
    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
  });

  test('and can be stricter than the flow', async () => {
    const { result } = await run({
      spec: flow({ minReputation: 0.5 }, { requireReputation: { minReputation: 0.99 } }),
      reputation: reputationOf(recordOf(15, 20)),
    });
    expect(result.steps[0]?.status).toBe(StepStatus.Skipped);
  });
});
