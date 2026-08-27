/**
 * The SDK's job is to make the §6.1 contract hard to get wrong, so these tests
 * are mostly about the failure shapes rather than the happy path: an agent that
 * returns the right answer is easy, and an agent that reports a failure in a
 * form the executor misreads is the expensive kind of bug.
 */

import { describe, expect, it } from 'vitest';
import {
  AgentError,
  SchemaError,
  handleInvoke,
  healthBody,
  require_,
  routeAgentRequest,
  schemaBody,
  type AgentDefinition,
  type JsonValue,
} from '../src/index.js';

const request = (input: Record<string, JsonValue>) => ({
  runId: '0x' + '11'.repeat(32),
  flowId: '0x' + '22'.repeat(32),
  stepIndex: 0,
  input,
  deadline: 1_800_000_000,
});

const echo: AgentDefinition = {
  agentId: '42',
  version: '2.1.0',
  schema: { input: { text: 'string' }, output: { text: 'string' } },
  invoke(req) {
    return { output: { text: require_.string(req.input, 'text').toUpperCase() } };
  },
};

/** Reaches into the response body without `any` at every call site. */
const body = (r: { body: JsonValue }) => r.body as Record<string, JsonValue>;
const errorOf = (r: { body: JsonValue }) =>
  body(r)['error'] as { code: string; message: string; retryable: boolean };

describe('handleInvoke', () => {
  it('returns the output and an explicit null attestation when there is none', async () => {
    const result = await handleInvoke(echo, request({ text: 'hello' }));

    expect(result.status).toBe(200);
    expect(body(result)['output']).toEqual({ text: 'HELLO' });
    // Present-and-null, not absent: the executor distinguishes "this agent
    // does not attest" from "this field went missing in transit".
    expect(body(result)).toHaveProperty('attestation', null);
  });

  it('passes an attestation through byte-for-byte', async () => {
    const raw = 'BAACAIEAAAAAAAAAk5pyM/ecTKmUCg2zlX8GB//==';
    const attesting: AgentDefinition = {
      ...echo,
      invoke: () => ({ output: { ok: true }, attestation: raw }),
    };

    const result = await handleInvoke(attesting, request({ text: 'x' }));

    // Re-encoding here would change attestationRef and break verification.
    expect(body(result)['attestation']).toBe(raw);
  });

  it('passes a well-formed attestation binding through', async () => {
    const binding = {
      chatID: 'chat-1',
      model: 'qwen/qwen2.5-omni-7b',
      // A digest envelope, as 0G Compute actually signs.
      text: `${'aa'.repeat(32)}:${'bb'.repeat(32)}:centralized:test:${'cc'.repeat(32)}`,
      signature: `0x${'ab'.repeat(65)}`,
      responseBody: '{"choices":[{"message":{"content":"Summary: ok."}}]}',
      responsePath: '$.choices[0].message.content',
      outputPath: '$.text',
    };
    const attesting: AgentDefinition = {
      ...echo,
      invoke: () => ({ output: { text: 'Summary: ok.' }, attestation: 'quote', attestationBinding: binding }),
    };

    const result = await handleInvoke(attesting, request({ text: 'x' }));
    expect(body(result)['attestationBinding']).toEqual(binding);
  });

  it('reports an explicit null binding, so absent and lost are distinguishable', async () => {
    const result = await handleInvoke(echo, request({ text: 'x' }));
    expect(body(result)).toHaveProperty('attestationBinding', null);
  });

  it('rejects a half-filled binding rather than anchoring an uncheckable one', async () => {
    // A binding missing a field would still be digested into attestationRef,
    // and the step would look attested while proving nothing.
    for (const missing of [
      'chatID',
      'model',
      'text',
      'signature',
      'responseBody',
      'responsePath',
      'outputPath',
    ]) {
      const binding: Record<string, string> = {
        chatID: 'c',
        model: 'm',
        text: 't',
        signature: '0xab',
        responseBody: '{}',
        responsePath: '$',
        outputPath: '$',
      };
      delete binding[missing];

      const broken: AgentDefinition = {
        ...echo,
        invoke: () =>
          ({ output: { text: 't' }, attestation: 'q', attestationBinding: binding }) as never,
      };

      const result = await handleInvoke(broken, request({ text: 'x' }));
      expect(result.status, missing).toBe(500);
      expect(errorOf(result).code).toBe('bad-binding');
    }
  });

  it('rejects a request with no input object rather than inventing one', async () => {
    for (const bad of [null, undefined, 42, 'string', [], {}, { input: null }, { input: [] }]) {
      const result = await handleInvoke(echo, bad);
      expect(result.status).toBe(400);
      expect(errorOf(result).code).toBe('bad-request');
    }
  });

  it('treats an agent that returns no output as a failure, not as an empty result', async () => {
    const silent = { ...echo, invoke: () => ({}) } as unknown as AgentDefinition;

    const result = await handleInvoke(silent, request({ text: 'x' }));

    expect(result.status).toBe(500);
    expect(errorOf(result).code).toBe('no-output');
    // Anchoring hashJson({}) here would commit to a claim the agent never made.
    expect(body(result)).not.toHaveProperty('output');
  });

  it('preserves an output that is legitimately empty', async () => {
    const empty: AgentDefinition = { ...echo, invoke: () => ({ output: {} }) };

    const result = await handleInvoke(empty, request({ text: 'x' }));

    // `{}` deliberately returned is a real answer; only its *absence* is not.
    expect(result.status).toBe(200);
    expect(body(result)['output']).toEqual({});
  });

  it('carries the agent-declared retryable flag and status through', async () => {
    const flaky: AgentDefinition = {
      ...echo,
      invoke: () => {
        throw new AgentError('upstream timed out', 'upstream', true, 504);
      },
    };

    const result = await handleInvoke(flaky, request({ text: 'x' }));

    expect(result.status).toBe(504);
    expect(errorOf(result)).toEqual({
      code: 'upstream',
      message: 'upstream timed out',
      retryable: true,
    });
  });

  it('defaults an unqualified AgentError to non-retryable', async () => {
    const failing: AgentDefinition = {
      ...echo,
      invoke: () => {
        throw new AgentError('nope', 'domain');
      },
    };

    // Silence is not consent to retry: repeating a deterministic failure four
    // times just burns the caller's deadline.
    expect(errorOf(await handleInvoke(failing, request({ text: 'x' }))).retryable).toBe(false);
  });

  it('wraps an unexpected throw as a non-retryable internal error', async () => {
    const broken: AgentDefinition = {
      ...echo,
      invoke: () => {
        throw new TypeError('cannot read properties of undefined');
      },
    };

    const result = await handleInvoke(broken, request({ text: 'x' }));

    expect(result.status).toBe(500);
    expect(errorOf(result).code).toBe('internal');
    expect(errorOf(result).retryable).toBe(false);
  });

  it('reports a schema violation as 422 and non-retryable', async () => {
    const result = await handleInvoke(echo, request({ text: 12 as unknown as JsonValue }));

    expect(result.status).toBe(422);
    expect(errorOf(result)).toEqual({
      code: 'schema',
      message: '"text" must be a string',
      retryable: false,
    });
  });

  it('awaits an async invoke', async () => {
    const slow: AgentDefinition = {
      ...echo,
      invoke: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { output: { done: true } };
      },
    };

    expect(body(await handleInvoke(slow, request({}))) ['output']).toEqual({ done: true });
  });

  it('accepts a partial envelope, defaulting only the fields it can', async () => {
    // A caller that omits runId is out of spec, but the input is what gets
    // hashed — refusing to run over a missing label would help nobody.
    const result = await handleInvoke(echo, { input: { text: 'a' } });
    expect(result.status).toBe(200);
  });
});

