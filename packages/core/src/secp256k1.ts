/**
 * secp256k1 public key recovery — the primitive behind attestation binding.
 *
 * Hand-written for the same reason keccak256 and sha256 are (see hash.ts):
 * §9 makes the verifier a zero-dependency single file, and §8.2 runs the same
 * core in a browser. Pulling in ethers or viem here would put a megabyte of
 * dependency behind the one check that decides whether a TEE attestation
 * actually says anything.
 *
 * This is recovery only — no signing, no key generation, no private keys ever.
 * A verifier never needs to produce a signature, and code that cannot sign
 * cannot leak a key.
 *
 * Not constant-time. It operates exclusively on public data — a signature, a
 * message hash and a public key — so there is no secret for a timing channel
 * to leak. Do not repurpose it for anything involving a private key.
 */

import { bytesToHex, hexToBytes, keccak256, type Hex } from './hash.js';

/** Field prime: 2^256 - 2^32 - 977. */
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
/** Group order. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** Curve is y^2 = x^3 + 7. */
const B = 7n;

const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

export class Secp256k1Error extends Error {
  override readonly name = 'Secp256k1Error';
}

function mod(a: bigint, m: bigint = P): bigint {
  const result = a % m;
  return result >= 0n ? result : result + m;
}

/** Extended Euclid. Much faster than exponentiation, and this runs in a loop. */
function invert(value: bigint, modulus: bigint = P): bigint {
  if (value === 0n) throw new Secp256k1Error('cannot invert zero');
  let [old_r, r] = [mod(value, modulus), modulus];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  return mod(old_s, modulus);
}

