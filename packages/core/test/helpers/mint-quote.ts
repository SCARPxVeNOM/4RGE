/**
 * Mints structurally genuine TDX quotes under a throwaway root.
 *
 * Real enclave keys live inside a TEE, so the success path cannot be exercised
 * with a captured quote: nobody outside the enclave can produce a signature by
 * the key its report_data names. The alternative — a flag that skips
 * verification — would mean the most important path is never actually run.
 *
 * So these build the whole structure for real: a P-256 CA chain, a QE report
 * committing to an attestation key, and both signatures, all valid. The only
 * difference from Intel's is which root anchors it, and `verifyQuote` takes
 * the root as a parameter for exactly that reason. Nothing here can weaken
 * production: re-anchoring still demands a complete, valid chain.
 *
 * node:crypto is used freely — this is a test helper, and only `src` is held
 * to the platform-agnostic rule.
 */

import {
  createHash,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';

// --- a minimal DER writer --------------------------------------------------

function length(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.from([n]);
  const bytes: number[] = [];
  let value = n;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>>= 8;
  }
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Uint8Array[]): Uint8Array {
  const body = concat(...content);
  return concat(Uint8Array.from([tag]), length(body.length), body);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const seq = (...c: Uint8Array[]) => tlv(0x30, ...c);
const set = (...c: Uint8Array[]) => tlv(0x31, ...c);
const bitString = (bytes: Uint8Array) => tlv(0x03, Uint8Array.from([0x00]), bytes);
const integer = (value: number) => {
  const bytes: number[] = [];
  let v = value;
  do {
    bytes.unshift(v & 0xff);
    v >>>= 8;
  } while (v > 0);
  if ((bytes[0]! & 0x80) !== 0) bytes.unshift(0);
  return tlv(0x02, Uint8Array.from(bytes));
};
const oid = (...bytes: number[]) => tlv(0x06, Uint8Array.from(bytes));
const printable = (text: string) => tlv(0x13, new TextEncoder().encode(text));
const utcTime = (text: string) => tlv(0x17, new TextEncoder().encode(text));

const OID_EC_PUBLIC_KEY = oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01);
const OID_PRIME256V1 = oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07);
const OID_ECDSA_SHA256 = oid(0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02);
const OID_CN = oid(0x55, 0x04, 0x03);

const name = (commonName: string) => seq(set(seq(OID_CN, printable(commonName))));

// --- keys ------------------------------------------------------------------

export interface KeyPair {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  /** Uncompressed 04‖X‖Y. */
  readonly raw: Uint8Array;
}

export function generateKey(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  return {
    privateKey,
    publicKey,
    raw: concat(Uint8Array.from([0x04]), new Uint8Array(x), new Uint8Array(y)),
  };
}

/** Raw 64-byte r‖s, the form used inside a quote body. */
export function signRaw(key: KeyObject, message: Uint8Array): Uint8Array {
  return new Uint8Array(sign('sha256', message, { key, dsaEncoding: 'ieee-p1363' }));
}

/** DER SEQUENCE{r,s}, the form used in an X.509 signatureValue. */
function signDer(key: KeyObject, message: Uint8Array): Uint8Array {
  return new Uint8Array(sign('sha256', message, { key, dsaEncoding: 'der' }));
}

// --- certificates ----------------------------------------------------------

export interface CertOptions {
  readonly subject: string;
  readonly issuer: string;
  readonly subjectKey: KeyPair;
  readonly issuerKey: KeyPair;
  readonly notBefore?: string;
  readonly notAfter?: string;
  readonly serial?: number;
}

export function makeCertificate(options: CertOptions): Uint8Array {
  const spki = seq(seq(OID_EC_PUBLIC_KEY, OID_PRIME256V1), bitString(options.subjectKey.raw));

  const tbs = seq(
    tlv(0xa0, integer(2)), // v3
    integer(options.serial ?? 1),
    seq(OID_ECDSA_SHA256),
    name(options.issuer),
    seq(
      utcTime(options.notBefore ?? '180521104510Z'),
      utcTime(options.notAfter ?? '491231235959Z'),
    ),
    name(options.subject),
    spki,
  );

  return seq(tbs, seq(OID_ECDSA_SHA256), bitString(signDer(options.issuerKey.privateKey, tbs)));
}

