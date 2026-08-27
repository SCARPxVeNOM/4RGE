/**
 * @0gflow/adapter-sdk — build an agent the executor can call (§6.1).
 *
 * The contract is small, and the SDK exists because the small parts are the
 * ones that get quietly wrong:
 *
 * - An error must say whether retrying is safe. The executor retries only on
 *   `retryable: true`, so an omitted flag means "do not retry" — and an agent
 *   that marks a deterministic failure retryable burns the caller's deadline
 *   four times over.
 * - A 200 must carry an `output`. Returning `{}` because there was nothing to
 *   say anchors a hash of nothing, which is a different and false claim.
 * - `attestation` must be the provider's bytes, unmodified. The executor
 *   digests exactly what is returned; re-encoding it breaks attestationRef.
 *
 * Zero runtime dependencies: an agent author should not inherit our tree.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [k: string]: JsonValue };

/** The envelope the executor POSTs to /invoke. */
export interface InvokeRequest {
  readonly runId: string;
  readonly flowId: string;
  readonly stepIndex: number;
  readonly input: Record<string, JsonValue>;
  /** Unix seconds after which the executor stops waiting. */
  readonly deadline: number;
}

export interface AgentSchema {
  readonly input: JsonValue;
  readonly output: JsonValue;
}

export class AgentError extends Error {
  override readonly name = 'AgentError';
  constructor(
    message: string,
    readonly code: string,
    /**
     * Whether the executor may safely call again. Default false: repeating a
     * call whose safety is unstated is the riskier assumption, and a
     * deterministic failure repeated four times just wastes the deadline.
     */
    readonly retryable = false,
    readonly status = 500,
  ) {
    super(message);
  }
}

/** Thrown when the input does not match what the agent declared it accepts. */
export class SchemaError extends AgentError {
  constructor(message: string) {
    // Not retryable: the same input will fail the same way.
    super(message, 'schema', false, 422);
  }
}

/**
 * The per-response signature that ties an attestation to *this* output.
 *
 * An attestation without one proves an enclave exists somewhere; it says
 * nothing about the answer being returned. An agent fronting 0G Compute gets
 * this from `GET {url}/v1/proxy/signature/{chatID}?model={model}`.
 *
 * Do not copy the SDK's own check here. `Verifier.verifySignature` compares the
 * signature against the `text` that same endpoint returned, never against the
 * completion the caller received — so it passes even when a provider serves one
 * response and signs another. The executor performs the comparison the SDK
 * omits, using `outputPath`.
 */
export interface AttestationBinding {
  /** From the `ZG-Res-Key` response header, not the completion id. */
  readonly chatID: string;
  readonly model: string;
  /**
   * The text the enclave signed, verbatim.
   *
   * On 0G Compute this is a colon-delimited digest envelope, not the answer:
   * `<sha256(request)>:<sha256(response)>:<type>:<identity>:<hash>`. Pass it
   * through untouched; the executor checks that it commits to `responseBody`.
   */
  readonly text: string;
  /** The 65-byte signature, 0x hex, exactly as returned. */
  readonly signature: string;
  /**
   * The provider's response, byte for byte as served — not re-serialised.
   *
   * The signature commits to a digest of these exact bytes, so a
   * `JSON.parse`/`JSON.stringify` round trip breaks the binding.
   */
  readonly responseBody: string;
  /** Where the answer sits in `responseBody`, e.g. `$.choices[0].message.content`. */
  readonly responsePath: string;
  /**
   * Where that same value sits in your `output`: `$` when the output is the
   * answer, `$.text` when you wrapped it.
   *
   * State both rather than leaving them to convention. If they do not agree,
   * the executor records the step as unattested — the correct outcome for an
   * attestation that does not describe the answer.
   */
  readonly outputPath: string;
}

export interface AgentResponse {
  readonly output: JsonValue;
  /**
   * The raw attestation exactly as produced, or null. Never re-encode it: the
   * executor hashes these bytes into attestationRef, and a verifier compares
   * against what the provider actually sent.
   */
  readonly attestation?: string | null;
  /**
   * The signature binding `attestation` to `output`. Without it the strongest
   * level a step can reach is `present`.
   */
  readonly attestationBinding?: AttestationBinding | null;
}

export interface AgentDefinition {
  /** ERC-721 token id of this agent's identity, as a decimal string. */
  readonly agentId: string;
  readonly version?: string;
  readonly schema: AgentSchema;
  invoke(request: InvokeRequest): Promise<AgentResponse> | AgentResponse;
}

