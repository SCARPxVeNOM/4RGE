/**
 * The conformance checks — spec §6.4.
 *
 * "Validates schema exposure, health, golden-input invocation, timeout
 * behaviour, and error shape. Passing is the criterion for composability."
 *
 * Two checks go past that list, and both come from §4.1 rather than §6:
 *
 *   determinism — the linkage invariant says step N's input must be
 *     re-derivable from step K's output. An agent that returns a timestamp or
 *     a random id produces runs that verify once and never again. This is the
 *     single most common way an otherwise correct agent makes a flow
 *     unverifiable, and it is invisible until someone tries to verify.
 *
 *   hashability — the output is hashed through the frozen §5.2 canonicaliser.
 *     An output that canonicalisation rejects can never be anchored, so an
 *     agent emitting one is broken no matter what its schema says.
 *
 * Severity is the honest distinction between "this agent cannot be composed"
 * and "this agent is doing something unusual". A warning never fails the run,
 * because a suite that cries wolf gets ignored, and one that is ignored may as
 * well not exist.
 */

import { hashJson, type JsonValue } from '@0gflow/core';
import { goldenInput } from './golden.js';
import type { Probe, ProbeResponse } from './probe.js';

export type Severity = 'fail' | 'warn';

export interface CheckResult {
  readonly id: string;
  readonly title: string;
  readonly passed: boolean;
  /** Meaningful only when `passed` is false. */
  readonly severity: Severity;
  readonly detail: string;
  readonly durationMs?: number;
}

export interface ConformanceReport {
  readonly endpoint: string;
  readonly results: readonly CheckResult[];
  /** True when no check failed at `fail` severity. */
  readonly conformant: boolean;
  readonly failures: number;
  readonly warnings: number;
}

const pass = (id: string, title: string, detail: string, durationMs?: number): CheckResult => ({
  id,
  title,
  passed: true,
  severity: 'fail',
  detail,
  ...(durationMs === undefined ? {} : { durationMs }),
});

const fail = (id: string, title: string, detail: string): CheckResult => ({
  id,
  title,
  passed: false,
  severity: 'fail',
  detail,
});

const warn = (id: string, title: string, detail: string): CheckResult => ({
  id,
  title,
  passed: false,
  severity: 'warn',
  detail,
});

const isObject = (v: unknown): v is Record<string, JsonValue> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Describes what came back when it was not what we hoped for. */
function describe(response: ProbeResponse): string {
  if (response.transportError !== null) return response.transportError;
  if (response.json === null) {
    return response.rawExcerpt.length === 0
      ? `HTTP ${response.httpStatus} with an empty body`
      : `HTTP ${response.httpStatus} with a non-JSON body: ${response.rawExcerpt}`;
  }
  return `HTTP ${response.httpStatus}: ${JSON.stringify(response.json).slice(0, 300)}`;
}

export interface RunOptions {
  readonly endpoint: string;
  readonly probe: Probe;
  /** Overrides the schema-derived golden input, for agents with odd schemas. */
  readonly input?: Record<string, JsonValue>;
}

const RUN_ID = `0x${'11'.repeat(32)}`;
const FLOW_ID = `0x${'22'.repeat(32)}`;

const envelope = (input: Record<string, JsonValue>, deadline: number): JsonValue => ({
  runId: RUN_ID,
  flowId: FLOW_ID,
  stepIndex: 0,
  input,
  deadline,
});

