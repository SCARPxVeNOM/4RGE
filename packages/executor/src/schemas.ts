/**
 * Reading a published schema back out of 0G Storage.
 *
 * The root comes from the registry, so what this fetches is the schema the
 * agent committed to — not whatever it happens to be serving from `/schema`
 * right now. That distinction is the whole value of the check: an agent
 * cannot quietly widen its contract after being hired against a narrower one.
 *
 * Nothing here verifies the storage inclusion proof. The verifier does that
 * when it re-checks a run; here the schema is used to refuse bad input before
 * an agent is called, and a wrong schema can only cause a step to be refused,
 * never to be wrongly accepted. Fetch failures return null rather than
 * throwing, so a storage outage does not look like a bad flow.
 */

import type { Hex, JsonValue } from '@0gflow/core';
import type { SchemaResolver } from './execute.js';

export interface ZgStorageSchemaSourceOptions {
  /** 0G Storage indexer, e.g. https://indexer-storage-testnet-turbo.0g.ai */
  readonly indexerUrl: string;
  readonly timeoutMs?: number;
}

export class ZgStorageSchemaSource implements SchemaResolver {
  /**
   * A schema is immutable at its root, and a flow may call the same agent in
   * several steps. One fetch each.
   */
  private readonly cache = new Map<string, JsonValue | null>();

  constructor(private readonly options: ZgStorageSchemaSourceOptions) {}

  async fetch(schemaRoot: Hex): Promise<JsonValue | null> {
    const key = schemaRoot.toLowerCase();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const resolved = await this.read(schemaRoot);
    this.cache.set(key, resolved);
    return resolved;
  }

  private async read(schemaRoot: Hex): Promise<JsonValue | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 15_000);
    try {
      const url = `${this.options.indexerUrl.replace(/\/+$/, '')}/file?root=${schemaRoot}`;
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return null;
      return (await response.json()) as JsonValue;
    } catch {
      // Unreachable, timed out, or not JSON. Nothing was established, and the
      // caller treats that as "unchecked" rather than "invalid".
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
