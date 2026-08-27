/**
 * Intel TDX quote verification — the last step of the four in
 * docs/attestation-structure.md.
 *
 * WHAT A QUOTE ACTUALLY PROVES, once this passes
 *
 *   Intel signed a certificate for a specific platform's provisioning key
 *     → that key signed the Quoting Enclave's report
 *       → that report commits to an attestation key
 *         → that attestation key signed the TD report
 *           → the TD report contains report_data
 *
 * So a verified quote means: *Intel's hardware root of trust attests that a
 * TDX enclave with these measurements produced this report_data.* Combined
 * with attestation.ts's binding — report_data names a signing key, and that
 * key signed this step's output — the chain runs from Intel silicon to a
 * receipt on chain with nothing taken on faith in between.
 *
 * THE FOUR CHECKS, all of which must pass
 *
 *   1. The PCK certificate chain is well-formed and terminates at the *pinned*
 *      Intel SGX Root CA. Not the root that arrived in the quote — every quote
 *      carries its own root, so trusting that one would be checking a
 *      signature against a key the prover supplied.
 *   2. The QE report is signed by the PCK leaf key.
 *   3. The QE report commits to the attestation key:
 *      sha256(attestation_key ‖ qe_auth_data) == qe_report.report_data[0..32].
 *      Without this the attestation key is unbound and anyone could substitute
 *      their own.
 *   4. The attestation key signed header ‖ td_report.
 *
 * WHAT THIS STILL DOES NOT DO
 *
 * - Revocation. CRLs live behind Intel's PCS and §9 keeps the verifier
 *   offline and dependency-free. A revoked-but-unexpired PCK would still pass.
 * - TCB status. The tcb_info in the envelope says whether the platform is
 *   up to date; evaluating it needs Intel's signed TCB info, another network
 *   fetch. A quote from an out-of-date platform verifies here.
 * - Measurement policy. Whether *this particular* mrtd/rtmr set is the
 *   software you expected is a policy question, not a cryptographic one. The
 *   measurements are returned so a caller can decide.
 *
 * All three are reported in `caveats` rather than omitted, so no caller can
 * mistake "the signatures check out" for "this enclave is trustworthy".
 */

import { bytesToHex, sha256, type Hex } from './hash.js';
import { INTEL_SGX_ROOT_CA_DER } from './intel-root.js';
import { parsePublicKey, verify as p256Verify, verifySha256, P256Error } from './p256.js';
import {
  bytesEqual,
  parseCertificate,
  parsePemChain,
  type Certificate,
} from './x509.js';

export class TdxError extends Error {
  override readonly name = 'TdxError';
}

const HEADER_LENGTH = 48;
const TD_REPORT_LENGTH = 584;
const QE_REPORT_LENGTH = 384;
/** TDX. SGX quotes use 0x00 and are a different structure. */
const TEE_TYPE_TDX = 0x81;

export interface TdMeasurements {
  /** Measurement of the TD's initial contents. */
  readonly mrtd: Hex;
  /** Runtime measurement registers 0-3. */
  readonly rtmr: readonly [Hex, Hex, Hex, Hex];
  readonly mrsignerseam: Hex;
  readonly mrseam: Hex;
  /** The 64 bytes the enclave chose to commit to. */
  readonly reportData: Uint8Array;
}

export interface QuoteVerification {
  /** True only when all four checks passed. */
  readonly verified: boolean;
  readonly quoteVersion: number;
  readonly teeType: number;
  readonly measurements: TdMeasurements | null;
  /** Why verification failed. Empty when `verified`. */
  readonly failures: string[];
  /** True statements that limit what a pass means. Never empty. */
  readonly caveats: string[];
}

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}
function u32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)) +
    bytes[offset + 3]! * 0x1000000
  );
}

export interface ParsedQuote {
  readonly version: number;
  readonly teeType: number;
  /** header ‖ td_report — exactly what the attestation key signs. */
  readonly signedBody: Uint8Array;
  readonly measurements: TdMeasurements;
  readonly quoteSignature: Uint8Array;
  readonly attestationKey: Uint8Array;
  readonly qeReport: Uint8Array;
  readonly qeReportSignature: Uint8Array;
  readonly qeAuthData: Uint8Array;
  readonly pckChainPem: string;
}