describe('require_', () => {
  it('accepts well-typed fields and returns them narrowed', () => {
    const input: Record<string, JsonValue> = { s: 'x', n: 1.5, o: { k: 1 } };
    expect(require_.string(input, 's')).toBe('x');
    expect(require_.number(input, 'n')).toBe(1.5);
    expect(require_.object(input, 'o')).toEqual({ k: 1 });
  });

  it('rejects a non-finite number, which has no JSON form to hash', () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => require_.number({ n: value }, 'n')).toThrow(SchemaError);
    }
  });

  it('rejects arrays and null where an object is required', () => {
    expect(() => require_.object({ o: [] }, 'o')).toThrow('"o" must be an object');
    expect(() => require_.object({ o: null }, 'o')).toThrow(SchemaError);
  });

  it('rejects a missing field by name', () => {
    expect(() => require_.string({}, 'absent')).toThrow('"absent" must be a string');
  });

  it('marks every schema failure non-retryable: the same input fails the same way', () => {
    try {
      require_.string({}, 'x');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentError);
      expect((error as AgentError).retryable).toBe(false);
      expect((error as AgentError).status).toBe(422);
    }
  });
});

describe('routeAgentRequest', () => {
  it('serves health and schema on GET', async () => {
    const health = await routeAgentRequest(echo, 'GET', '/health', null);
    expect(health).toEqual({ status: 200, body: healthBody(echo) });
    expect(healthBody(echo)).toEqual({ ok: true, agentId: '42', version: '2.1.0' });

    const schema = await routeAgentRequest(echo, 'GET', '/schema', null);
    expect(schema).toEqual({ status: 200, body: schemaBody(echo) });
  });

  it('defaults the reported version rather than omitting it', () => {
    const { version, ...rest } = echo;
    void version;
    expect(healthBody(rest as AgentDefinition)).toMatchObject({ version: '1.0.0' });
  });

  it('routes invoke and tolerates a mount prefix or trailing slash', async () => {
    for (const path of ['/invoke', '/agents/echo/invoke', '/invoke/']) {
      const result = await routeAgentRequest(echo, 'POST', path, request({ text: 'q' }));
      expect(result?.status).toBe(200);
    }
  });

  it('returns 405 for invoke with the wrong method', async () => {
    const result = await routeAgentRequest(echo, 'GET', '/invoke', null);
    expect(result?.status).toBe(405);
    expect(errorOf(result!).code).toBe('method-not-allowed');
  });

  it('returns null for a path it does not own, so a host can mount its own', async () => {
    expect(await routeAgentRequest(echo, 'GET', '/metrics', null)).toBeNull();
    expect(await routeAgentRequest(echo, 'POST', '/', null)).toBeNull();
  });
});
