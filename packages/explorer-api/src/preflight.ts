/**
 * The half of publishing that a browser cannot do.
 *
 * Publishing an agent is two on-chain writes and three off-chain steps. The
 * writes belong to the publisher and are signed by their own wallet — this
 * service never sees a private key and never sends a transaction. What it does
 * is the part a web page is structurally incapable of:
 *
 *   · calling the agent's endpoint. The §6.4 suite POSTs JSON, which browsers
 *     preflight with OPTIONS, and an agent that does not answer OPTIONS would
 *     be reported as broken when it is merely not a CORS server. Judging
 *     someone's agent by whether it is reachable from a web page would be
 *     judging the wrong thing.
 *
 *   · writing the schema to 0G Storage. That is a paid write with an SDK that
 *     does not run in a browser. This service pays for it, which is a subsidy
 *     and worth naming as one: it buys the publisher a blob of storage, and
 *     nothing else. The listing that points at it can still only be written by
 *     whoever owns the identity.
 *
 * So the trust given up by using this page instead of the CLI is bounded: the
 * server chooses the schema bytes and the conformance verdict. Both are
 * checkable afterwards by anyone — the schema is a public 0G Storage object,
 * and `npx @0gflow/conform <endpoint>` re-runs the suite from the reader's own
 * machine. The page says so.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { runConformance, createHttpProbe, type ConformanceReport } from '@0gflow/conform';
import { ZgStorageTraceStore } from '@0gflow/storage';
import type { JsonValue } from '@0gflow/core';
import type { Network } from '@0gflow/config';

export interface PreflightOptions {
  readonly network: Network;
  /**
   * The key that pays for schema storage. Absent is a supported state, not a
   * misconfiguration: preflight still runs the conformance suite and says
   * plainly that it cannot produce a schemaRoot, which is better than a page
   * that half-works without explaining why.
   */
  readonly storageKey?: string | undefined;
}

export interface PreflightResult {
  readonly endpoint: string;
  readonly conformance: ConformanceReport;
  /** null when the agent failed the gate, or when no storage key is configured. */
  readonly schemaRoot: string | null;
  readonly schemaNote: string | null;
  /** The signer the agent publishes for itself, when it publishes one. */
  readonly signer: string | null;
}

export class PreflightError extends Error {
  override readonly name = 'PreflightError';
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * Whether an address is one this server should be talking to at all.
 *
 * The endpoint is chosen by an anonymous caller, and the server will fetch it.
 * Without this, the URL field is a request forwarder into whatever the
 * container can reach: its own metadata service, the database on the private
 * network, other services in the same project.
 */
/**
 * An IPv6 address as its 16 bytes, or null if it will not parse.
 *
 * Expanded rather than pattern-matched because `new URL()` rewrites the
 * address into its own canonical form: `[::ffff:127.0.0.1]` comes back out as
 * `::ffff:7f00:1`, and a regex looking for a dotted quad sees a public
 * address. That was a real hole here, found by a test rather than by reading.
 */
function expandIpv6(value: string): Uint8Array | null {
  const [head, tail, ...rest] = value.toLowerCase().split('::');
  if (rest.length > 0 || head === undefined) return null;

  const groups = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);

  // A trailing dotted quad — `::ffff:127.0.0.1` — is two groups' worth.
  const last = (right.length > 0 ? right : left).at(-1);
  const quad = last !== undefined && last.includes('.') ? last.split('.').map(Number) : null;
  if (quad !== null) {
    if (quad.length !== 4 || quad.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((quad[0]! << 8) | quad[1]!).toString(16);
    const lo = ((quad[2]! << 8) | quad[3]!).toString(16);
    (right.length > 0 ? right : left).splice(-1, 1, hi, lo);
  }

  const missing = 8 - (left.length + right.length);
  if (tail === undefined ? missing !== 0 : missing < 0) return null;

  const words = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...right];
  const bytes = new Uint8Array(16);
  for (const [i, word] of words.entries()) {
    if (!/^[0-9a-f]{1,4}$/.test(word)) return null;
    const n = parseInt(word, 16);
    bytes[i * 2] = n >> 8;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const bytes = expandIpv6(address);
    if (bytes === null) return false;

    // An IPv4 address wearing a hat: ::ffff:a.b.c.d and the deprecated
    // ::a.b.c.d both put the real address in the last four bytes, and both
    // reach exactly the same host as the IPv4 form would.
    const prefixIsZero = bytes.slice(0, 10).every((b) => b === 0);
    const marker = (bytes[10]! << 8) | bytes[11]!;
    if (prefixIsZero && (marker === 0xffff || marker === 0)) {
      return isPublicAddress(bytes.slice(12).join('.'));
    }

    const first = bytes[0]!;
    if ((first & 0xfe) === 0xfc) return false; // unique-local, fc00::/7
    if (first === 0xfe && (bytes[1]! & 0xc0) === 0x80) return false; // link-local, fe80::/10
    if (first === 0xff) return false; // multicast
    return true;
  }

  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];

  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 169 && b === 254) return false; // link-local, and the cloud metadata service
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a >= 224) return false; // multicast and reserved
  return true;
}

