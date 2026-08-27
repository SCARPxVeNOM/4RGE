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
 * THE TRUST ANCHOR IS 0G, NOT INTEL
 *
 * 0G's InferenceServing contract already records, per provider, the TEE signer
 * address it has acknowledged (`teeSignerAddress`, `teeSignerAcknowledged`).
 * That is the key the enclave controls, published as 0G chain state.
 *
 * Verified against Galileo: for both providers captured in
 * artifacts/attestation, the acknowledged `teeSignerAddress` is byte-identical
 * to the address inside the TEE quote's `report_data`. So anchoring on 0G does
 * not change *which* key is trusted — it changes who vouches for it, from a
 * vendor PKI to the chain this system already reads.
 *
 * Three things follow, all of them improvements:
 *
 *   - No foreign root certificate is vendored, and no vendor PKI has to be
 *     kept current.
 *   - Revocation works. Chain state is live: a provider whose signer is
 *     de-acknowledged stops verifying on the next read. A pinned certificate
 *     chain could not express that without a network fetch it was built to
 *     avoid.
 *   - §9's verifier reads the acknowledged signer over the same RPC it already
 *     uses for receipts, so attestation rests on exactly the public data
 *     everything else in the procedure rests on.
 *
 * WHAT THIS RESTS ON, STATED PLAINLY
 *
 * That 0G acknowledges a signer only for an enclave it actually attested. The
 * claim is "0G's registry vouches for this key, and this key signed this
 * output" — not an independent hardware proof. The quote is still stored in
 * the trace as evidence for anyone who wants to check it out of band.
 *
 * A NOTE ON THE 0G SDK, WHICH DOES NOT BIND THE OUTPUT
 *
 * `Verifier.verifySignature(ResponseSignature.text, sig, addr)` verifies the
 * signature over `text` — the text returned by the *same* endpoint that
 * returned the signature. It never compares that text against the response the
 * client actually received. So the SDK's check establishes "the enclave signed
 * something", not "the enclave signed what I got": a provider can serve one
 * completion and a correctly-signed different `text`, and the SDK passes.
 *
 * This module requires the comparison the SDK omits. That is the whole
 * difference between `attested` and `bound`.
 */

import { canonicalBytes, type JsonValue } from './canonicalize.js';
import { sha256, type Hex } from './hash.js';
import { addressesEqual, recoverMessageAddress } from './secp256k1.js';

/**
 * How much this attestation actually establishes. Ordered weakest first.
 *
 *   absent    nothing was returned
 *   present   a document was captured; nothing about its meaning is established
 *   attested  the signer 0G acknowledges for this provider signed some text
 *   bound     that signer signed *this step's output*
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
  /**
   * The text the enclave signed, verbatim.
   *
   * On 0G Compute this is NOT the completion. It is a colon-delimited envelope
   * of digests, observed live on Galileo:
   *
   *   <sha256(request)>:<sha256(response)>:centralized:aliyun:<provider hash>
   *
   * Only the second field is reproducible by a verifier, and it is the one
   * that matters: it commits to the exact response bytes. Assuming the signed
   * text equalled the answer — as an earlier version of this module did —
   * makes `bound` unreachable against a real provider.
   */
  readonly text: string;
  /** 65-byte secp256k1 signature over the EIP-191 digest of `text`. */
  readonly signature: Hex;
  /**
   * The provider's response, byte for byte as served.
   *
   * The link between the signature and the answer: `text` commits to
   * sha256 of these bytes, and the step's output is drawn from them. Storing a
   * re-serialised copy breaks the digest and with it the whole binding.
   */
  readonly responseBody: string;
  /**
   * Where the answer sits inside `responseBody` — for an OpenAI-shaped
   * completion, `$.choices[0].message.content`.
   */
  readonly responsePath: string;
  /**
   * Where the same value sits inside the step's output. `$` when the output is
   * that value; `$.text` when it was wrapped.
   *
   * Both paths are recorded rather than assumed: the agent knows how it built
   * its output from the provider's response, and a verifier working from the
   * trace alone does not. Without them, `bound` would rest on a convention
   * nobody wrote down.
   */
  readonly outputPath: string;
}