function toPem(der: Uint8Array): string {
  const b64 = Buffer.from(der).toString('base64');
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

// --- quotes ----------------------------------------------------------------

export interface MintedQuote {
  readonly quote: Uint8Array;
  readonly rootDer: Uint8Array;
  readonly reportData: Uint8Array;
}

export interface MintOptions {
  /** The 64 report_data bytes. Usually an ASCII address, zero padded. */
  readonly reportData: Uint8Array;
  readonly mrtd?: Uint8Array;
  /** Break exactly one thing, to prove the corresponding check is load-bearing. */
  readonly tamper?:
    | 'quote-signature'
    | 'qe-signature'
    | 'attestation-key-commitment'
    | 'report-data'
    | 'chain-root'
    | 'expired-cert';
}

export function addressReportData(address: string): Uint8Array {
  const out = new Uint8Array(64);
  out.set(new TextEncoder().encode(address), 0);
  return out;
}

const u16 = (v: number) => Uint8Array.from([v & 0xff, (v >> 8) & 0xff]);
const u32 = (v: number) => Uint8Array.from([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);

export function mintQuote(options: MintOptions): MintedQuote {
  const rootKey = generateKey();
  const intermediateKey = generateKey();
  const pckKey = generateKey();
  const attestationKey = generateKey();

  const rootDer = makeCertificate({
    subject: 'Test Root CA',
    issuer: 'Test Root CA',
    subjectKey: rootKey,
    issuerKey: rootKey,
  });
  const intermediateDer = makeCertificate({
    subject: 'Test Platform CA',
    issuer: 'Test Root CA',
    subjectKey: intermediateKey,
    issuerKey: rootKey,
    serial: 2,
  });
  const pckDer = makeCertificate({
    subject: 'Test PCK Certificate',
    issuer: 'Test Platform CA',
    subjectKey: pckKey,
    issuerKey: intermediateKey,
    serial: 3,
    ...(options.tamper === 'expired-cert'
      ? { notBefore: '200101000000Z', notAfter: '210101000000Z' }
      : {}),
  });

  // A different root, so the chain is internally valid but anchors elsewhere.
  const presentedRootDer =
    options.tamper === 'chain-root'
      ? makeCertificate({
          subject: 'Test Root CA',
          issuer: 'Test Root CA',
          subjectKey: generateKey(),
          issuerKey: rootKey,
        })
      : rootDer;

  const chainPem = toPem(pckDer) + toPem(intermediateDer) + toPem(presentedRootDer);

  // --- header (48 bytes) ---
  const header = new Uint8Array(48);
  header.set(u16(4), 0); // version
  header.set(u16(2), 2); // ECDSA-P256
  header.set(u32(0x81), 4); // TDX

  // --- TD report (584 bytes) ---
  const tdReport = new Uint8Array(584);
  tdReport.set(options.mrtd ?? new Uint8Array(48).fill(0xab), 136); // mrtd
  const reportData =
    options.tamper === 'report-data' ? addressReportData('0x' + 'de'.repeat(20)) : options.reportData;
  tdReport.set(reportData, 520);

  const signedBody = concat(header, tdReport);
  let quoteSignature = signRaw(attestationKey.privateKey, signedBody);
  if (options.tamper === 'quote-signature') quoteSignature = signRaw(generateKey().privateKey, signedBody);

  // --- QE report (384 bytes) ---
  const authData = new Uint8Array(32);
  for (let i = 0; i < 32; i++) authData[i] = i;

  const committedKey =
    options.tamper === 'attestation-key-commitment' ? generateKey().raw.slice(1) : attestationKey.raw.slice(1);

  const qeReport = new Uint8Array(384);
  const commitment = new Uint8Array(
    createHash('sha256').update(concat(committedKey, authData)).digest(),
  );
  qeReport.set(commitment, 320);

  let qeSignature = signRaw(pckKey.privateKey, qeReport);
  if (options.tamper === 'qe-signature') qeSignature = signRaw(generateKey().privateKey, qeReport);

  // --- assemble the signature section ---
  const chainBytes = new TextEncoder().encode(chainPem);
  const inner = concat(
    qeReport,
    qeSignature,
    u16(authData.length),
    authData,
    u16(5),
    u32(chainBytes.length),
    chainBytes,
  );

  const sigSection = concat(
    quoteSignature,
    attestationKey.raw.slice(1), // 64 bytes, no 0x04 tag
    u16(6),
    u32(inner.length),
    inner,
  );

  return {
    quote: concat(signedBody, u32(sigSection.length), sigSection),
    rootDer,
    reportData,
  };
}
