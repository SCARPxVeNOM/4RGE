/**
 * Every check is exercised against an agent that fails it. A conformance suite
 * that has only ever been run against a conformant agent has not been tested —
 * it has been demonstrated.
 */

import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@0gflow/core';
import { runConformance, type ConformanceReport } from '../src/checks.js';
import type { Probe, ProbeResponse } from '../src/probe.js';

const ok = (json: JsonValue): ProbeResponse => ({
  httpStatus: 200,
  json,
  rawExcerpt: JSON.stringify(json),
  durationMs: 3,
  transportError: null,
});

const status = (code: number, json: JsonValue | null): ProbeResponse => ({
  httpStatus: code,
  json,
  rawExcerpt: json === null ? '' : JSON.stringify(json),
  durationMs: 3,
  transportError: null,
});

const dead = (message: string): ProbeResponse => ({
  httpStatus: null,
  json: null,
  rawExcerpt: '',
  durationMs: 15_000,
  transportError: message,
});

const SCHEMA: JsonValue = {
  input: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
  output: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
};

const HEALTH: JsonValue = { ok: true, agentId: '7', version: '1.0.0' };

const REJECT: ProbeResponse = status(400, {
  error: { code: 'bad-request', message: '"input" must be an object', retryable: false },
});

interface FakeAgent {
  health?: ProbeResponse;
  schema?: ProbeResponse;
  /** Called for a well-formed invoke; `call` counts from 1. */
  invoke?: (body: Record<string, JsonValue>, call: number) => ProbeResponse;
  /** Called for an invoke whose envelope carries no `input`. */
  malformed?: ProbeResponse;
}

function fakeProbe(agent: FakeAgent): Probe {
  let calls = 0;
  return {
    get: async (path) =>
      path === 'health' ? (agent.health ?? ok(HEALTH)) : (agent.schema ?? ok(SCHEMA)),
    post: async (_path, body) => {
      const envelope = body as Record<string, JsonValue>;
      if (envelope['input'] === undefined) return agent.malformed ?? REJECT;
      calls += 1;
      return agent.invoke === undefined
        ? ok({ output: { text: 'CONFORMANCE-PROBE' }, attestation: null })
        : agent.invoke(envelope, calls);
    },
  };
}

const run = (agent: FakeAgent): Promise<ConformanceReport> =>
  runConformance({ endpoint: 'http://agent.test', probe: fakeProbe(agent) });

const check = (report: ConformanceReport, id: string) => {
  const result = report.results.find((r) => r.id === id);
  expect(result, `expected a check with id "${id}"`).toBeDefined();
  return result!;
};

describe('a conformant agent', () => {
  it('passes every check', async () => {
    const report = await run({});
    expect(report.conformant).toBe(true);
    expect(report.failures).toBe(0);
    expect(report.warnings).toBe(0);
    for (const result of report.results) expect(result.passed, result.title).toBe(true);
  });

  it('invokes with an input built from the declared schema', async () => {
    let seen: JsonValue | undefined;
    await run({
      invoke: (body) => {
        seen ??= body['input'];
        return ok({ output: { text: 'x' }, attestation: null });
      },
    });
    expect(seen).toEqual({ text: 'conformance-probe' });
  });

  it('sends a complete §6.1 envelope, not just the input', async () => {
    let envelope: Record<string, JsonValue> | undefined;
    await run({
      invoke: (body) => {
        envelope ??= body;
        return ok({ output: {}, attestation: null });
      },
    });
    expect(Object.keys(envelope!).sort()).toEqual([
      'deadline',
      'flowId',
      'input',
      'runId',
      'stepIndex',
    ]);
  });
});

