import { describe, expect, test } from 'vitest';
import { verifyLinkage, type LinkedStep, type StepEvidence } from '../src/linkage.js';
import { hashJson } from '../src/hash.js';
import { type Receipt, StepStatus, ZERO_BYTES32 } from '../src/receipt.js';
import type { JsonValue } from '../src/canonicalize.js';

const FLOW_ID = '0x1111111111111111111111111111111111111111111111111111111111111111';
const RUN_ID = '0x2222222222222222222222222222222222222222222222222222222222222222';
const AGENT = 1n;

/**
 * Builds a run whose receipts are internally consistent with the supplied
 * evidence, so that each test can break exactly one thing and observe that the
 * linkage check catches it.
 */
function buildRun(
  steps: readonly LinkedStep[],
  runInputs: JsonValue,
  outputs: Record<string, JsonValue>,
  overrides: Partial<Record<string, Partial<Receipt>>> = {},
) {
  const evidence: StepEvidence[] = [];
  const receipts: Receipt[] = [];

  steps.forEach((step, stepIndex) => {
    const input = resolveExpected(step, runInputs, outputs);
    const output = outputs[step.id]!;
    evidence.push({ stepId: step.id, input, output });
    receipts.push({
      flowId: FLOW_ID,
      runId: RUN_ID,
      stepIndex,
      agentId: AGENT,
      inputHash: hashJson(input),
      outputHash: hashJson(output),
      traceRoot: '0x' + '55'.repeat(32),
      attestationRef: ZERO_BYTES32,
      startedAt: BigInt(1755600000 + stepIndex),
      endedAt: BigInt(1755600100 + stepIndex),
      status: StepStatus.Ok,
      ...overrides[step.id],
    });
  });

  return { steps, runInputs, evidence, receipts };
}

/** Independent re-implementation of resolution for fixture construction. */
function resolveExpected(
  step: LinkedStep,
  runInputs: JsonValue,
  outputs: Record<string, JsonValue>,
): JsonValue {
  const json = JSON.stringify(step.input, (_k, v: unknown) => {
    if (typeof v !== 'string') return v;
    const m = /^\{\{\s*([^}]+?)\s*\}\}$/.exec(v);
    if (!m) return v;
    const path = m[1]!.split('.');
    if (path[0] === 'inputs') return (runInputs as Record<string, JsonValue>)[path[1]!];
    return (outputs[path[1]!] as Record<string, JsonValue>)[path[3]!];
  });
  return JSON.parse(json) as JsonValue;
}

const LINEAR: LinkedStep[] = [
  { id: 'audit', input: { repo: '{{ inputs.repoUrl }}' } },
  { id: 'summarize', needs: ['audit'], input: { text: '{{ steps.audit.output.report }}' } },
];

const RUN_INPUTS = { repoUrl: 'https://example.test/repo' };
const OUTPUTS = { audit: { report: 'the findings' }, summarize: { text: 'a summary' } };

describe('a well-formed run', () => {
  test('verifies', () => {
    const report = verifyLinkage(buildRun(LINEAR, RUN_INPUTS, OUTPUTS));
    expect(report.ok).toBe(true);
    expect(report.failures).toStrictEqual([]);
  });

  test('records which upstream steps each input derived from', () => {
    const report = verifyLinkage(buildRun(LINEAR, RUN_INPUTS, OUTPUTS));
    expect(report.steps[0]!.derivedFrom).toStrictEqual([]);
    expect(report.steps[1]!.derivedFrom).toStrictEqual(['audit']);
  });

  test('counts inputs that derive from declared upstream outputs', () => {
    const report = verifyLinkage(buildRun(LINEAR, RUN_INPUTS, OUTPUTS));
    expect(report.linkedSteps).toBe(2);
    expect(report.totalSteps).toBe(2);
  });
});

describe('the linkage invariant', () => {
  // §4.1: step n's input must be re-derivable from step k's declared output.
  // These are the cases where a run executed but must not verify.

  test('rejects an upstream output that does not match its receipt', () => {
    const run = buildRun(LINEAR, RUN_INPUTS, OUTPUTS);
    run.evidence[0]!.output = { report: 'tampered after the fact' };
    const report = verifyLinkage(run);
    expect(report.ok).toBe(false);
    expect(report.steps[0]!.outputHashMatches).toBe(false);
  });

  test('rejects a downstream input not derived from the upstream output', () => {
    // The attack this exists to stop: run step 2 on data of the operator's
    // choosing while presenting step 1's genuine receipt alongside it.
    const run = buildRun(LINEAR, RUN_INPUTS, OUTPUTS);
    const forged: JsonValue = { text: 'text the agent never received' };
    run.evidence[1]!.input = forged;
    run.receipts[1] = { ...run.receipts[1]!, inputHash: hashJson(forged) };

    const report = verifyLinkage(run);
    expect(report.ok).toBe(false);
    expect(report.steps[1]!.inputHashMatches).toBe(false);
    expect(report.failures.join(' ')).toMatch(/inputHash/i);
  });

  test('rejects an inputHash that matches nothing in the trace', () => {
    const run = buildRun(LINEAR, RUN_INPUTS, OUTPUTS);
    run.receipts[1] = { ...run.receipts[1]!, inputHash: '0x' + 'ab'.repeat(32) };
    expect(verifyLinkage(run).ok).toBe(false);
  });

  test('rejects a changed run input that the receipts no longer reflect', () => {
    const run = buildRun(LINEAR, RUN_INPUTS, OUTPUTS);
    const report = verifyLinkage({ ...run, runInputs: { repoUrl: 'https://evil.test/repo' } });
    expect(report.ok).toBe(false);
    expect(report.steps[0]!.inputHashMatches).toBe(false);
  });

  test('detects tampering even when both hashes are recomputed consistently', () => {
    // A tamperer who rewrites the trace AND both receipt hashes still fails,
    // because step 2's input no longer derives from step 1's output.
    const run = buildRun(LINEAR, RUN_INPUTS, OUTPUTS);
    const swapped: JsonValue = { report: 'a different report' };
    run.evidence[0]!.output = swapped;
    run.receipts[0] = { ...run.receipts[0]!, outputHash: hashJson(swapped) };

    const report = verifyLinkage(run);
    expect(report.ok).toBe(false);
    expect(report.steps[0]!.outputHashMatches).toBe(true);
    expect(report.steps[1]!.inputHashMatches).toBe(false);
  });
});