export async function runConformance(options: RunOptions): Promise<ConformanceReport> {
  const { probe, endpoint } = options;
  const results: CheckResult[] = [];

  // --- health -------------------------------------------------------------
  const health = await probe.get('health');
  results.push(checkHealth(health));

  // --- schema exposure ----------------------------------------------------
  const schema = await probe.get('schema');
  const schemaCheck = checkSchema(schema);
  results.push(schemaCheck);

  const inputSchema =
    isObject(schema.json) && schema.json['input'] !== undefined ? schema.json['input'] : null;

  // --- golden input construction -----------------------------------------
  let input: Record<string, JsonValue>;
  if (options.input !== undefined) {
    input = options.input;
    results.push(
      pass('golden-input', 'Golden input', 'supplied by the caller; schema not exercised'),
    );
  } else if (inputSchema === null) {
    input = {};
    results.push(
      warn(
        'golden-input',
        'Golden input',
        'no input schema to build from; invoking with {} — a stranger could not construct a call from this agent',
      ),
    );
  } else {
    const built = goldenInput(inputSchema);
    input = built.input;
    results.push(
      built.opaque === null
        ? pass(
            'golden-input',
            'Golden input',
            `built from the declared schema: ${JSON.stringify(built.input).slice(0, 200)}`,
          )
        : warn(
            'golden-input',
            'Golden input',
            `${built.opaque}; invoking with {} instead. Add types, examples or defaults so a caller can construct an input from /schema alone`,
          ),
    );
  }

  // --- golden-input invocation -------------------------------------------
  const future = Math.floor(Date.now() / 1000) + 60;
  const first = await probe.post('invoke', envelope(input, future));
  const invokeCheck = checkInvoke(first);
  results.push(invokeCheck);

  const output = invokeCheck.passed && isObject(first.json) ? first.json['output'] : undefined;

  // --- attestation field --------------------------------------------------
  if (invokeCheck.passed && isObject(first.json)) {
    results.push(checkAttestation(first.json));
  }

  // --- hashability --------------------------------------------------------
  if (output !== undefined) {
    results.push(checkHashable(output));
  }

  // --- determinism --------------------------------------------------------
  if (output !== undefined) {
    const second = await probe.post('invoke', envelope(input, future));
    results.push(checkDeterminism(output, second));
  }

  // --- error shape --------------------------------------------------------
  results.push(...(await checkErrorShape(probe)));

  // --- timeout behaviour --------------------------------------------------
  results.push(await checkDeadline(probe, input, invokeCheck.passed));

  const failures = results.filter((r) => !r.passed && r.severity === 'fail').length;
  const warnings = results.filter((r) => !r.passed && r.severity === 'warn').length;

  return { endpoint, results, conformant: failures === 0, failures, warnings };
}

// ---------------------------------------------------------------------------

function checkHealth(response: ProbeResponse): CheckResult {
  const id = 'health';
  const title = 'GET /health';

  if (response.httpStatus !== 200 || !isObject(response.json)) {
    return fail(id, title, `expected HTTP 200 with a JSON object; got ${describe(response)}`);
  }
  const body = response.json;
  if (body['ok'] !== true) {
    // An agent reporting itself unhealthy is answering honestly, but it is not
    // ready to be composed into a flow right now.
    return fail(id, title, `expected "ok": true; got ${JSON.stringify(body['ok'])}`);
  }

  const agentId = body['agentId'];
  const version = body['version'];
  const notes: string[] = [];

  if (typeof agentId !== 'string' || agentId.length === 0) {
    notes.push('"agentId" is missing or not a string');
  } else if (!/^\d+$/.test(agentId) && !/^0x[0-9a-fA-F]+$/.test(agentId)) {
    // Agent identity is an ERC-721 token id on both 0G registries, so the
    // decimal form is canonical; hex is accepted because §6.1's example shows
    // it. Anything else cannot be resolved against a registry.
    notes.push(`"agentId" ${JSON.stringify(agentId)} is neither a decimal token id nor hex`);
  }
  if (typeof version !== 'string' || version.length === 0) {
    notes.push('"version" is missing or not a string');
  }

  return notes.length === 0
    ? pass(id, title, `ok, agentId ${String(agentId)}, version ${String(version)}`, response.durationMs)
    : warn(id, title, notes.join('; '));
}

