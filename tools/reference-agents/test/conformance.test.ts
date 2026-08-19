import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAgentServer } from '../src/serve.js';
import { AGENTS } from '../src/agents.js';

/**
 * A conformance check for the §6.1 contract, run against every reference
 * agent. This is the shape §6.4's `npx @0gflow/conform` will formalise; having
 * it here first means the reference agents cannot drift from the contract they
 * are supposed to demonstrate.
 */

let server: Server;
let base: string;

beforeAll(async () => {
  server = createAgentServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

describe.each(AGENTS.map((a) => [a.id, a] as const))('agent %s', (id, agent) => {
  test('exposes health', async () => {
    const res = await fetch(`${base}/agents/${id}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, agentId: agent.agentId });
  });

  test('exposes input and output schemas', async () => {
    const res = await fetch(`${base}/agents/${id}/schema`);
    expect(res.status).toBe(200);
    const schema = (await res.json()) as Record<string, unknown>;
    expect(schema['input']).toBeDefined();
    expect(schema['output']).toBeDefined();
  });

  test('rejects a request with no input object', async () => {
    const { status, json } = await post(`/agents/${id}/invoke`, { runId: '0x00' });
    expect(status).toBe(400);
    expect((json['error'] as Record<string, unknown>)['retryable']).toBe(false);
  });

  test('answers /invoke with either an output or a structured error', async () => {
    const { status, json } = await post(`/agents/${id}/invoke`, {
      runId: `0x${'22'.repeat(32)}`,
      flowId: `0x${'11'.repeat(32)}`,
      stepIndex: 0,
      input: { repo: 'https://example.test/r', text: 'x', report: 'no critical', body: 'b', grade: 1 },
      deadline: 1_900_000_000,
    });
    if (status === 200) {
      expect(json['output']).toBeDefined();
      expect(json).toHaveProperty('attestation');
    } else {
      const error = json['error'] as Record<string, unknown>;
      expect(typeof error['code']).toBe('string');
      expect(typeof error['message']).toBe('string');
      expect(typeof error['retryable']).toBe('boolean');
    }
  });
});

describe('deterministic behaviour', () => {
  // Linkage means nothing if the same input can produce two different outputs.
  test('the same input yields the same output', async () => {
    const call = () =>
      post('/agents/audit/invoke', { input: { repo: 'https://example.test/repo' } });
    const [a, b] = await Promise.all([call(), call()]);
    expect(a.json['output']).toStrictEqual(b.json['output']);
  });
});

describe('the deliberately misbehaving agents', () => {
  test('always-fails returns a non-retryable error', async () => {
    const { status, json } = await post('/agents/always-fails/invoke', { input: {} });
    expect(status).toBe(422);
    expect((json['error'] as Record<string, unknown>)['retryable']).toBe(false);
  });

  test('never-attests succeeds with a null attestation', async () => {
    const { status, json } = await post('/agents/never-attests/invoke', { input: { text: 'hello' } });
    expect(status).toBe(200);
    expect(json['output']).toBeDefined();
    expect(json['attestation']).toBeNull();
  });

  test('summarize returns an attestation', async () => {
    const { json } = await post('/agents/summarize/invoke', { input: { text: 'hello' } });
    expect(typeof json['attestation']).toBe('string');
  });
});

describe('routing', () => {
  test('lists agents at the root', async () => {
    const res = await fetch(`${base}/`);
    const body = (await res.json()) as { agents: unknown[] };
    expect(body.agents).toHaveLength(AGENTS.length);
  });

  test('404s an unknown agent with a structured error', async () => {
    const { status, json } = await post('/agents/ghost/invoke', { input: {} });
    expect(status).toBe(404);
    expect(json['error']).toBeDefined();
  });
});
