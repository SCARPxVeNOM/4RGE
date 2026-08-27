/**
 * The transport the checks run over.
 *
 * Kept behind an interface so the check logic is exercised against agents that
 * hang, return HTML, or close the socket mid-response — none of which are
 * convenient to arrange over a real network, and all of which the suite must
 * report clearly rather than crash on.
 */

import type { JsonValue } from '@0gflow/core';

export interface ProbeResponse {
  /** HTTP status, or null when no response was obtained at all. */
  readonly httpStatus: number | null;
  /** Parsed JSON body, or null when the body was absent or not JSON. */
  readonly json: JsonValue | null;
  /** The first 400 characters of the raw body, for error messages. */
  readonly rawExcerpt: string;
  readonly durationMs: number;
  /** Transport-level failure: timeout, refused connection, socket reset. */
  readonly transportError: string | null;
}

export interface Probe {
  get(path: string): Promise<ProbeResponse>;
  post(path: string, body: JsonValue): Promise<ProbeResponse>;
}

const excerpt = (text: string): string =>
  text.length <= 400 ? text : `${text.slice(0, 400)}… (${text.length} bytes)`;

/**
 * Joins the base endpoint with a sub-path without losing a mount prefix.
 * `http://host/agents/audit` + `/health` must become
 * `http://host/agents/audit/health`, not `http://host/health` — which is what
 * `new URL('/health', base)` would produce.
 */
export function joinEndpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function createHttpProbe(endpoint: string, timeoutMs: number): Probe {
  async function request(
    method: 'GET' | 'POST',
    path: string,
    body: JsonValue | undefined,
  ): Promise<ProbeResponse> {
    const controller = new AbortController();
    // The suite's own deadline. An agent that never answers is a conformance
    // failure, so this must fire rather than let the run hang forever.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(joinEndpoint(endpoint, path), {
        method,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      const text = await response.text();
      let json: JsonValue | null = null;
      try {
        json = text.length === 0 ? null : (JSON.parse(text) as JsonValue);
      } catch {
        // Left null on purpose: "answered with something that is not JSON" is
        // a distinct and more useful finding than a parse exception.
        json = null;
      }

      return {
        httpStatus: response.status,
        json,
        rawExcerpt: excerpt(text),
        durationMs: Date.now() - startedAt,
        transportError: null,
      };
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError';
      return {
        httpStatus: null,
        json: null,
        rawExcerpt: '',
        durationMs: Date.now() - startedAt,
        transportError: aborted
          ? `no response within ${timeoutMs}ms`
          : ((error as Error).message || String(error)),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get: (path) => request('GET', path, undefined),
    post: (path, body) => request('POST', path, body),
  };
}
