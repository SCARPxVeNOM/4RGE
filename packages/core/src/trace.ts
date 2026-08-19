/**
 * Execution trace schema — spec §7.6.
 *
 * The trace is what a verifier reads to check a receipt: it holds the exact
 * input and output the step used, plus everything needed to explain what
 * happened. The receipt commits to it twice over — `inputHash` and
 * `outputHash` are sha256 of the canonical forms of `input` and `output`, and
 * `traceRoot` is the 0G Storage root of the whole document.
 *
 * This lives in core because the executor writes it and the verifier reads it,
 * and a disagreement about the shape is a disagreement about what was proven.
 */

import type { JsonValue } from './canonicalize.js';

export interface TraceRetry {
  readonly attempt: number;
  readonly error: string;
  readonly delayMs: number;
}

export interface ExecutionTrace {
  readonly version: string;
  readonly runId: string;
  readonly stepIndex: number;
  readonly stepId: string;
  /** ERC-721 token id of the agent, as a decimal string (JSON has no uint256). */
  readonly agent: string;
  /** The canonical input the step was invoked with. Hashes to inputHash. */
  readonly input: JsonValue;
  /** The canonical output the step returned. Hashes to outputHash. */
  readonly output: JsonValue;
  readonly request?: JsonValue;
  readonly response?: JsonValue;
  readonly timings?: JsonValue;
  readonly retries?: readonly TraceRetry[];
  /**
   * The raw TEE attestation exactly as the provider returned it, base64
   * encoded. attestationRef is sha256 over those raw bytes — never over a
   * re-serialised form (see docs/attestation-structure.md).
   */
  readonly attestation?: string | null;
  readonly error?: string | null;
}

export class TraceError extends Error {
  override readonly name = 'TraceError';
}

/**
 * Parses a stored trace, rejecting anything that does not carry the two fields
 * a receipt commits to. A trace missing `input` or `output` cannot be checked
 * at all, and must not be treated as a trace that merely happens to match.
 */
export function parseTrace(bytes: Uint8Array): ExecutionTrace {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    throw new TraceError(`trace is not valid JSON: ${(cause as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TraceError('trace must be a JSON object');
  }
  const trace = parsed as Record<string, unknown>;
  for (const field of ['input', 'output']) {
    if (!(field in trace)) {
      throw new TraceError(`trace has no "${field}" field, so the receipt cannot be checked`);
    }
  }
  return trace as unknown as ExecutionTrace;
}
