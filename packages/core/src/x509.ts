/**
 * Just enough DER and X.509 to verify Intel's PCK certificate chain.
 *
 * Deliberately not a general X.509 implementation. It reads the handful of
 * fields chain verification needs and refuses everything else, because a
 * permissive parser in a verifier is a liability: this runs over bytes
 * supplied by the party being verified.
 *
 * What it deliberately does NOT do:
 *
 * - Name parsing. Issuer and subject are compared as raw DER byte strings,
 *   which is exact and sidesteps every RDN normalisation subtlety. Two names
 *   that are "equal" under some normalisation but differ in bytes would be
 *   treated as different, which errs toward rejecting a chain rather than
 *   accepting a wrong one.
 * - Extension processing beyond basicConstraints/keyUsage being present. The
 *   chain here is a fixed three-link Intel chain with a pinned root, not an
 *   arbitrary PKI.
 * - Revocation. See the note in tdx.ts: CRLs need a network, and §9 keeps the
 *   verifier offline. The limitation is reported, never hidden.
 */

export class DerError extends Error {
  override readonly name = 'DerError';
}

export interface DerNode {
  readonly tag: number;
  /** The value bytes, excluding tag and length. */
  readonly value: Uint8Array;
  /** Tag, length and value together — the bytes a signature covers. */
  readonly raw: Uint8Array;
}

/** Reads one TLV at `offset`. */
export function readNode(bytes: Uint8Array, offset: number): { node: DerNode; end: number } {
  if (offset + 2 > bytes.length) throw new DerError('truncated DER: no tag/length');
  const tag = bytes[offset]!;
  const first = bytes[offset + 1]!;

  let length: number;
  let headerLength: number;

  if (first < 0x80) {
    length = first;
    headerLength = 2;
  } else {
    const count = first & 0x7f;
    if (count === 0) throw new DerError('indefinite-length DER is not supported');
    if (count > 4) throw new DerError('DER length field is implausibly large');
    if (offset + 2 + count > bytes.length) throw new DerError('truncated DER length');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + bytes[offset + 2 + i]!;
    headerLength = 2 + count;
  }

  const end = offset + headerLength + length;
  if (end > bytes.length) throw new DerError('DER element runs past the end of the buffer');

  return {
    node: {
      tag,
      value: bytes.subarray(offset + headerLength, end),
      raw: bytes.subarray(offset, end),
    },
    end,
  };
}

/** Reads every TLV in a buffer, as the children of a constructed node. */
export function readChildren(value: Uint8Array): DerNode[] {
  const out: DerNode[] = [];
  let offset = 0;
  while (offset < value.length) {
    const { node, end } = readNode(value, offset);
    out.push(node);
    offset = end;
  }
  return out;
}

function expect(node: DerNode, tag: number, what: string): DerNode {
  if (node.tag !== tag) {
    throw new DerError(`expected ${what} (tag 0x${tag.toString(16)}), got 0x${node.tag.toString(16)}`);
  }
  return node;
}

const SEQUENCE = 0x30;
const BIT_STRING = 0x03;
const INTEGER = 0x02;

export interface Certificate {
  /** The exact bytes the issuer's signature covers. */
  readonly tbs: Uint8Array;
  /** Raw DER of the issuer name, for exact comparison. */
  readonly issuer: Uint8Array;
  /** Raw DER of the subject name. */
  readonly subject: Uint8Array;
  /** Uncompressed EC public key, 04‖X‖Y. */
  readonly publicKey: Uint8Array;
  /** Signature r and s. */
  readonly signature: { readonly r: bigint; readonly s: bigint };
  readonly notBefore: Date;
  readonly notAfter: Date;
}

/**
 * ECDSA signatures in X.509 are DER SEQUENCE { INTEGER r, INTEGER s },
 * not the raw 64-byte form used inside the quote body.
 */