describe('health', () => {
  it('fails when the endpoint is unreachable', async () => {
    const report = await run({ health: dead('connect ECONNREFUSED 127.0.0.1:8710') });
    expect(check(report, 'health').passed).toBe(false);
    expect(check(report, 'health').detail).toContain('ECONNREFUSED');
    expect(report.conformant).toBe(false);
  });

  it('fails when the agent reports itself not ok', async () => {
    const report = await run({ health: ok({ ok: false, agentId: '7', version: '1.0.0' }) });
    expect(check(report, 'health')).toMatchObject({ passed: false, severity: 'fail' });
  });

  it('fails on a non-JSON body, saying what came back instead', async () => {
    const report = await run({
      health: {
        httpStatus: 200,
        json: null,
        rawExcerpt: '<!DOCTYPE html><title>nginx</title>',
        durationMs: 2,
        transportError: null,
      },
    });
    expect(check(report, 'health').detail).toContain('nginx');
  });

  it('warns, not fails, on an unresolvable agentId', async () => {
    // Identity is an ERC-721 token id on both 0G registries. A name is not
    // resolvable against a registry, but it does not stop composition today.
    const report = await run({ health: ok({ ok: true, agentId: 'my-agent', version: '1.0' }) });
    expect(check(report, 'health')).toMatchObject({ passed: false, severity: 'warn' });
    expect(report.conformant).toBe(true);
  });

  it('accepts a hex agentId, as §6.1 shows it', async () => {
    const report = await run({ health: ok({ ok: true, agentId: '0x2a', version: '1.0' }) });
    expect(check(report, 'health').passed).toBe(true);
  });

  it('warns when version is missing', async () => {
    const report = await run({ health: ok({ ok: true, agentId: '7' }) });
    expect(check(report, 'health').detail).toContain('version');
  });
});

describe('schema exposure', () => {
  it('fails when a half is missing', async () => {
    const report = await run({ schema: ok({ input: { type: 'object' } }) });
    expect(check(report, 'schema')).toMatchObject({ passed: false, severity: 'fail' });
    expect(check(report, 'schema').detail).toContain('"output"');
  });

  it('fails on 404 — an agent nobody can introspect cannot be composed', async () => {
    const report = await run({ schema: status(404, { error: 'not found' }) });
    expect(check(report, 'schema').passed).toBe(false);
    expect(report.conformant).toBe(false);
  });

  it('still invokes, warning that no input could be built', async () => {
    const report = await run({ schema: status(404, null) });
    const golden = check(report, 'golden-input');
    expect(golden).toMatchObject({ passed: false, severity: 'warn' });
    // The invocation still happened, so the report says more than "no schema".
    expect(check(report, 'invoke').passed).toBe(true);
  });

  it('warns when the schema is too vague to construct an input from', async () => {
    const report = await run({
      schema: ok({ input: { type: 'object' }, output: { type: 'object' } }),
    });
    expect(check(report, 'schema').passed).toBe(true);
    expect(check(report, 'golden-input')).toMatchObject({ passed: false, severity: 'warn' });
  });
});

describe('golden-input invocation', () => {
  it('fails when a schema-conformant input is rejected', async () => {
    // The agent's own schema produced this input. Rejecting it is a defect in
    // the agent, and precisely what §6.4 exists to catch.
    const report = await run({
      invoke: () => status(422, { error: { code: 'schema', message: 'no', retryable: false } }),
    });
    expect(check(report, 'invoke').passed).toBe(false);
    expect(check(report, 'invoke').detail).toContain('422');
  });

  it('fails when a 200 carries no output', async () => {
    const report = await run({ invoke: () => ok({ attestation: null }) });
    expect(check(report, 'invoke').detail).toContain('no "output"');
  });

  it('fails when output is null: an absent result is not an empty one', async () => {
    const report = await run({ invoke: () => ok({ output: null, attestation: null }) });
    expect(check(report, 'invoke').passed).toBe(false);
  });

  it('accepts an output that is deliberately {}', async () => {
    const report = await run({ invoke: () => ok({ output: {}, attestation: null }) });
    expect(check(report, 'invoke').passed).toBe(true);
  });

  it('fails when the agent hangs', async () => {
    const report = await run({ invoke: () => dead('no response within 15000ms') });
    expect(check(report, 'invoke').detail).toContain('15000ms');
    expect(report.conformant).toBe(false);
  });

  it('skips downstream checks it has no output for, rather than inventing verdicts', async () => {
    const report = await run({ invoke: () => status(500, null) });
    expect(report.results.map((r) => r.id)).not.toContain('determinism');
    expect(report.results.map((r) => r.id)).not.toContain('hashable');
  });
});

