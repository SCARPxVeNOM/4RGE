import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideStepStatus,
  reportStepOutcome,
  reportRunOutcome,
  isSuccess,
  isRunSuccess,
  OutcomeError,
  type AnchoredArtifact,
} from '../src/outcome.js';
import { hashReceipt, type Receipt, StepStatus, ZERO_BYTES32 } from '../src/receipt.js';
import { foldChainRoot } from '../src/chain-root.js';

/**
 * §10.3 — THE INVARIANT TEST.
 *
 * "No status reports success unless a third party can independently confirm it
 * from public data."
 *
 * This file exists to make that structural rather than conventional. It is
 * written before the executor, API and CLI so that they are built against it:
 * the only way to obtain a success value anywhere in this codebase is to hand
 * over an on-chain artifact that matches the receipt. Retrofitting this later
 * would mean rewriting status handling everywhere.
 *
 * A failure here is never fixed by relaxing the test.
 */

const RUN_ID = '0x2222222222222222222222222222222222222222222222222222222222222222';

const receipt: Receipt = {
  flowId: '0x1111111111111111111111111111111111111111111111111111111111111111',
  runId: RUN_ID,
  stepIndex: 0,
  agentId: 1n,
  inputHash: '0x' + '33'.repeat(32),
  outputHash: '0x' + '44'.repeat(32),
  traceRoot: '0x' + '55'.repeat(32),
  attestationRef: ZERO_BYTES32,
  startedAt: 1755600000n,
  endedAt: 1755600100n,
  status: StepStatus.Ok,
};

const anchor: AnchoredArtifact = {
  txHash: '0x' + 'ab'.repeat(32),
  blockNumber: 1234n,
  logIndex: 0,
  runId: RUN_ID,
  stepIndex: 0,
  receiptHash: hashReceipt(receipt),
};

describe('success is unreachable without an on-chain artifact', () => {
  test('an anchored ok receipt reports success', () => {
    const outcome = reportStepOutcome(receipt, anchor);
    expect(outcome.kind).toBe('success');
    expect(isSuccess(outcome)).toBe(true);
  });

  test('an ok receipt with no anchor does not report success', () => {
    const outcome = reportStepOutcome(receipt, null);
    expect(outcome.kind).toBe('unanchored');
    expect(isSuccess(outcome)).toBe(false);
  });

  test('an anchor for a different receipt does not report success', () => {
    // Presenting someone else's transaction as evidence for this step.
    const wrong = { ...anchor, receiptHash: '0x' + 'cd'.repeat(32) };
    expect(() => reportStepOutcome(receipt, wrong)).toThrow(OutcomeError);
  });

  test('an anchor for a different run or step does not report success', () => {
    expect(() => reportStepOutcome(receipt, { ...anchor, runId: '0x' + '99'.repeat(32) })).toThrow(
      OutcomeError,
    );
    expect(() => reportStepOutcome(receipt, { ...anchor, stepIndex: 1 })).toThrow(OutcomeError);
  });

  test('no non-ok status can report success even when anchored', () => {
    for (const status of [StepStatus.Failed, StepStatus.Skipped, StepStatus.Unattested]) {
      const r = { ...receipt, status };
      const outcome = reportStepOutcome(r, { ...anchor, receiptHash: hashReceipt(r) });
      expect(isSuccess(outcome)).toBe(false);
      expect(outcome.kind).not.toBe('success');
    }
  });
});

describe('unattested is never ok', () => {
  // §1.3 / §7.7: a step that required an attestation and did not get one is
  // recorded unattested, never ok.
  test('a required attestation that is absent yields Unattested', () => {
    expect(
      decideStepStatus({ requireAttestation: true, attestationPresent: false }),
    ).toBe(StepStatus.Unattested);
  });

  test('a required attestation that is present yields Ok', () => {
    expect(decideStepStatus({ requireAttestation: true, attestationPresent: true })).toBe(
      StepStatus.Ok,
    );
  });

  test('an absent attestation that was not required yields Ok', () => {
    expect(decideStepStatus({ requireAttestation: false, attestationPresent: false })).toBe(
      StepStatus.Ok,
    );
  });

  test('an error outranks a present attestation', () => {
    expect(
      decideStepStatus({ requireAttestation: true, attestationPresent: true, error: 'boom' }),
    ).toBe(StepStatus.Failed);
  });

  test('a skipped step is never ok', () => {
    expect(
      decideStepStatus({ requireAttestation: false, attestationPresent: true, skipped: 'policy' }),
    ).toBe(StepStatus.Skipped);
  });

  test('a missing attestation cannot be overridden into ok by any input', () => {
    // Exhaustive over the decision inputs: no combination with a required and
    // absent attestation may produce Ok.
    for (const error of [undefined, 'boom']) {
      for (const skipped of [undefined, 'policy']) {
        const status = decideStepStatus({
          requireAttestation: true,
          attestationPresent: false,
          ...(error === undefined ? {} : { error }),
          ...(skipped === undefined ? {} : { skipped }),
        });
        expect(status).not.toBe(StepStatus.Ok);
      }
    }
  });
});

