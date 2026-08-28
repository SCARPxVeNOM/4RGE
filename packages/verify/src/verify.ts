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
  attestationRefFor,
  recoverAgentSigner,
  verifyAgentSignature,
  describeBinding,
  foldChainRoot,
  hashJson,
  hashReceipt,
  legacyAttestationRef,
  parseTrace,
  statusSucceeded,
  verifyAttestation,
  verifyLinkage,
  StepStatus,
  ZERO_BYTES32,
  type AcknowledgedSigner,
  type AttestationVerification,
  type ExecutionTrace,
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
  /** The digest matches. Says nothing yet about what the attestation means. */
  | 'verified'
  | 'mismatched'
  | 'missing-trace'
  | 'absent-but-referenced';

/**
 * Recomputes what an attestation establishes, from the trace and the receipt.
 *
 * The trace also carries the executor's own `attestationBinding` finding. It
 * is deliberately not read: the executor is the party being verified, and
 * taking its word for the binding would be letting it grade its own homework.
 * Everything below is re-derived.
 */
function checkAttestation(
  receipt: AnchoredReceipt,
  trace: ExecutionTrace,
  acknowledgedSigner: AcknowledgedSigner | null,
): {
  state: AttestationState;
  binding: AttestationVerification | null;
  notes: string[];
  failures: string[];
} {
  const notes: string[] = [];
  const failures: string[] = [];

  const bundle = trace.attestationBundle ?? null;
  const legacyRaw = typeof trace.attestation === 'string' ? trace.attestation : null;

  if (bundle === null && (legacyRaw === null || legacyRaw.length === 0)) {
    return {
      state: 'absent-but-referenced',
      binding: null,
      notes,
      failures: [
        `the receipt anchors attestationRef ${receipt.attestationRef} but the trace carries no attestation`,
      ],
    };
  }

  // Which digest scheme the receipt used is decided by which one reproduces
  // it — not by which fields happen to be present, since a trace can carry
  // both and only one can be what was anchored.
  let state: AttestationState;
  let boundScheme: 'bundle' | 'legacy' | null = null;

  if (bundle !== null && attestationRefFor(bundle) === receipt.attestationRef) {
    boundScheme = 'bundle';
    state = 'verified';
  } else if (legacyRaw !== null && legacyAttestationRef(legacyRaw) === receipt.attestationRef) {
    boundScheme = 'legacy';
    state = 'verified';
  } else {
    const computed =
      bundle !== null ? attestationRefFor(bundle) : legacyAttestationRef(legacyRaw ?? '');
    return {
      state: 'mismatched',
      binding: null,
      notes,
      failures: [
        `the stored attestation hashes to ${computed} but the receipt anchors attestationRef ${receipt.attestationRef}`,
      ],
    };
  }

  if (boundScheme === 'legacy') {
    // Pre-binding receipt. The digest is over the quote alone, so nothing
    // ties it to this output and no amount of checking can raise that.
    notes.push(
      'attestationRef digests the quote alone (pre-binding format): the attestation is unmodified but is not tied to this output',
    );
    return {
      state,
      binding: {
        level: 'present',
        acknowledgedSigner: null,
        recoveredAddress: null,
        signerResolved: false,
        notes: ['legacy quote-only attestationRef'],
      },
      notes,
      failures,
    };
  }

  const binding = verifyAttestation({ bundle, output: trace.output, acknowledgedSigner });
  notes.push(describeBinding(binding));
  for (const note of binding.notes) notes.push(note);

  // A step anchored ok whose attestation does not cover its output is the
  // exact substitution the binding exists to catch: a genuine quote, a
  // genuine signature, and the wrong response. It is a verification failure,
  // not a note.
  if (statusSucceeded(receipt.status) && binding.level === 'attested') {
    failures.push(
      'the attestation is signed by the attested enclave key but does not cover this step output, so it belongs to a different response',
    );
  }

  return { state, binding, notes, failures };
}

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
  /**
   * What the attestation actually establishes, recomputed here rather than
   * read from the trace. null when there was no attestation to evaluate.
   */
  readonly binding: AttestationVerification | null;
  /**
   * Whether the agent named in the receipt actually signed this output,
   * recomputed here from the trace and the registry rather than read from the
   * executor's own finding.
   */
  readonly outputIdentity: IdentityState;
  /** The address the signature recovers to, when there was one. */
  readonly recoveredAgentSigner: Hex | null;
  readonly notes: string[];
}

/**
 * What could be established about who produced a step's output.
 *
 *   absent            the trace carries no signature — the pre-marketplace
 *                     default, and not a failure
 *   unchecked         a signature exists but no adapter registry was supplied
 *   no-registered-key the agent has published no signing key, so nothing can
 *                     check the signature against anything
 *   valid             the signature recovers to the agent's published key
 *   unconfirmed       it does not
 */