describe('attestation', () => {
  it('passes on an explicit null', async () => {
    const report = await run({ invoke: () => ok({ output: { a: 1 }, attestation: null }) });
    expect(check(report, 'attestation').passed).toBe(true);
    expect(check(report, 'attestation').detail).toContain('does not attest');
  });

  it('passes on a non-empty string', async () => {
    const report = await run({ invoke: () => ok({ output: { a: 1 }, attestation: 'BAACAIEA' }) });
    expect(check(report, 'attestation').passed).toBe(true);
  });

  it('warns when the field is absent', async () => {
    // Absent and null mean the same thing to the executor, but only one of
    // them distinguishes "does not attest" from "lost in transit".
    const report = await run({ invoke: () => ok({ output: { a: 1 } }) });
    expect(check(report, 'attestation')).toMatchObject({ passed: false, severity: 'warn' });
    expect(report.conformant).toBe(true);
  });

  it('fails on a non-string, non-null attestation', async () => {
    const report = await run({
      invoke: () => ok({ output: { a: 1 }, attestation: { quote: 'x' } as unknown as JsonValue }),
    });
    expect(check(report, 'attestation')).toMatchObject({ passed: false, severity: 'fail' });
  });

  it('fails on an empty-string attestation, which digests to a lie', async () => {
    const report = await run({ invoke: () => ok({ output: { a: 1 }, attestation: '' }) });
    expect(check(report, 'attestation').passed).toBe(false);
  });
});

describe('hashability', () => {
  it('fails on an output the frozen canonicaliser rejects', async () => {
    // A lone surrogate has no valid UTF-8 encoding, so §5.2 refuses it and the
    // step could never be anchored.
    const report = await run({
      invoke: () => ok({ output: { text: '\ud800' }, attestation: null }),
    });
    expect(check(report, 'hashable')).toMatchObject({ passed: false, severity: 'fail' });
    expect(report.conformant).toBe(false);
  });

  it('passes on ordinary output including non-ASCII', async () => {
    const report = await run({
      invoke: () => ok({ output: { text: 'héllo — 世界', n: 1e21 }, attestation: null }),
    });
    expect(check(report, 'hashable').passed).toBe(true);
  });
});

describe('determinism', () => {
  it('fails when two identical calls differ', async () => {
    const report = await run({
      invoke: (_body, call) => ok({ output: { at: `2026-01-01T00:00:0${call}Z` }, attestation: null }),
    });
    const result = check(report, 'determinism');
    expect(result).toMatchObject({ passed: false, severity: 'fail' });
    expect(result.detail).toContain('timestamps');
    expect(report.conformant).toBe(false);
  });

  it('passes when key order differs but the canonical form does not', async () => {
    // RFC 8785 sorts keys, so an agent whose serialiser reorders them is still
    // deterministic where it counts. Comparing raw bodies would flag this.
    const report = await run({
      invoke: (_body, call) =>
        ok({
          output: call === 1 ? { a: 1, b: 2 } : { b: 2, a: 1 },
          attestation: null,
        }),
    });
    expect(check(report, 'determinism').passed).toBe(true);
  });

  it('fails when the second call errors', async () => {
    const report = await run({
      invoke: (_b, call) =>
        call === 1 ? ok({ output: { a: 1 }, attestation: null }) : status(503, null),
    });
    expect(check(report, 'determinism').passed).toBe(false);
  });

  it('ignores a differing attestation: only the output is hashed into linkage', async () => {
    const report = await run({
      invoke: (_b, call) => ok({ output: { a: 1 }, attestation: `nonce-${call}` }),
    });
    expect(check(report, 'determinism').passed).toBe(true);
  });
});

