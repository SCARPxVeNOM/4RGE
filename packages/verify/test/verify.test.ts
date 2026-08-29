import { describe, expect, test } from 'vitest';
import { canonicalize, hashJson, hashReceipt, foldChainRoot, StepStatus, ZERO_BYTES32, type Hex, type JsonValue, type Receipt } from '@0gflow/core';
import { verifyRun } from '../src/verify.js';
import { STEP_ANCHORED_TOPIC, RUN_SEALED_TOPIC, type RawLog } from '../src/decode.js';
import type { ChainSource, FetchedTrace, TraceSource } from '../src/sources.js';

/**
 * The verification procedure (§9) exercised offline against constructed
 * evidence, so every failure mode can be provoked deliberately.
 *
 * The verdict rules under test are the ones that matter for §1.3: the verifier
 * must never report VERIFIED for evidence it did not actually check.
 */

const RUN_ID = `0x${'22'.repeat(32)}` as Hex;
const FLOW_ID = `0x${'11'.repeat(32)}` as Hex;
const REGISTRY = '0x7177a6867296406881e20d6647232314736dd09a' as Hex;

const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');
const bare = (h: string) => h.replace(/^0x/, '');

/** Encodes a receipt the way the contract does, so the decoder is exercised. */
function encodeStepAnchoredLog(r: Receipt, txHash: string, blockNumber: number, logIndex: number): RawLog {
  return {
    address: '0x741a36faba40ee71223539a5a062fdedc8574e30',
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
    transactionHash: txHash,
    logIndex: `0x${logIndex.toString(16)}`,
  };
}

function encodeRunSealedLog(runId: Hex, chainRoot: Hex, stepCount: number, outcome: number): RawLog {
  return {
    address: '0x741a36faba40ee71223539a5a062fdedc8574e30',
    topics: [RUN_SEALED_TOPIC, runId],
    data: '0x' + bare(chainRoot) + word(stepCount) + word(outcome),
    blockNumber: '0x1',
    transactionHash: `0x${'ee'.repeat(32)}`,
    logIndex: '0x0',
  };
}

// A two-step run where step 1's input is step 0's output.
const INPUTS: JsonValue = { repoUrl: 'https://example.test/repo' };
const OUT_0: JsonValue = { report: 'the findings' };
const OUT_1: JsonValue = { text: 'a summary' };
const IN_0: JsonValue = { repo: 'https://example.test/repo' };
const IN_1: JsonValue = { text: 'the findings' };

const SPEC = {
  steps: [
    { id: 'audit', input: { repo: '{{ inputs.repoUrl }}' } },
    { id: 'summarize', needs: ['audit'], input: { text: '{{ steps.audit.output.report }}' } },
  ],
  inputs: INPUTS,
};

function trace(stepId: string, stepIndex: number, input: JsonValue, output: JsonValue): JsonValue {
  return { version: '0gflow/1', runId: RUN_ID, stepIndex, stepId, agent: '1', input, output };
}

const TRACES: JsonValue[] = [trace('audit', 0, IN_0, OUT_0), trace('summarize', 1, IN_1, OUT_1)];
const TRACE_ROOTS = TRACES.map((t) => hashJson(t)) as Hex[];

function buildReceipts(): Receipt[] {
  return [
    {
      flowId: FLOW_ID, runId: RUN_ID, stepIndex: 0, agentId: 1n,
      inputHash: hashJson(IN_0), outputHash: hashJson(OUT_0), traceRoot: TRACE_ROOTS[0]!,
      attestationRef: ZERO_BYTES32, startedAt: 100n, endedAt: 101n, status: StepStatus.Ok,
    },
    {
      flowId: FLOW_ID, runId: RUN_ID, stepIndex: 1, agentId: 1n,
      inputHash: hashJson(IN_1), outputHash: hashJson(OUT_1), traceRoot: TRACE_ROOTS[1]!,
      attestationRef: ZERO_BYTES32, startedAt: 102n, endedAt: 103n, status: StepStatus.Ok,
    },
  ];
}

class FakeChain implements ChainSource {
  constructor(
    private readonly stepLogs: RawLog[],
    private readonly sealLogs: RawLog[],
    private readonly owners: Map<string, Hex> = new Map([['1', '0x00000000000000000000000000000000000000aa' as Hex]]),
  ) {}
  async getStepAnchoredLogs() { return this.stepLogs; }
  async getRunSealedLogs() { return this.sealLogs; }
  async ownerOf(_registry: Hex, agentId: bigint) { return this.owners.get(agentId.toString()) ?? null; }
}

