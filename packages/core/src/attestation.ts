/**
 * Attestation binding — closes the gap recorded in docs/attestation-structure.md.
 *
 * THE PROBLEM
 *
 * `attestationRef = sha256(quote)` proves the quote was not modified after the
 * fact. It does not prove the quote has anything to do with this step's output.
 * An operator can attach a genuine attestation, captured from a real enclave,
 * to an output that enclave never produced, and nothing in §9's verification
 * would notice.
 *
 * WHAT ACTUALLY CLOSES IT
 *
 * The TDX quote's 64-byte `report_data` carries the ASCII of an Ethereum
 * address, zero-padded — the key the enclave controls. Because `report_data`
 * is covered by the quote's signature, Intel's hardware root of trust attests
 * "an enclave running these measurements controls this key". Binding an output
 * to that key needs a second signature, by that key, over that output.
 *
 * A NOTE ON THE 0G SDK, WHICH DOES NOT DO THIS
 *
 * `Verifier.verifySignature(ResponseSignature.text, sig, addr)` verifies the
 * signature over `text` — the text returned by the *same* endpoint that
 * returned the signature. It never compares that text against the response the
 * client actually received. So the SDK's check establishes "the enclave signed
 * something", not "the enclave signed what I got": a provider can serve one
 * completion and a correctly-signed different `text`, and the SDK passes.
 *
 * This module therefore requires the comparison the SDK omits. That is the
 * whole difference between `attested` and `bound`.
 *
 * WHAT IS NOT CLOSED
 *
 * The TDX quote's own signature is not verified against Intel's certificate
 * chain — that needs the PCS roots, and §9 keeps the verifier
 * zero-dependency. So `bound` means "the key named in this quote signed this
 * output", not "Intel vouches for the enclave holding that key". The
 * `quoteSignatureVerified` flag is reported as false rather than omitted, so
 * nothing here can be read as an unqualified TEE tick.
 */

import { canonicalBytes, type JsonValue } from './canonicalize.js';
import { hexToBytes, sha256, type Hex } from './hash.js';
import { addressesEqual, recoverMessageAddress } from './secp256k1.js';

/**
 * How much this attestation actually establishes. Ordered weakest first.
 *
 *   absent    nothing was returned
 *   present   a document was captured; nothing about its meaning is established
 *   attested  a key named in the quote signed some text
 *   bound     that key signed *this step's output*
 *
 * Only `bound` makes the attestation load-bearing for a receipt. §1.3 forbids
 * silently promoting the weaker levels.
 */
export type BindingLevel = 'absent' | 'present' | 'attested' | 'bound';

const RANK: Record<BindingLevel, number> = { absent: 0, present: 1, attested: 2, bound: 3 };

/** True when `level` is at least as strong as `required`. */
export function meetsBinding(level: BindingLevel, required: BindingLevel): boolean {
  return RANK[level] >= RANK[required];
}

/** The per-response signature, as served by /v1/proxy/signature/{chatID}. */
export interface ResponseSignature {
  readonly chatID: string;
  readonly model: string;
  /** The text the enclave signed, verbatim. */
  readonly text: string;
  /** 65-byte secp256k1 signature over the EIP-191 digest of `text`. */
  readonly signature: Hex;
  /**
   * Which part of the step output the signed text is. A dotted path such as
   * `$.text`, or `$` when the whole output is the signed string.
   *
   * Recorded rather than assumed: the executor knows how it built the output
   * from the completion, and a verifier working from the trace alone does not.
   * Without it, `bound` would rest on a convention nobody wrote down.
   */
  readonly outputPath: string;
}

/** What the executor stores in the trace and digests into `attestationRef`. */
export interface AttestationBundle {
  /** The attestation document exactly as served. Never re-encoded. */
  readonly quote: string;
  /** null when the provider served a quote but no per-response signature. */
  readonly response: ResponseSignature | null;
}

export interface AttestationVerification {
  readonly level: BindingLevel;
  /** The address from the quote's report_data, when it could be read. */
  readonly signerAddress: Hex | null;
  /** The address recovered from the response signature, when there was one. */
  readonly recoveredAddress: Hex | null;
  /**
   * Always false for now: verifying the quote against Intel's PCS roots is not
   * implemented. Reported rather than omitted so no caller can print an
   * unqualified TEE tick.
   */
  readonly quoteSignatureVerified: false;
  /** Why the level is not higher. Empty when `bound`. */
  readonly notes: string[];
}

export class AttestationError extends Error {
  override readonly name = 'AttestationError';
}

// ---------------------------------------------------------------------------
// report_data
// ---------------------------------------------------------------------------

function decodeBase64(value: string): Uint8Array {
  // atob exists in Node 16+ and in every browser, so core stays platform-free.
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Reads the signing address out of a TDX quote's `report_data`.
 *
 * Observed on Galileo (docs/attestation-structure.md): 64 bytes, holding the
 * ASCII text of an Ethereum address followed by zero padding. It is not a
 * hash, which is the finding the whole design depends on.
 */
export function signerFromReportData(reportData: string): Hex {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(reportData);
  } catch {
    throw new AttestationError('report_data is not valid base64');
  }
  if (bytes.length !== 64) {
    throw new AttestationError(`report_data must be 64 bytes, got ${bytes.length}`);
  }

  let text = '';
  for (const byte of bytes) {
    if (byte === 0) break;
    text += String.fromCharCode(byte);
  }

  const address = text.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new AttestationError(
      `report_data does not hold an Ethereum address; got ${JSON.stringify(address.slice(0, 80))}`,
    );
  }
  return address.toLowerCase() as Hex;
}

