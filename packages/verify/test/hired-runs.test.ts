/**
 * Following a hired sub-workflow — §9, extended to nesting.
 *
 * When a step's output names a child run, the verifier fetches that run's own
 * receipts and seal and verifies it too, then checks the parent's claim
 * against what the child actually sealed. That check is the entire reason a
 * sub-flow step publishes the child's *root* rather than the child's data: a
 * parent cannot take credit for work its child did not do.
 *
 * The cases that matter most are the dishonest ones. A parent claiming a root
 * the child never sealed must fail — not be reported as an unknown — because
 * the parent's trace hash is already verified against its receipt, so a
 * mismatch is a false claim rather than a corrupted file.
 */

import { describe, expect, test } from 'vitest';
import {
  canonicalize,
  hashJson,
  foldChainRoot,
  StepStatus,
  ZERO_BYTES32,
  type Hex,
  type JsonValue,
  type Receipt,
} from '@0gflow/core';
import { verifyRun } from '../src/verify.js';
import { STEP_ANCHORED_TOPIC, RUN_SEALED_TOPIC, type RawLog } from '../src/decode.js';
import type { ChainSource, FetchedTrace, TraceSource } from '../src/sources.js';

const PARENT_RUN = `0x${'22'.repeat(32)}` as Hex;
const CHILD_RUN = `0x${'33'.repeat(32)}` as Hex;
const PARENT_FLOW = `0x${'11'.repeat(32)}` as Hex;
const CHILD_FLOW = `0x${'44'.repeat(32)}` as Hex;

const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');
const bare = (h: string) => h.replace(/^0x/, '');

function stepLog(r: Receipt, blockNumber: number, logIndex: number): RawLog {
  return {
    address: '0x5368974b886d04ac90ffb6f385e494fdf13e055b',
    topics: [STEP_ANCHORED_TOPIC, r.flowId, r.runId, `0x${word(r.stepIndex)}`],
    data:
      '0x' +
      word(r.agentId) +
      bare(r.inputHash) +
      bare(r.outputHash) +
      bare(r.traceRoot) +
      bare(r.attestationRef) +
      word(r.startedAt) +
      word(r.endedAt) +
      word(r.status),
    blockNumber: `0x${blockNumber.toString(16)}`,
    transactionHash: `0x${'ab'.repeat(32)}`,
    logIndex: `0x${logIndex.toString(16)}`,
  };
}

function sealLog(runId: Hex, chainRoot: Hex, stepCount: number, outcome: number): RawLog {
  return {
    address: '0x5368974b886d04ac90ffb6f385e494fdf13e055b',
    topics: [RUN_SEALED_TOPIC, runId],
    data: '0x' + bare(chainRoot) + word(stepCount) + word(outcome),
    blockNumber: '0x2',
    transactionHash: `0x${'ee'.repeat(32)}`,
    logIndex: '0x0',
  };
}

const trace = (runId: Hex, stepIndex: number, input: JsonValue, output: JsonValue): JsonValue => ({
  version: '0gflow/1',
  runId,
  stepIndex,
  stepId: `step-${stepIndex}`,
  agent: '1',
  input,
  output,
});

const receipt = (
  runId: Hex,
  flowId: Hex,
  stepIndex: number,
  input: JsonValue,
  output: JsonValue,
  traceRoot: Hex,
): Receipt => ({
  flowId,
  runId,
  stepIndex,
  agentId: 1n,
  inputHash: hashJson(input),
  outputHash: hashJson(output),
  traceRoot,
  attestationRef: ZERO_BYTES32,
  startedAt: 100n,
  endedAt: 101n,
  status: StepStatus.Ok,
});

/** Serves receipts, seals and traces for however many runs a test needs. */
class World implements ChainSource, TraceSource {
  readonly describe = 'fake';
  readonly steps = new Map<string, RawLog[]>();
  readonly seals = new Map<string, RawLog[]>();
  readonly traces = new Map<string, JsonValue>();
  /** Every run id the verifier asked about, so recursion can be observed. */
  readonly asked: string[] = [];

