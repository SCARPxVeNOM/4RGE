import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GALILEO } from '@0gflow/config';
import { foldChainRoot, StepStatus, ZERO_BYTES32, type Hex, type Receipt } from '@0gflow/core';
import { MemoryStore } from '@0gflow/indexer';
import { createServer, verifyCommand } from '../src/server.js';
import type { FastifyInstance } from 'fastify';

/**
 * §8.2: public, read-only, no wallet.
 *
 * The property that matters is that responses carry enough for a client to
 * check them rather than trust them. An explorer that only shows a green tick
 * is asking to be believed, which is the opposite of the point.
 */

const RUN = `0x${'22'.repeat(32)}` as Hex;
const FLOW = `0x${'11'.repeat(32)}` as Hex;

function receipt(stepIndex: number, over: Partial<Receipt> = {}): Receipt {
  return {
    flowId: FLOW, runId: RUN, stepIndex, agentId: 1n,
    inputHash: `0x${'33'.repeat(32)}`, outputHash: `0x${'44'.repeat(32)}`,
    traceRoot: `0x${'55'.repeat(32)}`, attestationRef: ZERO_BYTES32,
    startedAt: 100n, endedAt: 101n, status: StepStatus.Ok, ...over,
  };
}

let app: FastifyInstance;
let store: MemoryStore;

beforeAll(async () => {
  store = new MemoryStore();
  const receipts = [receipt(0), receipt(1, { attestationRef: `0x${'77'.repeat(32)}` })];
  for (const [i, r] of receipts.entries()) {
    await store.upsertStep({
      ...r, txHash: `0x${'ab'.repeat(32)}`, blockNumber: BigInt(10 + i),
      blockHash: `0xblock${10 + i}`, logIndex: 0,
    });
  }
  await store.upsertSeal({
    runId: RUN, chainRoot: foldChainRoot(receipts) as Hex, stepCount: 2, outcome: 0,
    txHash: `0x${'ef'.repeat(32)}`, blockNumber: 12n, blockHash: '0xblock12',
  });
  await store.upsertFlow({
    flowId: FLOW, name: 'audit-summarize', owner: `0x${'aa'.repeat(20)}` as Hex,
    specRoot: `0x${'66'.repeat(32)}`, publishedAt: 1n, blockNumber: 9n, blockHash: '0xblock9',
  });

  app = createServer({ store, network: GALILEO });
  await app.ready();
});

afterAll(async () => { await app.close(); });

const get = async (url: string) => {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
};

describe('health', () => {
  test('reports the network and what has been indexed', async () => {
    const { status, body } = await get('/api/health');
    expect(status).toBe(200);
    expect(body['network'].chainId).toBe(GALILEO.chainId);
    expect(body['indexed'].runs).toBe(1);
    expect(body['contracts'].executionReceipts).toBe(GALILEO.contracts.executionReceipts);
  });
});

describe('runs', () => {
  test('lists runs', async () => {
    const { body } = await get('/api/runs');
    expect(body['runs']).toHaveLength(1);
    expect(body['runs'][0].succeeded).toBe(true);
  });

  test('serves a run with its steps', async () => {
    const { status, body } = await get(`/api/runs/${RUN}`);
    expect(status).toBe(200);
    expect(body['steps']).toHaveLength(2);
    expect(body['steps'][0].statusName).toBe('ok');
    expect(body['steps'][1].attested).toBe(true);
  });

  test('serves the fields a client needs to fold the root itself', async () => {
    // Not a badge: the raw receipt fields, so the browser can recompute.
    const { body } = await get(`/api/runs/${RUN}`);
    for (const key of ['inputHash', 'outputHash', 'traceRoot', 'attestationRef', 'startedAt', 'endedAt', 'status', 'agentId', 'stepIndex']) {
      expect(body['steps'][0]).toHaveProperty(key);
    }
  });

  test('hands out a verify command that names the chain it indexed', async () => {
    // The verifier defaults to Galileo. A mainnet run whose suggested command
    // omits the network sends the reader looking for these receipts on the
    // testnet, where they do not exist, and prints FAILED — sound evidence
    // reported as broken by our own instructions. This ran on Galileo, so the
    // prefix is correctly absent here; the aristotle case is pinned below.
    const { body } = await get(`/api/runs/${RUN}`);
    expect(body['verification'].command).toBe(`npx @0gflow/verify ${RUN}`);
  });

  test('names any network that is not the verifier default', () => {
    expect(verifyCommand(RUN, 'aristotle')).toBe(`ZG_NETWORK=aristotle npx @0gflow/verify ${RUN}`);
    expect(verifyCommand(RUN, 'galileo')).toBe(`npx @0gflow/verify ${RUN}`);
  });

  test('reports whether the folded root matches the seal', async () => {
    const { body } = await get(`/api/runs/${RUN}`);
    expect(body['run'].chainRootMatches).toBe(true);
    expect(body['run'].computedChainRoot).toBe(body['run'].chainRoot);
  });

  test('flags a mismatch rather than hiding it', async () => {
    const other = `0x${'33'.repeat(32)}` as Hex;
    await store.upsertStep({
      ...receipt(0, { runId: other }), runId: other,
      txHash: `0x${'cd'.repeat(32)}`, blockNumber: 20n, blockHash: '0xblock20', logIndex: 0,
    });
    await store.upsertSeal({
      runId: other, chainRoot: `0x${'00'.repeat(31)}01`, stepCount: 1, outcome: 0,
      txHash: `0x${'cd'.repeat(32)}`, blockNumber: 21n, blockHash: '0xblock21',
    });
    const { body } = await get(`/api/runs/${other}`);
    expect(body['run'].chainRootMatches).toBe(false);
  });

  test('offers a copyable verification command', async () => {
    const { body } = await get(`/api/runs/${RUN}`);
    expect(body['verification'].command).toBe(`npx @0gflow/verify ${RUN}`);
    expect(body['verification'].note).toMatch(/proves nothing on its own/i);
  });

  test('404s an unknown run and 400s a malformed one', async () => {
    expect((await get(`/api/runs/0x${'99'.repeat(32)}`)).status).toBe(404);
    expect((await get('/api/runs/nonsense')).status).toBe(400);
  });
});

describe('flows and agents', () => {
  test('serves a flow with its runs', async () => {
    const { status, body } = await get(`/api/flows/${FLOW}`);
    expect(status).toBe(200);
    expect(body['flow'].name).toBe('audit-summarize');
    expect(body['runs'].length).toBeGreaterThanOrEqual(1);
  });

  test('serves agent participation with denominators', async () => {
    const { status, body } = await get('/api/agents/1');
    expect(status).toBe(200);
    // Rates alongside counts: "100% attested" over one step is not the same
    // claim as over a hundred.
    expect(body['agent'].stepCount).toBeGreaterThan(0);
    expect(body['agent'].attestationRate).toBeGreaterThan(0);
    expect(body['agent'].identityRegistry).toBe(GALILEO.contracts.identityRegistry);
  });

  test('400s a non-numeric agent id', async () => {
    // Agents are ERC-721 token ids, not addresses.
    expect((await get('/api/agents/0xabc')).status).toBe(400);
  });

  test('404s an unknown agent', async () => {
    expect((await get('/api/agents/9999')).status).toBe(404);
  });
});

describe('public access', () => {
  test('requires no wallet, auth or cookies', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('serialises bigints as strings rather than crashing', async () => {
    const { body } = await get(`/api/runs/${RUN}`);
    expect(typeof body['steps'][0].agentId).toBe('string');
    expect(typeof body['steps'][0].blockNumber).toBe('string');
  });
});
