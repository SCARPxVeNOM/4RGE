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
import { StepStatus, type Hex, type JsonValue, type LinkageReport, type LinkedStep } from '@0gflow/core';
import type { ChainSource, TraceOrigin, TraceSource } from './sources.js';
export type Verdict = 'verified' | 'failed' | 'incomplete';
export type AttestationState = 'not-required' | 'verified' | 'mismatched' | 'missing-trace' | 'absent-but-referenced';
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
export declare function verifyRun(options: VerifyOptions): Promise<VerificationReport>;
//# sourceMappingURL=verify.d.ts.map