  async getStepAnchoredLogs(runId: Hex) {
    this.asked.push(runId.toLowerCase());
    return this.steps.get(runId.toLowerCase()) ?? [];
  }
  async getRunSealedLogs(runId: Hex) {
    return this.seals.get(runId.toLowerCase()) ?? [];
  }
  async ownerOf() {
    return '0x00000000000000000000000000000000000000aa' as Hex;
  }
  async fetch(root: Hex): Promise<FetchedTrace | null> {
    const found = this.traces.get(root.toLowerCase());
    if (found === undefined) return null;
    return {
      bytes: new TextEncoder().encode(canonicalize(found)),
      origin: 'storage',
      inclusionProofVerified: true,
    };
  }

  /** Adds a single-step run and returns the root it seals to. */
  addRun(
    runId: Hex,
    flowId: Hex,
    input: JsonValue,
    output: JsonValue,
    outcome = 0,
    hiredRuns: readonly string[] = [],
  ): Hex {
    const t = {
      ...(trace(runId, 0, input, output) as Record<string, JsonValue>),
      ...(hiredRuns.length === 0 ? {} : { hiredRuns: [...hiredRuns] }),
    } as JsonValue;
    const traceRoot = hashJson(t) as Hex;
    this.traces.set(traceRoot.toLowerCase(), t);

    const r = receipt(runId, flowId, 0, input, output, traceRoot);
    this.steps.set(runId.toLowerCase(), [stepLog(r, 1, 0)]);

    const chainRoot = foldChainRoot([r]) as Hex;
    this.seals.set(runId.toLowerCase(), [sealLog(runId, chainRoot, 1, outcome)]);
    return chainRoot;
  }
}

/** The output a `kind: 'flow'` step publishes. */
const hiredOutput = (childRunId: Hex, chainRoot: Hex, over: Record<string, JsonValue> = {}) => ({
  childRunId,
  childFlowId: CHILD_FLOW,
  chainRoot,
  stepCount: 1,
  outcome: 0,
  ...over,
});

/** A parent whose only step hired `childRunId` and claims it sealed `claimed`. */
function buildWorld(claimed: Hex, childRoot: Hex): World {
  const world = new World();
  world.addRun(CHILD_RUN, CHILD_FLOW, { task: 'audit' }, { text: 'done' });
  // Overwrite the child's seal only if the test wants a different real root.
  const parentOutput = hiredOutput(CHILD_RUN, claimed) as unknown as JsonValue;
  world.addRun(PARENT_RUN, PARENT_FLOW, { topic: 'x' }, parentOutput);
  void childRoot;
  return world;
}

const verify = (world: World, over: Record<string, unknown> = {}) =>
  verifyRun({
    runId: PARENT_RUN,
    chain: world,
    traces: world,
    identityRegistries: [],
    spec: null,
    ...over,
  } as Parameters<typeof verifyRun>[0]);

