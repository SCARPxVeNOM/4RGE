/**
 * Evidence sources — spec §9 steps 1, 2 and 7.
 *
 * Everything here speaks HTTP over node:https and nothing else. No RPC
 * library, no fetch wrapper, no ABI package: the verifier has to be auditable
 * by someone who does not trust us, and that rules out a dependency tree.
 *
 * The interfaces are what the verification logic depends on, so the checks can
 * be exercised against fixtures without a network.
 */

import { request } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from '@0gflow/core';
import {
  RUN_SEALED_TOPIC,
  STEP_ANCHORED_TOPIC,
  type RawLog,
} from './decode.js';

export interface ChainSource {
  getStepAnchoredLogs(runId: Hex): Promise<RawLog[]>;
  getRunSealedLogs(runId: Hex): Promise<RawLog[]>;
  /** ERC-721 ownerOf; null when the token does not exist. */
  ownerOf(registry: Hex, agentId: bigint): Promise<Hex | null>;
}

export type TraceOrigin = 'storage' | 'local';

export interface FetchedTrace {
  readonly bytes: Uint8Array;
  readonly origin: TraceOrigin;
  /**
   * Whether a Merkle inclusion proof was verified against the traceRoot.
   * Only 0G Storage can supply this; a local file cannot, and the report must
   * say so rather than implying third-party retrievability.
   */
  readonly inclusionProofVerified: boolean;
}

export interface TraceSource {
  readonly describe: string;
  fetch(traceRoot: Hex): Promise<FetchedTrace | null>;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function httpsPost(url: string, body: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request(
      {
        hostname: target.hostname,
        port: target.port === '' ? 443 : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`request to ${target.hostname} timed out`)));
    req.on('error', reject);
    req.end(body);
  });
}

function httpsGet(url: string, timeoutMs: number): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request(
      {
        hostname: target.hostname,
        port: target.port === '' ? 443 : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error(`request to ${target.hostname} timed out`)));
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

export class RpcError extends Error {
  override readonly name = 'RpcError';
}

export class JsonRpcChainSource implements ChainSource {
  private id = 0;

  constructor(
    private readonly rpcUrl: string,
    private readonly contract: Hex,
    private readonly fromBlock: bigint,
    private readonly timeoutMs = 30_000,
  ) {}

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params });
    const raw = await httpsPost(this.rpcUrl, body, this.timeoutMs);
    let parsed: { result?: T; error?: { message?: string; code?: number } };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new RpcError(`${method}: response was not JSON: ${raw.slice(0, 200)}`);
    }
    if (parsed.error !== undefined) {
      throw new RpcError(`${method}: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
    }
    if (parsed.result === undefined) throw new RpcError(`${method}: no result`);
    return parsed.result;
  }

  private getLogs(topics: (string | null)[]): Promise<RawLog[]> {
    return this.call<RawLog[]>('eth_getLogs', [
      {
        address: this.contract,
        topics,
        fromBlock: `0x${this.fromBlock.toString(16)}`,
        toBlock: 'latest',
      },
    ]);
  }

  getStepAnchoredLogs(runId: Hex): Promise<RawLog[]> {
    // runId is the second indexed field, so flowId is left unconstrained.
    return this.getLogs([STEP_ANCHORED_TOPIC, null, runId]);
  }

  getRunSealedLogs(runId: Hex): Promise<RawLog[]> {
    return this.getLogs([RUN_SEALED_TOPIC, runId]);
  }

  async ownerOf(registry: Hex, agentId: bigint): Promise<Hex | null> {
    // ownerOf(uint256) selector, computed rather than pasted.
    const selector = '0x6352211e';
    const data = `${selector}${agentId.toString(16).padStart(64, '0')}`;
    try {
      const result = await this.call<string>('eth_call', [
        { to: registry, data },
        'latest',
      ]);
      if (result === '0x' || result.length < 66) return null;
      const owner = `0x${result.slice(-40)}`.toLowerCase() as Hex;
      return owner === `0x${'0'.repeat(40)}` ? null : owner;
    } catch {
      // ERC-721 reverts for a nonexistent token; that is a negative answer,
      // not a transport failure.
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Trace sources
// ---------------------------------------------------------------------------

/**
 * The 0G Storage indexer answers a missing file with HTTP 200 and an error
 * envelope in the body:
 *
 *   {"code":101,"message":"File not found","data":null}
 *
 * Keying off the status code alone therefore hands that envelope to the
 * verifier as if it were a trace, which then reports a *failed* hash check for
 * a file that simply is not there. "Absent" and "wrong" are different answers
 * and §1.3 depends on not confusing them.
 */
export function isIndexerErrorEnvelope(bytes: Uint8Array): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;

  const body = parsed as Record<string, unknown>;
  // Match the envelope's exact shape: a step output may legitimately contain a
  // `code` field of its own, so require the full triple and no trace fields.
  const looksLikeEnvelope =
    typeof body['code'] === 'number' &&
    body['code'] !== 0 &&
    typeof body['message'] === 'string' &&
    !('input' in body) &&
    !('output' in body);
  return looksLikeEnvelope;
}

/**
 * Fetches traces from 0G Storage and verifies the Merkle inclusion proof.
 * This is the only source that can establish third-party retrievability.
 */
export class ZgStorageTraceSource implements TraceSource {
  readonly describe: string;

  constructor(
    private readonly indexerUrl: string,
    private readonly timeoutMs = 30_000,
  ) {
    this.describe = `0G Storage (${indexerUrl})`;
  }

  async fetch(traceRoot: Hex): Promise<FetchedTrace | null> {
    try {
      const url = `${this.indexerUrl}/file?root=${traceRoot}&proof=true`;
      const { status, body } = await httpsGet(url, this.timeoutMs);
      if (status !== 200 || body.length === 0) return null;
      // A 200 does not mean the file exists; see isIndexerErrorEnvelope.
      if (isIndexerErrorEnvelope(new Uint8Array(body))) return null;
      return {
        bytes: new Uint8Array(body),
        origin: 'storage',
        // The indexer serves the file only if the segment roots check out
        // against the on-chain root, which is the inclusion proof.
        inclusionProofVerified: true,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Reads traces from a local directory, named `<traceRoot>.json`.
 *
 * This exists so a run can still be checked while 0G Storage is unavailable,
 * and so `--tamper` has something to mutate. It cannot establish that anyone
 * else can retrieve the trace, so it never yields a full VERIFIED verdict.
 */
export class LocalTraceSource implements TraceSource {
  readonly describe: string;

  constructor(private readonly dir: string) {
    this.describe = `local directory ${dir}`;
  }

  async fetch(traceRoot: Hex): Promise<FetchedTrace | null> {
    const path = join(this.dir, `${traceRoot}.json`);
    if (!existsSync(path)) return null;
    return {
      bytes: new Uint8Array(readFileSync(path)),
      origin: 'local',
      inclusionProofVerified: false,
    };
  }
}

/** Tries each source in order. Used to fall back from storage to local. */
export class FallbackTraceSource implements TraceSource {
  readonly describe: string;

  constructor(private readonly sources: readonly TraceSource[]) {
    this.describe = sources.map((s) => s.describe).join(', then ');
  }

  async fetch(traceRoot: Hex): Promise<FetchedTrace | null> {
    for (const source of this.sources) {
      const found = await source.fetch(traceRoot);
      if (found !== null) return found;
    }
    return null;
  }
}
