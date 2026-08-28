/**
 * HTTP adapter invocation — spec §6.1, §7.4.
 *
 *   POST /invoke  { runId, flowId, stepIndex, input, deadline }
 *     200  { output, attestation | null, meta }
 *     4xx  { error: { code, message, retryable } }
 *
 * Two rules here are load-bearing:
 *
 * - Retry only when the adapter says `retryable: true`. Repeating a
 *   deterministic failure burns the deadline and, for a non-idempotent agent,
 *   may do the work twice.
 * - Never invent an output. A 200 with no `output` field is an error, not an
 *   empty object: anchoring a hash of `{}` would record that the agent
 *   returned nothing, which is a different claim from "the agent misbehaved".
 */

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { canonicalize, type Hex, type JsonValue, type ResponseSignature } from '@0gflow/core';

export interface InvokeRequest {
  readonly runId: string;
  readonly flowId: string;
  readonly stepIndex: number;
  readonly input: JsonValue;
  /** Unix seconds after which the agent should stop trying. */
  readonly deadline: number;
  /**
   * Where this step will be anchored, so the agent can sign an output bound
   * to one specific chain and deployment. Omitted when no signature is asked
   * for; never defaulted, because a signature over chain 0 would look
   * well-formed and verify nowhere.
   */
  readonly chainId?: number;
  readonly receipts?: Hex;
}

export interface AttemptRecord {
  readonly attempt: number;
  readonly status: number | null;
  readonly durationMs: number;
  readonly error: string | null;
  readonly retryable: boolean;
}

export interface InvokeResult {
  readonly output: JsonValue;
  /** Raw attestation exactly as returned, or null. Never re-encoded. */
  readonly attestation: string | null;
  /**
   * The per-response signature, when the agent produced one.
   *
   * Without it the attestation is a document about an enclave, not a statement
   * about this output — see packages/core/src/attestation.ts. Agents fronting
   * 0G Compute obtain it from /v1/proxy/signature/{chatID}.
   */
  readonly attestationBinding: ResponseSignature | null;
  /**
   * The 0G provider that served the inference, when the agent fronts 0G
   * Compute. The executor reads this provider's acknowledged TEE signer from
   * the InferenceServing contract; without it there is nothing to check the
   * response signature against.
   */
  readonly attestationProvider: Hex | null;
  /**
   * The agent's signature over its own output, when it produced one.
   *
   * This is what turns the receipt's `agentId` from a claim into a fact, and
   * what `FlowEscrowV2` requires before paying.
   */
  readonly outputSignature: Hex | null;
  readonly meta: JsonValue | null;
  readonly attempts: AttemptRecord[];
}

export interface InvokeOptions {
  readonly timeoutMs: number;
  readonly retries?: { readonly max: number; readonly backoffMs: number };
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

export class AdapterError extends Error {
  override readonly name = 'AdapterError';
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly attempts: AttemptRecord[] = [],
  ) {
    super(message);
  }
}

interface RawResponse {
  status: number;
  body: string;
}

function post(url: string, payload: string, timeoutMs: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(
      {
        hostname: target.hostname,
        port: target.port === '' ? (target.protocol === 'https:' ? 443 : 80) : Number(target.port),
        path: target.pathname === '/' ? '/invoke' : `${target.pathname.replace(/\/$/, '')}/invoke`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('timeout', () =>
      req.destroy(new Error(`invocation timed out after ${timeoutMs}ms`)),
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Exponential backoff with full jitter (§7.4). Jitter matters when several
 * workers retry the same overloaded agent: without it they retry in lockstep
 * and keep it overloaded.
 */
function backoffFor(attempt: number, baseMs: number, random: () => number): number {
  const exponential = baseMs * 2 ** (attempt - 1);
  return Math.round(exponential + exponential * random());
}

function parseSuccess(body: string, attempts: AttemptRecord[]): InvokeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new AdapterError(
      `adapter returned 200 with a body that is not JSON: ${body.slice(0, 120)}`,
      'malformed-response',
      false,
      attempts,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AdapterError('adapter returned 200 with a non-object body', 'malformed-response', false, attempts);
  }

  const envelope = parsed as Record<string, unknown>;
  if (!('output' in envelope)) {
    throw new AdapterError(
      'adapter returned 200 with no "output" field; an absent output is not an empty one',
      'malformed-response',
      false,
      attempts,
    );
  }

  const output = envelope['output'] as JsonValue;
  // Fail here rather than at hashing time, so the error names the agent.
  try {
    canonicalize(output);
  } catch (error) {
    throw new AdapterError(
      `adapter output cannot be canonicalized: ${(error as Error).message}`,
      'malformed-response',
      false,
      attempts,
    );
  }

  const attestation = envelope['attestation'];
  return {
    output,
    attestation: typeof attestation === 'string' && attestation.length > 0 ? attestation : null,
    attestationBinding: parseBinding(envelope['attestationBinding']),
    attestationProvider: parseProvider(envelope['attestationProvider']),
    outputSignature: parseSignature(envelope['outputSignature']),
    meta: (envelope['meta'] ?? null) as JsonValue | null,
    attempts,
  };
}

/**
 * A 65-byte signature, or null.
 *
 * A malformed one is dropped rather than passed along: the executor would
 * only fail to recover an address from it, and reporting "the agent did not
 * sign" is the same outcome by a clearer route.
 */
function parseSignature(value: unknown): Hex | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value)
    ? (value.toLowerCase() as Hex)
    : null;
}

/** A 0G provider address, or null. Never a partially-valid one. */
function parseProvider(value: unknown): Hex | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)
    ? (value.toLowerCase() as Hex)
    : null;
}

