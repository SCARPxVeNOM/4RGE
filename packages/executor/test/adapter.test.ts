import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { invokeHttpAdapter, AdapterError } from '../src/adapter.js';

/**
 * Exercised against a real HTTP server rather than a mocked transport. The
 * behaviours that matter here — timeouts, retries, malformed bodies — are
 * properties of actual sockets, and a mock would only confirm that the mock
 * behaves as written.
 */

interface Handler {
  (body: Record<string, unknown>, attempt: number): {
    status: number;
    json?: unknown;
    raw?: string;
    delayMs?: number;
  };
}

let server: Server;
let baseUrl: string;
let handler: Handler;
let attempts = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, agentId: '1', version: '1.0.0' }));
        return;
      }
      attempts += 1;
      const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>) : {};
      const result = handler(body, attempts);
      const send = () => {
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(result.raw ?? JSON.stringify(result.json ?? {}));
      };
      if (result.delayMs !== undefined) setTimeout(send, result.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const request = {
  runId: `0x${'22'.repeat(32)}`,
  flowId: `0x${'11'.repeat(32)}`,
  stepIndex: 0,
  input: { repo: 'https://example.test/repo' },
  deadline: 1_900_000_000,
};

/** No real waiting: retry timing is asserted from the recorded delays. */
const noSleep = { sleep: async () => {} };

function reset(h: Handler) {
  attempts = 0;
  handler = h;
}

describe('a successful invocation', () => {
  test('returns the output', async () => {
    reset(() => ({ status: 200, json: { output: { report: 'findings' }, attestation: null, meta: { durationMs: 5 } } }));
    const result = await invokeHttpAdapter(baseUrl, request, { timeoutMs: 5000, ...noSleep });
    expect(result.output).toStrictEqual({ report: 'findings' });
    expect(result.attestation).toBeNull();
    expect(result.attempts).toHaveLength(1);
  });

  test('sends the documented request envelope', async () => {
    let seen: Record<string, unknown> = {};
    reset((body) => {
      seen = body;
      return { status: 200, json: { output: {} } };
    });
    await invokeHttpAdapter(baseUrl, request, { timeoutMs: 5000, ...noSleep });
    expect(Object.keys(seen).sort()).toStrictEqual(['deadline', 'flowId', 'input', 'runId', 'stepIndex']);
    expect(seen['runId']).toBe(request.runId);
    expect(seen['input']).toStrictEqual(request.input);
  });

  test('carries an attestation through untouched', async () => {
    const attestation = Buffer.from('quote').toString('base64');
    reset(() => ({ status: 200, json: { output: {}, attestation } }));
    const result = await invokeHttpAdapter(baseUrl, request, { timeoutMs: 5000, ...noSleep });
    expect(result.attestation).toBe(attestation);
  });
});

describe('retry policy (§7.4)', () => {
  test('retries when the adapter says the error is retryable', async () => {
    reset((_b, attempt) =>
      attempt < 3
        ? { status: 503, json: { error: { code: 'busy', message: 'try later', retryable: true } } }
        : { status: 200, json: { output: { ok: true } } },
    );
    const result = await invokeHttpAdapter(baseUrl, request, {
      timeoutMs: 5000,
      retries: { max: 3, backoffMs: 10 },
      ...noSleep,
    });
    expect(result.output).toStrictEqual({ ok: true });
    expect(result.attempts).toHaveLength(3);
  });

  test('does not retry when the adapter says the error is not retryable', async () => {
    // Retrying a deterministic failure just burns the deadline.
    reset(() => ({ status: 400, json: { error: { code: 'bad-input', message: 'no', retryable: false } } }));
    await expect(
      invokeHttpAdapter(baseUrl, request, { timeoutMs: 5000, retries: { max: 5, backoffMs: 10 }, ...noSleep }),
    ).rejects.toThrow(AdapterError);
    expect(attempts).toBe(1);
  });

  test('does not retry by default', async () => {
    reset(() => ({ status: 503, json: { error: { code: 'busy', message: 'x', retryable: true } } }));
    await expect(invokeHttpAdapter(baseUrl, request, { timeoutMs: 5000, ...noSleep })).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  test('gives up after max attempts and reports every one', async () => {
    reset(() => ({ status: 503, json: { error: { code: 'busy', message: 'x', retryable: true } } }));
    try {
      await invokeHttpAdapter(baseUrl, request, {
        timeoutMs: 5000,
        retries: { max: 2, backoffMs: 10 },
        ...noSleep,
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).attempts).toHaveLength(2);
      expect(attempts).toBe(2);
    }
  });

  test('backs off exponentially with jitter inside the expected band', async () => {
    const delays: number[] = [];
    reset(() => ({ status: 503, json: { error: { code: 'busy', message: 'x', retryable: true } } }));
    await invokeHttpAdapter(baseUrl, request, {
      timeoutMs: 5000,
      retries: { max: 4, backoffMs: 100 },
      sleep: async (ms) => void delays.push(ms),
      random: () => 0.5,
    }).catch(() => {});

    // base * 2^n, plus up to 100% jitter; random()=0.5 puts it mid-band.
    expect(delays).toHaveLength(3);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[0]).toBeLessThanOrEqual(200);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
    expect(delays[1]).toBeLessThanOrEqual(400);
    expect(delays[2]).toBeGreaterThanOrEqual(400);
    expect(delays[2]).toBeLessThanOrEqual(800);
  });
});

describe('timeout (§7.4)', () => {
  test('aborts a response that exceeds timeoutMs', async () => {
    reset(() => ({ status: 200, json: { output: {} }, delayMs: 400 }));
    await expect(
      invokeHttpAdapter(baseUrl, request, { timeoutMs: 80, ...noSleep }),
    ).rejects.toThrow(/timed out|timeout/i);
  });

  test('a timeout is retryable', async () => {
    // A slow agent may simply be loaded; the failure is not deterministic.
    reset((_b, attempt) =>
      attempt === 1 ? { status: 200, json: { output: {} }, delayMs: 400 } : { status: 200, json: { output: { ok: true } } },
    );
    const result = await invokeHttpAdapter(baseUrl, request, {
      timeoutMs: 120,
      retries: { max: 2, backoffMs: 5 },
      ...noSleep,
    });
    expect(result.output).toStrictEqual({ ok: true });
  });
});

describe('malformed adapter responses', () => {
  test('rejects a 200 with no output field', async () => {
    // Treating a missing output as {} would anchor a hash of nothing.
    reset(() => ({ status: 200, json: { meta: {} } }));
    await expect(invokeHttpAdapter(baseUrl, request, { timeoutMs: 5000, ...noSleep })).rejects.toThrow(
      /output/i,
    );
  });

  test('rejects a 200 that is not JSON', async () => {
    reset(() => ({ status: 200, raw: 'not json' }));
    await expect(invokeHttpAdapter(baseUrl, request, { timeoutMs: 5000, ...noSleep })).rejects.toThrow(
      /json/i,
    );
  });

  test('rejects an output that cannot be canonicalized', async () => {
    // NaN has no JSON form; hashing it would be impossible later anyway.
    reset(() => ({ status: 200, raw: '{"output":{"v":NaN}}' }));
    await expect(invokeHttpAdapter(baseUrl, request, { timeoutMs: 5000, ...noSleep })).rejects.toThrow();
  });

  test('surfaces the adapter error code and message', async () => {
    reset(() => ({ status: 422, json: { error: { code: 'schema', message: 'input invalid', retryable: false } } }));
    try {
      await invokeHttpAdapter(baseUrl, request, { timeoutMs: 5000, ...noSleep });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AdapterError).code).toBe('schema');
      expect((error as AdapterError).message).toMatch(/input invalid/);
      expect((error as AdapterError).retryable).toBe(false);
    }
  });

  test('treats an error body with no retryable flag as not retryable', async () => {
    // Default to not retrying: repeating a call whose safety is unstated is
    // the riskier assumption.
    reset(() => ({ status: 500, json: { error: { code: 'x', message: 'y' } } }));
    await expect(
      invokeHttpAdapter(baseUrl, request, { timeoutMs: 5000, retries: { max: 3, backoffMs: 5 }, ...noSleep }),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  test('reports a connection failure rather than hanging', async () => {
    await expect(
      invokeHttpAdapter('http://127.0.0.1:1', request, { timeoutMs: 2000, ...noSleep }),
    ).rejects.toThrow(AdapterError);
  });
});

describe('attempt records', () => {
  test('record status and error for every attempt, for the trace', async () => {
    reset((_b, attempt) =>
      attempt === 1
        ? { status: 503, json: { error: { code: 'busy', message: 'later', retryable: true } } }
        : { status: 200, json: { output: { ok: true } } },
    );
    const result = await invokeHttpAdapter(baseUrl, request, {
      timeoutMs: 5000,
      retries: { max: 2, backoffMs: 5 },
      ...noSleep,
    });
    expect(result.attempts[0]!.status).toBe(503);
    expect(result.attempts[0]!.error).toMatch(/later/);
    expect(result.attempts[1]!.status).toBe(200);
    expect(result.attempts[1]!.error).toBeNull();
    expect(result.attempts.every((a) => typeof a.durationMs === 'number')).toBe(true);
  });
});
