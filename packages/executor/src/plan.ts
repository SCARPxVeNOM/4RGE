/**
 * Flow planning and pre-execution validation — spec §5.1, §7.
 *
 * §5.1: "Unresolvable references fail validation before execution begins."
 * Everything here exists to fail early. A flow that will break should break
 * before it spends gas, before it calls an agent, and above all before it
 * anchors a receipt that can never verify — a bad receipt is permanent, while
 * a rejected plan costs nothing.
 *
 * Note that `stepIndex` is declaration order, NOT topological order. The chain
 * root folds by stepIndex (§1.1), so if the planner renumbered steps the
 * verifier would fold a different root.
 */

import {
  canonicalize,
  keccak256,
  referencedSteps,
  TemplateError,
  type BindingLevel,
  type Hex,
  type JsonValue,
} from '@0gflow/core';

export class PlanError extends Error {
  override readonly name = 'PlanError';
}

export interface StepSpec {
  readonly id: string;
  /** Agent identity as an ERC-721 token id, decimal string. */
  readonly agent: string;
  readonly input: JsonValue;
  readonly needs?: readonly string[];
  /**
   * `'flow'` makes this step a sub-workflow: the executor opens a child run,
   * executes `flow` inside it, and the step's output is that child's on-chain
   * result. Any other value (or none) is an ordinary agent invocation.
   */
  readonly kind?: string;
  /**
   * The sub-workflow to run, when `kind` is `'flow'`.
   *
   * This is how an agent hires other agents with the hiring recorded rather
   * than hidden. The alternative — an agent quietly calling three others
   * inside its own process — produces one receipt for work four parties did,
   * and nobody downstream can tell which of them to credit or blame.
   */
  readonly flow?: FlowSpec;
  readonly model?: string;
  readonly requireAttestation?: boolean;
  /**
   * How much the attestation must actually establish. Defaults to `present`,
   * which is what `requireAttestation` alone has always meant: a document was
   * returned.
   *
   * `bound` is the level that makes the attestation say something about this
   * step — that the key named in the quote signed this output. A flow handling
   * anything consequential should ask for it; see
   * packages/core/src/attestation.ts for why the weaker levels do not carry
   * that claim.
   */
  readonly requireBinding?: BindingLevel;
  /**
   * Whether the agent must prove it produced this output, by signing it with
   * the key it published in the adapter registry.
   *
   * A different question from `requireAttestation`, which asks where the work
   * ran. This asks who did it. Nothing stops an executor from anchoring a
   * receipt naming any `agentId` — on Galileo today every reference agent
   * claims agent 1, which belongs to a stranger — so without this the agent
   * field is a claim rather than a fact. Set it for any flow whose receipts
   * feed reputation or payment.
   */
  readonly requireSignedOutput?: boolean;
  /**
   * This step's own bar, replacing the flow's policy for this step.
   *
   * Replacing rather than adding: a step that states its own terms means them,
   * and silently ANDing the flow's bar on top would make a step look more
   * permissive than it is.
   */
  readonly requireReputation?: {
    readonly minReputation?: number;
    readonly minSteps?: number;
    readonly minStake?: string;
  };
  readonly timeoutMs?: number;
  readonly retries?: { readonly max: number; readonly backoffMs: number };
}

/**
 * What a flow demands of every agent it hires — spec §7 step 2.
 *
 * A bar set here applies to the whole flow. A step may set its own
 * `requireReputation`, which replaces this rather than adding to it: a step
 * that states its own terms means them.
 */
export interface FlowPolicy {
  /** Minimum success rate, 0..1, over `minSteps` attempted steps. */
  readonly minReputation?: number;
  /** How large the sample must be. Defaults to 10 — see core/reputation.ts. */
  readonly minSteps?: number;
  /** Minimum bond, in wei, posted to `AgentReputationV1`. */
  readonly minStake?: string;
  readonly failFast?: boolean;
}

export interface FlowSpec {
  readonly version: string;
  readonly name: string;
  readonly inputs: Readonly<Record<string, JsonValue>>;
  readonly steps: readonly StepSpec[];
  readonly outputs?: Readonly<Record<string, JsonValue>>;
  readonly policy?: FlowPolicy;
}