/**
 * Rejects an endpoint this server must not fetch.
 *
 * Resolves the hostname rather than pattern-matching it, because
 * `agent.example.com` resolving to 127.0.0.1 is the entire trick. A DNS
 * rebinding attack can still change the answer between this check and the
 * fetch; closing that properly needs a pinned-IP agent, and it is worth being
 * clear that this guard raises the cost rather than eliminating the class.
 */
export async function assertFetchableEndpoint(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PreflightError(`${raw} is not a URL`);
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PreflightError(`endpoints must be http or https, not ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new PreflightError('endpoints must not carry credentials');
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) !== 0 ? [{ address: host }] : await lookup(host, { all: true }).catch(() => null);

  if (addresses === null || addresses.length === 0) {
    throw new PreflightError(`${url.hostname} does not resolve`);
  }
  // Every address, not the first: a host that resolves to both a public and a
  // private address would otherwise pass on the ordering of a DNS response.
  for (const { address } of addresses) {
    if (!isPublicAddress(address)) {
      throw new PreflightError(
        `${url.hostname} resolves to ${address}, which is not a public address. ` +
          `Publish from a machine that can reach it: ZG_PRIVATE_KEY=0x… npx @0gflow/publish --endpoint ${raw}`,
      );
    }
  }

  return url;
}

/** Fetches the agent's declared schema. */
async function fetchSchema(endpoint: string): Promise<JsonValue> {
  const url = `${endpoint.replace(/\/+$/, '')}/schema`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) }).catch((error: Error) => {
    throw new PreflightError(`could not fetch ${url}: ${error.message}`);
  });
  if (!response.ok) throw new PreflightError(`${url} returned HTTP ${response.status}`);
  return (await response.json()) as JsonValue;
}

/** Reads the signer the agent publishes for itself, if it publishes one. */
async function fetchSigner(endpoint: string): Promise<string | null> {
  const url = `${endpoint.replace(/\/+$/, '')}/health`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { signer?: unknown };
    // Offered as a suggestion for the form, never used silently. The publisher
    // is registering a key that will be paid against their name, and taking
    // that from a server they are evaluating would be exactly backwards.
    return typeof body.signer === 'string' && /^0x[0-9a-fA-F]{40}$/.test(body.signer)
      ? body.signer
      : null;
  } catch {
    return null;
  }
}

export async function preflight(
  endpoint: string,
  options: PreflightOptions,
): Promise<PreflightResult> {
  const url = await assertFetchableEndpoint(endpoint);
  const normalised = url.toString().replace(/\/+$/, '');

  // The gate runs first and costs nothing. Only an agent that passes it is
  // worth paying to store a schema for, which also means a stranger cannot
  // spend this service's balance by pointing it at an arbitrary URL.
  const conformance = await runConformance({
    endpoint: normalised,
    probe: createHttpProbe(normalised, 15_000),
  });

  const signer = await fetchSigner(normalised);

  if (!conformance.conformant) {
    return {
      endpoint: normalised,
      conformance,
      schemaRoot: null,
      schemaNote: 'not stored: the agent did not pass the adapter contract',
      signer,
    };
  }

  if (options.storageKey === undefined) {
    return {
      endpoint: normalised,
      conformance,
      schemaRoot: null,
      schemaNote:
        'this explorer has no storage key configured, so it cannot write the schema to 0G Storage. ' +
        'Publish from a terminal instead: ZG_PRIVATE_KEY=0x… npx @0gflow/publish',
      signer,
    };
  }

  const schema = await fetchSchema(normalised);
  const storage = new ZgStorageTraceStore({
    rpcUrl: options.network.rpcUrl,
    indexerUrl: options.network.storageIndexerUrl,
    privateKey: options.storageKey,
  });
  const { traceRoot } = await storage.put(schema);

  return { endpoint: normalised, conformance, schemaRoot: traceRoot, schemaNote: null, signer };
}
