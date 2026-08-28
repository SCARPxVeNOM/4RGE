/**
 * Outcome reporting — spec §1.3, §7, §10.3.
 *
 * THE DESIGN INVARIANT LIVES HERE:
 *
 *   No status reports success unless a third party can independently confirm
 *   it from public data.
 *
 * This module is the only place in the codebase permitted to construct a
 * success value, and the only way to obtain one is to hand over an on-chain
 * artifact that matches the receipt it claims to anchor. Every other package —
 * executor, API, indexer, explorer, CLI — must route through `isSuccess` and
 * `isRunSuccess` rather than inspecting `status` directly.
 *
 * The test in `test/invariant-success-requires-anchor.test.ts` enforces this
 * structurally, including a scan of the source tree. If that test fails, the
 * fix is in the calling code, never in the test.
 */

import { meetsBinding, type BindingLevel } from './attestation.js';
import { foldChainRoot } from './chain-root.js';
import type { Hex } from './hash.js';
import { hashReceipt, StepStatus, type Receipt } from './receipt.js';

export class OutcomeError extends Error {
  override readonly name = 'OutcomeError';
}

/** Evidence that a receipt exists in a log on 0G Chain. */
export interface AnchoredArtifact {
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly logIndex: number;
  readonly runId: Hex;
  readonly stepIndex: number;
  /** keccak256(abi.encode(receipt)) as anchored. */
  readonly receiptHash: Hex;
}

/** Evidence that a run was sealed on 0G Chain. */
export interface SealArtifact {
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly runId: Hex;
  readonly chainRoot: Hex;
  readonly stepCount: number;
}

export type StepOutcome =
  | { readonly kind: 'success'; readonly receipt: Receipt; readonly anchor: AnchoredArtifact }
  | { readonly kind: 'unanchored'; readonly receipt: Receipt; readonly reason: string }
  | { readonly kind: 'failed'; readonly receipt: Receipt; readonly anchor: AnchoredArtifact | null }
  | { readonly kind: 'skipped'; readonly receipt: Receipt; readonly anchor: AnchoredArtifact | null }
  | {
      readonly kind: 'unattested';
      readonly receipt: Receipt;
      readonly anchor: AnchoredArtifact | null;
    };

export type RunOutcome =
  | {
      readonly kind: 'success';
      readonly runId: Hex;
      readonly sealed: true;
      readonly seal: SealArtifact;
      readonly steps: readonly StepOutcome[];
    }
  | {
      readonly kind: 'failure';
      readonly runId: Hex;
      readonly sealed: boolean;
      readonly seal: SealArtifact | null;
      readonly steps: readonly StepOutcome[];
      readonly reason: string;
    }
  | {
      readonly kind: 'unsealed';
      readonly runId: Hex;
      readonly sealed: false;
      readonly seal: null;
      readonly steps: readonly StepOutcome[];
      readonly reason: string;
    };

export interface StatusDecision {
  readonly requireAttestation: boolean;
  readonly attestationPresent: boolean;
  /**
   * How much the attestation actually establishes. Omitted means the caller
   * did not evaluate binding, which is treated as `present` when an
   * attestation exists — the weakest honest reading.
   */
  readonly bindingLevel?: BindingLevel;
  /**
   * The binding a step demands. Defaults to `present`, preserving the original
   * behaviour: an attestation only has to exist.
   *
   * A flow that sets `bound` is asking for the one level that means the
   * attested key signed *this output*. See attestation.ts for why the weaker
   * levels do not carry that claim.
   */
  readonly requireBinding?: BindingLevel;
  /**
   * Whether the step demands that the agent prove it produced this output.
   *
   * Distinct from `requireAttestation`, which asks *where* the work ran. This
   * asks *who* did it. A TEE attestation says an enclave computed something;
   * it says nothing about which of the market's agents is entitled to the
   * credit, or the payment.
   */
  readonly requireSignedOutput?: boolean;
  /**
   * Whether the agent's signature recovered to the key that agent published in
   * the adapter registry.
   *
   * Undefined means the caller did not check, which is not the same as a valid
   * signature and is never treated as one — the same rule `bindingLevel`
   * follows, for the same §1.3 reason.
   */
  readonly outputSignatureValid?: boolean;
  /** Set when the invocation terminally failed. */
  readonly error?: string;
  /** Set when policy prevented the step from running at all. */
  readonly skipped?: string;
}

/**
 * The single place a step's status is decided. Ordering matters: a step that
 * did not run cannot have failed, a step that failed cannot be judged on its
 * attestation, and a step missing a required attestation is never Ok.
 *
 * The binding rule is the attestation rule generalised. §1.3 says a step that
 * required an attestation and did not get one is Unattested, never Ok — and an
 * attestation that does not bind the output is, for a flow that asked for
 * binding, exactly that: not the attestation it required.
 */