export interface PlannedStep extends StepSpec {
  /** Position in declaration order. The chain root folds by this. */
  readonly stepIndex: number;
  /** Upstream steps whose output this step's input actually reads. */
  readonly reads: string[];
  /** Everything that must complete first: `needs` plus anything read. */
  readonly dependsOn: string[];
}

export interface Plan {
  readonly flowId: Hex;
  readonly name: string;
  readonly steps: PlannedStep[];
  /** Steps grouped into waves; every step in a wave may run concurrently. */
  readonly waves: PlannedStep[][];
  readonly maxParallelism: number;
}

function assertUniqueIds(spec: FlowSpec): void {
  if (spec.steps.length === 0) throw new PlanError('a flow must declare at least one step');
  const seen = new Set<string>();
  for (const step of spec.steps) {
    if (typeof step.id !== 'string' || step.id.length === 0) {
      throw new PlanError('every step needs a non-empty id');
    }
    if (seen.has(step.id)) throw new PlanError(`duplicate step id "${step.id}"`);
    seen.add(step.id);
  }
}

/** Which `inputs.*` keys a template graph reads, so undeclared ones fail early. */
function referencedInputs(value: JsonValue): string[] {
  const found = new Set<string>();
  const walk = (node: JsonValue): void => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(/\{\{([^{}]*)\}\}/g)) {
        const path = match[1]!.trim().split('.');
        if (path[0] === 'inputs' && path[1] !== undefined) found.add(path[1]);
      }
      return;
    }
    if (Array.isArray(node)) return void node.forEach(walk);
    if (node !== null && typeof node === 'object') Object.values(node).forEach(walk);
  };
  walk(value);
  return [...found];
}

/**
 * How deep sub-flow nesting may go at planning time.
 *
 * Matches the executor's default. The planner's job is to refuse a spec that
 * could never run, and a spec nested deeper than the executor will follow is
 * exactly that.
 */
const MAX_PLAN_DEPTH = 4;

export function planFlow(spec: FlowSpec): Plan {
  return planFlowInner(spec, new Set(), 0);
}

/**
 * `seen` holds the sub-flow objects currently being validated, by identity.
 *
 * A spec whose step points back at an enclosing spec is expressible in
 * memory — nothing stops a caller building one — and validating it naively
 * recurses forever. Identity is the right test here and not flowId: computing
 * a flowId canonicalizes the spec, which on a circular object never returns,
 * so the cycle has to be caught *before* hashing rather than by comparing
 * hashes.
 *
 * Structurally identical but distinct objects slip past this, deliberately.
 * They are caught at run time by the executor's lineage check, which compares
 * flowIds across runs — by then each has been hashed safely.
 */
