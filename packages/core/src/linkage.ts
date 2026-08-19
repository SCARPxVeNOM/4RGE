/**
 * The linkage invariant — spec §4.1.
 *
 * This is the whole technical claim. Everything else in the system is
 * machinery around it:
 *
 *   For every step that consumes output from an upstream step, the step's
 *   inputHash must be re-derivable from that upstream step's outputHash under
 *   the template declared in the flow spec.
 *
 * That is what makes a run a chain rather than a list of independently
 * attested calls. An operator who wants to run step 2 on data of their
 * choosing must either produce an upstream output that hashes to the anchored
 * outputHash, or produce an input that hashes to the anchored inputHash while
 * not deriving from that output. The check below closes both doors at once by
 * re-deriving the input from the output it claims to come from.
 *
 * The verifier calls this with evidence pulled from 0G Storage and receipts
 * pulled from chain logs; it never trusts the executor's own account of what
 * happened.
 */

import type { JsonValue } from './canonicalize.js';
import { hashJson, type Hex } from './hash.js';
import { statusSucceeded } from './outcome.js';
import { StepStatus, type Receipt } from './receipt.js';
import { referencedSteps, resolveTemplates, TemplateError, type StepContext } from './template.js';

/** A step as declared in the flow spec. Array position is its stepIndex. */
export interface LinkedStep {
  readonly id: string;
  /** Input template, resolved against inputs.* and steps.<id>.output.*. */
  readonly input: JsonValue;
  readonly needs?: readonly string[];
}

/** What actually happened, recovered from the step's stored trace. */
export interface StepEvidence {
  readonly stepId: string;
  input: JsonValue;
  output: JsonValue;
}

export interface StepLinkage {
  readonly stepIndex: number;
  readonly stepId: string;
  /** Upstream step ids this step's input actually reads. */
  readonly derivedFrom: string[];
  /** The input hash re-derived from upstream evidence, if derivable. */
  readonly derivedInputHash: Hex | null;
  readonly inputHashMatches: boolean;
  readonly outputHashMatches: boolean;
  readonly ok: boolean;
  readonly failures: string[];
}

export interface LinkageReport {
  readonly ok: boolean;
  readonly totalSteps: number;
  /** Steps whose input provably derives from their declared upstream outputs. */
  readonly linkedSteps: number;
  readonly steps: StepLinkage[];
  readonly failures: string[];
}

export interface LinkageQuery {
  readonly steps: readonly LinkedStep[];
  readonly runInputs: JsonValue;
  readonly evidence: readonly StepEvidence[];
  readonly receipts: readonly Receipt[];
}