export interface HandlerResult {
  readonly status: number;
  readonly body: JsonValue;
}

const errorBody = (error: AgentError): JsonValue => ({
  error: { code: error.code, message: error.message, retryable: error.retryable },
});

/**
 * Runs one invocation and returns the exact status and body to send.
 *
 * Transport-agnostic on purpose: an agent may be behind Express, Fastify, a
 * Lambda or a raw node:http server, and none of that should change what the
 * executor sees.
 */
export async function handleInvoke(
  agent: AgentDefinition,
  body: unknown,
): Promise<HandlerResult> {
  const request = parseRequest(body);
  if (request === null) {
    return {
      status: 400,
      body: errorBody(
        new AgentError('request must carry an "input" object', 'bad-request', false, 400),
      ),
    };
  }

  try {
    const result = await agent.invoke(request);

    if (result === null || typeof result !== 'object' || !('output' in result)) {
      // An agent that returns nothing has misbehaved; saying so beats
      // anchoring a hash of {} as though it were the answer.
      throw new AgentError(
        'agent returned no "output"; an absent output is not an empty one',
        'no-output',
        false,
        500,
      );
    }

    const binding = result.attestationBinding ?? null;
    if (binding !== null) {
      // A half-filled binding is worse than none: the executor would digest
      // fields a verifier cannot check, and the step would look attested.
      for (const field of [
        'chatID',
        'model',
        'text',
        'signature',
        'responseBody',
        'responsePath',
        'outputPath',
      ] as const) {
        if (typeof binding[field] !== 'string' || binding[field].length === 0) {
          throw new AgentError(
            `attestationBinding.${field} must be a non-empty string`,
            'bad-binding',
            false,
            500,
          );
        }
      }
    }

    return {
      status: 200,
      body: {
        output: result.output,
        attestation: result.attestation ?? null,
        attestationBinding: binding === null ? null : { ...binding },
      },
    };
  } catch (error) {
    if (error instanceof AgentError) {
      return { status: error.status, body: errorBody(error) };
    }
    // An unexpected throw is not known to be safe to repeat.
    return {
      status: 500,
      body: errorBody(new AgentError((error as Error).message, 'internal', false, 500)),
    };
  }
}

function parseRequest(body: unknown): InvokeRequest | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const envelope = body as Record<string, unknown>;
  const input = envelope['input'];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;

  return {
    runId: String(envelope['runId'] ?? ''),
    flowId: String(envelope['flowId'] ?? ''),
    stepIndex: Number(envelope['stepIndex'] ?? 0),
    input: input as Record<string, JsonValue>,
    deadline: Number(envelope['deadline'] ?? 0),
  };
}

export function healthBody(agent: AgentDefinition): JsonValue {
  return { ok: true, agentId: agent.agentId, version: agent.version ?? '1.0.0' };
}

export function schemaBody(agent: AgentDefinition): JsonValue {
  return { input: agent.schema.input, output: agent.schema.output };
}

/** Minimal helpers so a schema check is one line and always non-retryable. */
export const require_ = {
  string(input: Record<string, JsonValue>, field: string): string {
    const value = input[field];
    if (typeof value !== 'string') throw new SchemaError(`"${field}" must be a string`);
    return value;
  },
  number(input: Record<string, JsonValue>, field: string): number {
    const value = input[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      // A non-finite number has no JSON form and could never be hashed.
      throw new SchemaError(`"${field}" must be a finite number`);
    }
    return value;
  },
  object(input: Record<string, JsonValue>, field: string): Record<string, JsonValue> {
    const value = input[field];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new SchemaError(`"${field}" must be an object`);
    }
    return value as Record<string, JsonValue>;
  },
};

/**
 * Routes the three §6.1 paths. Returns null when the path is not ours, so a
 * host application can mount this alongside its own routes.
 */
export async function routeAgentRequest(
  agent: AgentDefinition,
  method: string,
  path: string,
  body: unknown,
): Promise<HandlerResult | null> {
  const tail = path.replace(/\/+$/, '').split('/').pop() ?? '';

  if (tail === 'health' && method === 'GET') return { status: 200, body: healthBody(agent) };
  if (tail === 'schema' && method === 'GET') return { status: 200, body: schemaBody(agent) };
  if (tail === 'invoke') {
    if (method !== 'POST') {
      return {
        status: 405,
        body: errorBody(new AgentError('use POST', 'method-not-allowed', false, 405)),
      };
    }
    return handleInvoke(agent, body);
  }
  return null;
}