export function decideStepStatus(decision: StatusDecision): StepStatus {
  if (decision.skipped !== undefined) return StepStatus.Skipped;
  if (decision.error !== undefined) return StepStatus.Failed;
  if (decision.requireAttestation) {
    if (!decision.attestationPresent) return StepStatus.Unattested;

    const required = decision.requireBinding ?? 'present';
    // Absent an evaluation, an existing attestation establishes no more than
    // its own existence. Assuming better would be the promotion §1.3 forbids.
    const achieved = decision.bindingLevel ?? 'present';
    if (!meetsBinding(achieved, required)) return StepStatus.Unattested;
  }
  // An unproven identity is the same class of failure as a missing
  // attestation: the work may well be correct, but nobody can confirm who did
  // it. In a market that is not a detail — it decides who gets paid and whose
  // record the step lands on.
  if (decision.requireSignedOutput === true && decision.outputSignatureValid !== true) {
    return StepStatus.Unattested;
  }
  return StepStatus.Ok;
}

/**
 * The single definition of "this step succeeded" at the status level. Notably
 * Unattested is not success (§1.3). Callers elsewhere must use this rather
 * than comparing against the enum themselves, so the rule has one home.
 *
 * This is a weaker statement than `isSuccess`: it says the invocation went
 * well, not that anyone else can confirm it. Only `isSuccess` means verified.
 */
export function statusSucceeded(status: StepStatus): boolean {
  return status === StepStatus.Ok;
}

function assertAnchorMatches(receipt: Receipt, anchor: AnchoredArtifact): void {
  if (anchor.runId.toLowerCase() !== receipt.runId.toLowerCase()) {
    throw new OutcomeError(
      `anchor is for run ${anchor.runId}, receipt is for run ${receipt.runId}`,
    );
  }
  if (anchor.stepIndex !== receipt.stepIndex) {
    throw new OutcomeError(
      `anchor is for stepIndex ${anchor.stepIndex}, receipt is for stepIndex ${receipt.stepIndex}`,
    );
  }
  const expected = hashReceipt(receipt);
  if (anchor.receiptHash.toLowerCase() !== expected.toLowerCase()) {
    throw new OutcomeError(
      `anchored receipt hash ${anchor.receiptHash} does not match the receipt, which hashes to ${expected}`,
    );
  }
}

/**
 * Maps a receipt plus its on-chain anchor (or its absence) to a reportable
 * outcome. An Ok receipt with no anchor is `unanchored`, not success: the run
 * may well have executed correctly, but nobody else can confirm that yet.
 */
export function reportStepOutcome(
  receipt: Receipt,
  anchor: AnchoredArtifact | null,
): StepOutcome {
  if (anchor !== null) assertAnchorMatches(receipt, anchor);

  switch (receipt.status) {
    case StepStatus.Failed:
      return { kind: 'failed', receipt, anchor };
    case StepStatus.Skipped:
      return { kind: 'skipped', receipt, anchor };
    case StepStatus.Unattested:
      return { kind: 'unattested', receipt, anchor };
    case StepStatus.Ok:
      if (anchor === null) {
        return {
          kind: 'unanchored',
          receipt,
          reason: `step ${receipt.stepIndex} completed but no anchoring transaction has been confirmed, so no third party can verify it`,
        };
      }
      return { kind: 'success', receipt, anchor };
    default: {
      const exhaustive: never = receipt.status;
      throw new OutcomeError(`unhandled status ${String(exhaustive)}`);
    }
  }
}

export function isSuccess(
  outcome: StepOutcome,
): outcome is Extract<StepOutcome, { kind: 'success' }> {
  return outcome.kind === 'success';
}

export interface RunReport {
  readonly runId: Hex;
  readonly steps: readonly StepOutcome[];
  readonly seal: SealArtifact | null;
  /** The receipts as anchored, used to re-check the sealed chain root. */
  readonly receipts: readonly Receipt[];
}

/**
 * A run is a success only when every step is an anchored success AND the run
 * is sealed with a chain root that the receipts actually fold to. A run that
 * fails is still a well-formed, verifiable object — it is simply not a
 * success.
 */
export function reportRunOutcome(report: RunReport): RunOutcome {
  const { runId, steps, seal, receipts } = report;

  if (seal !== null) {
    if (seal.runId.toLowerCase() !== runId.toLowerCase()) {
      throw new OutcomeError(`seal is for run ${seal.runId}, not ${runId}`);
    }
    if (seal.stepCount !== receipts.length) {
      throw new OutcomeError(
        `seal claims ${seal.stepCount} steps but ${receipts.length} receipts were anchored`,
      );
    }
    const folded = foldChainRoot(receipts);
    if (folded.toLowerCase() !== seal.chainRoot.toLowerCase()) {
      throw new OutcomeError(
        `sealed chainRoot ${seal.chainRoot} does not match the root the anchored receipts fold to (${folded})`,
      );
    }
  }

  const unsuccessful = steps.filter((s) => !isSuccess(s));

  if (seal === null) {
    return {
      kind: 'unsealed',
      runId,
      sealed: false,
      seal: null,
      steps,
      reason: 'the run has not been sealed on chain, so its chain root cannot be checked',
    };
  }

  if (unsuccessful.length > 0) {
    return {
      kind: 'failure',
      runId,
      sealed: true,
      seal,
      steps,
      reason: `${unsuccessful.length} of ${steps.length} steps did not complete as verifiable successes: ${unsuccessful
        .map((s) => `step ${s.receipt.stepIndex} (${s.kind})`)
        .join(', ')}`,
    };
  }

  return { kind: 'success', runId, sealed: true, seal, steps };
}

export function isRunSuccess(
  outcome: RunOutcome,
): outcome is Extract<RunOutcome, { kind: 'success' }> {
  return outcome.kind === 'success';
}