describe('a step that hired a sub-workflow', () => {
  test('the child is fetched and verified in its own right', async () => {
    const world = new World();
    const childRoot = world.addRun(CHILD_RUN, CHILD_FLOW, { task: 'audit' }, { text: 'done' });
    world.addRun(
      PARENT_RUN,
      PARENT_FLOW,
      { topic: 'x' },
      hiredOutput(CHILD_RUN, childRoot) as unknown as JsonValue,
    );

    const report = await verify(world);

    expect(world.asked).toContain(CHILD_RUN.toLowerCase());
    expect(report.hired).toHaveLength(1);
    expect(report.hired[0]!.childRunId).toBe(CHILD_RUN.toLowerCase());
    // Its receipts, seal and hashes all check out. The verdict is INCOMPLETE
    // rather than VERIFIED only because no spec was supplied for it, so its
    // linkage went unchecked — the same answer the parent would get.
    expect(report.hired[0]!.report?.failures).toEqual([]);
    expect(report.hired[0]!.report?.verdict).toBe('incomplete');
    expect(report.hired[0]!.report?.linkageSkipped).not.toBeNull();
  });

  /// A sub-flow is declared inline in the parent, so the parent's spec already
  /// contains the child's. Deriving it is what lets a run that hires anything
  /// reach VERIFIED at all.
  test('the child is checked against the sub-flow the parent declared', async () => {
    const world = new World();
    const childRoot = world.addRun(CHILD_RUN, CHILD_FLOW, { task: 'audit' }, { text: 'done' });
    world.addRun(
      PARENT_RUN,
      PARENT_FLOW,
      // The parent step's input is what the executor hands the child as its
      // inputs, so the fixture has to reflect that.
      { task: 'audit' },
      hiredOutput(CHILD_RUN, childRoot) as unknown as JsonValue,
    );

    const report = await verify(world, {
      spec: {
        inputs: { task: 'audit' },
        steps: [
          {
            id: 'step-0',
            // The parent step's resolved input is what the child runs on, so
            // these have to agree — as they do in the executor, which passes
            // one straight to the other.
            input: { task: 'audit' },
            flow: { steps: [{ id: 'step-0', input: { task: '{{ inputs.task }}' } }] },
          },
        ],
      },
    });

    expect(report.hired[0]!.report?.linkage).not.toBeNull();
    expect(report.hired[0]!.report?.verdict).toBe('verified');
    expect(report.verdict).toBe('verified');
  });

  /// The load-bearing check. The parent's trace hash is verified against its
  /// receipt, so a mismatch here is not a corrupted file — it is a parent
  /// claiming something about a child run the chain does not support.
  test('a parent claiming a root the child never sealed FAILS', async () => {
    const world = new World();
    world.addRun(CHILD_RUN, CHILD_FLOW, { task: 'audit' }, { text: 'done' });
    world.addRun(
      PARENT_RUN,
      PARENT_FLOW,
      { topic: 'x' },
      hiredOutput(CHILD_RUN, `0x${'99'.repeat(32)}` as Hex) as unknown as JsonValue,
    );

    const report = await verify(world);

    expect(report.verdict).toBe('failed');
    expect(report.failures.join(' ')).toMatch(/claims hired run .* sealed .* but that run sealed/);
  });

  /// A parent is only as good as the run it points at.
  test('a child that does not verify fails the parent', async () => {
    const world = new World();
    const childRoot = world.addRun(CHILD_RUN, CHILD_FLOW, { task: 'audit' }, { text: 'done' });
    // The child's receipts exist but its seal claims a different root.
    world.seals.set(CHILD_RUN.toLowerCase(), [
      sealLog(CHILD_RUN, `0x${'77'.repeat(32)}` as Hex, 1, 0),
    ]);
    world.addRun(
      PARENT_RUN,
      PARENT_FLOW,
      { topic: 'x' },
      hiredOutput(CHILD_RUN, childRoot) as unknown as JsonValue,
    );

    const report = await verify(world);
    expect(report.verdict).toBe('failed');
  });

  /// Reporting VERIFIED over an INCOMPLETE child would be the clean-looking
  /// summary §9 exists to prevent: the parent's evidence IS the child run.
  test('an incomplete child makes the parent incomplete', async () => {
    const world = new World();
    const childRoot = world.addRun(CHILD_RUN, CHILD_FLOW, { task: 'audit' }, { text: 'done' });
    world.addRun(
      PARENT_RUN,
      PARENT_FLOW,
      { topic: 'x' },
      hiredOutput(CHILD_RUN, childRoot) as unknown as JsonValue,
    );
    // Make the child's trace unretrievable: it still seals correctly, so the
    // parent's claim holds, but the child cannot be fully checked.
    world.traces.clear();
    const parentTrace = trace(
      PARENT_RUN,
      0,
      { topic: 'x' },
      hiredOutput(CHILD_RUN, childRoot) as unknown as JsonValue,
    );
    world.traces.set((hashJson(parentTrace) as Hex).toLowerCase(), parentTrace);

    const report = await verify(world);
    expect(report.verdict).toBe('incomplete');
    expect(report.incomplete.join(' ')).toMatch(/is itself incomplete/);
  });

  test('a child that was never sealed is reported, not assumed', async () => {
    const world = new World();
    const childRoot = world.addRun(CHILD_RUN, CHILD_FLOW, { task: 'audit' }, { text: 'done' });
    world.seals.delete(CHILD_RUN.toLowerCase());
    world.addRun(
      PARENT_RUN,
      PARENT_FLOW,
      { topic: 'x' },
      hiredOutput(CHILD_RUN, childRoot) as unknown as JsonValue,
    );

    const report = await verify(world);
    expect(report.incomplete.join(' ')).toMatch(/not sealed on chain/);
  });
});

