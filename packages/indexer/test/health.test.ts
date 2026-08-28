/**
 * Probing listed agents.
 *
 * The behaviour worth guarding is mostly about restraint: a probe is one
 * process's observation and nothing decides anything on it, so the tests are
 * about not overclaiming — a 200 that does not say `ok` is not a working
 * agent, one failure is not "down", and a deactivated listing is not a fault.
 */

import { describe, expect, test } from 'vitest';
import { MemoryStore } from '../src/memory-store.js';
import { probeAgents, type HealthProbe } from '../src/health.js';
import type { AgentListingRow } from '../src/store.js';
import type { Hex } from '@0gflow/core';

const listing = (agentId: bigint, over: Partial<AgentListingRow> = {}): AgentListingRow => ({
  agentId,
  owner: `0x${'aa'.repeat(20)}` as Hex,
  kind: 0,
  endpoint: `https://agents.example/${agentId}`,
  schemaRoot: `0x${'11'.repeat(32)}` as Hex,
  version: 1,
  active: true,
  payTo: `0x${'bb'.repeat(20)}` as Hex,
  signer: `0x${'cc'.repeat(20)}` as Hex,
  pricePerCall: 0n,
  metadataURI: '',
  blockNumber: 100n,
  blockHash: '0xblock',
  ...over,
});

/** Answers per endpoint, and records what it was asked. */
function probeReturning(answers: Record<string, boolean>): { probe: HealthProbe; asked: string[] } {
  const asked: string[] = [];
  const probe: HealthProbe = async (endpoint) => {
    asked.push(endpoint);
    return answers[endpoint] === true
      ? { ok: true, error: null }
      : { ok: false, error: 'connection refused' };
  };
  return { probe, asked };
}

describe('probing', () => {
  test('records a success with its latency', async () => {
    const store = new MemoryStore();
    await store.upsertAgentListing(listing(7n));

    let clock = 1_000;
    const result = await probeAgents({
      store,
      probe: probeReturning({ 'https://agents.example/7': true }).probe,
      now: () => (clock += 25),
    });

    expect(result).toEqual({ probed: 1, healthy: 1 });
    const health = await store.getAgentHealth(7n);
    expect(health?.ok).toBe(true);
    expect(health?.latencyMs).toBeGreaterThan(0);
    expect(health?.consecutiveFailures).toBe(0);
    expect(health?.lastError).toBeNull();
  });

  test('records a failure with its reason and no latency', async () => {
    const store = new MemoryStore();
    await store.upsertAgentListing(listing(7n));

    await probeAgents({ store, probe: probeReturning({}).probe });

    const health = await store.getAgentHealth(7n);
    expect(health?.ok).toBe(false);
    // A failed probe has no meaningful round-trip time; reporting one would
    // invite reading it as a slow success.
    expect(health?.latencyMs).toBeNull();
    expect(health?.lastError).toBe('connection refused');
  });

  /// One failure is noise — a restart, a cold start, a blip. The streak is
  /// what lets a reader tell that apart from an abandoned listing.
  test('failures accumulate into a streak, and a success clears it', async () => {
    const store = new MemoryStore();
    await store.upsertAgentListing(listing(7n));

    await probeAgents({ store, probe: probeReturning({}).probe });
    await probeAgents({ store, probe: probeReturning({}).probe });
    await probeAgents({ store, probe: probeReturning({}).probe });
    expect((await store.getAgentHealth(7n))?.consecutiveFailures).toBe(3);

    await probeAgents({ store, probe: probeReturning({ 'https://agents.example/7': true }).probe });
    expect((await store.getAgentHealth(7n))?.consecutiveFailures).toBe(0);
  });

  /// A listing its operator deactivated is not expected to answer. Marking it
  /// unhealthy would report a deliberate withdrawal as a fault.
  test('deactivated listings are not probed', async () => {
    const store = new MemoryStore();
    await store.upsertAgentListing(listing(7n));
    await store.upsertAgentListing(listing(8n, { active: false }));

    const { probe, asked } = probeReturning({ 'https://agents.example/7': true });
    const result = await probeAgents({ store, probe });

    expect(result.probed).toBe(1);
    expect(asked).toEqual(['https://agents.example/7']);
    expect(await store.getAgentHealth(8n)).toBeNull();
  });

  test('an agent never probed has no health, rather than a false one', async () => {
    const store = new MemoryStore();
    expect(await store.getAgentHealth(999n)).toBeNull();
  });

  /// One unreachable endpoint holding a sequential pass for its whole timeout
  /// is how a prober falls behind and starts reporting stale data as current.
  test('a slow endpoint does not hold up the others', async () => {
    const store = new MemoryStore();
    await store.upsertAgentListing(listing(7n));
    await store.upsertAgentListing(listing(8n));

    let running = 0;
    let concurrent = 0;
    const probe: HealthProbe = async () => {
      running += 1;
      concurrent = Math.max(concurrent, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return { ok: true, error: null };
    };

    await probeAgents({ store, probe });
    expect(concurrent).toBe(2);
  });

  /// A probe that throws rather than returning is still just a failed probe.
  test('a probe that throws is recorded, not propagated', async () => {
    const store = new MemoryStore();
    await store.upsertAgentListing(listing(7n));

    await expect(
      probeAgents({
        store,
        probe: () => Promise.reject(new Error('dns exploded')),
      }),
    ).resolves.toEqual({ probed: 1, healthy: 0 });

    expect((await store.getAgentHealth(7n))?.lastError).toBe('dns exploded');
  });
});
