import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hashJson, verifyAgentSignature, type Hex, type JsonValue } from '@0gflow/core';
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
    expect(await res.json()).toMatchObject({
      ok: true,
      agentId: agent.identity.agentId,
      signer: agent.identity.address,
    });
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

/**
 * The identities are only worth having if the signatures they produce
 * actually verify. This checks the whole path the executor walks: the server
 * signs, and `verifyAgentSignature` — the same function the executor and the
 * verifier call — recovers the agent's published key from it.
 */
describe('each agent proves its own identity', () => {
  const CHAIN_ID = 31337;
  const RECEIPTS = '0x741a36faba40ee71223539a5a062fdedc8574e30' as Hex;
  const RUN_ID = `0x${'22'.repeat(32)}` as Hex;

  // The agents that return an output at all; always-fails never does.
  const producers = AGENTS.filter((a) => a.id !== 'always-fails');

  const invoke = (agent: (typeof AGENTS)[number], input: Record<string, JsonValue>) =>
    post(`/agents/${agent.id}/invoke`, {
      runId: RUN_ID,
      flowId: `0x${'11'.repeat(32)}`,
      stepIndex: 3,
      input,
      deadline: Math.floor(Date.now() / 1000) + 30,
      chainId: CHAIN_ID,
      receipts: RECEIPTS,
    });

  const INPUTS: Record<string, Record<string, JsonValue>> = {
    audit: { repo: 'https://example.test/repo' },
    summarize: { text: 'a report' },
    score: { report: 'no critical findings' },
    publish: { body: 'body text', grade: 90 },
    'never-attests': { text: 'a report' },
  };

  test.each(producers.map((a) => [a.id, a] as const))(
    '%s signs an output that recovers to its registered key',
    async (id, agent) => {
      const { status, json } = await invoke(agent, INPUTS[id] ?? {});
      expect(status).toBe(200);

      const signature = json['outputSignature'] as Hex;
      expect(signature).toMatch(/^0x[0-9a-f]{130}$/);

      const claim = {
        chainId: CHAIN_ID,
        receipts: RECEIPTS,
        runId: RUN_ID,
        stepIndex: 3,
        agentId: BigInt(agent.identity.agentId),
        inputHash: hashJson(INPUTS[id] ?? {}),
        outputHash: hashJson(json['output'] as JsonValue),
      };

      expect(verifyAgentSignature(claim, signature, agent.identity.address as Hex)).toBe(true);
    },
  );

  test('one agent cannot sign for another', async () => {
    // The concrete thing distinct identities buy: audit's signature must not
    // verify as summarize's, even on identical bytes.
    const audit = AGENTS.find((a) => a.id === 'audit')!;
    const summarize = AGENTS.find((a) => a.id === 'summarize')!;
    expect(audit.identity.address).not.toBe(summarize.identity.address);
    expect(audit.identity.agentId).not.toBe(summarize.identity.agentId);

    const { json } = await invoke(audit, INPUTS['audit']!);
    const claim = {
      chainId: CHAIN_ID,
      receipts: RECEIPTS,
      runId: RUN_ID,
      stepIndex: 3,
      agentId: BigInt(audit.identity.agentId),
      inputHash: hashJson(INPUTS['audit']!),
      outputHash: hashJson(json['output'] as JsonValue),
    };

    expect(
      verifyAgentSignature(claim, json['outputSignature'] as Hex, summarize.identity.address as Hex),
    ).toBe(false);
  });

  test('no signature is produced when the executor did not say where it anchors', async () => {
    // An older executor sends no chainId. A signature not bound to a chain and
    // contract would be valid against every deployment, which is worse than
    // none — so the server returns none.
    const { json } = await post(`/agents/audit/invoke`, {
      runId: RUN_ID,
      stepIndex: 3,
      input: INPUTS['audit'],
      deadline: Math.floor(Date.now() / 1000) + 30,
    });
    expect(json['outputSignature']).toBeNull();
    expect(json['output']).toBeDefined();
  });
});
