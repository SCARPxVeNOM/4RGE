/**
 * The marketplace directory endpoint.
 *
 * The behaviour that matters here is the one the old explorer got wrong by
 * omission: an agent published a minute ago has a listing and no receipts, and
 * it must still appear. Before this endpoint, an agent became visible only
 * after somebody had already hired it — which is exactly backwards for a
 * directory whose purpose is to let people find agents to hire.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { MemoryStore } from '@0gflow/indexer';
import { GALILEO } from '@0gflow/config';
import { StepStatus, type Hex } from '@0gflow/core';
import { createServer } from '../src/server.js';

const meta = (name: string) =>
  `data:application/json;base64,${Buffer.from(
    JSON.stringify({ name, description: `${name} does things` }),
  ).toString('base64')}`;

const listing = (agentId: bigint, over: Partial<Record<string, unknown>> = {}) => ({
  agentId,
  owner: `0x${'aa'.repeat(20)}` as Hex,
  kind: 0,
  endpoint: `https://agents.example/${agentId}`,
  schemaRoot: `0x${'11'.repeat(32)}` as Hex,
  version: 1,
  active: true,
  payTo: `0x${'bb'.repeat(20)}` as Hex,
  signer: `0x${'cc'.repeat(20)}` as Hex,
  pricePerCall: 1_000n,
  metadataURI: meta(`agent-${agentId}`),
  blockNumber: 100n + agentId,
  blockHash: `0xblock${agentId}`,
  ...over,
});

let app: FastifyInstance;
let store: MemoryStore;

beforeAll(async () => {
  store = new MemoryStore();

  // Three listings: one that has run, one freshly published, one withdrawn.
  await store.upsertAgentListing(listing(7n));
  await store.upsertAgentListing(listing(8n));
  await store.upsertAgentListing(listing(9n, { active: false, kind: 3 }));

  // Only agent 7 has ever executed anything.
  await store.upsertStep({
    runId: `0x${'22'.repeat(32)}` as Hex,
    flowId: `0x${'33'.repeat(32)}` as Hex,
    stepIndex: 0,
    agentId: 7n,
    inputHash: `0x${'44'.repeat(32)}` as Hex,
    outputHash: `0x${'55'.repeat(32)}` as Hex,
    traceRoot: `0x${'66'.repeat(32)}` as Hex,
    attestationRef: `0x${'00'.repeat(32)}` as Hex,
    startedAt: 1n,
    endedAt: 2n,
    status: StepStatus.Ok,
    txHash: `0x${'ab'.repeat(32)}` as Hex,
    blockNumber: 200n,
    blockHash: '0xblock200',
    logIndex: 0,
  });

  app = createServer({ store, network: GALILEO });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
};

describe('GET /api/agents', () => {
  test('lists active agents, newest first', async () => {
    const { status, body } = await get('/api/agents');
    expect(status).toBe(200);
    expect(body.agents.map((a: any) => a.agentId)).toEqual(['8', '7']);
  });

  /// The point of the endpoint. Agent 8 has no receipts at all and is still
  /// discoverable.
  test('an agent that has never run is still listed', async () => {
    const { body } = await get('/api/agents');
    const fresh = body.agents.find((a: any) => a.agentId === '8');
    expect(fresh).toBeDefined();
    expect(fresh.endpoint).toBe('https://agents.example/8');
    expect(fresh.stepCount).toBe(0);
    // Not zero — "no runs yet" and "zero successes" are different statements,
    // and a directory that shows 0% for an unused agent is lying about it.
    expect(fresh.successRate).toBeNull();
  });

  test('an agent that has run carries its record', async () => {
    const { body } = await get('/api/agents');
    const used = body.agents.find((a: any) => a.agentId === '7');
    expect(used.stepCount).toBe(1);
    expect(used.okCount).toBe(1);
    expect(used.successRate).toBe(1);
  });

  /// An inactive listing is an agent whose operator said "do not hire me".
  /// A directory that shows it by default invites exactly that.
  test('withdrawn agents are hidden by default and visible on request', async () => {
    const { body: byDefault } = await get('/api/agents');
    expect(byDefault.agents.map((a: any) => a.agentId)).not.toContain('9');

    const { body: all } = await get('/api/agents?active=all');
    expect(all.agents.map((a: any) => a.agentId)).toContain('9');
  });

  test('filters by kind', async () => {
    const { body } = await get('/api/agents?kind=3&active=all');
    expect(body.agents.map((a: any) => a.agentId)).toEqual(['9']);
  });

  test('paginates', async () => {
    const { body } = await get('/api/agents?limit=1&offset=1');
    expect(body.agents.map((a: any) => a.agentId)).toEqual(['7']);
  });

  test('decodes the published name so the directory shows more than a token id', async () => {
    const { body } = await get('/api/agents');
    expect(body.agents[0].metadata).toMatchObject({ name: 'agent-8' });
  });

  /// A listing is published by a stranger. Malformed metadata is their
  /// problem, not a reason for the directory to fail.
  test('survives metadata it cannot parse', async () => {
    await store.upsertAgentListing(listing(10n, { metadataURI: 'ipfs://something-else' }));
    const { status, body } = await get('/api/agents');
    expect(status).toBe(200);
    expect(body.agents.find((a: any) => a.agentId === '10').metadata).toBeNull();
  });
});

describe('GET /api/agents/:agentId', () => {
  test('returns the listing alongside the record', async () => {
    const { status, body } = await get('/api/agents/7');
    expect(status).toBe(200);
    expect(body.listing.endpoint).toBe('https://agents.example/7');
    expect(body.listing.signer).toBe(`0x${'cc'.repeat(20)}`);
    expect(body.agent.stepCount).toBe(1);
  });

  /// Either source is enough to have something to show: a published agent
  /// that never ran, or an agent that ran before the marketplace existed.
  test('works for a published agent with no runs', async () => {
    const { status, body } = await get('/api/agents/8');
    expect(status).toBe(200);
    expect(body.listing.agentId).toBe('8');
    expect(body.agent.stepCount).toBe(0);
    expect(body.agent.successRate).toBeNull();
    expect(body.runs).toEqual([]);
  });

  test('404s for an agent that is neither listed nor seen', async () => {
    const { status } = await get('/api/agents/9999');
    expect(status).toBe(404);
  });
});