class FakeTraces implements TraceSource {
  readonly describe = 'fake';
  constructor(
    private readonly byRoot: Map<string, JsonValue>,
    private readonly origin: 'storage' | 'local' = 'storage',
  ) {}
  async fetch(root: Hex): Promise<FetchedTrace | null> {
    const found = this.byRoot.get(root.toLowerCase());
    if (found === undefined) return null;
    return {
      bytes: new TextEncoder().encode(canonicalize(found)),
      origin: this.origin,
      inclusionProofVerified: this.origin === 'storage',
    };
  }
}

function scenario(overrides: { receipts?: Receipt[]; traces?: Map<string, JsonValue>; origin?: 'storage' | 'local'; seal?: RawLog[] } = {}) {
  const receipts = overrides.receipts ?? buildReceipts();
  const chainRoot = foldChainRoot(receipts) as Hex;
  const stepLogs = receipts.map((r, i) => encodeStepAnchoredLog(r, `0x${(i + 1).toString(16).padStart(64, '0')}`, 10 + i, i));
  const sealLogs = overrides.seal ?? [encodeRunSealedLog(RUN_ID, chainRoot, receipts.length, 0)];
  const traceMap = overrides.traces ?? new Map(receipts.map((r, i) => [r.traceRoot.toLowerCase(), TRACES[i]!]));
  return {
    runId: RUN_ID,
    chain: new FakeChain(stepLogs, sealLogs),
    traces: new FakeTraces(traceMap, overrides.origin ?? 'storage'),
    identityRegistries: [{ address: REGISTRY, standard: 'ERC-8004' }],
    spec: SPEC,
  };
}

describe('a well-formed run', () => {
  test('verifies', async () => {
    const report = await verifyRun(scenario());
    expect(report.failures).toStrictEqual([]);
    expect(report.verdict).toBe('verified');
  });

  test('reports the chain root and the sealed root as equal', async () => {
    const report = await verifyRun(scenario());
    expect(report.computedChainRoot).toBe(report.sealedChainRoot);
  });

  test('confirms linkage across the two steps', async () => {
    const report = await verifyRun(scenario());
    expect(report.linkage?.ok).toBe(true);
    expect(report.linkage?.linkedSteps).toBe(2);
  });

  test('resolves each agent against the identity registry', async () => {
    const report = await verifyRun(scenario());
    expect(report.steps.every((s) => s.identityResolved === true)).toBe(true);
  });
});

