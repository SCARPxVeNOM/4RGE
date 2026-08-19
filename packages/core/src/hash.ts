/**
 * Hashing primitives — spec §4.1, §5.2.
 *
 * Two different hash functions are load-bearing and must not be confused:
 *   sha256   — payload hashes (inputHash, outputHash), taken over canonical JSON
 *   keccak256 — chain-level hashes (flowId, receipt hashes, chain root)
 *
 * keccak256 is implemented here rather than taken from node:crypto because
 * node:crypto has no keccak256. It has 'sha3-256', which is a different
 * function: SHA-3 pads with 0x06, original Keccak pads with 0x01. Substituting
 * one for the other yields well-formed digests that never match the chain.
 */

import { createHash } from 'node:crypto';
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
// SHA-256
// --------------------------------------------------------------------------

export function sha256(input: Uint8Array | string): Hex {
  return bytesToHex(new Uint8Array(createHash('sha256').update(toBytes(input)).digest()));
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