/** What the executor stores in the trace and digests into `attestationRef`. */
export interface AttestationBundle {
  /**
   * The attestation document exactly as served. Never re-encoded.
   *
   * Evidence, not a trust anchor: it is kept so a reader can inspect the
   * enclave's own report, but nothing here parses or verifies it.
   */
  readonly quote: string;
  /**
   * The 0G provider that served this step. The verifier reads *this* address's
   * acknowledged TEE signer from the InferenceServing contract, so the binding
   * cannot be pointed at some other provider's key.
   */
  readonly provider: Hex;
  /** null when the provider served a quote but no per-response signature. */
  readonly response: ResponseSignature | null;
}

/** What 0G's InferenceServing contract says about a provider's TEE signer. */
export interface AcknowledgedSigner {
  readonly provider: Hex;
  readonly teeSignerAddress: Hex;
  /** False means 0G has not vouched for this key, so it establishes nothing. */
  readonly acknowledged: boolean;
}

export interface AttestationVerification {
  readonly level: BindingLevel;
  /** The signer 0G acknowledges for this provider, when it could be read. */
  readonly acknowledgedSigner: Hex | null;
  /** The address recovered from the response signature, when there was one. */
  readonly recoveredAddress: Hex | null;
  /**
   * Whether the acknowledged signer was actually read from 0G chain. False
   * caps the level at `present`: without it there is nothing to check against,
   * and assuming would be the promotion §1.3 forbids.
   */
  readonly signerResolved: boolean;
  /** Why the level is not higher. Empty when `bound`. */
  readonly notes: string[];
}

export class AttestationError extends Error {
  override readonly name = 'AttestationError';
}

// ---------------------------------------------------------------------------
// report_data — advisory only
// ---------------------------------------------------------------------------

