/**
 * Trace storage — spec §7.6, §7.3.
 *
 * The receipt's `traceRoot` commits to the trace, and the verifier fetches it
 * to recompute `inputHash` and `outputHash`. Anchoring happens only after the
 * root is confirmed (§7.3): an anchored root nobody can resolve is an
 * unverifiable receipt.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize, hashJson, type Hex, type JsonValue } from '@0gflow/core';
import type { TraceStore } from './execute.js';

/**
 * Writes traces to disk, keyed by a sha256 of the canonical form.
 *
 * A STAND-IN, not a substitute. Use `ZgStorageTraceStore` from
 * `@0gflow/storage` for anything that needs to be verifiable by someone else.
 *
 * The commitment this produces is real — the root is a hash of the exact bytes
 * written — but it proves nothing about third-party retrievability, which is
 * precisely why the verifier refuses to report VERIFIED for a locally sourced
 * trace and returns INCOMPLETE instead. Useful for tests, for offline
 * development, and as a fallback when storage is unreachable.
 */
export class LocalTraceStore implements TraceStore {
  readonly describe: string;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.describe = `local directory ${dir}`;
  }

  async put(trace: JsonValue): Promise<{ traceRoot: Hex }> {
    const traceRoot = hashJson(trace) as Hex;
    // Write the canonical bytes, so what is stored is exactly what was hashed.
    writeFileSync(join(this.dir, `${traceRoot}.json`), canonicalize(trace));
    return { traceRoot };
  }
}