describe('error shape', () => {
  it('fails when a request with no input is accepted', async () => {
    const report = await run({ malformed: ok({ output: { invented: true }, attestation: null }) });
    expect(check(report, 'error-shape').passed).toBe(false);
    expect(check(report, 'error-shape').detail).toContain('invents an input');
  });

  it('fails when the error is not in an envelope', async () => {
    const report = await run({ malformed: status(400, { message: 'bad request' }) });
    expect(check(report, 'error-shape').passed).toBe(false);
  });

  it('fails on a plain-text error body', async () => {
    const report = await run({
      malformed: {
        httpStatus: 400,
        json: null,
        rawExcerpt: 'Bad Request',
        durationMs: 1,
        transportError: null,
      },
    });
    expect(check(report, 'error-shape').detail).toContain('Bad Request');
  });

  it('fails when code or message is missing', async () => {
    const report = await run({ malformed: status(400, { error: { retryable: false } }) });
    const result = check(report, 'error-shape');
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('"code"');
    expect(result.detail).toContain('"message"');
  });

  it('fails when a deterministic failure claims to be retryable', async () => {
    // Four attempts to relearn the first answer, spending the caller's whole
    // deadline on it.
    const report = await run({
      malformed: status(400, { error: { code: 'x', message: 'y', retryable: true } }),
    });
    expect(check(report, 'error-retryable')).toMatchObject({ passed: false, severity: 'fail' });
    expect(report.conformant).toBe(false);
  });

  it('fails on a non-boolean retryable', async () => {
    const report = await run({
      malformed: status(400, { error: { code: 'x', message: 'y', retryable: 'no' } }),
    });
    expect(check(report, 'error-retryable')).toMatchObject({ passed: false, severity: 'fail' });
  });

  it('warns when retryable is absent, since the executor defaults it safely', async () => {
    const report = await run({ malformed: status(400, { error: { code: 'x', message: 'y' } }) });
    expect(check(report, 'error-retryable')).toMatchObject({ passed: false, severity: 'warn' });
    expect(report.conformant).toBe(true);
  });

  it('accepts any 4xx or 5xx, not one particular code', async () => {
    for (const code of [400, 422, 500]) {
      const report = await run({
        malformed: status(code, { error: { code: 'x', message: 'y', retryable: false } }),
      });
      expect(check(report, 'error-shape').passed, `HTTP ${code}`).toBe(true);
    }
  });
});

describe('timeout behaviour', () => {
  it('passes when the agent honours an expired deadline', async () => {
    const report = await run({
      invoke: (body) =>
        Number(body['deadline']) * 1000 < Date.now()
          ? status(504, { error: { code: 'deadline', message: 'expired', retryable: false } })
          : ok({ output: { a: 1 }, attestation: null }),
    });
    expect(check(report, 'deadline').passed).toBe(true);
    expect(check(report, 'deadline').detail).toContain('honoured');
  });

  it('passes, with a note, when the agent answers anyway', async () => {
    // The executor enforces timeoutMs on its side, so ignoring the deadline is
    // tolerable. Going silent is not.
    const report = await run({});
    expect(check(report, 'deadline').passed).toBe(true);
    expect(check(report, 'deadline').detail).toContain('rather than hanging');
  });

  it('does not credit deadline enforcement to an agent that errors regardless', async () => {
    // always-fails answers 4xx to everything. Reading that as "honoured the
    // deadline" would attribute a behaviour it does not have.
    const report = await run({
      invoke: () => status(422, { error: { code: 'x', message: 'y', retryable: false } }),
    });
    const result = check(report, 'deadline');
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('not demonstrated');
    expect(result.detail).not.toContain('honoured');
  });

  it('fails when the agent goes silent on an expired deadline', async () => {
    const report = await run({
      invoke: (body) =>
        Number(body['deadline']) * 1000 < Date.now()
          ? dead('no response within 15000ms')
          : ok({ output: { a: 1 }, attestation: null }),
    });
    expect(check(report, 'deadline')).toMatchObject({ passed: false, severity: 'fail' });
    expect(report.conformant).toBe(false);
  });
});

describe('the verdict', () => {
  it('warnings alone never make a run non-conformant', async () => {
    const report = await run({
      health: ok({ ok: true, agentId: 'named-agent' }),
      invoke: () => ok({ output: { a: 1 } }),
      malformed: status(400, { error: { code: 'x', message: 'y' } }),
    });
    expect(report.warnings).toBeGreaterThan(0);
    expect(report.failures).toBe(0);
    expect(report.conformant).toBe(true);
  });

  it('counts every failure rather than stopping at the first', async () => {
    const report = await run({
      health: status(500, null),
      schema: status(500, null),
      invoke: () => status(500, null),
      malformed: ok({ output: {} }),
    });
    expect(report.failures).toBeGreaterThanOrEqual(4);
    expect(report.conformant).toBe(false);
  });

  it('carries the endpoint through to the report', async () => {
    const report = await run({});
    expect(report.endpoint).toBe('http://agent.test');
  });
});