/** Parses a TDX v4 quote. Throws when the layout does not hold. */
export function parseQuote(quote: Uint8Array): ParsedQuote {
  if (quote.length < HEADER_LENGTH + TD_REPORT_LENGTH + 4) {
    throw new TdxError(`quote is too short: ${quote.length} bytes`);
  }

  const version = u16(quote, 0);
  const teeType = u32(quote, 4);
  if (version !== 4) {
    // v5 exists and moves things around. Parsing it with v4 offsets would read
    // measurements from the wrong place and still "succeed".
    throw new TdxError(`unsupported quote version ${version}; only v4 is implemented`);
  }
  if (teeType !== TEE_TYPE_TDX) {
    throw new TdxError(`quote TEE type is 0x${teeType.toString(16)}, expected 0x81 (TDX)`);
  }

  const tdReport = quote.subarray(HEADER_LENGTH, HEADER_LENGTH + TD_REPORT_LENGTH);
  const hex = (from: number, length: number): Hex => bytesToHex(tdReport.subarray(from, from + length));

  const measurements: TdMeasurements = {
    // Offsets within the TD report, per the TDX quoting library layout.
    mrseam: hex(16, 48),
    mrsignerseam: hex(64, 48),
    mrtd: hex(136, 48),
    rtmr: [hex(328, 48), hex(376, 48), hex(424, 48), hex(472, 48)],
    reportData: tdReport.subarray(520, 584),
  };

  const sigOffset = HEADER_LENGTH + TD_REPORT_LENGTH;
  const sigLength = u32(quote, sigOffset);
  const sig = quote.subarray(sigOffset + 4);
  if (sigLength > sig.length) {
    throw new TdxError('quote signature section is truncated');
  }

  const quoteSignature = sig.subarray(0, 64);
  const attestationKey = sig.subarray(64, 128);

  const certDataType = u16(sig, 128);
  const certDataSize = u32(sig, 130);
  if (certDataType !== 6) {
    // Type 6 carries the QE report and the PCK chain. Anything else cannot be
    // verified offline, and pretending otherwise would be the overclaim.
    throw new TdxError(
      `unsupported certification data type ${certDataType}; only type 6 (QE report) is implemented`,
    );
  }
  const inner = sig.subarray(134, 134 + certDataSize);
  if (inner.length < QE_REPORT_LENGTH + 64 + 2) {
    throw new TdxError('certification data is too short to hold a QE report');
  }

  const qeReport = inner.subarray(0, QE_REPORT_LENGTH);
  const qeReportSignature = inner.subarray(QE_REPORT_LENGTH, QE_REPORT_LENGTH + 64);
  const authSize = u16(inner, 448);
  const qeAuthData = inner.subarray(450, 450 + authSize);

  const chainOffset = 450 + authSize;
  const chainType = u16(inner, chainOffset);
  const chainSize = u32(inner, chainOffset + 2);
  if (chainType !== 5) {
    throw new TdxError(`unsupported PCK certification type ${chainType}; only type 5 (PEM chain) is implemented`);
  }
  const chainBytes = inner.subarray(chainOffset + 6, chainOffset + 6 + chainSize);

  return {
    version,
    teeType,
    signedBody: quote.subarray(0, HEADER_LENGTH + TD_REPORT_LENGTH),
    measurements,
    quoteSignature,
    attestationKey,
    qeReport,
    qeReportSignature,
    qeAuthData,
    pckChainPem: new TextDecoder().decode(chainBytes),
  };
}

/**
 * Walks a chain leaf → … → pinned root, checking every signature.
 *
 * Order is taken from the chain as presented but each link is checked by
 * issuer/subject bytes, so a reordered or padded chain fails rather than
 * being silently repaired.
 */
function verifyChain(
  chain: Certificate[],
  at: Date,
  trustedRootDer: Uint8Array,
  failures: string[],
): Certificate | null {
  const root = parseCertificate(trustedRootDer);

  if (chain.length < 2) {
    failures.push('PCK chain has fewer than two certificates');
    return null;
  }

  // The last certificate must be the pinned root, byte for byte. Comparing
  // only the public key would accept a re-issued root with different
  // constraints.
  const presentedRoot = chain[chain.length - 1]!;
  if (!bytesEqual(presentedRoot.tbs, root.tbs)) {
    failures.push('the PCK chain does not terminate at the pinned Intel SGX Root CA');
    return null;
  }

  for (let i = 0; i < chain.length; i++) {
    const certificate = chain[i]!;
    // The root verifies against itself; every other link against the next.
    const issuer = i === chain.length - 1 ? root : chain[i + 1]!;

    if (!bytesEqual(certificate.issuer, issuer.subject)) {
      failures.push(`certificate ${i} is not issued by the next certificate in the chain`);
      return null;
    }
    if (at < certificate.notBefore || at > certificate.notAfter) {
      failures.push(
        `certificate ${i} is outside its validity window (${certificate.notBefore.toISOString()} .. ${certificate.notAfter.toISOString()})`,
      );
      return null;
    }

    let ok: boolean;
    try {
      ok = p256Verify(
        parsePublicKey(issuer.publicKey),
        hexTo32(sha256(certificate.tbs)),
        certificate.signature.r,
        certificate.signature.s,
      );
    } catch (error) {
      failures.push(`certificate ${i}: ${(error as Error).message}`);
      return null;
    }
    if (!ok) {
      failures.push(`certificate ${i} has an invalid signature`);
      return null;
    }
  }

  return chain[0]!;
}