export function verifyLinkage(query: LinkageQuery): LinkageReport {
  const { steps, runInputs, evidence, receipts } = query;
  const failures: string[] = [];
  const results: StepLinkage[] = [];

  const evidenceById = new Map(evidence.map((e) => [e.stepId, e]));
  const receiptByIndex = new Map(receipts.map((r) => [r.stepIndex, r]));
  const indexById = new Map(steps.map((s, i) => [s.id, i]));

  // Outputs that have been confirmed against their receipt. A downstream step
  // may only derive from these — deriving from an unconfirmed output would
  // make the chain assert nothing.
  const confirmedOutputs = new Map<string, StepContext>();
  const statusById = new Map<string, StepStatus>();

  steps.forEach((step, stepIndex) => {
    const stepFailures: string[] = [];
    let derivedFrom: string[] = [];
    let derivedInputHash: Hex | null = null;
    let inputHashMatches = false;
    let outputHashMatches = false;

    try {
      derivedFrom = referencedSteps(step.input);
    } catch (error) {
      stepFailures.push(`step "${step.id}": ${(error as Error).message}`);
    }

    // Declared dependencies must cover what the input actually reads.
    const declared = new Set(step.needs ?? []);
    for (const upstream of derivedFrom) {
      if (!declared.has(upstream)) {
        stepFailures.push(
          `step "${step.id}" reads steps.${upstream}.output but does not declare it in needs`,
        );
      }
      const upstreamIndex = indexById.get(upstream);
      if (upstreamIndex === undefined) {
        stepFailures.push(`step "${step.id}" references unknown step "${upstream}"`);
      } else if (upstreamIndex >= stepIndex) {
        stepFailures.push(
          `step "${step.id}" (index ${stepIndex}) references step "${upstream}" (index ${upstreamIndex}), which does not execute before it: forward references cannot be linked`,
        );
      }
    }

    const receipt = receiptByIndex.get(stepIndex);
    const record = evidenceById.get(step.id);
    if (receipt === undefined) stepFailures.push(`step "${step.id}": no receipt at index ${stepIndex}`);
    if (record === undefined) stepFailures.push(`step "${step.id}": no trace evidence`);

    if (receipt !== undefined) {
      statusById.set(step.id, receipt.status);

      // A step cannot legitimately succeed on data an unsuccessful upstream
      // step never produced.
      if (statusSucceeded(receipt.status)) {
        for (const upstream of derivedFrom) {
          const upstreamStatus = statusById.get(upstream);
          if (upstreamStatus !== undefined && !statusSucceeded(upstreamStatus)) {
            stepFailures.push(
              `step "${step.id}" is status ok but its upstream step "${upstream}" is status ${StepStatus[upstreamStatus]}`,
            );
          }
        }
      }
    }

    if (receipt !== undefined && record !== undefined) {
      // 1. The stored output must be the one the receipt commits to.
      const outputHash = hashJson(record.output);
      outputHashMatches = outputHash === receipt.outputHash;
      if (!outputHashMatches) {
        stepFailures.push(
          `step "${step.id}": stored output hashes to ${outputHash} but the receipt anchors outputHash ${receipt.outputHash}`,
        );
      }

      // 2. Re-derive the input from confirmed upstream outputs and the run
      //    inputs, using the template declared in the spec.
      const missing = derivedFrom.filter((id) => !confirmedOutputs.has(id));
      if (missing.length > 0) {
        stepFailures.push(
          `step "${step.id}": cannot re-derive input because upstream output${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m}"`).join(', ')} ${missing.length > 1 ? 'were' : 'was'} not confirmed`,
        );
      } else {
        try {
          const derived = resolveTemplates(step.input, {
            inputs: runInputs,
            steps: Object.fromEntries(confirmedOutputs),
          });
          derivedInputHash = hashJson(derived);
          inputHashMatches = derivedInputHash === receipt.inputHash;
          if (!inputHashMatches) {
            stepFailures.push(
              `step "${step.id}": input re-derived from declared upstream outputs hashes to ${derivedInputHash} but the receipt anchors inputHash ${receipt.inputHash}`,
            );
          }
        } catch (error) {
          const reason =
            error instanceof TemplateError ? error.message : `unexpected: ${String(error)}`;
          stepFailures.push(`step "${step.id}": input template did not resolve: ${reason}`);
        }
      }

      if (outputHashMatches) {
        confirmedOutputs.set(step.id, { output: record.output });
      }
    }

    const ok = stepFailures.length === 0 && inputHashMatches && outputHashMatches;
    results.push({
      stepIndex,
      stepId: step.id,
      derivedFrom,
      derivedInputHash,
      inputHashMatches,
      outputHashMatches,
      ok,
      failures: stepFailures,
    });
    failures.push(...stepFailures);
  });

  // Receipts for steps the spec never declared would mean the run does not
  // correspond to the flow it claims to execute.
  for (const receipt of receipts) {
    if (receipt.stepIndex >= steps.length) {
      failures.push(
        `receipt at stepIndex ${receipt.stepIndex} has no corresponding step in a ${steps.length}-step flow`,
      );
    }
  }

  return {
    ok: failures.length === 0,
    totalSteps: steps.length,
    linkedSteps: results.filter((r) => r.ok).length,
    steps: results,
    failures,
  };
}