function planFlowInner(spec: FlowSpec, seen: Set<FlowSpec>, depth: number): Plan {
  if (seen.has(spec)) {
    throw new PlanError(
      `flow "${spec.name}" contains itself as a sub-flow, so planning it would not terminate`,
    );
  }
  if (depth > MAX_PLAN_DEPTH) {
    throw new PlanError(
      `sub-flow nesting exceeds the maximum depth of ${MAX_PLAN_DEPTH} at flow "${spec.name}"`,
    );
  }

  assertUniqueIds(spec);

  const indexById = new Map(spec.steps.map((s, i) => [s.id, i]));
  const declaredInputs = new Set(Object.keys(spec.inputs ?? {}));

  const planned: PlannedStep[] = spec.steps.map((step, stepIndex) => {
    // Template syntax is validated here, so a malformed reference is a
    // planning error rather than a mid-run surprise.
    let reads: string[];
    try {
      reads = referencedSteps(step.input);
    } catch (error) {
      const reason = error instanceof TemplateError ? error.message : String(error);
      throw new PlanError(`step "${step.id}": ${reason}`);
    }

    for (const name of referencedInputs(step.input)) {
      if (!declaredInputs.has(name)) {
        throw new PlanError(
          `step "${step.id}" reads inputs.${name}, which the flow does not declare in its inputs`,
        );
      }
    }

    const needs = step.needs ?? [];
    for (const upstream of needs) {
      if (!indexById.has(upstream)) {
        throw new PlanError(`step "${step.id}" declares needs on unknown step "${upstream}"`);
      }
    }
    for (const upstream of reads) {
      if (!indexById.has(upstream)) {
        throw new PlanError(`step "${step.id}" references unknown step "${upstream}"`);
      }
      if (!needs.includes(upstream)) {
        throw new PlanError(
          `step "${step.id}" reads steps.${upstream}.output but does not declare "${upstream}" in needs`,
        );
      }
    }

    // A sub-flow is validated here, recursively, for the same §5.1 reason
    // everything else is: a malformed child plan must cost nothing, and
    // discovering it mid-run would mean a parent already anchored steps for a
    // flow that was never executable.
    if (step.kind === 'flow') {
      if (step.flow === undefined) {
        throw new PlanError(`step "${step.id}" has kind "flow" but declares no flow to run`);
      }
      seen.add(spec);
      try {
        planFlowInner(step.flow, seen, depth + 1);
      } catch (error) {
        throw new PlanError(
          `step "${step.id}": the sub-flow is not valid: ${(error as Error).message}`,
        );
      } finally {
        // Removed on the way out so a flow legitimately hired by two sibling
        // steps is not mistaken for a cycle.
        seen.delete(spec);
      }
    } else if (step.flow !== undefined) {
      // Silently ignoring it would mean a spec whose author expected a
      // sub-flow to run getting a plain agent call instead.
      throw new PlanError(
        `step "${step.id}" declares a flow but its kind is "${step.kind ?? 'agent'}"; set kind: "flow" to run it`,
      );
    }

    const dependsOn = [...new Set([...needs, ...reads])];
    return { ...step, stepIndex, reads, dependsOn };
  });

  const waves = buildWaves(planned);

  return {
    flowId: keccak256(new TextEncoder().encode(canonicalize(spec as unknown as JsonValue))),
    name: spec.name,
    steps: planned,
    waves,
    maxParallelism: waves.reduce((max, wave) => Math.max(max, wave.length), 0),
  };
}

/**
 * Kahn's algorithm, grouped by level so each wave can run concurrently (§7.1).
 * Within a wave, steps keep declaration order so behaviour is reproducible.
 */
function buildWaves(steps: readonly PlannedStep[]): PlannedStep[][] {
  const remaining = new Map(steps.map((s) => [s.id, new Set(s.dependsOn)]));
  const done = new Set<string>();
  const waves: PlannedStep[][] = [];

  while (done.size < steps.length) {
    const wave = steps.filter((s) => !done.has(s.id) && remaining.get(s.id)!.size === 0);

    if (wave.length === 0) {
      const stuck = steps
        .filter((s) => !done.has(s.id))
        .map((s) => `"${s.id}" waiting on ${[...remaining.get(s.id)!].join(', ')}`);
      throw new PlanError(
        `the flow has a dependency cycle: ${stuck.join('; ')}. Steps cannot depend on themselves or on a step that depends on them`,
      );
    }

    for (const step of wave) done.add(step.id);
    for (const step of steps) {
      if (done.has(step.id)) continue;
      const pending = remaining.get(step.id)!;
      for (const finished of wave) pending.delete(finished.id);
    }
    waves.push(wave);
  }

  // A step must not depend on one declared after it: the verifier re-derives
  // inputs in stepIndex order and could not resolve a later step's output.
  for (const step of steps) {
    for (const upstream of step.dependsOn) {
      const upstreamIndex = steps.find((s) => s.id === upstream)!.stepIndex;
      if (upstreamIndex >= step.stepIndex) {
        throw new PlanError(
          `step "${step.id}" (index ${step.stepIndex}) depends on "${upstream}" (index ${upstreamIndex}), which is not declared before it; a verifier re-derives inputs in stepIndex order and could not resolve this`,
        );
      }
    }
  }

  return waves;
}
