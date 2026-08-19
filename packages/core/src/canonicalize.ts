/**
 * RFC 8785 JSON Canonicalization Scheme — spec §5.2.
 *
 * FROZEN MODULE. Five consumers hash through this code: executor, verifier,
 * indexer, and both SDKs. If any two disagree by a single byte you get runs
 * that execute successfully and then fail verification, with a symptom that
 * points nowhere near the cause. Changing observable behaviour here is a
 * consensus break, not a refactor.
 *
 * Zero runtime dependencies, by requirement: the verifier CLI (§9) ships as a
 * single auditable file, so everything it hashes through must be dependency
 * free.
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export class CanonicalizationError extends Error {
  override readonly name = 'CanonicalizationError';
  constructor(message: string, readonly path: string) {
    super(`${message} (at ${path || '<root>'})`);
  }
}

const ESCAPES = new Map<number, string>([
  [0x08, '\\b'],
  [0x09, '\\t'],
  [0x0a, '\\n'],
  [0x0c, '\\f'],
  [0x0d, '\\r'],
  [0x22, '\\"'],
  [0x5c, '\\\\'],
]);

/**
 * RFC 8785 §3.2.2.2: short escapes where defined, \u00xx lowercase for the
 * remaining C0 controls, every other code point literal. Notably the solidus
 * is NOT escaped and non-ASCII is NOT escaped.
 */
function serializeString(raw: string, path: string): string {
  assertWellFormed(raw, path);
  const s = raw.normalize('NFC');
  let out = '"';
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    const short = ESCAPES.get(code);
    if (short !== undefined) out += short;
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}

/**
 * Lone surrogates cannot be encoded as UTF-8, so they have no canonical byte
 * form. Reject rather than emit a replacement character and hash something the
 * caller never supplied.
 */
function assertWellFormed(s: string, path: string): void {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalizationError('unpaired high surrogate', path);
      }
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new CanonicalizationError('unpaired low surrogate', path);
    }
  }
}

/**
 * RFC 8785 §3.2.2.3 defers to ECMAScript Number::toString, which is exactly
 * what String(n) produces: shortest representation that round-trips.
 */
function serializeNumber(n: number, path: string): string {
  if (!Number.isFinite(n)) {
    throw new CanonicalizationError(`non-finite number: ${String(n)}`, path);
  }
  // -0 and 0 are the same JSON value; emitting "-0" would give two equal
  // documents different hashes.
  return Object.is(n, -0) ? '0' : String(n);
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * RFC 8785 §3.2.3 sorts property names by UTF-16 code unit, which is the
 * JavaScript default comparison. This is NOT code point order: U+1F600 sorts
 * before U+FFFF because its leading surrogate (0xD83D) is below 0xFFFF.
 * Ports must sort on the UTF-16 encoding, not on code points — Python's
 * sorted() gets this wrong by default and produces unverifiable runs.
 */
function sortKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function serialize(value: unknown, path: string, seen: Set<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return serializeNumber(value, path);
    case 'string':
      return serializeString(value, path);
    case 'undefined':
      throw new CanonicalizationError('undefined is not a JSON value', path);
    case 'bigint':
      // Silently narrowing to a double would corrupt values above 2^53.
      throw new CanonicalizationError('bigint is not a JSON value', path);
    case 'function':
    case 'symbol':
      throw new CanonicalizationError(`${typeof value} is not a JSON value`, path);
  }

  const obj = value as object;
  if (seen.has(obj)) throw new CanonicalizationError('circular reference', path);
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts = obj.map((item, i) => serialize(item, `${path}[${i}]`, seen));
      return `[${parts.join(',')}]`;
    }

    // A Date, Map or class instance has no own enumerable keys and would
    // otherwise canonicalize to "{}", discarding the value in silence.
    if (!isPlainObject(obj)) {
      throw new CanonicalizationError(
        `unsupported object type: ${obj.constructor?.name ?? 'unknown'}`,
        path,
      );
    }
    // toJSON is deliberately not honoured: a payload must not be able to
    // choose its own canonical form.
    if ('toJSON' in obj) {
      throw new CanonicalizationError('objects carrying toJSON are not accepted', path);
    }

    const record = obj as Record<string, unknown>;
    const normalized = new Map<string, string>();
    for (const key of Object.keys(record)) {
      assertWellFormed(key, path);
      const nfc = key.normalize('NFC');
      if (normalized.has(nfc)) {
        // Two distinct keys collapsing under NFC would make the canonical form
        // depend on iteration order.
        throw new CanonicalizationError(`duplicate key after NFC normalisation: ${nfc}`, path);
      }
      normalized.set(nfc, key);
    }

    const parts = sortKeys([...normalized.keys()]).map((nfc) => {
      const original = normalized.get(nfc)!;
      const child = serialize(record[original], `${path}.${nfc}`, seen);
      return `${serializeString(nfc, path)}:${child}`;
    });
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

/** Canonical RFC 8785 form of `value`. Throws on anything not representable. */
export function canonicalize(value: JsonValue): string {
  return serialize(value, '', new Set());
}

/** Canonical form as UTF-8 bytes — the exact preimage every hash is taken over. */
export function canonicalBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
