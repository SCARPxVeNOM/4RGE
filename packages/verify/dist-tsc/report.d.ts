/**
 * Human-readable verification output — spec §9.
 *
 * The output is deliberately explicit about what was NOT checked. A verifier
 * that prints a clean-looking summary while silently skipping a step teaches
 * people to trust it in exactly the cases where it proved nothing.
 */
import type { VerificationReport } from './verify.js';
export declare function renderReport(report: VerificationReport, context: {
    networkName: string;
    chainId: number;
    contract: string;
}): string;
/** Exit codes: 0 verified, 1 failed, 2 incomplete. Non-zero on anything but a full pass. */
export declare function exitCodeFor(verdict: VerificationReport['verdict']): number;
//# sourceMappingURL=report.d.ts.map