/**
 * An agent's track record, derived from receipts — spec §7 step 2.
 *
 * WHY THIS IS A PURE FUNCTION
 *
 * The explorer shows a record, the executor may refuse to hire on one, and a
 * third party must be able to check both. If those were three pieces of code
 * they would drift, and the first anyone would notice is a flow refusing an
 * agent the directory calls excellent. So the record is computed here, from
 * receipts, and everyone else calls this.
 *
 * It also means the record is *recomputable*. Receipts are on chain: anyone can
 * fetch the `StepAnchored` logs naming an agent and get the same numbers. That
 * is the difference between this and the health probe next door — an indexer
 * serving a record is a cache of something checkable, and a lying one can be
 * caught.
 *
 * WHAT A RECORD DOES AND DOES NOT PROVE
 *
 * It proves what was anchored: how many steps named this agent, and how they
 * were graded. Since agent signatures exist, a step that required one and got
 * it also proves the agent really produced that output.
 *
 * It does not survive the obvious dodge. An agent with a bad record can mint a
 * fresh identity and start clean, and nothing here stops that — see
 * `AgentReputationV1`, which is the part that makes discarding an identity
 * cost something. A record alone prices poor work only for an agent that keeps
 * using the same name.
 */

import type { Receipt } from './receipt.js';
import { StepStatus } from './receipt.js';

export interface AgentRecord {
  readonly agentId: bigint;
  /** Steps anchored naming this agent, whatever their status. */
  readonly steps: number;
  readonly ok: number;
  readonly failed: number;
  readonly skipped: number;
  /** Ran, but could not be proven: no attestation, or an unproven identity. */
  readonly unattested: number;
  /** Distinct runs this agent appeared in. */
  readonly runs: number;
  /** Distinct flows, so one repeated workflow is not mistaken for variety. */
  readonly flows: number;
  /** Earliest and latest `startedAt` seen, in unix seconds. */
  readonly firstSeenAt: bigint | null;
  readonly lastSeenAt: bigint | null;
}

export const EMPTY_RECORD = (agentId: bigint): AgentRecord => ({
  agentId,
  steps: 0,
  ok: 0,
  failed: 0,
  skipped: 0,
  unattested: 0,
  runs: 0,
  flows: 0,
  firstSeenAt: null,
  lastSeenAt: null,
});

/**
 * Folds receipts into a record.
 *
 * Receipts for other agents are ignored rather than rejected: the natural way
 * to call this is with every receipt of a run, and making the caller filter
 * first would just move the same loop somewhere with less context.
 */
export function computeAgentRecord(
  agentId: bigint,
  receipts: Iterable<Receipt>,
): AgentRecord {
  const runs = new Set<string>();
  const flows = new Set<string>();
  let steps = 0;
  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let unattested = 0;
  let firstSeenAt: bigint | null = null;
  let lastSeenAt: bigint | null = null;

  for (const receipt of receipts) {
    if (receipt.agentId !== agentId) continue;

    steps += 1;
    runs.add(receipt.runId.toLowerCase());
    flows.add(receipt.flowId.toLowerCase());

    switch (receipt.status) {
      case StepStatus.Ok:
        ok += 1;
        break;
      case StepStatus.Failed:
        failed += 1;
        break;
      case StepStatus.Skipped:
        skipped += 1;
        break;
      case StepStatus.Unattested:
        unattested += 1;
        break;
    }

    if (firstSeenAt === null || receipt.startedAt < firstSeenAt) firstSeenAt = receipt.startedAt;
    if (lastSeenAt === null || receipt.startedAt > lastSeenAt) lastSeenAt = receipt.startedAt;
  }

  return { agentId, steps, ok, failed, skipped, unattested, runs: runs.size, flows: flows.size, firstSeenAt, lastSeenAt };
}

/**
 * Success rate over the steps that were actually attempted.
 *
 * Skipped steps are excluded from the denominator. A step skipped because an
 * upstream one failed says nothing about this agent, and counting it against
 * them would let one bad agent drag down everyone downstream of it.
 *
 * Returns null when nothing was attempted. Null is not zero: an agent that has
 * never run has no rate, and reporting 0% for it would be a claim nobody made.
 */
export function successRate(record: AgentRecord): number | null {
  const attempted = record.ok + record.failed + record.unattested;
  return attempted === 0 ? null : record.ok / attempted;
}

/** What a flow demands of an agent before hiring it. */
export interface ReputationRequirement {
  /**
   * Minimum success rate, 0..1. Spec §7 step 2's `policy.minReputation`.
   */
  readonly minReputation?: number;
  /**
   * How many attempted steps that rate must be measured over.
   *
   * Defaults to 10, and the default is the point. "100% successful" over one
   * step is not a track record, and without a floor every brand-new agent
   * clears every bar — which is precisely the agent a threshold was meant to
   * screen out.
   */
  readonly minSteps?: number;
  /**
   * Minimum bond the agent must have posted, in wei.
   *
   * A record alone does not survive an agent discarding its identity and
   * minting a fresh one. This is what makes that cost something.
   */
  readonly minStake?: bigint;
}

export interface ReputationVerdict {
  readonly meets: boolean;
  /** Why not, phrased for a receipt. Null when it meets the bar. */
  readonly reason: string | null;
}

const MET: ReputationVerdict = { meets: true, reason: null };

/**
 * Whether an agent clears a flow's bar.
 *
 * An unknown record is a failure to meet the bar, not a pass. That is the same
 * rule as everywhere else here: "I could not establish this" and "this is
 * fine" are different answers, and a policy that treats them alike protects
 * nobody.
 */
export function evaluateReputation(
  record: AgentRecord | null,
  stake: bigint | null,
  requirement: ReputationRequirement,
): ReputationVerdict {
  const wantsRate = requirement.minReputation !== undefined && requirement.minReputation > 0;
  const wantsStake = requirement.minStake !== undefined && requirement.minStake > 0n;
  if (!wantsRate && !wantsStake) return MET;

  if (wantsStake) {
    if (stake === null) {
      return {
        meets: false,
        reason: `the flow requires a bond of at least ${requirement.minStake} wei, and this agent's stake could not be read`,
      };
    }
    if (stake < requirement.minStake!) {
      return {
        meets: false,
        reason: `agent has bonded ${stake} wei, below the ${requirement.minStake} wei this flow requires`,
      };
    }
  }

  if (wantsRate) {
    if (record === null) {
      return {
        meets: false,
        reason: 'the flow requires a minimum success rate, and this agent’s record could not be read',
      };
    }

    const minSteps = requirement.minSteps ?? 10;
    const attempted = record.ok + record.failed + record.unattested;
    if (attempted < minSteps) {
      return {
        meets: false,
        reason: `agent has ${attempted} attempted step(s), too few to judge against a threshold measured over at least ${minSteps}`,
      };
    }

    const rate = successRate(record)!;
    if (rate < requirement.minReputation!) {
      return {
        meets: false,
        reason: `agent succeeded on ${record.ok}/${attempted} attempted steps (${(rate * 100).toFixed(1)}%), below the ${(requirement.minReputation! * 100).toFixed(1)}% this flow requires`,
      };
    }
  }

  return MET;
}
