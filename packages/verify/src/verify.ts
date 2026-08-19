/**
 * The verification procedure — spec §9.
 *
 *   1. Read StepAnchored and RunSealed logs for runId.
 *   2. Fetch each traceRoot; verify the Merkle inclusion proof.
 *   3. Recompute inputHash and outputHash from the trace contents.
 *   4. Re-derive each step's input from its declared upstream outputs.
 *   5. Verify each attestationRef against the raw attestation in the trace.
 *   6. Fold the chain root; compare against the on-chain seal.
 *   7. Resolve every agentId against the identity registry.
 *
 * The governing rule is §1.3: no status reports success unless a third party
 * can independently confirm it from public data. So this distinguishes three
 * verdicts, and "I could not obtain the evidence" is never quietly folded into
 * success:
 *
 *   verified   — every check ran and passed against retrievable public data
 *   failed     — a check ran and did not pass
 *   incomplete — evidence was missing, so some check could not run
 *
 * Failure outranks incompleteness, so a broken run cannot hide behind missing
 * data.
 */

import {
  foldChainRoot,
  hashJson,
  hashReceipt,
  parseTrace,
  sha256,
  statusSucceeded,
  verifyLinkage,
  StepStatus,
  ZERO_BYTES32,
  type Hex,
  type JsonValue,
  type LinkageReport,
  type LinkedStep,
  type Receipt,
} from '@0gflow/core';
import { decodeRunSealed, decodeStepAnchored, type AnchoredReceipt } from './decode.js';
import type { ChainSource, TraceOrigin, TraceSource } from './sources.js';

export type Verdict = 'verified' | 'failed' | 'incomplete';

export type AttestationState =
  | 'not-required'
  | 'verified'
  | 'mismatched'
  | 'missing-trace'
  | 'absent-but-referenced';

export interface StepCheck {
  readonly stepIndex: number;
  readonly stepId: string | null;
  readonly agentId: bigint;
  readonly status: StepStatus;
  readonly receiptHash: Hex;
  readonly txHash: Hex;
  /** null when the registry was not supplied and the check did not run. */
  readonly identityResolved: boolean | null;
  readonly identityOwner: Hex | null;
  readonly traceOrigin: TraceOrigin | null;
  readonly inclusionProofVerified: boolean;
  /** null when the trace could not be fetched. */
  readonly hashesMatch: boolean | null;
  readonly attestation: AttestationState;
  readonly notes: string[];
}

export interface VerificationReport {
  readonly runId: Hex;
  readonly flowId: Hex | null;
  readonly verdict: Verdict;
  readonly stepCount: number;
  readonly computedChainRoot: Hex | null;
  readonly sealedChainRoot: Hex | null;
  readonly sealedStepCount: number | null;
  readonly sealedOutcome: number | null;
  /** Whether the run itself succeeded — distinct from whether it verified. */
  readonly runSucceeded: boolean;
  readonly steps: StepCheck[];
  readonly linkage: LinkageReport | null;
  /** Why linkage was not checked, when it was not. */
  readonly linkageSkipped: string | null;
  readonly failures: string[];
  readonly incomplete: string[];
  readonly traceSource: string;
}

/** The parts of a flow spec needed to re-derive inputs (§9 step 4). */
export interface SpecForLinkage {
  readonly steps: readonly LinkedStep[];
  readonly inputs: JsonValue;
}

export interface VerifyOptions {
  readonly runId: Hex;
  readonly chain: ChainSource;
  readonly traces: TraceSource;
  /** ERC-721 agent registry; null skips step 7 and marks it incomplete. */
  readonly identityRegistry: Hex | null;
  /** Flow spec; null skips step 4 and marks it incomplete. */
  readonly spec: SpecForLinkage | null;
}

interface StepEvidenceRecord {
  readonly stepIndex: number;
  readonly input: JsonValue;
  readonly output: JsonValue;
}