function hexTo32(hex: Hex): Uint8Array {
  const body = hex.slice(2);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const CAVEATS = [
  'certificate revocation was not checked (CRLs require a network fetch)',
  'TCB status was not evaluated: a quote from an out-of-date platform still verifies',
  'measurements are reported, not judged: whether mrtd/rtmr are the expected software is a policy decision',
];

export interface VerifyQuoteOptions {
  /** Time to evaluate certificate validity at. Defaults to now. */
  readonly at?: Date;
  /**
   * The trust anchor for the PCK chain. Defaults to the pinned Intel SGX Root
   * CA and should be left alone outside tests.
   *
   * This can only *re-anchor* verification, never disable it: a quote still
   * needs a complete, valid chain to whatever root is supplied. Tests use it
   * to mint structurally genuine quotes under a throwaway root, which is the
   * only way to exercise the success path without an actual enclave.
   */
  readonly trustedRootDer?: Uint8Array;
}

/**
 * Verifies a TDX quote against the pinned Intel root.
 *
 * Never throws for a bad quote — a malformed or unverifiable quote is a
 * finding, and the caller needs the finding to decide a status.
 */
export function verifyQuote(quote: Uint8Array, options: VerifyQuoteOptions = {}): QuoteVerification {
  const failures: string[] = [];
  const at = options.at ?? new Date();

  let parsed: ParsedQuote;
  try {
    parsed = parseQuote(quote);
  } catch (error) {
    return {
      verified: false,
      quoteVersion: quote.length >= 2 ? u16(quote, 0) : 0,
      teeType: quote.length >= 8 ? u32(quote, 4) : 0,
      measurements: null,
      failures: [(error as Error).message],
      caveats: CAVEATS,
    };
  }

  const base = {
    quoteVersion: parsed.version,
    teeType: parsed.teeType,
    measurements: parsed.measurements,
    caveats: CAVEATS,
  };

  // 1. The chain, anchored at the pinned root.
  let chain: Certificate[];
  try {
    chain = parsePemChain(parsed.pckChainPem).map(parseCertificate);
  } catch (error) {
    return { ...base, verified: false, failures: [`PCK chain: ${(error as Error).message}`] };
  }

  const pck = verifyChain(chain, at, options.trustedRootDer ?? INTEL_SGX_ROOT_CA_DER, failures);
  if (pck === null) return { ...base, verified: false, failures };

  // 2. The QE report is signed by the PCK leaf.
  try {
    if (!verifySha256(parsePublicKey(pck.publicKey), parsed.qeReport, parsed.qeReportSignature)) {
      failures.push('the QE report signature does not verify against the PCK certificate');
    }
  } catch (error) {
    failures.push(`QE report signature: ${(error as Error).message}`);
  }

  // 3. The QE report commits to the attestation key. Without this the
  //    attestation key is unbound and anyone could substitute their own.
  const expected = sha256(concat(parsed.attestationKey, parsed.qeAuthData));
  const committed = bytesToHex(parsed.qeReport.subarray(320, 352));
  if (expected !== committed) {
    failures.push(
      'the QE report does not commit to this attestation key: ' +
        `expected sha256(key‖auth) ${expected}, report holds ${committed}`,
    );
  }

  // 4. The attestation key signed the header and TD report.
  try {
    const attestationKey = parsePublicKey(parsed.attestationKey);
    if (!verifySha256(attestationKey, parsed.signedBody, parsed.quoteSignature)) {
      failures.push('the quote signature does not verify against the attestation key');
    }
  } catch (error) {
    if (error instanceof P256Error) failures.push(`attestation key: ${error.message}`);
    else throw error;
  }

  return { ...base, verified: failures.length === 0, failures };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