describe('failures (§9 exit non-zero)', () => {
  test('a chain root that does not match the seal fails', async () => {
    const wrongSeal = [encodeRunSealedLog(RUN_ID, `0x${'99'.repeat(32)}` as Hex, 2, 0)];
    const report = await verifyRun(scenario({ seal: wrongSeal }));
    expect(report.verdict).toBe('failed');
    expect(report.failures.join(' ')).toMatch(/chain root/i);
  });

  test('a trace whose output does not match outputHash fails', async () => {
    const tampered = new Map([
      [TRACE_ROOTS[0]!.toLowerCase(), trace('audit', 0, IN_0, { report: 'tampered' })],
      [TRACE_ROOTS[1]!.toLowerCase(), TRACES[1]!],
    ]);
    const report = await verifyRun(scenario({ traces: tampered }));
    expect(report.verdict).toBe('failed');
    expect(report.failures.join(' ')).toMatch(/outputHash/i);
  });

  test('a trace whose input does not match inputHash fails', async () => {
    const tampered = new Map([
      [TRACE_ROOTS[0]!.toLowerCase(), trace('audit', 0, { repo: 'https://evil.test' }, OUT_0)],
      [TRACE_ROOTS[1]!.toLowerCase(), TRACES[1]!],
    ]);
    const report = await verifyRun(scenario({ traces: tampered }));
    expect(report.verdict).toBe('failed');
    expect(report.failures.join(' ')).toMatch(/inputHash/i);
  });

  test('a broken linkage fails even when every hash is internally consistent', async () => {
    // The §4.1 case: rewrite step 0's output and its receipt hash so the step
    // checks out on its own, but step 1's input no longer derives from it.
    const receipts = buildReceipts();
    const newOut: JsonValue = { report: 'a different report' };
    const newTrace = trace('audit', 0, IN_0, newOut);
    const newRoot = hashJson(newTrace) as Hex;
    receipts[0] = { ...receipts[0]!, outputHash: hashJson(newOut), traceRoot: newRoot };

    const traces = new Map([
      [newRoot.toLowerCase(), newTrace],
      [TRACE_ROOTS[1]!.toLowerCase(), TRACES[1]!],
    ]);
    const report = await verifyRun(scenario({ receipts, traces }));
    expect(report.verdict).toBe('failed');
    expect(report.steps[0]!.hashesMatch).toBe(true);
    expect(report.linkage?.ok).toBe(false);
  });

  test('a seal claiming a different step count fails', async () => {
    const receipts = buildReceipts();
    const seal = [encodeRunSealedLog(RUN_ID, foldChainRoot(receipts) as Hex, 5, 0)];
    const report = await verifyRun(scenario({ seal }));
    expect(report.verdict).toBe('failed');
    expect(report.failures.join(' ')).toMatch(/step count/i);
  });

  test('a run with no anchored receipts fails rather than verifying vacuously', async () => {
    const report = await verifyRun({ ...scenario(), chain: new FakeChain([], []) });
    expect(report.verdict).toBe('failed');
    expect(report.failures.join(' ')).toMatch(/no .*receipt|not found/i);
  });

  test('an attestationRef that does not match the stored attestation fails', async () => {
    const receipts = buildReceipts();
    const attested = { ...TRACES[0]! as object, attestation: Buffer.from('quote-bytes').toString('base64') } as JsonValue;
    const root = hashJson(attested) as Hex;
    receipts[0] = { ...receipts[0]!, traceRoot: root, attestationRef: `0x${'ab'.repeat(32)}` as Hex };
    const traces = new Map([
      [root.toLowerCase(), attested],
      [TRACE_ROOTS[1]!.toLowerCase(), TRACES[1]!],
    ]);
    const report = await verifyRun(scenario({ receipts, traces }));
    expect(report.verdict).toBe('failed');
    expect(report.failures.join(' ')).toMatch(/attestation/i);
  });
});

describe('incomplete (evidence not obtainable)', () => {
  // §1.3: absence of evidence is never reported as success.
  test('an unfetchable trace yields incomplete, not verified', async () => {
    const report = await verifyRun(scenario({ traces: new Map() }));
    expect(report.verdict).toBe('incomplete');
    expect(report.failures).toStrictEqual([]);
    expect(report.incomplete.join(' ')).toMatch(/trace/i);
  });

  test('a locally sourced trace never yields verified', async () => {
    // A local file proves nothing about third-party retrievability.
    const report = await verifyRun(scenario({ origin: 'local' }));
    expect(report.verdict).toBe('incomplete');
    expect(report.incomplete.join(' ')).toMatch(/retriev|local|inclusion/i);
  });

  test('an unsealed run yields incomplete', async () => {
    const report = await verifyRun(scenario({ seal: [] }));
    expect(report.verdict).toBe('incomplete');
    expect(report.incomplete.join(' ')).toMatch(/seal/i);
  });

  test('a missing spec leaves linkage unchecked and yields incomplete', async () => {
    const report = await verifyRun({ ...scenario(), spec: null });
    expect(report.verdict).toBe('incomplete');
    expect(report.linkage).toBeNull();
    expect(report.incomplete.join(' ')).toMatch(/linkage|spec/i);
  });

  test('failure outranks incompleteness', async () => {
    // A run that both fails a check and lacks evidence is FAILED, so a broken
    // run cannot hide behind missing data.
    const wrongSeal = [encodeRunSealedLog(RUN_ID, `0x${'99'.repeat(32)}` as Hex, 2, 0)];
    const report = await verifyRun({ ...scenario({ seal: wrongSeal, traces: new Map() }) });
    expect(report.verdict).toBe('failed');
  });
});