describe('recursion is bounded', () => {
  /// The runs being followed are named by data this verifier is in the middle
  /// of checking, so an unbounded walk is a denial of service handed to
  /// whoever wrote the trace.
  test('depth 0 reports the hired run without following it', async () => {
    const world = new World();
    const childRoot = world.addRun(CHILD_RUN, CHILD_FLOW, { task: 'audit' }, { text: 'done' });
    world.addRun(
      PARENT_RUN,
      PARENT_FLOW,
      { topic: 'x' },
      hiredOutput(CHILD_RUN, childRoot) as unknown as JsonValue,
    );

    const report = await verify(world, { maxHireDepth: 0 });

    expect(report.hired).toHaveLength(1);
    expect(report.hired[0]!.report).toBeNull();
    expect(report.hired[0]!.skipped).toMatch(/depth limit/);
    expect(world.asked).not.toContain(CHILD_RUN.toLowerCase());
    // Not silently dropped: an unfollowed child is a gap in the evidence.
    expect(report.verdict).toBe('incomplete');
  });

  /// A run naming itself would otherwise recurse forever.
  test('a run that hires itself terminates', async () => {
    const world = new World();
    const selfRoot = world.addRun(PARENT_RUN, PARENT_FLOW, { topic: 'x' }, { placeholder: true });
    world.addRun(
      PARENT_RUN,
      PARENT_FLOW,
      { topic: 'x' },
      hiredOutput(PARENT_RUN, selfRoot) as unknown as JsonValue,
    );

    // Resolves rather than blowing the stack; the depth cap is what stops it.
    const report = await verify(world, { maxHireDepth: 2 });
    expect(report.hired.length).toBeGreaterThan(0);
  });
});

describe('what does not count as hiring', () => {
  /// A partial match would mean chasing a run id some ordinary agent happened
  /// to put in its output under a colliding key.
  test.each([
    ['no childRunId', { chainRoot: `0x${'33'.repeat(32)}`, stepCount: 1, outcome: 0 }],
    ['no chainRoot', { childRunId: CHILD_RUN, stepCount: 1, outcome: 0 }],
    ['no stepCount', { childRunId: CHILD_RUN, chainRoot: `0x${'33'.repeat(32)}`, outcome: 0 }],
    ['a malformed run id', { childRunId: '0xnope', chainRoot: `0x${'33'.repeat(32)}`, stepCount: 1, outcome: 0 }],
    ['a plain string output', 'just an answer'],
    ['an array output', [1, 2, 3]],
  ])('%s is not followed', async (_name, output) => {
    const world = new World();
    world.addRun(PARENT_RUN, PARENT_FLOW, { topic: 'x' }, output as JsonValue);

    const report = await verify(world);
    expect(report.hired).toHaveLength(0);
  });
});

// Referenced so the helper is not dead code if a case is removed.
void buildWorld;


