/**
 * Client-side verification — spec §8.2: "performs client-side verification
 * where feasible."
 *
 * The explorer must not ask to be believed. The API serves the raw receipt
 * fields, and this recomputes the chain root in the browser using the same
 * frozen `@0gflow/core` the executor and the verifier use. If the API were
 * lying — or merely wrong — the fold computed here would not match the sealed
 * root read from chain, and the page says so.
 *
 * What is feasible in a browser, honestly stated:
 *
 *   YES  fold the receipts and compare against the sealed chain root
 *   YES  recompute each receipt hash from its fields
 *   NO   fetch traces from 0G Storage and re-derive the linkage invariant
 *
 * The last needs the traces, so the page never claims a run is verified — only
 * that the chain root it can check does or does not hold. Anything stronger is
 * `npx @0gflow/verify`, which the page tells you to run.
 */

import { foldChainRoot, hashReceipt, StepStatus, type Receipt } from '@0gflow/core';

export interface ApiStep {
  runId: string;
  flowId: string;
  stepIndex: number;
  agentId: string;
  inputHash: string;
  outputHash: string;
  traceRoot: string;
  attestationRef: string;
  startedAt: string;
  endedAt: string;
  status: number;
  statusName: string;
  attested: boolean;
  txHash: string;
  blockNumber: string;
  explorerTx: string;
}

export type ChainRootCheck =
  | { kind: 'match'; computed: string }
  | { kind: 'mismatch'; computed: string; sealed: string }
  | { kind: 'unsealed'; computed: string }
  | { kind: 'incomputable'; reason: string };

/** Rebuilds the on-chain Receipt struct from what the API served. */
export function toReceipt(step: ApiStep): Receipt {
  return {
    flowId: step.flowId,
    runId: step.runId,
    stepIndex: step.stepIndex,
    agentId: BigInt(step.agentId),
    inputHash: step.inputHash,
    outputHash: step.outputHash,
    traceRoot: step.traceRoot,
    attestationRef: step.attestationRef,
    startedAt: BigInt(step.startedAt),
    endedAt: BigInt(step.endedAt),
    status: step.status as StepStatus,
  };
}

export function checkChainRoot(steps: ApiStep[], sealed: string | null): ChainRootCheck {
  if (steps.length === 0) {
    return { kind: 'incomputable', reason: 'no receipts indexed for this run' };
  }
  let computed: string;
  try {
    computed = foldChainRoot(steps.map(toReceipt));
  } catch (error) {
    // A gap in stepIndex means the index is incomplete. Saying so beats
    // folding a partial set and presenting the result as meaningful.
    return { kind: 'incomputable', reason: (error as Error).message };
  }
  if (sealed === null) return { kind: 'unsealed', computed };
  return sealed.toLowerCase() === computed.toLowerCase()
    ? { kind: 'match', computed }
    : { kind: 'mismatch', computed, sealed };
}

export function receiptHashOf(step: ApiStep): string {
  return hashReceipt(toReceipt(step));
}