describe('parallel branches', () => {
  const parallel: LinkedStep[] = [
    { id: 'audit', input: { repo: '{{ inputs.repoUrl }}' } },
    { id: 'summarize', needs: ['audit'], input: { text: '{{ steps.audit.output.report }}' } },
    { id: 'score', needs: ['audit'], input: { report: '{{ steps.audit.output.report }}' } },
    {
      id: 'publish',
      needs: ['summarize', 'score'],
      input: { body: '{{ steps.summarize.output.text }}', grade: '{{ steps.score.output.value }}' },
    },
  ];
  const outputs = {
    audit: { report: 'the findings' },
    summarize: { text: 'a summary' },
    score: { value: 42 },
    publish: { url: 'https://example.test/published' },
  };

  test('verifies a diamond-shaped run', () => {
    const report = verifyLinkage(buildRun(parallel, RUN_INPUTS, outputs));
    expect(report.ok).toBe(true);
    expect(report.linkedSteps).toBe(4);
  });

  test('reports both upstream sources for the joining step', () => {
    const report = verifyLinkage(buildRun(parallel, RUN_INPUTS, outputs));
    expect(report.steps[3]!.derivedFrom.sort()).toStrictEqual(['score', 'summarize']);
  });

  test('rejects tampering on either branch', () => {
    for (const branch of [1, 2]) {
      const run = buildRun(parallel, RUN_INPUTS, outputs);
      run.evidence[branch]!.output = { spoofed: true };
      expect(verifyLinkage(run).ok).toBe(false);
    }
  });
});

describe('structural validation', () => {
  test('rejects a forward reference', () => {
    const steps: LinkedStep[] = [
      { id: 'first', needs: ['second'], input: { x: '{{ steps.second.output.v }}' } },
      { id: 'second', input: { y: '{{ inputs.repoUrl }}' } },
    ];
    const report = verifyLinkage({
      steps,
      runInputs: RUN_INPUTS,
      evidence: [
        { stepId: 'first', input: { x: 1 }, output: {} },
        { stepId: 'second', input: { y: 'z' }, output: { v: 1 } },
      ],
      receipts: [],
    });
    expect(report.ok).toBe(false);
    expect(report.failures.join(' ')).toMatch(/before|forward|order/i);
  });

  test('rejects an input reading a step it did not declare in needs', () => {
    // An undeclared dependency would let the planner schedule the step before
    // the data it reads exists.
    const steps: LinkedStep[] = [
      { id: 'audit', input: { repo: '{{ inputs.repoUrl }}' } },
      { id: 'summarize', input: { text: '{{ steps.audit.output.report }}' } },
    ];
    const report = verifyLinkage(buildRun(steps, RUN_INPUTS, OUTPUTS));
    expect(report.ok).toBe(false);
    expect(report.failures.join(' ')).toMatch(/needs/i);
  });

  test('rejects a run missing a receipt for a step', () => {
    const run = buildRun(LINEAR, RUN_INPUTS, OUTPUTS);
    expect(verifyLinkage({ ...run, receipts: [run.receipts[0]!] }).ok).toBe(false);
  });

  test('rejects a run missing trace evidence for a step', () => {
    const run = buildRun(LINEAR, RUN_INPUTS, OUTPUTS);
    expect(verifyLinkage({ ...run, evidence: [run.evidence[0]!] }).ok).toBe(false);
  });

  test('rejects a receipt whose stepIndex does not match declaration order', () => {
    const run = buildRun(LINEAR, RUN_INPUTS, OUTPUTS);
    run.receipts[1] = { ...run.receipts[1]!, stepIndex: 5 };
    expect(verifyLinkage(run).ok).toBe(false);
  });
});

describe('status propagation', () => {
  test('rejects a successful step whose upstream did not succeed', () => {
    // §1.3: a step cannot legitimately succeed on data a failed step never
    // produced.
    const run = buildRun(LINEAR, RUN_INPUTS, OUTPUTS, {
      audit: { status: StepStatus.Failed },
    });
    const report = verifyLinkage(run);
    expect(report.ok).toBe(false);
    expect(report.failures.join(' ')).toMatch(/upstream/i);
  });

  test('accepts a failed step whose downstream did not succeed', () => {
    const run = buildRun(LINEAR, RUN_INPUTS, OUTPUTS, {
      audit: { status: StepStatus.Failed },
      summarize: { status: StepStatus.Skipped },
    });
    expect(verifyLinkage(run).ok).toBe(true);
  });

  test('treats an unattested upstream as not succeeded', () => {
    const run = buildRun(LINEAR, RUN_INPUTS, OUTPUTS, {
      audit: { status: StepStatus.Unattested },
    });
    expect(verifyLinkage(run).ok).toBe(false);
  });
});