describe('a run reports success only when sealed on chain', () => {
  const stepA: Receipt = { ...receipt, stepIndex: 0 };
  const stepB: Receipt = { ...receipt, stepIndex: 1, inputHash: '0x' + '66'.repeat(32) };
  const anchorFor = (r: Receipt): AnchoredArtifact => ({
    ...anchor,
    stepIndex: r.stepIndex,
    receiptHash: hashReceipt(r),
  });
  const chainRoot = foldChainRoot([stepA, stepB]);
  const seal = {
    txHash: '0x' + 'ef'.repeat(32),
    blockNumber: 1300n,
    runId: RUN_ID,
    chainRoot,
    stepCount: 2,
  };
  const steps = [
    reportStepOutcome(stepA, anchorFor(stepA)),
    reportStepOutcome(stepB, anchorFor(stepB)),
  ];

  test('all steps anchored and the run sealed reports success', () => {
    const outcome = reportRunOutcome({ runId: RUN_ID, steps, seal, receipts: [stepA, stepB] });
    expect(isRunSuccess(outcome)).toBe(true);
  });

  test('an unsealed run does not report success', () => {
    const outcome = reportRunOutcome({
      runId: RUN_ID,
      steps,
      seal: null,
      receipts: [stepA, stepB],
    });
    expect(isRunSuccess(outcome)).toBe(false);
    expect(outcome.kind).toBe('unsealed');
  });

  test('a seal whose chainRoot does not match the receipts is rejected', () => {
    expect(() =>
      reportRunOutcome({
        runId: RUN_ID,
        steps,
        seal: { ...seal, chainRoot: '0x' + '00'.repeat(32) },
        receipts: [stepA, stepB],
      }),
    ).toThrow(OutcomeError);
  });

  test('a seal claiming a different step count is rejected', () => {
    expect(() =>
      reportRunOutcome({ runId: RUN_ID, steps, seal: { ...seal, stepCount: 3 }, receipts: [stepA, stepB] }),
    ).toThrow(OutcomeError);
  });

  test('one unanchored step prevents run success', () => {
    const outcome = reportRunOutcome({
      runId: RUN_ID,
      steps: [steps[0]!, reportStepOutcome(stepB, null)],
      seal,
      receipts: [stepA, stepB],
    });
    expect(isRunSuccess(outcome)).toBe(false);
  });

  test('a failed run is still sealed and still verifiable as a failure', () => {
    // §1.3: runs that fail are sealed and verifiable as failures. A failed run
    // is a valid object, it is just not a success.
    const failed: Receipt = { ...stepB, status: StepStatus.Failed };
    const failedSteps = [steps[0]!, reportStepOutcome(failed, anchorFor(failed))];
    const outcome = reportRunOutcome({
      runId: RUN_ID,
      steps: failedSteps,
      seal: { ...seal, chainRoot: foldChainRoot([stepA, failed]) },
      receipts: [stepA, failed],
    });
    expect(isRunSuccess(outcome)).toBe(false);
    expect(outcome.kind).toBe('failure');
    expect(outcome.sealed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Structural enforcement
// ---------------------------------------------------------------------------

const SRC_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', 'out', 'cache', 'lib'].includes(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe('structural enforcement across the codebase', () => {
  // These scans are what stop the invariant from decaying as the executor,
  // API, indexer and CLI get built on top of core.

  test('only outcome.ts may construct a success value', () => {
    const offenders = sourceFiles(join(SRC_ROOT, 'packages'))
      .filter((f) => !f.endsWith(join('core', 'src', 'outcome.ts')))
      .filter((f) => /kind:\s*['"]success['"]/.test(readFileSync(f, 'utf8')));
    expect(offenders, 'construct success through reportStepOutcome instead').toStrictEqual([]);
  });

  test('only outcome.ts may produce an Ok status', () => {
    // Comparing against Ok is fine and necessary; *producing* one outside
    // decideStepStatus is how the attestation rule gets bypassed. This matches
    // assignment, return and object-literal forms while permitting `===`.
    const producesOk =
      /(status:\s*StepStatus\.Ok)|((?<![=!<>])=\s*StepStatus\.Ok)|(return\s+StepStatus\.Ok)/;
    const offenders = sourceFiles(join(SRC_ROOT, 'packages'))
      .filter((f) => !f.endsWith(join('core', 'src', 'outcome.ts')))
      .filter((f) => producesOk.test(readFileSync(f, 'utf8')));
    expect(offenders, 'derive status via decideStepStatus instead').toStrictEqual([]);
  });

  test('only outcome.ts decides whether a status counts as succeeding', () => {
    // A local `status === StepStatus.Ok` predicate elsewhere would quietly
    // fork the definition of success — most dangerously by treating
    // Unattested as fine.
    const offenders = sourceFiles(join(SRC_ROOT, 'packages'))
      .filter((f) => !f.endsWith(join('core', 'src', 'outcome.ts')))
      .filter((f) => /[=!]==\s*StepStatus\.Ok\b/.test(readFileSync(f, 'utf8')));
    expect(offenders, 'use statusSucceeded() from outcome.ts instead').toStrictEqual([]);
  });

  test('no source file hardcodes a zero status literal into a receipt', () => {
    const offenders = sourceFiles(join(SRC_ROOT, 'packages'))
      .filter((f) => !f.endsWith(join('core', 'src', 'outcome.ts')))
      .filter((f) => /status:\s*0\b/.test(readFileSync(f, 'utf8')));
    expect(offenders, 'use StepStatus via decideStepStatus instead of a literal').toStrictEqual([]);
  });
});
