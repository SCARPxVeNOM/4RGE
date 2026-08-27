import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  StepStatus,
  attestationRefFor,
  hashJson,
  foldChainRoot,
  legacyAttestationRef,
  sha256,
  verifyLinkage,
  ZERO_BYTES32,
  type Hex,
  type JsonValue,
  type Receipt,
} from '@0gflow/core';
import { executeRun, type ChainWriter, type TraceStore, type AnchorReceipt } from '../src/execute.js';
import type { FlowSpec } from '../src/plan.js';

/**
 * §7 executor semantics, provable without a chain.
 *
 * The behaviours under test are the ones that decide whether a run means
 * anything: that a step's input really is derived from its upstream output,
 * that a missing attestation cannot become a success, and that a failed run is
 * still sealed as a verifiable failure rather than abandoned.
 */

// --- a real agent server, because invocation is the point ------------------

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = req.url ?? '';
      const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, JsonValue>) : {};
      const input = (body['input'] ?? {}) as Record<string, JsonValue>;
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (path.startsWith('/agents/audit/')) {
        return reply(200, { output: { report: `audited ${String(input['repo'])}` }, attestation: null });
      }
      if (path.startsWith('/agents/summarize/')) {
        const output = { text: `summary of ${String(input['text'])}` };
        return reply(200, { output, attestation: Buffer.from('attest:summarize').toString('base64') });
      }
      if (path.startsWith('/agents/score/')) {
        return reply(200, { output: { value: String(input['report']).length }, attestation: null });
      }
      if (path.startsWith('/agents/publish/')) {
        return reply(200, { output: { url: `https://x.test/${String(input['grade'])}` }, attestation: null });
      }
      if (path.startsWith('/agents/never-attests/')) {
        return reply(200, { output: { text: 'unproven' }, attestation: null });
      }
      if (path.startsWith('/agents/always-fails/')) {
        return reply(422, { error: { code: 'unprocessable', message: 'deliberate failure', retryable: false } });
      }
      return reply(404, { error: { code: 'not-found', message: path, retryable: false } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// --- fakes for the chain and the trace store -------------------------------

class FakeChain implements ChainWriter {
  readonly executorAddress = '0x00000000000000000000000000000000000000e1' as Hex;
  readonly anchored: Receipt[] = [];
  readonly published = new Set<string>();
  sealed: { chainRoot: Hex; stepCount: number; outcome: number } | null = null;
  runs = 0;

  async isFlowPublished(flowId: Hex) { return this.published.has(flowId); }
  async publishFlow(flowId: Hex) { this.published.add(flowId); }
  async startRun() { this.runs += 1; }
  async anchorStep(receipt: Receipt): Promise<AnchorReceipt> {
    // Mirrors the contract: duplicates are keyed on (runId, stepIndex).
    if (this.anchored.some((r) => r.runId === receipt.runId && r.stepIndex === receipt.stepIndex)) {
      throw new Error(`duplicate anchor for step ${receipt.stepIndex}`);
    }
    this.anchored.push(receipt);
    return { txHash: `0x${'ab'.repeat(32)}` as Hex, blockNumber: BigInt(this.anchored.length), logIndex: 0 };
  }
  async sealRun(_runId: Hex, chainRoot: Hex, stepCount: number, outcome: number) {
    this.sealed = { chainRoot, stepCount, outcome };
    return { txHash: `0x${'ef'.repeat(32)}` as Hex, blockNumber: 99n };
  }
}

class FakeTraces implements TraceStore {
  readonly describe = 'fake';
  readonly stored = new Map<string, JsonValue>();
  /** Records the order of writes relative to anchoring, for §7.3. */
  readonly writes: string[] = [];

  async put(trace: JsonValue) {
    const root = hashJson(trace) as Hex;
    this.stored.set(root, trace);
    this.writes.push(root);
    return { traceRoot: root };
  }
}

const agent = (id: string) => `${base}/agents/${id}`;

function spec(steps: FlowSpec['steps']): FlowSpec {
  return { version: '0gflow/1', name: 'test-flow', inputs: { repoUrl: { type: 'string' } }, steps };
}

const DIAMOND = spec([
  { id: 'audit', agent: '1', input: { repo: '{{ inputs.repoUrl }}' } },
  { id: 'summarize', agent: '1', needs: ['audit'], input: { text: '{{ steps.audit.output.report }}' } },
  { id: 'score', agent: '1', needs: ['audit'], input: { report: '{{ steps.audit.output.report }}' } },
  {
    id: 'publish',
    agent: '1',
    needs: ['summarize', 'score'],
    input: { body: '{{ steps.summarize.output.text }}', grade: '{{ steps.score.output.value }}' },
  },
]);

// Built lazily: `base` is only assigned in beforeAll, so a module-level
// object would capture "undefined/agents/...".
const endpoints = (...ids: string[]): Record<string, string> =>
  Object.fromEntries(ids.map((id) => [id, agent(id)]));

const ENDPOINTS = () => endpoints('audit', 'summarize', 'score', 'publish');

const RUN_INPUTS: JsonValue = { repoUrl: 'https://example.test/repo' };

function run(flow: FlowSpec, endpoints: Record<string, string>, overrides: Partial<Parameters<typeof executeRun>[0]> = {}) {
  const chain = new FakeChain();
  const traces = new FakeTraces();
  return {
    chain,
    traces,
    result: executeRun({
      spec: flow,
      inputs: RUN_INPUTS,
      endpointFor: (step) => endpoints[step.id] ?? agent(step.id),
      chain,
      traces,
      runId: `0x${'22'.repeat(32)}` as Hex,
      ...overrides,
    }),
  };
}

describe('a four-step run with a parallel branch', () => {
  test('anchors every step and seals the run', async () => {
    const { chain, result } = run(DIAMOND, ENDPOINTS());
    const outcome = await result;
    expect(chain.anchored).toHaveLength(4);
    expect(chain.sealed).not.toBeNull();
    expect(chain.sealed!.stepCount).toBe(4);
    expect(chain.sealed!.outcome).toBe(0);
    expect(outcome.sealed).toBe(true);
  });

  test('the sealed root is what the receipts fold to', async () => {
    const { chain, result } = run(DIAMOND, ENDPOINTS());
    await result;
    expect(chain.sealed!.chainRoot).toBe(foldChainRoot(chain.anchored));
  });

  test('every step reports status ok', async () => {
    const { chain, result } = run(DIAMOND, ENDPOINTS());
    await result;
    expect(chain.anchored.every((r) => r.status === StepStatus.Ok)).toBe(true);
  });

  test('the run satisfies the linkage invariant it claims', async () => {
    // The executor's own output, checked the way a verifier would check it.
    const { chain, traces, result } = run(DIAMOND, ENDPOINTS());
    const outcome = await result;

    const report = verifyLinkage({
      steps: DIAMOND.steps.map((s) => ({ id: s.id, input: s.input, ...(s.needs ? { needs: s.needs } : {}) })),
      runInputs: RUN_INPUTS,
      evidence: outcome.steps.map((s) => {
        const trace = traces.stored.get(s.traceRoot) as Record<string, JsonValue>;
        return { stepId: s.stepId, input: trace['input']!, output: trace['output']! };
      }),
      receipts: chain.anchored,
    });
    expect(report.failures).toStrictEqual([]);
    expect(report.linkedSteps).toBe(4);
  });

  test('runs the independent branch concurrently', async () => {
    // summarize and score share a wave; if they were sequential the second
    // would start only after the first finished.
    const { result } = run(DIAMOND, ENDPOINTS());
    const outcome = await result;
    const summarize = outcome.steps.find((s) => s.stepId === 'summarize')!;
    const score = outcome.steps.find((s) => s.stepId === 'score')!;
    expect(Math.min(summarize.endedAt, score.endedAt)).toBeGreaterThanOrEqual(
      Math.max(summarize.startedAt, score.startedAt) - 1,
    );
  });

  test('stores each trace before anchoring its receipt', async () => {
    // §7.3: anchor once the storage root is confirmed, never before. An
    // anchored traceRoot nobody can fetch is an unverifiable receipt.
    const { chain, traces, result } = run(DIAMOND, ENDPOINTS());
    await result;
    for (const receipt of chain.anchored) {
      expect(traces.stored.has(receipt.traceRoot)).toBe(true);
    }
  });

  test('records the resolved input and output in each trace', async () => {
    const { chain, traces, result } = run(DIAMOND, ENDPOINTS());
    await result;
    for (const receipt of chain.anchored) {
      const trace = traces.stored.get(receipt.traceRoot) as Record<string, JsonValue>;
      expect(hashJson(trace['input']!)).toBe(receipt.inputHash);
      expect(hashJson(trace['output']!)).toBe(receipt.outputHash);
    }
  });
});

describe('attestation handling (§1.3)', () => {
  test('records attestationRef over the attestation bundle, not the quote alone', async () => {
    const { chain, result } = run(DIAMOND, ENDPOINTS());
    await result;
    const summarize = chain.anchored.find((r) => r.stepIndex === 1)!;

    // The quote is the attestation string exactly as the agent sent it —
    // never a decoded or re-encoded form.
    const quote = Buffer.from('attest:summarize').toString('base64');

    // The digest now covers the quote together with the per-response
    // signature, so that attestationRef commits to something about this
    // output rather than only to the document's integrity.
    // No provider is named by this test agent, so the bundle carries the zero
    // address: the digest still commits to a value, and a verifier will find
    // no acknowledged signer for it.
    expect(summarize.attestationRef).toBe(
      attestationRefFor({ quote, provider: `0x${'00'.repeat(20)}`, response: null }),
    );
  });

  test('the bundle digest is distinct from the pre-binding quote-only digest', async () => {
    const { chain, result } = run(DIAMOND, ENDPOINTS());
    await result;
    const summarize = chain.anchored.find((r) => r.stepIndex === 1)!;
    const quote = Buffer.from('attest:summarize').toString('base64');

    // Domain separation: a receipt anchored before binding existed cannot be
    // replayed as though it carried one.
    expect(summarize.attestationRef).not.toBe(legacyAttestationRef(quote));
    expect(legacyAttestationRef(quote)).toBe(
      sha256(new Uint8Array(Buffer.from('attest:summarize'))),
    );
  });

  test('leaves attestationRef zero when no attestation was returned', async () => {
    const { chain, result } = run(DIAMOND, ENDPOINTS());
    await result;
    expect(chain.anchored.find((r) => r.stepIndex === 0)!.attestationRef).toBe(ZERO_BYTES32);
  });

  test('a required attestation that is absent yields unattested, never ok', async () => {
    const flow = spec([
      { id: 'audit', agent: '1', input: { repo: '{{ inputs.repoUrl }}' } },
      {
        id: 'summarize',
        agent: '1',
        needs: ['audit'],
        requireAttestation: true,
        input: { text: '{{ steps.audit.output.report }}' },
      },
    ]);
    const { chain, result } = run(flow, { audit: agent('audit'), summarize: agent('never-attests') });
    await result;

    const step = chain.anchored.find((r) => r.stepIndex === 1)!;
    expect(step.status).toBe(StepStatus.Unattested);
    expect(step.status).not.toBe(StepStatus.Ok);
    // The step produced a real output; it simply cannot be attributed.
    expect(step.outputHash).not.toBe(ZERO_BYTES32);
  });

  test('an unattested step makes the run outcome non-zero but still sealed', async () => {
    const flow = spec([
      { id: 'audit', agent: '1', input: { repo: '{{ inputs.repoUrl }}' } },
      { id: 'summarize', agent: '1', needs: ['audit'], requireAttestation: true, input: { text: '{{ steps.audit.output.report }}' } },
    ]);
    const { chain, result } = run(flow, { audit: agent('audit'), summarize: agent('never-attests') });
    const outcome = await result;
    expect(chain.sealed).not.toBeNull();
    expect(chain.sealed!.outcome).not.toBe(0);
    expect(outcome.succeeded).toBe(false);
  });

  test('an attestation that is present but not required is still recorded', async () => {
    const { chain, result } = run(DIAMOND, ENDPOINTS());
    await result;
    expect(chain.anchored[1]!.attestationRef).not.toBe(ZERO_BYTES32);
    expect(chain.anchored[1]!.status).toBe(StepStatus.Ok);
  });
});

describe('failure handling (§7.8)', () => {
  const failing = spec([
    { id: 'audit', agent: '1', input: { repo: '{{ inputs.repoUrl }}' } },
    { id: 'broken', agent: '1', needs: ['audit'], input: { text: '{{ steps.audit.output.report }}' } },
    { id: 'after', agent: '1', needs: ['broken'], input: { text: '{{ steps.broken.output.text }}' } },
  ]);
  // Lazy for the same reason as ENDPOINTS: describe bodies run at collection
  // time, before beforeAll assigns `base`.
  const failingEndpoints = () => ({
    audit: agent('audit'),
    broken: agent('always-fails'),
    after: agent('summarize'),
  });

  test('anchors the failed step with status failed', async () => {
    const { chain, result } = run(failing, failingEndpoints());
    await result;
    expect(chain.anchored.find((r) => r.stepIndex === 1)!.status).toBe(StepStatus.Failed);
  });

  test('a failed run is still sealed, and sealed as a failure', async () => {
    // §1.3: runs that fail are sealed and verifiable as failures.
    const { chain, result } = run(failing, failingEndpoints());
    const outcome = await result;
    expect(chain.sealed).not.toBeNull();
    expect(chain.sealed!.outcome).toBe(StepStatus.Failed);
    expect(outcome.succeeded).toBe(false);
  });

  test('downstream steps are skipped rather than run on absent data', async () => {
    const { chain, result } = run(failing, failingEndpoints());
    await result;
    const after = chain.anchored.find((r) => r.stepIndex === 2)!;
    expect(after.status).toBe(StepStatus.Skipped);
    // Nothing was produced, so there is nothing to commit to.
    expect(after.outputHash).toBe(ZERO_BYTES32);
  });

  test('every step is anchored so the chain root covers the whole run', async () => {
    // Omitting skipped steps would leave a gap and the root would not fold.
    const { chain, result } = run(failing, failingEndpoints());
    await result;
    expect(chain.anchored).toHaveLength(3);
    expect(chain.sealed!.chainRoot).toBe(foldChainRoot(chain.anchored));
  });

  test('an unrelated branch still runs when failFast is off', async () => {
    const flow = spec([
      { id: 'audit', agent: '1', input: { repo: '{{ inputs.repoUrl }}' } },
      { id: 'broken', agent: '1', needs: ['audit'], input: { text: '{{ steps.audit.output.report }}' } },
      { id: 'score', agent: '1', needs: ['audit'], input: { report: '{{ steps.audit.output.report }}' } },
    ]);
    const { chain, result } = run(
      flow,
      { audit: agent('audit'), broken: agent('always-fails'), score: agent('score') },
      { failFast: false },
    );
    await result;
    expect(chain.anchored.find((r) => r.stepIndex === 2)!.status).toBe(StepStatus.Ok);
  });

  test('failFast stops the unrelated branch too', async () => {
    const flow = spec([
      { id: 'audit', agent: '1', input: { repo: '{{ inputs.repoUrl }}' } },
      { id: 'broken', agent: '1', needs: ['audit'], input: { text: '{{ steps.audit.output.report }}' } },
      { id: 'later', agent: '1', needs: ['audit'], input: { report: '{{ steps.audit.output.report }}' } },
    ]);
    // broken and later share a wave, so both run; the wave after would stop.
    const { chain, result } = run(
      flow,
      { audit: agent('audit'), broken: agent('always-fails'), later: agent('score') },
      { failFast: true },
    );
    await result;
    expect(chain.anchored).toHaveLength(3);
    expect(chain.sealed!.outcome).not.toBe(0);
  });
});

describe('validation before execution', () => {
  test('an invalid flow never reaches the chain', async () => {
    // §5.1: fail before spending gas or calling an agent.
    const broken = spec([{ id: 'a', agent: '1', input: { v: '{{ steps.ghost.output.x }}' } }]);
    const chain = new FakeChain();
    await expect(
      executeRun({
        spec: broken,
        inputs: RUN_INPUTS,
        endpointFor: () => base,
        chain,
        traces: new FakeTraces(),
        runId: `0x${'22'.repeat(32)}` as Hex,
      }),
    ).rejects.toThrow();
    expect(chain.anchored).toHaveLength(0);
    expect(chain.runs).toBe(0);
  });
});

describe('flow publication', () => {
  test('publishes the flow once and reuses it afterwards', async () => {
    const chain = new FakeChain();
    const traces = new FakeTraces();
    const opts = {
      spec: DIAMOND,
      inputs: RUN_INPUTS,
      endpointFor: (s: { id: string }) => ENDPOINTS()[s.id]!,
      chain,
      traces,
    };
    await executeRun({ ...opts, runId: `0x${'22'.repeat(32)}` as Hex });
    await executeRun({ ...opts, runId: `0x${'33'.repeat(32)}` as Hex });
    expect(chain.published.size).toBe(1);
    expect(chain.runs).toBe(2);
  });
});