function power(base: bigint, exponent: bigint, modulus: bigint = P): bigint {
  let result = 1n;
  let b = mod(base, modulus);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/**
 * Square root mod p. p ≡ 3 (mod 4), so a^((p+1)/4) is the root when one
 * exists. The caller must confirm it squares back — this returns a value for
 * non-residues too.
 */
function sqrt(value: bigint): bigint {
  return power(value, (P + 1n) / 4n);
}

/** Jacobian point: (X, Y, Z) represents affine (X/Z^2, Y/Z^3). */
interface Point {
  readonly x: bigint;
  readonly y: bigint;
  readonly z: bigint;
}

const ZERO: Point = { x: 0n, y: 1n, z: 0n };
const G: Point = { x: GX, y: GY, z: 1n };

const isZero = (point: Point): boolean => point.z === 0n;

function double(point: Point): Point {
  if (isZero(point)) return point;
  const { x, y, z } = point;
  const a = (x * x) % P;
  const b = (y * y) % P;
  const c = (b * b) % P;
  let d = 2n * ((x + b) * (x + b) - a - c);
  d = mod(d);
  const e = 3n * a;
  const f = mod(e * e);
  const nx = mod(f - 2n * d);
  const ny = mod(e * (d - nx) - 8n * c);
  const nz = mod(2n * y * z);
  return { x: nx, y: ny, z: nz };
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

  if (h === 0n) {
    // Same x. Either the same point (double) or inverses (result is zero).
    return r === 0n ? double(p1) : ZERO;
  }

  const hh = mod(h * h);
  const hhh = mod(h * hh);
  const v = mod(u1 * hh);
  const nx = mod(r * r - hhh - 2n * v);
  const ny = mod(r * (v - nx) - s1 * hhh);
  const nz = mod(h * p1.z * p2.z);
  return { x: nx, y: ny, z: nz };
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

function toAffine(point: Point): { x: bigint; y: bigint } {
  if (isZero(point)) throw new Secp256k1Error('point at infinity has no affine form');
  const zInv = invert(point.z);
  const zInv2 = mod(zInv * zInv);
  return { x: mod(point.x * zInv2), y: mod(point.y * zInv2 * zInv) };
}

export interface Signature {
  readonly r: bigint;
  readonly s: bigint;
  /** Recovery id, 0-3. */
  readonly recovery: number;
}

/**
 * Splits a 65-byte signature into r, s and a normalised recovery id.
 *
 * The trailing byte is 27/28 in Ethereum's convention and 0/1 in the raw one;
 * both appear in the wild and both are accepted. EIP-155 chain-encoded v
 * values are rejected rather than guessed at: those belong to transactions,
 * not to personal_sign, and silently mishandling one would recover a
 * plausible-looking wrong address.
 */
export function parseSignature(signature: Hex | Uint8Array): Signature {
  const bytes = typeof signature === 'string' ? hexToBytes(signature) : signature;
  if (bytes.length !== 65) {
    throw new Secp256k1Error(`signature must be 65 bytes, got ${bytes.length}`);
  }

  const r = BigInt(bytesToHex(bytes.slice(0, 32)));
  const s = BigInt(bytesToHex(bytes.slice(32, 64)));
  const raw = bytes[64]!;

  let recovery: number;
  if (raw === 0 || raw === 1) recovery = raw;
  else if (raw === 27 || raw === 28) recovery = raw - 27;
  else if (raw === 2 || raw === 3) recovery = raw;
  else throw new Secp256k1Error(`unsupported signature v byte: ${raw}`);

  if (r <= 0n || r >= N) throw new Secp256k1Error('signature r is out of range');
  if (s <= 0n || s >= N) throw new Secp256k1Error('signature s is out of range');

  // Reject the malleable high-s form. Every signature ECDSA produces has a
  // second valid encoding with s' = N - s, and accepting both would let the
  // same signed message appear under two different attestation digests.
  if (s > N / 2n) throw new Secp256k1Error('signature s is in the high half (malleable form)');

  return { r, s, recovery };
}

/**
 * Recovers the uncompressed public key (64 bytes, X‖Y) that produced a
 * signature over `messageHash`.
 */
export function recoverPublicKey(messageHash: Hex | Uint8Array, signature: Signature): Uint8Array {
  const hashBytes = typeof messageHash === 'string' ? hexToBytes(messageHash) : messageHash;
  if (hashBytes.length !== 32) {
    throw new Secp256k1Error(`message hash must be 32 bytes, got ${hashBytes.length}`);
  }
  const z = BigInt(bytesToHex(hashBytes));
  const { r, s, recovery } = signature;

  // Recovery bit 1 says the x coordinate overflowed the group order.
  const x = (recovery & 2) !== 0 ? r + N : r;
  if (x >= P) throw new Secp256k1Error('recovered x coordinate is not in the field');

  const ySquared = mod(mod(x * x) * x + B);
  let y = sqrt(ySquared);
  if (mod(y * y) !== ySquared) {
    throw new Secp256k1Error('signature does not correspond to a point on the curve');
  }
  // Recovery bit 0 is the parity of y.
  if ((y & 1n) !== BigInt(recovery & 1)) y = P - y;

  const R: Point = { x, y, z: 1n };
  const rInv = invert(r, N);

  // Q = r^-1 (sR - zG)
  const sR = multiply(R, s);
  const zG = multiply(G, mod(-z, N));
  const Q = multiply(add(sR, zG), rInv);

  if (isZero(Q)) throw new Secp256k1Error('recovered the point at infinity');

  const affine = toAffine(Q);
  const out = new Uint8Array(64);
  out.set(hexToBytes(affine.x.toString(16).padStart(64, '0')), 0);
  out.set(hexToBytes(affine.y.toString(16).padStart(64, '0')), 32);
  return out;
}

/** The low 20 bytes of keccak256 over the uncompressed key, lowercase. */
export function publicKeyToAddress(publicKey: Uint8Array): Hex {
  if (publicKey.length === 65 && publicKey[0] === 0x04) publicKey = publicKey.slice(1);
  if (publicKey.length !== 64) {
    throw new Secp256k1Error(`public key must be 64 bytes, got ${publicKey.length}`);
  }
  return `0x${keccak256(publicKey).slice(-40)}`;
}

/** Recovers the signing address directly. Lowercase, for comparison. */
export function recoverAddress(messageHash: Hex | Uint8Array, signature: Hex | Uint8Array): Hex {
  return publicKeyToAddress(recoverPublicKey(messageHash, parseSignature(signature)));
}

/**
 * EIP-191 personal_sign digest:
 *
 *   keccak256("\x19Ethereum Signed Message:\n" ‖ len(message) ‖ message)
 *
 * The length is the message's UTF-8 *byte* count, not its character count.
 * This is what 0G Compute's enclave signs, matching ethers' hashMessage —
 * confirmed by reading the SDK rather than assuming.
 */
export function hashPersonalMessage(message: string | Uint8Array): Hex {
  const body = typeof message === 'string' ? new TextEncoder().encode(message) : message;
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${body.length}`);
  const combined = new Uint8Array(prefix.length + body.length);
  combined.set(prefix, 0);
  combined.set(body, prefix.length);
  return keccak256(combined);
}

/** Recovers the address that personal_signed a message. */
export function recoverMessageAddress(
  message: string | Uint8Array,
  signature: Hex | Uint8Array,
): Hex {
  return recoverAddress(hashPersonalMessage(message), signature);
}

/** EIP-55 mixed-case checksum, for display only. */
export function toChecksumAddress(address: Hex): Hex {
  const body = address.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(body)) throw new Secp256k1Error(`not an address: ${address}`);
  const digest = keccak256(new TextEncoder().encode(body)).slice(2);
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    out += parseInt(digest[i]!, 16) >= 8 ? body[i]!.toUpperCase() : body[i]!;
  }
  return out;
}

/** Case-insensitive address comparison, so callers never hand-roll it. */
export function addressesEqual(a: string, b: string): boolean {
  return a.replace(/^0x/, '').toLowerCase() === b.replace(/^0x/, '').toLowerCase();
}