function checkSchema(response: ProbeResponse): CheckResult {
  const id = 'schema';
  const title = 'GET /schema';

  if (response.httpStatus !== 200 || !isObject(response.json)) {
    return fail(id, title, `expected HTTP 200 with a JSON object; got ${describe(response)}`);
  }
  const body = response.json;
  const missing = ['input', 'output'].filter((k) => !isObject(body[k]));
  if (missing.length > 0) {
    // Without both halves an executor cannot validate what it sends or what it
    // gets back, which is the whole of composability.
    return fail(
      id,
      title,
      `expected "input" and "output" JSON Schema objects; ${missing
        .map((k) => `"${k}"`)
        .join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing or not an object`,
    );
  }
  return pass(id, title, 'exposes both input and output schemas', response.durationMs);
}

function checkInvoke(response: ProbeResponse): CheckResult {
  const id = 'invoke';
  const title = 'POST /invoke with golden input';

  if (response.transportError !== null) {
    return fail(id, title, response.transportError);
  }
  if (response.httpStatus !== 200) {
    return fail(id, title, `expected HTTP 200 for a schema-conformant input; got ${describe(response)}`);
  }
  if (!isObject(response.json)) {
    return fail(id, title, `expected a JSON object; got ${describe(response)}`);
  }
  if (!('output' in response.json)) {
    // §6.1 requires an "output" on a 200. Anchoring the hash of an absent
    // output would commit to a claim the agent never made.
    return fail(id, title, 'a 200 response carries no "output" field');
  }
  if (response.json['output'] === undefined || response.json['output'] === null) {
    return fail(id, title, '"output" is null; an absent result is not an empty one');
  }
  return pass(id, title, `answered in ${response.durationMs}ms`, response.durationMs);
}

function checkAttestation(body: Record<string, JsonValue>): CheckResult {
  const id = 'attestation';
  const title = 'Attestation field';

  if (!('attestation' in body)) {
    // Absent is treated as null by the executor, so this is not fatal — but an
    // explicit null distinguishes "does not attest" from "field lost in
    // transit", and a step with requireAttestation depends on knowing which.
    return warn(id, title, 'field is absent; return an explicit null when there is no attestation');
  }
  const value = body['attestation'];
  if (value === null) {
    return pass(id, title, 'explicitly null: this agent does not attest');
  }
  if (typeof value !== 'string' || value.length === 0) {
    return fail(id, title, `expected a non-empty string or null; got ${JSON.stringify(value)}`);
  }
  return pass(id, title, `present, ${value.length} characters`);
}

function checkHashable(output: JsonValue): CheckResult {
  const id = 'hashable';
  const title = 'Output survives canonicalisation';
  try {
    hashJson(output);
    return pass(id, title, 'canonicalises cleanly under RFC 8785');
  } catch (error) {
    // §5.2 rejects lone surrogates and keys that collide under NFC. An output
    // like this can never be anchored, whatever the schema permits.
    return fail(id, title, `output cannot be canonicalised: ${(error as Error).message}`);
  }
}

function checkDeterminism(firstOutput: JsonValue, second: ProbeResponse): CheckResult {
  const id = 'determinism';
  const title = 'Identical input yields identical output';

  if (second.httpStatus !== 200 || !isObject(second.json) || !('output' in second.json)) {
    return fail(
      id,
      title,
      `the second identical call did not succeed: ${describe(second)}`,
    );
  }

  let a: string;
  let b: string;
  try {
    a = hashJson(firstOutput);
    b = hashJson(second.json['output'] as JsonValue);
  } catch (error) {
    return fail(id, title, `could not hash both outputs: ${(error as Error).message}`);
  }

  if (a !== b) {
    // §4.1: a downstream step's input is re-derived from this output. If it
    // changes between calls, the run verifies at most once — usually never.
    return fail(
      id,
      title,
      `two identical calls produced different outputs (${a.slice(0, 18)}… vs ${b.slice(0, 18)}…). ` +
        'Remove timestamps, random ids and unordered collections from the output, or move them into the trace',
    );
  }
  return pass(id, title, `stable across two calls (${a.slice(0, 18)}…)`);
}