function parseDerSignature(bitString: Uint8Array): { r: bigint; s: bigint } {
  if (bitString.length === 0 || bitString[0] !== 0x00) {
    throw new DerError('signature BIT STRING has unexpected padding');
  }
  const { node } = readNode(bitString.subarray(1), 0);
  const [r, s] = readChildren(expect(node, SEQUENCE, 'signature sequence').value);
  if (r === undefined || s === undefined) throw new DerError('signature is not a SEQUENCE of two INTEGERs');
  return {
    r: derInteger(expect(r, INTEGER, 'signature r')),
    s: derInteger(expect(s, INTEGER, 'signature s')),
  };
}

function derInteger(node: DerNode): bigint {
  let value = 0n;
  for (const byte of node.value) value = (value << 8n) | BigInt(byte);
  return value;
}

/**
 * DER times are YYMMDDHHMMSSZ (UTCTime, tag 0x17) or YYYYMMDDHHMMSSZ
 * (GeneralizedTime, 0x18). RFC 5280 pivots two-digit years at 50.
 */
function parseTime(node: DerNode): Date {
  const text = new TextDecoder().decode(node.value);
  let match: RegExpMatchArray | null;

  if (node.tag === 0x17) {
    match = text.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (match === null) throw new DerError(`unsupported UTCTime: ${text}`);
    const yy = Number(match[1]);
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    return new Date(
      Date.UTC(year, Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6])),
    );
  }
  if (node.tag === 0x18) {
    match = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/);
    if (match === null) throw new DerError(`unsupported GeneralizedTime: ${text}`);
    return new Date(
      Date.UTC(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        Number(match[4]),
        Number(match[5]),
        Number(match[6]),
      ),
    );
  }
  throw new DerError(`unexpected time tag 0x${node.tag.toString(16)}`);
}

/** Parses a DER-encoded X.509 certificate. */
export function parseCertificate(der: Uint8Array): Certificate {
  const { node: certificate } = readNode(der, 0);
  const parts = readChildren(expect(certificate, SEQUENCE, 'Certificate').value);
  const [tbsNode, , signatureNode] = parts;
  if (tbsNode === undefined || signatureNode === undefined) {
    throw new DerError('Certificate must hold tbsCertificate, algorithm and signature');
  }

  const tbs = readChildren(expect(tbsNode, SEQUENCE, 'tbsCertificate').value);

  // [0] EXPLICIT version is optional. When absent, everything shifts by one.
  let index = tbs[0]?.tag === 0xa0 ? 1 : 0;
  index += 1; // serialNumber
  index += 1; // signature algorithm
  const issuer = tbs[index++];
  const validity = tbs[index++];
  const subject = tbs[index++];
  const spki = tbs[index++];

  if (issuer === undefined || validity === undefined || subject === undefined || spki === undefined) {
    throw new DerError('tbsCertificate is missing required fields');
  }

  const [notBefore, notAfter] = readChildren(expect(validity, SEQUENCE, 'Validity').value);
  if (notBefore === undefined || notAfter === undefined) {
    throw new DerError('Validity must hold notBefore and notAfter');
  }

  const spkiChildren = readChildren(expect(spki, SEQUENCE, 'SubjectPublicKeyInfo').value);
  const keyBits = spkiChildren[1];
  if (keyBits === undefined) throw new DerError('SubjectPublicKeyInfo has no key');
  const bits = expect(keyBits, BIT_STRING, 'public key BIT STRING').value;
  if (bits.length === 0 || bits[0] !== 0x00) {
    throw new DerError('public key BIT STRING has unexpected padding');
  }

  return {
    tbs: tbsNode.raw,
    issuer: issuer.raw,
    subject: subject.raw,
    publicKey: bits.subarray(1),
    signature: parseDerSignature(expect(signatureNode, BIT_STRING, 'signatureValue').value),
    notBefore: parseTime(notBefore),
    notAfter: parseTime(notAfter),
  };
}

/** Splits a PEM bundle into DER certificates, in order. */
export function parsePemChain(pem: string): Uint8Array[] {
  const blocks = pem.match(
    /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g,
  );
  if (blocks === null || blocks.length === 0) {
    throw new DerError('no PEM certificates found');
  }
  return blocks.map((block) => {
    const body = block
      .replace(/-----BEGIN CERTIFICATE-----/, '')
      .replace(/-----END CERTIFICATE-----/, '')
      .replace(/\s+/g, '');
    return base64ToBytes(body);
  });
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