/**
 * Reads the optional per-response signature.
 *
 * A partial binding is dropped rather than half-accepted: every field is
 * needed to check it, and carrying an incomplete one into the receipt would
 * anchor a digest over fields a verifier cannot use.
 */
function parseBinding(value: unknown): ResponseSignature | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const binding = value as Record<string, unknown>;

  const chatID = binding['chatID'];
  const model = binding['model'];
  const text = binding['text'];
  const signature = binding['signature'];
  const responseBody = binding['responseBody'];
  // Both default to the whole document, the only assumption that cannot
  // silently point at the wrong field.
  const responsePath = binding['responsePath'] ?? '$';
  const outputPath = binding['outputPath'] ?? '$';

  if (
    typeof chatID !== 'string' ||
    typeof model !== 'string' ||
    typeof text !== 'string' ||
    typeof signature !== 'string' ||
    typeof responseBody !== 'string' ||
    typeof responsePath !== 'string' ||
    typeof outputPath !== 'string' ||
    signature.length === 0 ||
    responseBody.length === 0
  ) {
    return null;
  }
  return {
    chatID,
    model,
    text,
    signature: signature as Hex,
    responseBody,
    responsePath,
    outputPath,
  };
}

function parseError(status: number, body: string): { code: string; message: string; retryable: boolean } {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; message?: string; retryable?: boolean } };
    const error = parsed.error;
    if (error !== undefined) {
      return {
        code: error.code ?? `http-${status}`,
        message: error.message ?? `adapter returned ${status}`,
        // Absent means not retryable: repeating a call whose safety is
        // unstated is the riskier assumption.
        retryable: error.retryable === true,
      };
    }
  } catch {
    /* fall through to the generic shape */
  }
  return { code: `http-${status}`, message: `adapter returned ${status}: ${body.slice(0, 120)}`, retryable: false };
}

export async function invokeHttpAdapter(
  endpoint: string,
  invocation: InvokeRequest,
  options: InvokeOptions,
): Promise<InvokeResult> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const maxAttempts = Math.max(1, options.retries?.max ?? 1);
  const backoffMs = options.retries?.backoffMs ?? 0;
  const payload = JSON.stringify(invocation);
  const attempts: AttemptRecord[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    try {
      const response = await post(endpoint, payload, options.timeoutMs);
      const durationMs = Date.now() - startedAt;

      if (response.status >= 200 && response.status < 300) {
        attempts.push({ attempt, status: response.status, durationMs, error: null, retryable: false });
        return parseSuccess(response.body, attempts);
      }

      const failure = parseError(response.status, response.body);
      attempts.push({
        attempt,
        status: response.status,
        durationMs,
        error: failure.message,
        retryable: failure.retryable,
      });

      if (!failure.retryable || attempt === maxAttempts) {
        throw new AdapterError(failure.message, failure.code, failure.retryable, attempts);
      }
    } catch (error) {
      if (error instanceof AdapterError) throw error;

      // Transport-level problems — timeouts, refused connections, resets — are
      // treated as retryable: they are rarely a property of the request.
      const durationMs = Date.now() - startedAt;
      const message = (error as Error).message;
      attempts.push({ attempt, status: null, durationMs, error: message, retryable: true });

      if (attempt === maxAttempts) {
        throw new AdapterError(message, 'transport', true, attempts);
      }
    }

    await sleep(backoffFor(attempt, backoffMs, random));
  }

  /* c8 ignore next */
  throw new AdapterError('exhausted attempts', 'transport', true, attempts);
}
