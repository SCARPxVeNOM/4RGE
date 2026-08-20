/**
 * Hashing primitives — spec §4.1, §5.2.
 *
 * Two different hash functions are load-bearing and must not be confused:
 *   sha256   — payload hashes (inputHash, outputHash), taken over canonical JSON
 *   keccak256 — chain-level hashes (flowId, receipt hashes, chain root)
 *
 * Both are implemented here in pure TypeScript rather than taken from a
 * platform API. keccak256 has to be, because node:crypto has no keccak256 —
 * it has 'sha3-256', a different function that pads with 0x06 instead of 0x01
 * and yields well-formed digests that never match the chain.
 *
 * sha256 is hand-written for a different reason: this module must run in a
 * browser. §5.2 makes it the single implementation shared by five components,
 * and §8.2's explorer performs client-side verification. Importing
 * node:crypto here meant the explorer bundle failed outright, leaving a page
 * that could only ask to be trusted. A test asserts core imports nothing
 * platform-specific.
 */

import { canonicalBytes, type JsonValue } from './canonicalize.js';

/** 0x-prefixed lowercase hex. */
export type Hex = string;

export function bytesToHex(bytes: Uint8Array): Hex {
  let out = '0x';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
  if (body.length % 2 !== 0) throw new Error(`hex string has odd length: ${hex}`);
  if (body.length > 0 && !/^[0-9a-fA-F]+$/.test(body)) {
    throw new Error(`not a hex string: ${hex}`);
  }
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toBytes(input: Uint8Array | string): Uint8Array {
  return typeof input === 'string' ? hexToBytes(input) : input;
}

// --------------------------------------------------------------------------
// Keccak-f[1600]
// --------------------------------------------------------------------------

const MASK64 = (1n << 64n) - 1n;

const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

/** Rho rotation offsets, flattened as index = x + 5y. */
const ROTATIONS: readonly number[] = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];

function rotl64(v: bigint, n: number): bigint {
  const s = BigInt(n);
  return ((v << s) | (v >> (64n - s))) & MASK64;
}

function keccakF1600(state: BigUint64Array): void {
  for (let round = 0; round < 24; round++) {
    // theta
    const c = new Array<bigint>(5);
    for (let x = 0; x < 5; x++) {
      c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!;
    }
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl64(c[(x + 1) % 5]!, 1);
      for (let y = 0; y < 5; y++) state[x + 5 * y] = state[x + 5 * y]! ^ d;
    }

    // rho + pi
    const b = new BigUint64Array(25);
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl64(state[x + 5 * y]!, ROTATIONS[x + 5 * y]!);
      }
    }

    // chi
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        state[x + 5 * y] =
          b[x + 5 * y]! ^ (~b[((x + 1) % 5) + 5 * y]! & MASK64 & b[((x + 2) % 5) + 5 * y]!);
      }
    }

    // iota
    state[0] = state[0]! ^ ROUND_CONSTANTS[round]!;
  }
}

const RATE_BYTES = 136; // 1600 - 2*256 bits, for keccak256

/**
 * Original Keccak sponge with 0x01 domain padding. Do not "modernise" this to
 * 0x06 — that turns it into SHA3-256 and breaks every on-chain comparison.
 */
export function keccak256(input: Uint8Array | string): Hex {
  const message = toBytes(input);
  const padded = new Uint8Array(Math.floor(message.length / RATE_BYTES + 1) * RATE_BYTES);
  padded.set(message);
  padded[message.length] = 0x01;
  padded[padded.length - 1] = (padded[padded.length - 1] ?? 0) | 0x80;

  const state = new BigUint64Array(25);
  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let lane = 0; lane < RATE_BYTES / 8; lane++) {
      let word = 0n;
      for (let byte = 7; byte >= 0; byte--) {
        word = (word << 8n) | BigInt(padded[offset + lane * 8 + byte]!);
      }
      state[lane] = state[lane]! ^ word;
    }
    keccakF1600(state);
  }

  const out = new Uint8Array(32);
  for (let lane = 0; lane < 4; lane++) {
    let word = state[lane]!;
    for (let byte = 0; byte < 8; byte++) {
      out[lane * 8 + byte] = Number(word & 0xffn);
      word >>= 8n;
    }
  }
  return bytesToHex(out);
}

// --------------------------------------------------------------------------
// SHA-256 (FIPS 180-4)
// --------------------------------------------------------------------------

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

export function sha256(input: Uint8Array | string): Hex {
  const message = toBytes(input);

  // Pad: 0x80, zeros, then the 64-bit big-endian bit length.
  const bitLength = BigInt(message.length) * 8n;
  const padded = new Uint8Array((Math.floor((message.length + 8) / 64) + 1) * 64);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setBigUint64(padded.length - 8, bitLength, false);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }

    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + S1 + ch + K256[i]! + w[i]!) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      hh = g; g = f; f = e;
      e = (d + temp1) | 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) | 0;
    }

    h[0] = (h[0]! + a) | 0; h[1] = (h[1]! + b) | 0; h[2] = (h[2]! + c) | 0; h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0; h[5] = (h[5]! + f) | 0; h[6] = (h[6]! + g) | 0; h[7] = (h[7]! + hh) | 0;
  }

  const out = new Uint8Array(32);
  new DataView(out.buffer).setUint32(0, h[0]!, false);
  for (let i = 0; i < 8; i++) new DataView(out.buffer).setUint32(i * 4, h[i]!, false);
  return bytesToHex(out);
}

/**
 * §4.1 inputHash / outputHash: sha256 over the RFC 8785 canonical form.
 * Always hash through this rather than hashing a JSON string directly, so the
 * preimage is the canonical bytes and not whatever the caller happened to
 * serialise.
 */
export function hashJson(value: JsonValue): Hex {
  return sha256(canonicalBytes(value));
}