describe('a failed run verifies AS a failure', () => {
  // §1.3: "Runs that fail are sealed and verifiable as failures." A failed
  // run that fails *verification* would be indistinguishable from a tampered
  // one, and the whole point is that the two are different.

  test('a failed step committing to no output does not fail verification', () => {
    const receipts = buildReceipts();
    receipts[1] = { ...receipts[1]!, status: StepStatus.Failed, outputHash: ZERO_BYTES32 };
    const traces = new Map([
      [TRACE_ROOTS[0]!.toLowerCase(), TRACES[0]!],
      [TRACE_ROOTS[1]!.toLowerCase(), trace('summarize', 1, IN_1, {})],
    ]);
    return verifyRun(scenario({ receipts, traces })).then((report) => {
      expect(report.failures).toStrictEqual([]);
      expect(report.verdict).toBe('verified');
      expect(report.runSucceeded).toBe(false);
    });
  });

  test('a skipped step committing to nothing does not fail verification', async () => {
    const receipts = buildReceipts();
    receipts[1] = {
      ...receipts[1]!,
      status: StepStatus.Skipped,
      inputHash: ZERO_BYTES32,
      outputHash: ZERO_BYTES32,
    };
    const traces = new Map([
      [TRACE_ROOTS[0]!.toLowerCase(), TRACES[0]!],
      [TRACE_ROOTS[1]!.toLowerCase(), trace('summarize', 1, {}, {})],
    ]);
    const report = await verifyRun(scenario({ receipts, traces }));
    expect(report.failures).toStrictEqual([]);
    expect(report.runSucceeded).toBe(false);
  });

  test('an ok step may not commit to nothing', async () => {
    // Keeps the exemption honest: zero is only allowed where the status
    // explains it, otherwise a step could pass by committing to nothing.
    const receipts = buildReceipts();
    receipts[1] = { ...receipts[1]!, outputHash: ZERO_BYTES32 };
    const traces = new Map([
      [TRACE_ROOTS[0]!.toLowerCase(), TRACES[0]!],
      [TRACE_ROOTS[1]!.toLowerCase(), trace('summarize', 1, IN_1, {})],
    ]);
    const report = await verifyRun(scenario({ receipts, traces }));
    expect(report.verdict).toBe('failed');
    expect(report.failures.join(' ')).toMatch(/commit/i);
  });

  test('a tampered failed run is still caught', async () => {
    // The exemption must not become a hiding place: a failed step that DOES
    // commit to an output is still held to it.
    const receipts = buildReceipts();
    receipts[1] = { ...receipts[1]!, status: StepStatus.Failed };
    const traces = new Map([
      [TRACE_ROOTS[0]!.toLowerCase(), TRACES[0]!],
      [TRACE_ROOTS[1]!.toLowerCase(), trace('summarize', 1, IN_1, { text: 'tampered' })],
    ]);
    const report = await verifyRun(scenario({ receipts, traces }));
    expect(report.verdict).toBe('failed');
  });
});

describe('status reporting', () => {
  test('an unattested step is reported as such and is not a success', async () => {
    const receipts = buildReceipts();
    receipts[1] = { ...receipts[1]!, status: StepStatus.Unattested };
    const report = await verifyRun(scenario({ receipts }));
    expect(report.steps[1]!.status).toBe(StepStatus.Unattested);
    expect(report.runSucceeded).toBe(false);
  });

  test('a failed run is reported as a verifiable failure, not an error', async () => {
    // §1.3: runs that fail are sealed and verifiable as failures.
    const receipts = buildReceipts();
    receipts[1] = { ...receipts[1]!, status: StepStatus.Failed };
    const seal = [encodeRunSealedLog(RUN_ID, foldChainRoot(receipts) as Hex, 2, 1)];
    const report = await verifyRun(scenario({ receipts, seal }));
    expect(report.sealedOutcome).toBe(1);
    expect(report.runSucceeded).toBe(false);
    // The evidence itself is intact, so this is not a verification failure.
    expect(report.failures.filter((f) => /chain root|hash/i.test(f))).toStrictEqual([]);
  });

  test('an unregistered agent is flagged', async () => {
    const chain = new FakeChain(
      buildReceipts().map((r, i) => encodeStepAnchoredLog(r, `0x${(i + 1).toString(16).padStart(64, '0')}`, 10 + i, i)),
      [encodeRunSealedLog(RUN_ID, foldChainRoot(buildReceipts()) as Hex, 2, 0)],
      new Map(),
    );
    const report = await verifyRun({ ...scenario(), chain });
    expect(report.steps.every((s) => s.identityResolved === false)).toBe(true);
    expect(report.verdict).toBe('failed');
  });
});

describe('receipt hashes', () => {
  test('each step reports the receipt hash that was anchored', async () => {
    const report = await verifyRun(scenario());
    const receipts = buildReceipts();
    expect(report.steps[0]!.receiptHash).toBe(hashReceipt(receipts[0]!));
  });
});