describe('runs an agent disclosed hiring', () => {
  /// Unlike a sub-flow step, nothing ties the parent's output to these. The
  /// agent is saying where it went, and anyone can name any run id. They are
  /// still worth checking — and still tamper-evident, because the trace hashes
  /// to the traceRoot the receipt anchors.
  test('are verified and reported as disclosures', async () => {
    const world = new World();
    world.addRun(CHILD_RUN, CHILD_FLOW, { task: 'audit' }, { text: 'done' });
    world.addRun(PARENT_RUN, PARENT_FLOW, { topic: 'x' }, { text: 'summary' }, 0, [CHILD_RUN]);

    const report = await verify(world);

    expect(world.asked).toContain(CHILD_RUN.toLowerCase());
    expect(report.hired).toHaveLength(1);
    expect(report.hired[0]!.kind).toBe('disclosed');
    // No claim was made about the run's contents, so there is nothing to
    // cross-check — and pretending otherwise would be the whole mistake.
    expect(report.hired[0]!.claimedChainRoot).toBeNull();
  });

  /// A disclosed run that does not verify says something is wrong with that
  /// run, not that this step's own evidence is bad. The parent never claimed
  /// anything about its contents.
  test('one that does not verify makes the parent incomplete, not failed', async () => {
    const world = new World();
    world.addRun(CHILD_RUN, CHILD_FLOW, { task: 'audit' }, { text: 'done' });
    world.seals.set(CHILD_RUN.toLowerCase(), [
      sealLog(CHILD_RUN, `0x${'77'.repeat(32)}` as Hex, 1, 0),
    ]);
    world.addRun(PARENT_RUN, PARENT_FLOW, { topic: 'x' }, { text: 'summary' }, 0, [CHILD_RUN]);

    const report = await verify(world);

    expect(report.verdict).toBe('incomplete');
    expect(report.failures).toEqual([]);
    expect(report.incomplete.join(' ')).toMatch(/disclosed run .* which does not verify/);
  });

  /// By contrast, a sub-flow the executor opened IS the parent's evidence.
  test('a sub-flow that does not verify still fails the parent', async () => {
    const world = new World();
    const childRoot = world.addRun(CHILD_RUN, CHILD_FLOW, { task: 'audit' }, { text: 'done' });
    world.seals.set(CHILD_RUN.toLowerCase(), [
      sealLog(CHILD_RUN, `0x${'77'.repeat(32)}` as Hex, 1, 0),
    ]);
    world.addRun(
      PARENT_RUN,
      PARENT_FLOW,
      { topic: 'x' },
      hiredOutput(CHILD_RUN, childRoot) as unknown as JsonValue,
    );

    const report = await verify(world);
    expect(report.verdict).toBe('failed');
  });

  test('a malformed disclosed run id is ignored', async () => {
    const world = new World();
    world.addRun(PARENT_RUN, PARENT_FLOW, { topic: 'x' }, { text: 'summary' }, 0, ['0xnope']);

    const report = await verify(world);
    expect(report.hired).toHaveLength(0);
  });

  /// A step that both hires a sub-flow and discloses the same run should not
  /// verify it twice.
  test('a run named both ways is followed once', async () => {
    const world = new World();
    const childRoot = world.addRun(CHILD_RUN, CHILD_FLOW, { task: 'audit' }, { text: 'done' });
    world.addRun(
      PARENT_RUN,
      PARENT_FLOW,
      { topic: 'x' },
      hiredOutput(CHILD_RUN, childRoot) as unknown as JsonValue,
      0,
      [CHILD_RUN],
    );

    const report = await verify(world);
    expect(report.hired).toHaveLength(1);
    // The stronger reading wins: it really was opened as a sub-flow.
    expect(report.hired[0]!.kind).toBe('subflow');
  });

  test('several disclosures are each verified', async () => {
    const second = `0x${'55'.repeat(32)}` as Hex;
    const world = new World();
    world.addRun(CHILD_RUN, CHILD_FLOW, { task: 'a' }, { text: 'a' });
    world.addRun(second, CHILD_FLOW, { task: 'b' }, { text: 'b' });
    world.addRun(PARENT_RUN, PARENT_FLOW, { topic: 'x' }, { text: 'summary' }, 0, [
      CHILD_RUN,
      second,
    ]);

    const report = await verify(world);
    expect(report.hired.map((h) => h.childRunId).sort()).toEqual(
      [CHILD_RUN.toLowerCase(), second.toLowerCase()].sort(),
    );
  });
});
