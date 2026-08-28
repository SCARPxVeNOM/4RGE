/**
 * Human-readable verification output — spec §9.
 *
 * The output is deliberately explicit about what was NOT checked. A verifier
 * that prints a clean-looking summary while silently skipping a step teaches
 * people to trust it in exactly the cases where it proved nothing.
 */

import { statusSucceeded, StepStatus } from '@0gflow/core';
import type { StepCheck, VerificationReport } from './verify.js';

const TICK = '✓';
const CROSS = '✗';
const DASH = '—';

const short = (hex: string, keep = 6): string =>
  hex.length <= keep + 4 ? hex : `${hex.slice(0, keep + 2)}…`;

/**
 * What the attestation line says.
 *
 * This used to print "TEE ✓" whenever the digest matched, which claimed
 * hardware attestation on the strength of a blob hashing correctly. The label
 * now reports the binding level, because those are very different statements:
 * a matching digest means the document was not altered, and only `bound` means
 * the attested key signed this output.
 *
 * Nothing here prints an unqualified tick, and the strongest line names its
 * anchor: the binding rests on the TEE signer 0G acknowledges for the
 * provider, read from chain.
 */
function attestationLabel(step: StepCheck): string {
  switch (step.attestation) {
    case 'not-required':
      // A zero attestationRef means no attestation was anchored. It does NOT
      // say one was required: since agent signatures exist, a step can be
      // Unattested because its identity went unproven instead. Inferring
      // "required but absent" from the status alone was wrong for every
      // signature-only step. The note on the step names the actual reason.
      return step.status === StepStatus.Unattested
        ? `attestation: ${CROSS} none anchored`
        : 'attestation: not required';
    case 'verified':
      switch (step.binding?.level) {
        case 'bound':
          // The strongest claim available: 0G's registry vouches for the
          // signer, and that signer signed this output.
          return `attestation: ${TICK} bound to output by 0G-acknowledged TEE signer`;
        case 'attested':
          return `attestation: ${CROSS} TEE-signed, but not over this output`;
        default:
          // Digest matches; nothing establishes what the document means.
          return step.binding?.signerResolved === true
            ? 'attestation: ? signer known, output unbound'
            : 'attestation: ? present, signer unresolved';
      }
    case 'mismatched':
      return `attestation: ${CROSS} digest mismatch`;
    case 'absent-but-referenced':
      return `attestation: ${CROSS} referenced but not in trace`;
    case 'missing-trace':
      return 'attestation: ? trace unavailable';
  }
}

/**
 * What the identity line says.
 *
 * Kept separate from the `id` mark, which reports only that the agent's token
 * exists in the identity registry. That an identity exists says nothing about
 * whether its holder produced this output — which is the whole gap agent
 * signatures close, and printing them as one thing would hide it.
 *
 * Nothing is printed when a step carries no signature: most runs predate
 * them, and a `?` on every line of every historical run would be noise rather
 * than information.
 */
function identityLabel(step: StepCheck): string | null {
  switch (step.outputIdentity) {
    case 'absent':
      return null;
    case 'valid':
      return `signed ${TICK} by agent ${step.agentId}`;
    case 'unconfirmed':
      return `signed ${CROSS} recovers to ${short(step.recoveredAgentSigner ?? '0x')}, not the registered key`;
    case 'no-registered-key':
      return `signed ? agent ${step.agentId} has published no key`;
    case 'unchecked':
      return 'signed ? no adapter registry configured';
    default:
      return null;
  }
}

function mark(value: boolean | null): string {
  if (value === null) return '?';
  return value ? TICK : CROSS;
}

function statusLabel(status: StepStatus): string {
  return { 0: 'ok', 1: 'failed', 2: 'skipped', 3: 'unattested' }[status] ?? String(status);
}

export function renderReport(
  report: VerificationReport,
  context: { networkName: string; chainId: number; contract: string },
): string {
  const lines: string[] = [];
  const flow = report.flowId === null ? '' : `flow ${short(report.flowId)}`;

  lines.push('');
  lines.push(`  Run    ${short(report.runId, 8)}   ${flow}`);
  lines.push(`  Chain  ${context.networkName} (${context.chainId})   ·   receipts ${short(context.contract)}`);
  lines.push(`  Traces ${report.traceSource}`);
  lines.push('');

  for (const step of report.steps) {
    const name = (step.stepId ?? `step ${step.stepIndex}`).padEnd(12);
    const parts = [
      `id ${mark(step.identityResolved)}`,
      `trace ${mark(step.hashesMatch === null ? null : true)}`,
      `hashes ${mark(step.hashesMatch)}`,
      attestationLabel(step),
    ];
    const identity = identityLabel(step);
    if (identity !== null) parts.push(identity);
    lines.push(`  [${step.stepIndex}] ${name} ${short(step.receiptHash)}   ${parts.join('   ')}`);
    // statusSucceeded rather than a local comparison: one definition of
    // success, in outcome.ts, so Unattested can never drift into 'fine'.
    if (!statusSucceeded(step.status)) {
      lines.push(`      ${DASH} status: ${statusLabel(step.status)}`);
    }
    for (const note of step.notes) lines.push(`      ${DASH} ${note}`);
  }

  lines.push('');

  if (report.linkage === null) {
    lines.push(`  Linkage      ?   not checked (${report.linkageSkipped ?? 'reason unrecorded'})`);
  } else {
    lines.push(
      `  Linkage      ${report.linkage.ok ? TICK : CROSS}   ${report.linkage.linkedSteps}/${report.linkage.totalSteps} inputs derive from declared upstream outputs`,
    );
  }

  if (report.sealedChainRoot === null) {
    lines.push(`  Chain root   ?   run is not sealed on chain`);
  } else {
    const ok = report.computedChainRoot === report.sealedChainRoot;
    lines.push(
      `  Chain root   ${ok ? TICK : CROSS}   ${short(report.sealedChainRoot)} ${ok ? 'matches' : 'does NOT match'} on-chain seal`,
    );
  }

  lines.push(
    `  Outcome      ${report.runSucceeded ? TICK : DASH}   ${report.runSucceeded ? 'success' : report.sealedOutcome === null ? 'unsealed' : `not a success (sealed outcome ${report.sealedOutcome})`}`,
  );
  lines.push('');

  if (report.failures.length > 0) {
    lines.push('  Failures:');
    for (const failure of report.failures) lines.push(`    ${CROSS} ${failure}`);
    lines.push('');
  }
  if (report.incomplete.length > 0) {
    lines.push('  Not checked:');
    for (const item of report.incomplete) lines.push(`    ? ${item}`);
    lines.push('');
  }

  const agents = new Set(report.steps.map((s) => s.agentId.toString())).size;
  const summary = `${report.stepCount} step${report.stepCount === 1 ? '' : 's'} · ${agents} agent${agents === 1 ? '' : 's'}`;

  switch (report.verdict) {
    case 'verified':
      lines.push(`  VERIFIED ${DASH} ${summary}`);
      break;
    case 'failed':
      lines.push(`  FAILED ${DASH} ${report.failures.length} check${report.failures.length === 1 ? '' : 's'} did not pass`);
      break;
    case 'incomplete':
      lines.push(`  INCOMPLETE ${DASH} nothing failed, but the evidence to finish verifying was not available`);
      break;
  }
  lines.push('');
  return lines.join('\n');
}

/** Exit codes: 0 verified, 1 failed, 2 incomplete. Non-zero on anything but a full pass. */
export function exitCodeFor(verdict: VerificationReport['verdict']): number {
  return verdict === 'verified' ? 0 : verdict === 'failed' ? 1 : 2;
}
