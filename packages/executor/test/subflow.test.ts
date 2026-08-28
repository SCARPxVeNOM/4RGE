/**
 * Agents hiring agents.
 *
 * A step with `kind: 'flow'` opens a child run and executes a whole workflow
 * inside it. The parent's step output is the child's *on-chain* result — its
 * run id and sealed chain root — which is what makes the nesting verifiable
 * rather than merely convenient: a parent cannot claim work its child did not
 * do, because the child's root is on chain and anyone can re-fold it.
 *
 * The recursion caps get as much attention as the happy path. `planFlow`
 * detects cycles within one flow and knows nothing across runs, so without a
 * depth limit and a lineage check a flow that hires itself would run until it
 * exhausted the funder's budget or the process.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StepStatus, hashJson, type Hex, type JsonValue, type Receipt } from '@0gflow/core';
import { executeRun, type AnchorReceipt, type ChainWriter, type TraceStore } from '../src/execute.js';
import { planFlow, PlanError, type FlowSpec } from '../src/plan.js';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, JsonValue>) : {};
      const input = (body['input'] ?? {}) as Record<string, JsonValue>;
      const fail = (req.url ?? '').includes('/broken/');
      res.writeHead(fail ? 500 : 200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          fail
            ? { error: { code: 'boom', message: 'deliberate failure', retryable: false } }
            : { output: { text: `did ${String(input['task'] ?? 'work')}` }, attestation: null },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Shared across parent and child runs, exactly as one contract would be. */
class FakeChain implements ChainWriter {
  readonly executorAddress = '0x00000000000000000000000000000000000000e1' as Hex;
  readonly chainId = 31337;
  readonly receiptsAddress = '0x741a36faba40ee71223539a5a062fdedc8574e30' as Hex;
  readonly anchored: Receipt[] = [];
  readonly seals = new Map<string, { chainRoot: Hex; stepCount: number; outcome: number }>();
  readonly startedRuns: Hex[] = [];

  async isFlowPublished() { return true; }
  async publishFlow() {}
  async startRun(_flowId: Hex, runId: Hex) {
    if (this.startedRuns.includes(runId)) throw new Error(`run ${runId} already started`);
    this.startedRuns.push(runId);
  }
  async anchorStep(receipt: Receipt): Promise<AnchorReceipt> {
    this.anchored.push(receipt);
    return { txHash: `0x${'ab'.repeat(32)}` as Hex, blockNumber: 1n, logIndex: 0 };
  }
  async sealRun(runId: Hex, chainRoot: Hex, stepCount: number, outcome: number) {
    this.seals.set(runId.toLowerCase(), { chainRoot, stepCount, outcome });
    return { txHash: `0x${'ef'.repeat(32)}` as Hex, blockNumber: 2n };
  }
}

class FakeTraces implements TraceStore {
  readonly describe = 'fake';
  readonly stored = new Map<string, JsonValue>();
  async put(trace: JsonValue) {
    const root = hashJson(trace) as Hex;
    this.stored.set(root, trace);
    return { traceRoot: root };
  }
}

const child = (agentPath: string): FlowSpec => ({
  version: '0gflow/1',
  name: 'child-flow',
  inputs: { task: { type: 'string' } },
  steps: [
    { id: 'first', agent: '2', input: { task: '{{ inputs.task }}' } },
    { id: 'second', agent: '3', needs: ['first'], input: { task: '{{ steps.first.output.text }}' } },
  ],
});

const parent = (sub: FlowSpec): FlowSpec => ({
  version: '0gflow/1',
  name: 'parent-flow',
  inputs: { topic: { type: 'string' } },
  steps: [
    {
      id: 'delegate',
      agent: '1',
      kind: 'flow',
      flow: sub,
      input: { task: '{{ inputs.topic }}' },
    },
    {
      id: 'wrapup',
      agent: '4',
      needs: ['delegate'],
      input: { task: '{{ steps.delegate.output.chainRoot }}' },
    },
  ],
});