async function checkErrorShape(probe: Probe): Promise<CheckResult[]> {
  const id = 'error-shape';
  const title = 'Error envelope on a malformed request';

  // No "input" key at all: malformed at the envelope level, so every agent
  // must reject it regardless of what its schema happens to accept.
  const response = await probe.post('invoke', { runId: RUN_ID, flowId: FLOW_ID, stepIndex: 0 });

  if (response.transportError !== null) {
    return [fail(id, title, `no usable response to a malformed request: ${response.transportError}`)];
  }
  if (response.httpStatus !== null && response.httpStatus >= 200 && response.httpStatus < 300) {
    return [
      fail(
        id,
        title,
        `accepted a request with no "input" and answered HTTP ${response.httpStatus}; ` +
          'an agent that invents an input hashes a claim nobody made',
      ),
    ];
  }
  if (!isObject(response.json) || !isObject(response.json['error'])) {
    return [
      fail(
        id,
        title,
        `expected { "error": { "code", "message", "retryable" } }; got ${describe(response)}`,
      ),
    ];
  }

  const error = response.json['error'];
  const problems: string[] = [];
  if (typeof error['code'] !== 'string' || error['code'].length === 0) {
    problems.push('"code" is missing or not a string');
  }
  if (typeof error['message'] !== 'string' || error['message'].length === 0) {
    problems.push('"message" is missing or not a string');
  }

  const results: CheckResult[] = [];
  results.push(
    problems.length === 0
      ? pass(id, title, `HTTP ${response.httpStatus} with a well-formed error envelope`)
      : fail(id, title, problems.join('; ')),
  );

  // Retryability is checked separately because it is the field with real
  // consequences: the executor acts on it.
  const retryId = 'error-retryable';
  const retryTitle = 'Retryability of a deterministic failure';
  const retryable = error['retryable'];
  if (retryable === undefined) {
    results.push(
      warn(
        retryId,
        retryTitle,
        'no "retryable" field; the executor will assume false, which is safe but silent',
      ),
    );
  } else if (typeof retryable !== 'boolean') {
    results.push(fail(retryId, retryTitle, `"retryable" must be a boolean; got ${JSON.stringify(retryable)}`));
  } else if (retryable) {
    // A malformed envelope fails identically every time. Marking it retryable
    // spends the caller's whole deadline relearning the first answer.
    results.push(
      fail(
        retryId,
        retryTitle,
        'a malformed request is reported as retryable; the same request will fail the same way',
      ),
    );
  } else {
    results.push(pass(retryId, retryTitle, 'correctly reported as non-retryable'));
  }

  return results;
}

async function checkDeadline(
  probe: Probe,
  input: Record<string, JsonValue>,
  /** Whether the same input succeeded with a deadline in the future. */
  succeedsWithTime: boolean,
): Promise<CheckResult> {
  const id = 'deadline';
  const title = 'Responds to an already-expired deadline';

  // §7.4 has the executor enforce timeoutMs on its side, so the agent is not
  // *required* to honour the deadline. What it may never do is go silent: a
  // hung connection is the one failure mode the executor cannot distinguish
  // from a slow success, and it costs the whole step timeout to discover.
  const expired = Math.floor(Date.now() / 1000) - 3600;
  const response = await probe.post('invoke', envelope(input, expired));

  if (response.transportError !== null) {
    return fail(id, title, `no response to a request with an expired deadline: ${response.transportError}`);
  }
  if (response.httpStatus === null) {
    return fail(id, title, 'no HTTP response');
  }

  const detail = `HTTP ${response.httpStatus} in ${response.durationMs}ms`;

  if (response.httpStatus < 400) {
    return pass(
      id,
      title,
      `${detail} — answered rather than hanging (the deadline itself was not enforced, which the executor covers)`,
      response.durationMs,
    );
  }

  // An error here only demonstrates deadline enforcement if the same input
  // succeeded when there was time. An agent that rejects everything would
  // otherwise be credited with a behaviour it does not have.
  return pass(
    id,
    title,
    succeedsWithTime
      ? `${detail} — deadline honoured: the same input succeeded when there was time`
      : `${detail} — answered rather than hanging, but this agent errors on that input regardless, so deadline enforcement is not demonstrated`,
    response.durationMs,
  );
}
