/**
 * NIST P-256 (secp256r1) ECDSA verification.
 *
 * A *different curve* from secp256k1.ts, not a variant of it. Intel signs TDX
 * quotes and the PCK certificate chain with P-256; Ethereum uses secp256k1.
 * They share a field size and nothing else that matters: P-256 has a = -3
 * where secp256k1 has a = 0, so the point doubling formula differs and a
 * "shared" implementation would silently produce points off the curve.
 *
 * Verification only — no signing, no key generation. Not constant-time; it
 * operates solely on public data (a certificate, a signature, a public key),
 * so there is no secret for a timing channel to leak.
 *
 * Zero-dependency for the reason given in hash.ts: §9 makes the verifier a
 * single auditable file, and vendoring a crypto library to check Intel's
 * signatures would defeat that.
 */

import { bytesToHex, sha256, type Hex } from './hash.js';

/** p = 2^256 - 2^224 + 2^192 + 2^96 - 1 */
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
/** Group order. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
/** a = -3 mod p. The whole reason this is a separate file. */
const A = P - 3n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;

const GX = 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n;
const GY = 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n;

export class P256Error extends Error {
  override readonly name = 'P256Error';
}

function mod(a: bigint, m: bigint = P): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function invert(value: bigint, modulus: bigint = P): bigint {
  if (mod(value, modulus) === 0n) throw new P256Error('cannot invert zero');
  let [oldR, r] = [mod(value, modulus), modulus];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return mod(oldS, modulus);
}

/** Jacobian (X, Y, Z) representing affine (X/Z², Y/Z³). */
interface Point {
  readonly x: bigint;
  readonly y: bigint;
  readonly z: bigint;
}

const ZERO: Point = { x: 0n, y: 1n, z: 0n };
const G: Point = { x: GX, y: GY, z: 1n };
const isZero = (p: Point): boolean => p.z === 0n;

/**
 * Generic doubling, valid for any `a`. The a = 0 shortcut used for secp256k1
 * would be wrong here — this is where the two curves actually diverge.
 */
function double(p: Point): Point {
  if (isZero(p)) return p;
  const delta = mod(p.z * p.z);
  const gamma = mod(p.y * p.y);
  const beta = mod(p.x * gamma);
  const alpha = mod(3n * p.x * p.x + A * delta * delta);
  const x3 = mod(alpha * alpha - 8n * beta);
  const z3 = mod((p.y + p.z) * (p.y + p.z) - gamma - delta);
  const y3 = mod(alpha * (4n * beta - x3) - 8n * gamma * gamma);
  return { x: x3, y: y3, z: z3 };
}

function add(p1: Point, p2: Point): Point {
  if (isZero(p1)) return p2;
  if (isZero(p2)) return p1;

  const z1z1 = mod(p1.z * p1.z);
  const z2z2 = mod(p2.z * p2.z);
  const u1 = mod(p1.x * z2z2);
  const u2 = mod(p2.x * z1z1);
  const s1 = mod(p1.y * p2.z * z2z2);
  const s2 = mod(p2.y * p1.z * z1z1);

  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  if (h === 0n) return r === 0n ? double(p1) : ZERO;

  const hh = mod(h * h);
  const hhh = mod(h * hh);
  const v = mod(u1 * hh);
  const x3 = mod(r * r - hhh - 2n * v);
  const y3 = mod(r * (v - x3) - s1 * hhh);
  const z3 = mod(h * p1.z * p2.z);
  return { x: x3, y: y3, z: z3 };
}

function multiply(point: Point, scalar: bigint): Point {
  let result = ZERO;
  let addend = point;
  let k = mod(scalar, N);
  while (k > 0n) {
    if (k & 1n) result = add(result, addend);
    addend = double(addend);
    k >>= 1n;
  }
  return result;
}

function affineX(point: Point): bigint {
  if (isZero(point)) throw new P256Error('point at infinity has no affine form');
  const zInv = invert(point.z);
  return mod(point.x * mod(zInv * zInv));
}

export interface PublicKey {
  readonly x: bigint;
  readonly y: bigint;
}

/** Parses an uncompressed public key, 64 bytes X‖Y or 65 with the 0x04 tag. */
export function parsePublicKey(bytes: Uint8Array): PublicKey {
  let body = bytes;
  if (body.length === 65) {
    if (body[0] !== 0x04) {
      // Compressed keys are legal X.509 and Intel does not use them. Rejecting
      // is honest; silently mis-parsing one would fail every signature with a
      // misleading error.
      throw new P256Error(`unsupported public key format 0x${body[0]!.toString(16)}`);
    }
    body = body.slice(1);
  }
  if (body.length !== 64) {
    throw new P256Error(`public key must be 64 bytes, got ${body.length}`);
  }

  const x = BigInt(bytesToHex(body.slice(0, 32)));
  const y = BigInt(bytesToHex(body.slice(32)));

  // y² = x³ + ax + b. A key off the curve makes every subsequent operation
  // meaningless, so it is checked once here rather than trusted.
  if (mod(y * y) !== mod(mod(x * x) * x + A * x + B)) {
    throw new P256Error('public key is not a point on P-256');
  }
  return { x, y };
}

/**
 * Verifies an ECDSA signature over `messageHash` (32 bytes).
 *
 * `r` and `s` are the raw big-endian halves. Unlike secp256k1.ts, a high `s`
 * is NOT rejected: malleability matters there because two encodings of one
 * signature would give one output two attestation digests, whereas here we are
 * checking signatures Intel already produced and must accept them as they are.
 */
export function verify(
  publicKey: PublicKey,
  messageHash: Uint8Array,
  r: bigint,
  s: bigint,
): boolean {
  if (messageHash.length !== 32) {
    throw new P256Error(`message hash must be 32 bytes, got ${messageHash.length}`);
  }
  if (r <= 0n || r >= N || s <= 0n || s >= N) return false;

  const z = BigInt(bytesToHex(messageHash));
  const w = invert(s, N);
  const u1 = mod(z * w, N);
  const u2 = mod(r * w, N);

  const q: Point = { x: publicKey.x, y: publicKey.y, z: 1n };
  const point = add(multiply(G, u1), multiply(q, u2));
  if (isZero(point)) return false;
  return mod(affineX(point), N) === mod(r, N);
}

/** Verifies a raw 64-byte r‖s signature over a message, hashing with SHA-256. */
export function verifySha256(
  publicKey: PublicKey,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (signature.length !== 64) {
    throw new P256Error(`raw signature must be 64 bytes, got ${signature.length}`);
  }
  const digest = hexToBytes32(sha256(message));
  const r = BigInt(bytesToHex(signature.slice(0, 32)));
  const s = BigInt(bytesToHex(signature.slice(32)));
  return verify(publicKey, digest, r, s);
}

function hexToBytes32(hex: Hex): Uint8Array {
  const body = hex.slice(2);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}