export interface QuoteEnvelope {
  readonly signerAddress: Hex;
  /** TDX quote version, from the header. */
  readonly quoteVersion: number;
  readonly teeType: number;
}

/**
 * Parses the JSON envelope 0G Compute serves at /v1/quote. Throws when the
 * payload is not one — a self-signed blob from an ordinary HTTP agent is not
 * a TEE quote, and must not be treated as one.
 */
export function parseQuoteEnvelope(raw: string): QuoteEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AttestationError('attestation is not a JSON quote envelope');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AttestationError('attestation is not a JSON object');
  }

  const envelope = parsed as Record<string, unknown>;
  const reportData = envelope['report_data'];
  if (typeof reportData !== 'string') {
    throw new AttestationError('attestation envelope has no report_data');
  }
  const signerAddress = signerFromReportData(reportData);

  // Header bytes: version at offset 0, TEE type at offset 4, both little
  // endian. 0x81 is TDX.
  let quoteVersion = 0;
  let teeType = 0;
  const quote = envelope['quote'];
  if (typeof quote === 'string' && quote.length >= 16) {
    const header = hexToBytes(quote.startsWith('0x') ? quote.slice(0, 18) : `0x${quote.slice(0, 16)}`);
    quoteVersion = (header[0] ?? 0) | ((header[1] ?? 0) << 8);
    teeType = (header[4] ?? 0) | ((header[5] ?? 0) << 8);
  }

  return { signerAddress, quoteVersion, teeType };
}

// ---------------------------------------------------------------------------
// attestationRef
// ---------------------------------------------------------------------------

const DOMAIN = '0gflow-attestation-v1\n';