export async function verifyRun(options: VerifyOptions): Promise<VerificationReport> {
  const { runId, chain, traces, identityRegistry, spec } = options;
  const failures: string[] = [];
  const incomplete: string[] = [];

  // --- Step 1: receipts and seal from chain logs -------------------------
  const stepLogs = await chain.getStepAnchoredLogs(runId);
  if (stepLogs.length === 0) {
    return {
      runId, flowId: null, verdict: 'failed', stepCount: 0,
      computedChainRoot: null, sealedChainRoot: null, sealedStepCount: null, sealedOutcome: null,
      runSucceeded: false, steps: [], linkage: null,
      linkageSkipped: 'the run has no receipts to link',
      failures: [`no StepAnchored receipts found for run ${runId}: the run does not exist on this chain, or was anchored to a different contract`],
      incomplete: [], traceSource: traces.describe,
    };
  }

  const receipts: AnchoredReceipt[] = stepLogs
    .map(decodeStepAnchored)
    .sort((a, b) => a.stepIndex - b.stepIndex);

  const flowId = receipts[0]!.flowId;
  for (const r of receipts) {
    if (r.flowId !== flowId) {
      failures.push(`step ${r.stepIndex} declares flowId ${r.flowId} but step 0 declares ${flowId}: these receipts are not all from the same flow`);
    }
  }

  const sealLogs = await chain.getRunSealedLogs(runId);
  const seal = sealLogs.length > 0 ? decodeRunSealed(sealLogs[sealLogs.length - 1]!) : null;
  if (seal === null) {
    incomplete.push('the run has not been sealed on chain, so its chain root cannot be compared');
  }

  // --- Step 6: fold and compare -----------------------------------------
  let computedChainRoot: Hex | null = null;
  try {
    computedChainRoot = foldChainRoot(receipts);
  } catch (error) {
    failures.push(`cannot fold a chain root: ${(error as Error).message}`);
  }

  if (seal !== null && computedChainRoot !== null) {
    if (seal.chainRoot.toLowerCase() !== computedChainRoot.toLowerCase()) {
      failures.push(
        `chain root mismatch: the anchored receipts fold to ${computedChainRoot} but the on-chain seal records ${seal.chainRoot}`,
      );
    }
    if (seal.stepCount !== receipts.length) {
      failures.push(
        `step count mismatch: the seal claims ${seal.stepCount} steps but ${receipts.length} receipts are anchored`,
      );
    }
  }

  // --- Steps 2, 3, 5, 7: per step ---------------------------------------
  const steps: StepCheck[] = [];
  const evidence: StepEvidenceRecord[] = [];
  let allTracesFromStorage = true;

  for (const receipt of receipts) {
    const notes: string[] = [];
    const stepId = spec?.steps[receipt.stepIndex]?.id ?? null;

    // Step 7: identity.
    let identityResolved: boolean | null = null;
    let identityOwner: Hex | null = null;
    if (identityRegistry === null) {
      notes.push('identity registry not configured; agent registration unchecked');
    } else {
      identityOwner = await chain.ownerOf(identityRegistry, receipt.agentId);
      identityResolved = identityOwner !== null;
      if (!identityResolved) {
        failures.push(
          `step ${receipt.stepIndex}: agent ${receipt.agentId} is not registered in the identity registry ${identityRegistry}`,
        );
      }
    }

    // Step 2: fetch the trace.
    const fetched = await traces.fetch(receipt.traceRoot);
    let hashesMatch: boolean | null = null;
    let attestation: AttestationState = 'not-required';

    if (fetched === null) {
      allTracesFromStorage = false;
      incomplete.push(
        `step ${receipt.stepIndex}: trace ${receipt.traceRoot} could not be retrieved, so its input and output hashes are unchecked`,
      );
      if (receipt.attestationRef !== ZERO_BYTES32) attestation = 'missing-trace';
    } else {
      if (!fetched.inclusionProofVerified) allTracesFromStorage = false;

      try {
        const trace = parseTrace(fetched.bytes);

        // A zero hash is a claim of ABSENCE — the step committed to nothing —
        // not a hash of empty data. Legitimate for a step that failed or was
        // skipped, because §1.3 requires such runs to stay verifiable AS
        // failures; a failed run that fails *verification* would be
        // indistinguishable from a tampered one. An ok step may never claim
        // it, or it could pass every check by committing to nothing.
        const commitsInput = receipt.inputHash !== ZERO_BYTES32;
        const commitsOutput = receipt.outputHash !== ZERO_BYTES32;

        if (statusSucceeded(receipt.status) && !(commitsInput && commitsOutput)) {
          failures.push(
            `step ${receipt.stepIndex} is status ok but commits to no ${commitsOutput ? 'input' : 'output'}: a successful step must commit to what it consumed and produced`,
          );
        }

        // Step 3: recompute the hashes the receipt commits to.
        const inputHash = hashJson(trace.input);
        const outputHash = hashJson(trace.output);
        const inputOk = !commitsInput || inputHash === receipt.inputHash;
        const outputOk = !commitsOutput || outputHash === receipt.outputHash;
        hashesMatch = inputOk && outputOk;

        if (!inputOk) {
          failures.push(
            `step ${receipt.stepIndex}: the stored input hashes to ${inputHash} but the receipt anchors inputHash ${receipt.inputHash}`,
          );
        }
        if (!outputOk) {
          failures.push(
            `step ${receipt.stepIndex}: the stored output hashes to ${outputHash} but the receipt anchors outputHash ${receipt.outputHash}`,
          );
        }

        evidence.push({ stepIndex: receipt.stepIndex, input: trace.input, output: trace.output });

        // Step 5: attestation.
        if (receipt.attestationRef === ZERO_BYTES32) {
          attestation = 'not-required';
          if (receipt.status === StepStatus.Unattested) {
            notes.push('required an attestation and did not get one');
          }
        } else if (typeof trace.attestation !== 'string' || trace.attestation.length === 0) {
          attestation = 'absent-but-referenced';
          failures.push(
            `step ${receipt.stepIndex}: the receipt anchors attestationRef ${receipt.attestationRef} but the trace carries no attestation`,
          );
        } else {
          // The digest is over the raw bytes exactly as the provider sent
          // them, never over a re-serialised form.
          const raw = Buffer.from(trace.attestation, 'base64');
          const digest = sha256(new Uint8Array(raw));
          if (digest === receipt.attestationRef) {
            attestation = 'verified';
          } else {
            attestation = 'mismatched';
            failures.push(
              `step ${receipt.stepIndex}: the stored attestation hashes to ${digest} but the receipt anchors attestationRef ${receipt.attestationRef}`,
            );
          }
        }
      } catch (error) {
        hashesMatch = false;
        failures.push(`step ${receipt.stepIndex}: ${(error as Error).message}`);
      }
    }

    steps.push({
      stepIndex: receipt.stepIndex,
      stepId,
      agentId: receipt.agentId,
      status: receipt.status,
      receiptHash: hashReceipt(receipt),
      txHash: receipt.txHash,
      identityResolved,
      identityOwner,
      traceOrigin: fetched?.origin ?? null,
      inclusionProofVerified: fetched?.inclusionProofVerified ?? false,
      hashesMatch,
      attestation,
      notes,
    });
  }

  if (!allTracesFromStorage) {
    incomplete.push(
      'not every trace was retrieved from 0G Storage with a verified inclusion proof, so third-party retrievability is unproven',
    );
  }

  // --- Step 4: linkage ---------------------------------------------------
  let linkage: LinkageReport | null = null;
  let linkageSkipped: string | null = null;
  if (spec === null) {
    linkageSkipped = 'the flow spec was not supplied (pass --spec)';
    incomplete.push(
      'the flow spec was not supplied, so the linkage invariant could not be re-derived (pass --spec)',
    );
  } else if (evidence.length !== receipts.length) {
    linkageSkipped = 'some traces were unavailable';
    incomplete.push('linkage could not be checked because some traces were unavailable');
  } else {
    linkage = verifyLinkage({
      steps: spec.steps,
      runInputs: spec.inputs,
      evidence: spec.steps.map((step, i) => {
        const record = evidence.find((e) => e.stepIndex === i)!;
        return { stepId: step.id, input: record.input, output: record.output };
      }),
      receipts: receipts as readonly Receipt[],
    });
    if (!linkage.ok) failures.push(...linkage.failures);
  }

  const runSucceeded =
    seal !== null &&
    seal.outcome === 0 &&
    receipts.every((r) => statusSucceeded(r.status));

  const verdict: Verdict =
    failures.length > 0 ? 'failed' : incomplete.length > 0 ? 'incomplete' : 'verified';

  return {
    runId,
    flowId,
    verdict,
    stepCount: receipts.length,
    computedChainRoot,
    sealedChainRoot: seal?.chainRoot ?? null,
    sealedStepCount: seal?.stepCount ?? null,
    sealedOutcome: seal?.outcome ?? null,
    runSucceeded,
    steps,
    linkage,
    linkageSkipped,
    failures,
    incomplete,
    traceSource: traces.describe,
  };
}
