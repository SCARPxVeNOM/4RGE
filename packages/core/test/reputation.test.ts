/**
 * An agent's derived record, and the bar a flow can set against it.
 *
 * Two judgements are being pinned, and they are the ones a reputation system
 * usually gets wrong:
 *
 *   a rate with no denominator is not a track record — 100% over one step
 *   must not clear a threshold, or the threshold screens out exactly nobody
 *
 *   "unknown" is not "fine" — an unreadable record fails the bar, because a
 *   policy that treats those alike protects nobody
 */

import { describe, expect, test } from 'vitest';
import {
  computeAgentRecord,
  evaluateReputation,
  successRate,
  EMPTY_RECORD,
} from '../src/reputation.js';
import { StepStatus, type Receipt } from '../src/receipt.js';
import type { Hex } from '../src/hash.js';

const receipt = (over: Partial<Receipt> = {}): Receipt => ({
  flowId: `0x${'11'.repeat(32)}` as Hex,
  runId: `0x${'22'.repeat(32)}` as Hex,
  stepIndex: 0,
  agentId: 7n,
  inputHash: `0x${'33'.repeat(32)}` as Hex,
  outputHash: `0x${'44'.repeat(32)}` as Hex,
  traceRoot: `0x${'55'.repeat(32)}` as Hex,
  attestationRef: `0x${'00'.repeat(32)}` as Hex,
  startedAt: 1_000n,
  endedAt: 1_001n,
  status: StepStatus.Ok,
  ...over,
});

describe('computing a record', () => {
  test('counts each status and the distinct runs and flows', () => {
    const record = computeAgentRecord(7n, [
      receipt({ stepIndex: 0, status: StepStatus.Ok }),
      receipt({ stepIndex: 1, status: StepStatus.Failed }),
      receipt({ stepIndex: 2, status: StepStatus.Unattested }),
      receipt({ stepIndex: 3, status: StepStatus.Skipped }),
      receipt({ runId: `0x${'99'.repeat(32)}` as Hex, flowId: `0x${'88'.repeat(32)}` as Hex }),
    ]);

    expect(record).toMatchObject({
      agentId: 7n,
      steps: 5,
      ok: 2,
      failed: 1,
      unattested: 1,
      skipped: 1,
      runs: 2,
      flows: 2,
    });
  });

  /// The natural call is "every receipt of a run"; making the caller filter
  /// first would move the same loop somewhere with less context.
  test('ignores receipts for other agents', () => {
    const record = computeAgentRecord(7n, [receipt(), receipt({ agentId: 8n })]);
    expect(record.steps).toBe(1);
  });

  test('tracks the first and last time it was seen', () => {
    const record = computeAgentRecord(7n, [
      receipt({ startedAt: 500n }),
      receipt({ startedAt: 2_000n }),
      receipt({ startedAt: 1_000n }),
    ]);
    expect(record.firstSeenAt).toBe(500n);
    expect(record.lastSeenAt).toBe(2_000n);
  });

  test('an agent with no receipts has an empty record, not a missing one', () => {
    expect(computeAgentRecord(7n, [])).toEqual(EMPTY_RECORD(7n));
  });
});

describe('the success rate', () => {
  /// A step skipped because an upstream one failed says nothing about this
  /// agent. Counting it would let one bad agent drag down everyone
  /// downstream of it.
  test('excludes skipped steps from the denominator', () => {
    const record = computeAgentRecord(7n, [
      receipt({ stepIndex: 0, status: StepStatus.Ok }),
      receipt({ stepIndex: 1, status: StepStatus.Skipped }),
      receipt({ stepIndex: 2, status: StepStatus.Skipped }),
    ]);
    expect(successRate(record)).toBe(1);
  });

  test('counts unattested against the agent', () => {
    // A step that ran but could not be proven is not a success (§1.3).
    const record = computeAgentRecord(7n, [
      receipt({ stepIndex: 0, status: StepStatus.Ok }),
      receipt({ stepIndex: 1, status: StepStatus.Unattested }),
    ]);
    expect(successRate(record)).toBe(0.5);
  });

  /// Null is not zero. An agent that has never run has no rate, and reporting
  /// 0% for it would be a claim nobody made.
  test('is null when nothing was attempted', () => {
    expect(successRate(EMPTY_RECORD(7n))).toBeNull();
    expect(
      successRate(computeAgentRecord(7n, [receipt({ status: StepStatus.Skipped })])),
    ).toBeNull();
  });
});

describe('evaluating against a flow’s bar', () => {
  const good = computeAgentRecord(
    7n,
    Array.from({ length: 20 }, (_, i) => receipt({ stepIndex: i })),
  );
  const mixed = computeAgentRecord(
    7n,
    Array.from({ length: 20 }, (_, i) =>
      receipt({ stepIndex: i, status: i < 15 ? StepStatus.Ok : StepStatus.Failed }),
    ),
  );

  test('a flow that asks for nothing accepts anything', () => {
    expect(evaluateReputation(null, null, {}).meets).toBe(true);
    expect(evaluateReputation(null, null, { minReputation: 0 }).meets).toBe(true);
  });

  test('a good record clears a threshold', () => {
    expect(evaluateReputation(good, null, { minReputation: 0.9 }).meets).toBe(true);
  });

  test('a poor record does not, and the reason carries the numbers', () => {
    const verdict = evaluateReputation(mixed, null, { minReputation: 0.9 });
    expect(verdict.meets).toBe(false);
    expect(verdict.reason).toMatch(/15\/20 attempted steps \(75\.0%\), below the 90\.0%/);
  });

  /// The judgement this whole module exists to make. Without a floor on the
  /// sample, every brand-new agent clears every bar — precisely the agent a
  /// threshold was meant to screen out.
  test('a perfect record over too few steps does NOT clear a threshold', () => {
    const fresh = computeAgentRecord(7n, [receipt()]);
    expect(successRate(fresh)).toBe(1);

    const verdict = evaluateReputation(fresh, null, { minReputation: 0.9 });
    expect(verdict.meets).toBe(false);
    expect(verdict.reason).toMatch(/too few to judge/);
  });

  test('the sample floor is the flow’s to choose', () => {
    const fresh = computeAgentRecord(7n, [receipt()]);
    expect(evaluateReputation(fresh, null, { minReputation: 0.9, minSteps: 1 }).meets).toBe(true);
  });

  /// "I could not establish this" and "this is fine" are different answers.
  test('an unreadable record fails the bar rather than passing it', () => {
    const verdict = evaluateReputation(null, null, { minReputation: 0.9 });
    expect(verdict.meets).toBe(false);
    expect(verdict.reason).toMatch(/could not be read/);
  });

  describe('stake', () => {
    test('a sufficient bond clears the bar', () => {
      expect(evaluateReputation(null, 10n, { minStake: 5n }).meets).toBe(true);
    });

    test('an insufficient bond does not', () => {
      const verdict = evaluateReputation(null, 1n, { minStake: 5n });
      expect(verdict.meets).toBe(false);
      expect(verdict.reason).toMatch(/bonded 1 wei, below the 5 wei/);
    });

    test('an unreadable stake fails rather than passes', () => {
      expect(evaluateReputation(null, null, { minStake: 5n }).meets).toBe(false);
    });

    test('both bars must be cleared', () => {
      expect(evaluateReputation(good, 1n, { minReputation: 0.9, minStake: 5n }).meets).toBe(false);
      expect(evaluateReputation(mixed, 10n, { minReputation: 0.9, minStake: 5n }).meets).toBe(false);
      expect(evaluateReputation(good, 10n, { minReputation: 0.9, minStake: 5n }).meets).toBe(true);
    });
  });
});