export type IdentityState =
  | 'absent'
  | 'unchecked'
  | 'no-registered-key'
  | 'valid'
  | 'unconfirmed';

/**
 * A sub-workflow one of this run's steps hired.
 *
 * A step of `kind: 'flow'` publishes the child run's on-chain result as its
 * output — run id and sealed chain root. That is what makes hiring verifiable:
 * the claim can be checked against the child's own seal, so a parent cannot
 * take credit for work its child did not do.
 */
export interface HiredRunCheck {
  readonly parentStepIndex: number;
  readonly childRunId: Hex;
  /** The chain root the parent's output claims the child sealed. */
  readonly claimedChainRoot: Hex;
  /** The full report for the child, or null when it was not verified. */
  readonly report: VerificationReport | null;
  /** Why the child was not verified, when it was not. */
  readonly skipped: string | null;
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
  /** Sub-workflows this run hired, each verified in its own right. */
  readonly hired: readonly HiredRunCheck[];
}

/**
 * A step of a flow spec, for linkage purposes.
 *
 * `flow` is carried so a parent's spec can supply its child's. Without it a
 * hired run is verified with no spec at all, its linkage goes unchecked, and
 * the parent can therefore never be better than INCOMPLETE — which would make
 * hiring permanently second-class for no good reason, since the parent's own
 * spec already contains the child's.
 */
export interface SpecStep extends LinkedStep {
  readonly flow?: { readonly steps: readonly SpecStep[] };
}

/** The parts of a flow spec needed to re-derive inputs (§9 step 4). */
export interface SpecForLinkage {
  readonly steps: readonly SpecStep[];
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
  /**
   * What is needed to re-derive an agent output signature: where the adapter
   * registry lists signing keys, and the chain and contract the signature was
   * bound to.
   *
   * All three or none. A digest recomputed against the wrong chain or the
   * wrong receipts address fails for a reason that looks exactly like forgery,
   * so a partially-configured check would be worse than an absent one.
   */
  readonly agentIdentity?: {
    readonly registry: Hex;
    readonly receipts: Hex;
    readonly chainId: number;
  };
  /**
   * How many levels of hired sub-workflow to follow. Default 3.
   *
   * A cap rather than unbounded recursion: the runs being followed are named
   * by data this verifier is in the middle of checking, so a malicious or
   * simply broken parent could otherwise point at a chain of runs long enough
   * to exhaust the process. Set 0 to report hired runs without verifying them.
   */
  readonly maxHireDepth?: number;
}

interface StepEvidenceRecord {
  readonly stepIndex: number;
  readonly input: JsonValue;
  readonly output: JsonValue;
}

