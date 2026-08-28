/**
 * The shapes the explorer API serves, and one place that fetches them.
 *
 * Types are written out rather than inferred because they are a contract with
 * a separate process: when `packages/explorer-api` changes a field, this file
 * is where it should fail to compile.
 */

import { useEffect, useState } from 'react';
import type { ApiStep } from './verify.js';

export interface RunSummary {
  runId: string;
  flowId: string;
  stepCount: number;
  sealed: boolean;
  chainRoot: string | null;
  outcome: number | null;
  outcomeName: string | null;
  succeeded: boolean;
  firstBlock: string;
  lastBlock: string;
}

export interface AgentRecord {
  stepCount: number;
  okCount: number;
  attestedCount: number;
  runCount: number;
  successRate: number | null;
  attestationRate: number | null;
  identityRegistry: string | null;
}

/**
 * A probe result.
 *
 * The one thing here that is NOT verifiable — see the note on `AgentHealthRow`
 * in the indexer. Rendered with an age, never as a bare tick.
 */
export interface AgentHealth {
  checkedAt: string;
  ok: boolean;
  latencyMs: number | null;
  consecutiveFailures: number;
  lastError: string | null;
}

/** Folded from `AgentReputationV1` events, so anyone can replay it. */
export interface AgentBond {
  agentId: string;
  amount: string;
  unlockAt: string;
  slashed: boolean;
  blockNumber: string;
}

export interface AgentListing {
  agentId: string;
  owner: string;
  kind: number;
  endpoint: string;
  schemaRoot: string;
  version: number;
  active: boolean;
  payTo: string;
  signer: string;
  pricePerCall: string;
  metadataURI: string;
  blockNumber: string;
  metadata: { name?: string; description?: string; conformance?: { conformant?: boolean; checks?: number } } | null;
  bond: AgentBond | null;
  health: AgentHealth | null;
  stepCount: number;
  okCount: number;
  runCount: number;
  successRate: number | null;
}

export interface Health {
  ok: boolean;
  network: {
    name: string;
    chainId: number;
    explorer: string;
    /** What the publish page tells a wallet to add. Public config, not a secret. */
    rpcUrl: string;
    nativeToken: string;
  };
  contracts: Record<string, string | null>;
  indexed: { runs: number; steps: number; flows: number; agents: number; cursor: string };
}

export interface RunDetail {
  run: RunSummary & { computedChainRoot: string | null; chainRootMatches: boolean | null };
  steps: ApiStep[];
  verification: { command: string; note: string };
}

export interface AgentDetail {
  listing: (AgentListing & { metadata: AgentListing['metadata'] }) | null;
  bond: AgentBond | null;
  health: AgentHealth | null;
  agent: AgentRecord & { agentId: string };
  runs: RunSummary[];
}

export interface FlowDetail {
  flow: { flowId: string; name: string; owner: string; specRoot: string } | null;
  runs: RunSummary[];
}

export class ApiError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? `${path} responded ${status}`);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    // The publish endpoint refuses for reasons the publisher can act on — a
    // host that does not resolve, an endpoint behind a private address, a rate
    // limit with the CLI as the way around it. Throwing "responded 400" would
    // discard the only useful part of the response.
    const detail = await response
      .json()
      .then((body: unknown) =>
        typeof (body as { error?: unknown }).error === 'string'
          ? ((body as { error: string }).error)
          : null,
      )
      .catch(() => null);
    throw new ApiError(path, response.status, detail ?? undefined);
  }
  return (await response.json()) as T;
}

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
}

/**
 * Fetches on mount and whenever `deps` change.
 *
 * The `live` flag is not ceremony: without it a fast route change resolves the
 * old request last and paints the previous page's data under the new heading,
 * which on a page about provenance is a genuinely bad thing to do.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });

  useEffect(() => {
    let live = true;
    setState({ data: null, error: null, loading: true });
    fn().then(
      (data) => {
        if (live) setState({ data, error: null, loading: false });
      },
      (error: unknown) => {
        if (live) setState({ data: null, error: (error as Error).message, loading: false });
      },
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