function lengthPrefixed(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + 8 + part.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const part of parts) {
    view.setBigUint64(offset, BigInt(part.length), false);
    offset += 8;
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

/**
 * The digest anchored as `attestationRef`.
 *
 * Deliberately a length-prefixed concatenation rather than canonical JSON.
 * The quote is served as text/plain and carries JSON-encoded strings inside
 * JSON fields; canonicalising it would NFC-normalise and re-escape bytes,
 * changing the digest without changing the meaning. Length prefixes make the
 * concatenation unambiguous, and the domain tag means this can never collide
 * with the legacy quote-only digest — so an old receipt cannot be replayed as
 * though it carried a binding.
 */
export function attestationRefFor(bundle: AttestationBundle): Hex {
  const response = bundle.response;
  const preimage = lengthPrefixed([
    utf8(DOMAIN),
    utf8(bundle.quote),
    utf8(response?.chatID ?? ''),
    utf8(response?.model ?? ''),
    utf8(response?.text ?? ''),
    response === null ? new Uint8Array(0) : hexToBytes(response.signature),
    utf8(response?.outputPath ?? ''),
  ]);
  return sha256(preimage);
}

/**
 * The pre-binding digest, reproduced exactly as it was anchored:
 * sha256 over the base64-*decoded* attestation.
 *
 * The decode is not a design choice, it is history. The executor hashed the
 * base64-decoded form, so that is what live receipts commit to, and a verifier
 * that hashed the string instead would report every one of them as tampered.
 * Kept solely so those receipts remain checkable; they establish `present` and
 * nothing more.
 *
 * Decoding is lenient for the same reason: Node's decoder silently drops
 * characters outside the alphabet, and a stricter one here would compute a
 * different digest for the same stored bytes.
 */
export function legacyAttestationRef(raw: string): Hex {
  return sha256(decodeBase64Lenient(raw));
}

function decodeBase64Lenient(value: string): Uint8Array {
  const cleaned = value.replace(/[^A-Za-z0-9+/]/g, '');
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  try {
    return decodeBase64(padded);
  } catch {
    return new Uint8Array(0);
  }
}

// ---------------------------------------------------------------------------
// output path
// ---------------------------------------------------------------------------

/**
 * Resolves `$`, `$.a`, `$.a.b` and `$.a[0]` against an output.
 *
 * Deliberately tiny and non-evaluating, for the same reason §5.1 templates
 * are: this runs inside a verifier, over data supplied by the party being
 * verified.
 */
export function resolveOutputPath(output: JsonValue, path: string): JsonValue | undefined {
  if (path === '$') return output;
  if (!path.startsWith('$')) return undefined;

  let current: JsonValue | undefined = output;
  const tokens = path.slice(1).match(/\.[^.[\]]+|\[\d+\]/g);
  if (tokens === null) return undefined;

  for (const token of tokens) {
    if (current === undefined || current === null) return undefined;
    if (token.startsWith('[')) {
      const index = Number(token.slice(1, -1));
      if (!Array.isArray(current)) return undefined;
      current = current[index];
    } else {
      const key = token.slice(1);
      if (typeof current !== 'object' || Array.isArray(current)) return undefined;
      current = (current as Record<string, JsonValue>)[key];
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------

export interface VerifyAttestationInput {
  readonly bundle: AttestationBundle | null;
  /** The step's output, as anchored. Needed to reach `bound`. */
  readonly output: JsonValue | null;
  /**
   * The TEE signer acknowledged on chain for this provider, when the caller
   * could read it. When supplied it must match, or the level is capped.
   */
  readonly acknowledgedSigner?: Hex | null;
}

/**
 * Establishes how much an attestation proves. Never throws for a malformed
 * attestation — a bad attestation is a finding, not an exception, and the
 * caller needs the level to decide a status.
 */
export function verifyAttestation(input: VerifyAttestationInput): AttestationVerification {
  const notes: string[] = [];
  const base = { quoteSignatureVerified: false as const };

  if (input.bundle === null || input.bundle.quote.length === 0) {
    return { ...base, level: 'absent', signerAddress: null, recoveredAddress: null, notes: [] };
  }

  let envelope: QuoteEnvelope;
  try {
    envelope = parseQuoteEnvelope(input.bundle.quote);
  } catch (error) {
    // An ordinary agent's self-signed blob lands here, correctly: it is a
    // document, not a hardware attestation.
    notes.push(`quote not parsed: ${(error as Error).message}`);
    return { ...base, level: 'present', signerAddress: null, recoveredAddress: null, notes };
  }

  if (envelope.teeType !== 0x81) {
    notes.push(
      `quote TEE type is 0x${envelope.teeType.toString(16)}, expected 0x81 (TDX)`,
    );
  }

  const signerAddress = envelope.signerAddress;
  notes.push('quote signature not verified against Intel PCS roots (not implemented)');

  if (
    input.acknowledgedSigner !== undefined &&
    input.acknowledgedSigner !== null &&
    !addressesEqual(signerAddress, input.acknowledgedSigner)
  ) {
    // The quote names a key, but not the key this provider registered. That
    // is a quote from somewhere else.
    notes.push(
      `quote binds ${signerAddress} but the provider's acknowledged TEE signer is ${input.acknowledgedSigner}`,
    );
    return { ...base, level: 'present', signerAddress, recoveredAddress: null, notes };
  }

  const response = input.bundle.response;
  if (response === null) {
    notes.push(
      'no per-response signature, so nothing ties this quote to the step output',
    );
    return { ...base, level: 'present', signerAddress, recoveredAddress: null, notes };
  }

  let recoveredAddress: Hex;
  try {
    recoveredAddress = recoverMessageAddress(response.text, response.signature);
  } catch (error) {
    notes.push(`response signature could not be recovered: ${(error as Error).message}`);
    return { ...base, level: 'present', signerAddress, recoveredAddress: null, notes };
  }

  if (!addressesEqual(recoveredAddress, signerAddress)) {
    notes.push(
      `response was signed by ${recoveredAddress}, which is not the key the quote binds (${signerAddress})`,
    );
    return { ...base, level: 'present', signerAddress, recoveredAddress, notes };
  }

  // At this point an enclave-held key signed `response.text`. That is exactly
  // as far as the 0G SDK goes, and it is not yet a statement about the output.
  if (input.output === null) {
    notes.push('output unavailable, so the signed text could not be compared against it');
    return { ...base, level: 'attested', signerAddress, recoveredAddress, notes };
  }

  const claimed = resolveOutputPath(input.output, response.outputPath);
  if (claimed === undefined) {
    notes.push(
      `outputPath ${response.outputPath} does not resolve in the step output`,
    );
    return { ...base, level: 'attested', signerAddress, recoveredAddress, notes };
  }

  // The comparison the SDK omits. Without it, a provider can serve one
  // completion and a correctly-signed different text.
  const matches =
    typeof claimed === 'string'
      ? claimed === response.text
      : new TextDecoder().decode(canonicalBytes(claimed)) === response.text;

  if (!matches) {
    notes.push(
      'the signed text does not match the step output: this attestation belongs to a different response',
    );
    return { ...base, level: 'attested', signerAddress, recoveredAddress, notes };
  }

  return {
    ...base,
    level: 'bound',
    signerAddress,
    recoveredAddress,
    // The Intel note stays: `bound` is a claim about the key, not about Intel.
    notes: notes.filter((n) => n.startsWith('quote signature not verified')),
  };
}

/** Human-readable, and deliberately never an unqualified tick. */
export function describeBinding(verification: AttestationVerification): string {
  switch (verification.level) {
    case 'absent':
      return 'no attestation';
    case 'present':
      return 'attestation present, unverified';
    case 'attested':
      return `signed by ${verification.signerAddress ?? 'an enclave key'}, but not tied to this output`;
    case 'bound':
      return `output signed by the enclave key ${verification.signerAddress ?? ''} (Intel chain not checked)`;
    default: {
      const exhaustive: never = verification.level;
      throw new AttestationError(`unhandled level ${String(exhaustive)}`);
    }
  }
}