async function run(spec: FlowSpec, path = 'ok') {
  const chain = new FakeChain();
  const traces = new FakeTraces();
  const result = await executeRun({
    spec,
    inputs: { topic: 'research' },
    runId: `0x${'22'.repeat(32)}` as Hex,
    chain,
    traces,
    endpointFor: () => `${base}/${path}/invoke`,
  });
  return { result, chain, traces };
}

describe('a step that hires a whole workflow', () => {
  test('opens a child run and succeeds when the child does', async () => {
    const { result, chain } = await run(parent(child('ok')));

    expect(result.succeeded).toBe(true);
    // Two runs were opened, not one.
    expect(chain.startedRuns).toHaveLength(2);
    // 2 child steps + 2 parent steps.
    expect(chain.anchored).toHaveLength(4);
  });

  /// The property that makes nesting verifiable. The parent's output is the
  /// child's on-chain result, so anyone can fetch that child's seal and check
  /// the root — a parent cannot claim work its child did not do.
  test('the parent step output is the child run’s sealed chain root', async () => {
    const { result, chain } = await run(parent(child('ok')));

    const delegate = result.steps.find((s) => s.stepId === 'delegate')!;
    const trace = [...chain.seals.entries()];
    expect(trace).toHaveLength(2);

    const parentReceipt = chain.anchored.find((r) => r.stepIndex === 0 && r.runId === result.runId)!;
    expect(parentReceipt.outputHash).toBe(delegate.outputHash);

    // The child's seal exists on chain and its root is the one the parent
    // published as its output.
    const childRunId = [...chain.seals.keys()].find((id) => id !== result.runId.toLowerCase())!;
    const childSeal = chain.seals.get(childRunId)!;
    expect(childSeal.outcome).toBe(0);
    expect(childSeal.chainRoot).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test('a downstream step can read the child’s root', async () => {
    const { result } = await run(parent(child('ok')));
    expect(result.steps.find((s) => s.stepId === 'wrapup')?.status).toBe(StepStatus.Ok);
  });

  /// The child's own receipts already record what went wrong, on chain and in
  /// detail. The parent points at them rather than restating them.
  test('a failing child fails the parent step and names the child run', async () => {
    const { result } = await run(parent(child('broken')), 'broken');

    const delegate = result.steps.find((s) => s.stepId === 'delegate')!;
    expect(delegate.status).toBe(StepStatus.Failed);
    expect(delegate.error).toMatch(/sub-flow 0x[0-9a-f]{64} sealed with outcome/);
    expect(result.succeeded).toBe(false);
    // Still a sealed, verifiable failure (§1.3).
    expect(result.sealed).toBe(true);
  });

  /// Child run ids are derived from the parent's, so a re-run of the same
  /// parent produces the same child — reproducible, and never colliding with
  /// a sibling step's child.
  test('child run ids are derived and distinct per step', async () => {
    const twoChildren: FlowSpec = {
      version: '0gflow/1',
      name: 'two-children',
      inputs: { topic: { type: 'string' } },
      steps: [
        { id: 'a', agent: '1', kind: 'flow', flow: child('ok'), input: { task: '{{ inputs.topic }}' } },
        { id: 'b', agent: '1', kind: 'flow', flow: child('ok'), input: { task: '{{ inputs.topic }}' } },
      ],
    };
    const { chain } = await run(twoChildren);
    expect(new Set(chain.startedRuns).size).toBe(3);
  });
});

describe('the recursion caps, which are not optional', () => {
  /// The planner validates one flow at a time, so it cannot see a cycle that
  /// spans runs. Without this the flow would recurse until something ran out.
  test('a flow that hires itself is refused', async () => {
    const selfHiring: FlowSpec = {
      version: '0gflow/1',
      name: 'ouroboros',
      inputs: { topic: { type: 'string' } },
      steps: [{ id: 'again', agent: '1', kind: 'flow', flow: undefined as never, input: {} }],
    };
    // Tie the knot after construction; a literal self-reference is not
    // expressible in one object.
    (selfHiring.steps[0] as { flow: FlowSpec }).flow = selfHiring;

    // Refused at planning time, before anything is anchored — §5.1. The
    // planner catches this one by object identity, because computing a flowId
    // means canonicalizing the spec, and canonicalizing a circular object
    // never returns. The cycle has to be found before hashing.
    await expect(run(selfHiring)).rejects.toThrow(/contains itself as a sub-flow/);
  });

  /// Defence in depth. Two structurally identical but distinct objects slip
  /// past the planner's identity check, so the executor compares flowIds
  /// across runs — by which point each has been hashed safely.
  test('the executor also refuses a repeat by flowId across runs', async () => {
    const inner = child('ok');
    const outer: FlowSpec = {
      version: '0gflow/1',
      name: 'wrapper',
      inputs: { topic: { type: 'string' } },
      steps: [
        { id: 'down', agent: '1', kind: 'flow', flow: inner, input: { task: '{{ inputs.topic }}' } },
      ],
    };

    const chain = new FakeChain();
    await expect(
      executeRun({
        spec: outer,
        inputs: { topic: 'x' },
        runId: `0x${'22'.repeat(32)}` as Hex,
        chain,
        traces: new FakeTraces(),
        endpointFor: () => `${base}/ok/invoke`,
        // Claim the wrapper already ran further up the chain.
        lineage: [{ runId: `0x${'99'.repeat(32)}` as Hex, flowId: planFlow(outer).flowId }],
      }),
    ).rejects.toThrow(/already appears in this run's lineage/);
    expect(chain.anchored).toHaveLength(0);
  });

  test('nesting deeper than the limit is refused', async () => {
    // Five distinct flows, one inside the next; the default cap is four.
    let deepest: FlowSpec = child('ok');
    for (let level = 0; level < 5; level++) {
      const inner = deepest;
      deepest = {
        version: '0gflow/1',
        name: `level-${level}`,
        inputs: { topic: { type: 'string' } },
        steps: [
          { id: `down-${level}`, agent: '1', kind: 'flow', flow: inner, input: { task: '{{ inputs.topic }}' } },
        ],
      };
    }

    await expect(run(deepest)).rejects.toThrow(/exceeds the maximum depth/);
  });
});

describe('planning rejects a malformed sub-flow before anything runs', () => {
  /// §5.1: a rejected plan costs nothing, a bad receipt is permanent. The
  /// child is validated with the parent, not when the parent reaches it.
  test('a sub-flow with a broken reference fails the parent’s plan', () => {
    const broken: FlowSpec = {
      version: '0gflow/1',
      name: 'child',
      inputs: {},
      steps: [{ id: 'x', agent: '2', input: { v: '{{ steps.nonexistent.output.a }}' }, needs: ['nonexistent'] }],
    };
    expect(() => planFlow(parent(broken))).toThrow(PlanError);
    expect(() => planFlow(parent(broken))).toThrow(/the sub-flow is not valid/);
  });

  test('kind flow with no flow is refused', () => {
    expect(() =>
      planFlow({
        version: '0gflow/1',
        name: 'p',
        inputs: {},
        steps: [{ id: 'x', agent: '1', kind: 'flow', input: {} }],
      }),
    ).toThrow(/declares no flow to run/);
  });

  /// Silently ignoring it would give an author who expected a sub-flow a
  /// plain agent call instead.
  test('a flow declared without kind flow is refused rather than ignored', () => {
    expect(() =>
      planFlow({
        version: '0gflow/1',
        name: 'p',
        inputs: {},
        steps: [{ id: 'x', agent: '1', flow: child('ok'), input: {} }],
      }),
    ).toThrow(/set kind: "flow" to run it/);
  });
});