export async function verifyRun(options: VerifyOptions): Promise<VerificationReport> {
  const { runId, chain, traces, identityRegistry, spec, agentIdentity } = options;
  const maxHireDepth = options.maxHireDepth ?? 3;
  const failures: string[] = [];
  const incomplete: string[] = [];
  const hiredClaims: { stepIndex: number; childRunId: Hex; chainRoot: Hex }[] = [];

  // --- Step 1: receipts and seal from chain logs -------------------------
  const stepLogs = await chain.getStepAnchoredLogs(runId);
  if (stepLogs.length === 0) {
    return {
      runId, flowId: null, verdict: 'failed', stepCount: 0,
      computedChainRoot: null, sealedChainRoot: null, sealedStepCount: null, sealedOutcome: null,
      runSucceeded: false, steps: [], linkage: null,
      linkageSkipped: 'the run has no receipts to link',
      failures: [`no StepAnchored receipts found for run ${runId}: the run does not exist on this chain, or was anchored to a different contract`],
      incomplete: [], traceSource: traces.describe, hired: [],
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
    let binding: AttestationVerification | null = null;
    let outputIdentity: IdentityState = 'absent';
    let recoveredAgentSigner: Hex | null = null;

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

        // A step whose output names a child run hired a whole sub-workflow.
        // Collected here and followed after this loop, so the parent's own
        // checks finish before any recursion.
        const claim = readHiredClaim(trace.output);
        if (claim !== null) {
          hiredClaims.push({ stepIndex: receipt.stepIndex, ...claim });
        }

        // Step 5: attestation.
        if (receipt.attestationRef === ZERO_BYTES32) {
          attestation = 'not-required';
          // Deliberately no note here about why the step is Unattested. With
          // agent signatures there are now two things a step can require, and
          // a zero attestationRef does not say which one was missing —
          // asserting "required an attestation" would be a guess, and it was
          // wrong for every signature-only step. The identity check below
          // names the actual reason when it is the identity.
        } else {
          // The trust anchor comes from chain, over the same RPC used for
          // receipts. Read per step, so a de-acknowledged signer stops
          // attesting from the next verification onward.
          const bundleProvider = trace.attestationBundle?.provider ?? null;
          let acknowledged: AcknowledgedSigner | null = null;
          if (bundleProvider !== null && chain.acknowledgedSigner !== undefined) {
            try {
              acknowledged = await chain.acknowledgedSigner(bundleProvider);
            } catch {
              // An unreachable registry establishes nothing; it is not a
              // failure of the attestation itself.
              acknowledged = null;
            }
          }

          const checked = checkAttestation(receipt, trace, acknowledged);
          attestation = checked.state;
          binding = checked.binding;
          notes.push(...checked.notes);
          failures.push(...checked.failures.map((f) => `step ${receipt.stepIndex}: ${f}`));
        }

        // Step 8: identity. Who produced this output, re-derived from the
        // signature in the trace and the key the agent published on chain.
        // The executor's own `outputIdentity.valid` is deliberately not read:
        // that would be letting the executor grade its own homework, exactly
        // as with the attestation level above.
        const signature = trace.outputIdentity?.signature ?? null;
        if (signature === null) {
          outputIdentity = 'absent';
        } else if (agentIdentity === undefined || chain.agentSigner === undefined) {
          outputIdentity = 'unchecked';
          incomplete.push(
            `step ${receipt.stepIndex}: the trace carries an agent signature but no adapter registry was configured, so it is unknown whether agent ${receipt.agentId} produced this output`,
          );
        } else {
          const claim = {
            chainId: agentIdentity.chainId,
            receipts: agentIdentity.receipts,
            runId: receipt.runId,
            stepIndex: receipt.stepIndex,
            agentId: receipt.agentId,
            inputHash: receipt.inputHash,
            outputHash: receipt.outputHash,
          };
          recoveredAgentSigner = recoverAgentSigner(claim, signature as Hex);

          let registered: Hex | null = null;
          try {
            registered = await chain.agentSigner(agentIdentity.registry, receipt.agentId);
          } catch {
            registered = null;
          }

          if (registered === null) {
            outputIdentity = 'no-registered-key';
            incomplete.push(
              `step ${receipt.stepIndex}: agent ${receipt.agentId} has published no signing key in ${agentIdentity.registry}, so its signature establishes nothing`,
            );
          } else if (verifyAgentSignature(claim, signature as Hex, registered)) {
            outputIdentity = 'valid';
            notes.push(`output signed by agent ${receipt.agentId} (${registered})`);
          } else {
            // Reported as unconfirmed rather than as a forgery, and so listed
            // under incomplete rather than failures. An agent that rotated a
            // compromised key produces exactly this: a signature that was
            // valid when made and no longer recovers to the registered key.
            // Calling that tampering would punish the right behaviour, and the
            // hash checks above already catch a modified output.
            outputIdentity = 'unconfirmed';
            incomplete.push(
              `step ${receipt.stepIndex}: the output signature recovers to ${recoveredAgentSigner ?? 'nothing'}, but agent ${receipt.agentId} has ${registered} registered, so its authorship is unconfirmed`,
            );
          }
        }
      } catch (error) {
        hashesMatch = false;
        failures.push(`step ${receipt.stepIndex}: ${(error as Error).message}`);
      }
    }

    // Why this step is not a success, said once and only from what is known.
    if (receipt.status === StepStatus.Unattested) {
      if (outputIdentity === 'unconfirmed') {
        notes.push('anchored unattested: the agent named here did not sign this output');
      } else if (outputIdentity === 'absent' && attestation === 'not-required') {
        notes.push(
          'anchored unattested: neither an attestation nor an agent signature was recorded',
        );
      } else if (attestation !== 'not-required') {
        notes.push('anchored unattested: the required attestation did not hold');
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
      binding,
      outputIdentity,
      recoveredAgentSigner,
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

  // --- Step 9: the sub-workflows this run hired ---------------------------
  //
  // Each child is a run in its own right, with its own receipts and its own
  // seal, so it is verified the same way this one was. The parent's claim is
  // then checked against what the child actually sealed — which is the whole
  // reason the parent publishes the child's root rather than its data.
  const hired: HiredRunCheck[] = [];
  for (const claim of hiredClaims) {
    if (maxHireDepth <= 0) {
      hired.push({
        parentStepIndex: claim.stepIndex,
        childRunId: claim.childRunId,
        claimedChainRoot: claim.chainRoot,
        report: null,
        skipped: 'the hired-run depth limit was reached, so this child was not verified',
      });
      incomplete.push(
        `step ${claim.stepIndex} hired run ${claim.childRunId}, which was not verified because the depth limit was reached`,
      );
      continue;
    }

    let report: VerificationReport;
    try {
      report = await verifyRun({
        ...options,
        runId: claim.childRunId,
        // The child's spec, when the parent's spec carries it. A sub-flow is
        // declared inline in the parent, so this is the same document — and
        // the child's inputs are exactly the parent step's resolved input,
        // which is in the evidence already gathered above.
        spec: childSpecFor(spec, evidence, claim.stepIndex),
        maxHireDepth: maxHireDepth - 1,
      });
    } catch (error) {
      hired.push({
        parentStepIndex: claim.stepIndex,
        childRunId: claim.childRunId,
        claimedChainRoot: claim.chainRoot,
        report: null,
        skipped: (error as Error).message,
      });
      incomplete.push(
        `step ${claim.stepIndex} hired run ${claim.childRunId}, which could not be verified: ${(error as Error).message}`,
      );
      continue;
    }

    hired.push({
      parentStepIndex: claim.stepIndex,
      childRunId: claim.childRunId,
      claimedChainRoot: claim.chainRoot,
      report,
      skipped: null,
    });

    // The load-bearing check. The parent's trace hash is already verified
    // against its receipt, so a disagreement here is not a corrupted trace —
    // it is a parent that anchored a claim about a child run the chain does
    // not support. That is a failure, not an unknown.
    if (
      report.sealedChainRoot !== null &&
      report.sealedChainRoot.toLowerCase() !== claim.chainRoot.toLowerCase()
    ) {
      failures.push(
        `step ${claim.stepIndex} claims hired run ${claim.childRunId} sealed ${claim.chainRoot}, but that run sealed ${report.sealedChainRoot}`,
      );
    }
    if (report.sealedChainRoot === null) {
      incomplete.push(
        `step ${claim.stepIndex} hired run ${claim.childRunId}, which is not sealed on chain, so its result cannot be confirmed`,
      );
    }
    if (report.verdict === 'failed') {
      failures.push(
        `step ${claim.stepIndex} hired run ${claim.childRunId}, which does not verify: ${report.failures[0] ?? 'see its own report'}`,
      );
    } else if (report.verdict === 'incomplete') {
      // A parent whose child could not be fully checked is itself not fully
      // checked. Reporting VERIFIED over an INCOMPLETE child would be the
      // clean-looking summary §9 exists to prevent: the parent's own evidence
      // is the child run, so the gap is the parent's gap too.
      incomplete.push(
        `step ${claim.stepIndex} hired run ${claim.childRunId}, which is itself incomplete: ${report.incomplete[0] ?? 'see its own report'}`,
      );
    }
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
    hired,
  };
}

/**
 * The spec to verify a hired child against, derived from the parent's.
 *
 * Returns null when the parent's spec was not supplied or does not declare a
 * sub-flow at that step — in which case the child's linkage is honestly
 * reported as unchecked rather than checked against the wrong flow.
 */
function childSpecFor(
  spec: SpecForLinkage | null,
  evidence: readonly StepEvidenceRecord[],
  stepIndex: number,
): SpecForLinkage | null {
  const flow = spec?.steps[stepIndex]?.flow;
  if (flow === undefined) return null;

  const parentStepInput = evidence.find((e) => e.stepIndex === stepIndex)?.input;
  if (parentStepInput === undefined) return null;

  // The sub-flow runs with the parent step's resolved input as its inputs.
  return { steps: flow.steps, inputs: parentStepInput };
}

/**
 * Reads a hired-run claim out of a step's output.
 *
 * Deliberately strict: every field must be present and well formed, or this
 * is not a sub-workflow step and no child is followed. A partial match would
 * mean chasing a run id that some ordinary agent happened to put in its
 * output under a colliding key.
 */
function readHiredClaim(output: JsonValue): { childRunId: Hex; chainRoot: Hex } | null {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return null;
  const record = output as Record<string, JsonValue>;

  const childRunId = record['childRunId'];
  const chainRoot = record['chainRoot'];
  const hex32 = /^0x[0-9a-fA-F]{64}$/;

  if (typeof childRunId !== 'string' || !hex32.test(childRunId)) return null;
  if (typeof chainRoot !== 'string' || !hex32.test(chainRoot)) return null;
  // These two accompany a real sub-flow output and are cheap corroboration
  // that this is one, rather than a coincidence.
  if (typeof record['stepCount'] !== 'number') return null;
  if (typeof record['outcome'] !== 'number') return null;

  return { childRunId: childRunId.toLowerCase() as Hex, chainRoot: chainRoot.toLowerCase() as Hex };
}