function decodeBase64(value: string): Uint8Array {
  // atob exists in Node 16+ and in every browser, so core stays platform-free.
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Reads the signing address out of 64 raw `report_data` bytes.
 *
 * Observed on Galileo (docs/attestation-structure.md): the ASCII text of an
 * Ethereum address followed by zero padding, not a hash.
 *
 * ADVISORY ONLY. Nothing here authenticates the quote, so this value is not
 * evidence of anything — it is used solely to cross-check against the address
 * 0G acknowledges, and a disagreement is reported as a note.
 */
export function addressFromReportDataBytes(bytes: Uint8Array): Hex {
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

/** The base64 form, as it appears in the attestation envelope. Advisory. */
export function signerFromReportData(reportData: string): Hex {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(reportData);
  } catch {
    throw new AttestationError('report_data is not valid base64');
  }
  return addressFromReportDataBytes(bytes);
}

/**
 * The address an attestation envelope claims, if it says so in a form we
 * recognise. Returns null rather than throwing: the envelope is not
 * authenticated, so a malformed one is uninteresting rather than an error.
 */
export function claimedSigner(quote: string): Hex | null {
  try {
    const parsed = JSON.parse(quote) as Record<string, unknown>;
    const reportData = parsed['report_data'];
    if (typeof reportData !== 'string') return null;
    return signerFromReportData(reportData);
  } catch {
    return null;
  }
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
 *
 * `provider` is inside the digest so the receipt commits to whose acknowledged
 * key a verifier must check against. Leaving it out would let an operator
 * re-point a stored bundle at whichever provider happens to acknowledge the
 * key that signed.
 */
export function attestationRefFor(bundle: AttestationBundle): Hex {
  const response = bundle.response;
  const preimage = lengthPrefixed([
    utf8(DOMAIN),
    utf8(bundle.quote),
    utf8(bundle.provider.toLowerCase()),
    utf8(response?.chatID ?? ''),
    utf8(response?.model ?? ''),
    utf8(response?.text ?? ''),
    response === null ? new Uint8Array(0) : hexBytes(response.signature),
    utf8(response?.responseBody ?? ''),
    utf8(response?.responsePath ?? ''),
    utf8(response?.outputPath ?? ''),
  ]);
  return sha256(preimage);
}

function hexBytes(hex: string): Uint8Array {
  const body = hex.replace(/^0x/, '');
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
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
   * What 0G's InferenceServing contract says about the bundle's provider.
   *
   * null means the caller could not read it — offline, no RPC, or the provider
   * is not registered. The level is then capped at `present`, because there is
   * nothing to check the signature against.
   */
  readonly acknowledgedSigner: AcknowledgedSigner | null;
}

/**
 * Establishes how much an attestation proves. Never throws for a malformed
 * attestation — a bad attestation is a finding, not an exception, and the
 * caller needs the level to decide a status.
 */
export function verifyAttestation(input: VerifyAttestationInput): AttestationVerification {
  const notes: string[] = [];

  if (input.bundle === null || input.bundle.quote.length === 0) {
    return {
      level: 'absent',
      acknowledgedSigner: null,
      recoveredAddress: null,
      signerResolved: false,
      notes: [],
    };
  }

  const bundle = input.bundle;
  const registry = input.acknowledgedSigner;

  if (registry === null) {
    notes.push(
      `the TEE signer 0G acknowledges for provider ${bundle.provider} could not be read, so the attestation establishes nothing`,
    );
    return {
      level: 'present',
      acknowledgedSigner: null,
      recoveredAddress: null,
      signerResolved: false,
      notes,
    };
  }

  if (!addressesEqual(registry.provider, bundle.provider)) {
    // Reading the wrong provider's registry entry would check the signature
    // against a key that has nothing to do with this step.
    notes.push(
      `registry entry is for provider ${registry.provider} but the bundle names ${bundle.provider}`,
    );
    return {
      level: 'present',
      acknowledgedSigner: null,
      recoveredAddress: null,
      signerResolved: false,
      notes,
    };
  }

  const base = { signerResolved: true, acknowledgedSigner: registry.teeSignerAddress } as const;

  if (!registry.acknowledged) {
    // 0G has a signer on file but has not vouched for it. That is exactly the
    // revocation case, and it must not attest anything.
    notes.push(
      `0G has not acknowledged the TEE signer for provider ${bundle.provider}, so it vouches for nothing`,
    );
    return { ...base, level: 'present', recoveredAddress: null, notes };
  }

  // Advisory cross-check. The envelope is unauthenticated, so a disagreement
  // is reported rather than acted on — the chain is what counts.
  const claimed = claimedSigner(bundle.quote);
  if (claimed !== null && !addressesEqual(claimed, registry.teeSignerAddress)) {
    notes.push(
      `the attestation document names ${claimed}, but 0G acknowledges ${registry.teeSignerAddress}; the acknowledged key is used`,
    );
  }

  const response = bundle.response;
  if (response === null) {
    notes.push('no per-response signature, so nothing ties this attestation to the step output');
    return { ...base, level: 'present', recoveredAddress: null, notes };
  }

  let recoveredAddress: Hex;
  try {
    recoveredAddress = recoverMessageAddress(response.text, response.signature);
  } catch (error) {
    notes.push(`response signature could not be recovered: ${(error as Error).message}`);
    return { ...base, level: 'present', recoveredAddress: null, notes };
  }

  if (!addressesEqual(recoveredAddress, registry.teeSignerAddress)) {
    notes.push(
      `response was signed by ${recoveredAddress}, which is not the signer 0G acknowledges for this provider (${registry.teeSignerAddress})`,
    );
    return { ...base, level: 'present', recoveredAddress, notes };
  }

  // At this point the acknowledged signer signed `response.text`. That is
  // exactly as far as the 0G SDK goes, and it is not yet a statement about the
  // output.
  //
  // What follows is the comparison the SDK omits, in two links:
  //   1. the signed text commits to the response bytes we were given
  //   2. the step's output is the value those bytes carry
  // Break either and the signature belongs to some other exchange.

  if (!signedTextCommitsTo(response.text, response.responseBody)) {
    notes.push(
      'the signature does not commit to the stored response: it belongs to a different exchange',
    );
    return { ...base, level: 'attested', recoveredAddress, notes };
  }

  if (input.output === null) {
    notes.push('output unavailable, so it could not be compared against the signed response');
    return { ...base, level: 'attested', recoveredAddress, notes };
  }

  let parsedResponse: JsonValue;
  try {
    parsedResponse = JSON.parse(response.responseBody) as JsonValue;
  } catch {
    notes.push('the stored response is not JSON, so the output could not be located in it');
    return { ...base, level: 'attested', recoveredAddress, notes };
  }

  const answer = resolveOutputPath(parsedResponse, response.responsePath);
  if (answer === undefined) {
    notes.push(`responsePath ${response.responsePath} does not resolve in the signed response`);
    return { ...base, level: 'attested', recoveredAddress, notes };
  }

  const claimedOutput = resolveOutputPath(input.output, response.outputPath);
  if (claimedOutput === undefined) {
    notes.push(`outputPath ${response.outputPath} does not resolve in the step output`);
    return { ...base, level: 'attested', recoveredAddress, notes };
  }

  // Compared canonically so key order in either document cannot break a
  // genuine binding, and cannot paper over a real difference either.
  const same =
    typeof answer === 'string' && typeof claimedOutput === 'string'
      ? answer === claimedOutput
      : new TextDecoder().decode(canonicalBytes(answer)) ===
        new TextDecoder().decode(canonicalBytes(claimedOutput));

  if (!same) {
    notes.push(
      'the step output is not what the signed response carried: this attestation belongs to a different response',
    );
    return { ...base, level: 'attested', recoveredAddress, notes };
  }

  return {
    ...base,
    level: 'bound',
    recoveredAddress,
    // Only notes still true of a bound result survive: the envelope
    // disagreement, if there was one.
    notes: notes.filter((n) => n.includes('the attestation document names')),
  };
}

/**
 * Whether a signed text commits to these response bytes.
 *
 * Two shapes are accepted, because the envelope is the provider's choice and
 * not something the protocol can dictate:
 *
 *   - the signed text IS the response (a provider that signs its answer)
 *   - the signed text contains sha256 of the response among colon-delimited
 *     fields (0G Compute, observed on Galileo)
 *
 * Anything else fails closed. Searching for the digest anywhere in the string
 * rather than at a fixed index keeps this working if the envelope gains or
 * reorders fields, without ever accepting a text that does not carry it.
 */
export function signedTextCommitsTo(signedText: string, responseBody: string): boolean {
  if (signedText === responseBody) return true;
  const digest = sha256(new TextEncoder().encode(responseBody)).slice(2).toLowerCase();
  return signedText
    .toLowerCase()
    .split(':')
    .some((field) => field === digest);
}

/** Human-readable, and deliberately never an unqualified tick. */
export function describeBinding(verification: AttestationVerification): string {
  switch (verification.level) {
    case 'absent':
      return 'no attestation';
    case 'present':
      return 'attestation present, not tied to this output';
    case 'attested':
      return `signed by the TEE signer 0G acknowledges (${verification.acknowledgedSigner ?? '?'}), but not over this output`;
    case 'bound':
      return `output signed by the TEE signer 0G acknowledges (${verification.acknowledgedSigner ?? '?'})`;
    default: {
      const exhaustive: never = verification.level;
      throw new AttestationError(`unhandled level ${String(exhaustive)}`);
    }
  }
}
