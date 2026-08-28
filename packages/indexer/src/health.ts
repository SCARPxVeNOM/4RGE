/**
 * Probing listed agents, so the directory can tell a live agent from an
 * abandoned one.
 *
 * WHAT THIS IS NOT
 *
 * Everything else this indexer stores is on chain: anyone can recompute it and
 * get the same answer. A probe result is one process's observation, from one
 * network vantage, at one moment, and a reader has no way to check it. An
 * agent could answer this prober and refuse everyone else, or be unreachable
 * from here and fine everywhere else.
 *
 * So it is presented as what it is — an observation with a timestamp — and
 * nothing decides anything on it. The executor does not read it: when a flow
 * wants to know whether an agent is up it probes for itself, which is at least
 * verifiable by doing, and a dead agent produces a Failed step regardless.
 *
 * The value is human: a directory where a listing that stopped answering three
 * days ago looks different from one that answered a minute ago.
 */

import type { Store } from './store.js';

/** Separated so tests need no network and no clock. */
export interface HealthProbe {
  (endpoint: string, timeoutMs: number): Promise<{ ok: boolean; error: string | null }>;
}

export interface ProbeAgentsArgs {
  readonly store: Store;
  readonly probe?: HealthProbe;
  readonly timeoutMs?: number;
  /** How many listings to probe per pass. */
  readonly limit?: number;
  readonly now?: () => number;
}

export interface ProbeResult {
  readonly probed: number;
  readonly healthy: number;
}

/**
 * The default probe: `GET {endpoint}/health`, and the response must actually
 * say `ok`.
 *
 * A 200 alone is not enough. Plenty of things return 200 — a parked domain, a
 * proxy error page, a load balancer with nothing behind it — and treating any
 * of them as a working agent is how a directory ends up recommending
 * something that cannot be hired.
 */
export const httpHealthProbe: HealthProbe = async (endpoint, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${endpoint.replace(/\/+$/, '')}/health`;
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };

    const body: unknown = await response.json();
    if (body === null || typeof body !== 'object' || (body as { ok?: unknown }).ok !== true) {
      return { ok: false, error: 'responded without ok: true' };
    }
    return { ok: true, error: null };
  } catch (error) {
    const message = (error as Error).name === 'AbortError' ? 'timed out' : (error as Error).message;
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Probes the active listings once.
 *
 * Only active ones: a listing its operator deactivated is not expected to
 * answer, and marking it unhealthy would report a deliberate withdrawal as a
 * fault.
 *
 * Probes run concurrently because they are almost all waiting, and a slow
 * agent should not delay the rest — one unreachable endpoint holding a
 * sequential pass for its whole timeout is how a prober falls behind and
 * starts reporting stale data as current.
 */
export async function probeAgents(args: ProbeAgentsArgs): Promise<ProbeResult> {
  const { store, probe = httpHealthProbe, timeoutMs = 10_000, limit = 100, now = Date.now } = args;

  const listings = await store.listAgentListings(limit, 0, { activeOnly: true });
  const checkedAt = BigInt(now());

  const results = await Promise.all(
    listings.map(async (listing) => {
      const started = now();
      const outcome = await probe(listing.endpoint, timeoutMs).catch((error: Error) => ({
        ok: false,
        error: error.message,
      }));

      await store.recordAgentHealth(listing.agentId, {
        ok: outcome.ok,
        latencyMs: outcome.ok ? now() - started : null,
        error: outcome.error,
        checkedAt,
      });
      return outcome.ok;
    }),
  );

  return { probed: results.length, healthy: results.filter(Boolean).length };
}
