/**
 * TDX quote verification.
 *
 * Two kinds of evidence, and both are needed:
 *
 *   - The real captured quotes verify against the pinned Intel root. That is
 *     the only proof the implementation matches what Intel actually produces;
 *     a synthetic quote would only prove it matches my reading of the spec.
 *   - Minted quotes, one per tampered field, prove each check is load-bearing.
 *     A verifier that accepts everything also "verifies" every real quote.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseQuote, verifyQuote, TdxError } from '../src/tdx.js';
import { INTEL_SGX_ROOT_CA_DER, INTEL_SGX_ROOT_CA_SHA256 } from '../src/intel-root.js';
import { parseCertificate, parsePemChain, DerError } from '../src/x509.js';
import { sha256 } from '../src/hash.js';
import { addressReportData, mintQuote } from './helpers/mint-quote.js';

const CAPTURES = [
  { provider: '0xa48f01287233509fd694a22bf840225062e67836', signer: '0x83df4B8EbA7c0B3B740019b8c9a77ffF77D508cF' },
  { provider: '0x4b2a941929e39adbea5316ddf2b9bd8ff3134389', signer: '0x2A94D671f1A5e080f75A8164087Cdd35c8442e69' },
];

function capturedQuote(provider: string): Uint8Array {
  const envelope = JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../../../artifacts/attestation/${provider}.raw.json`, import.meta.url)),
      'utf8',
    ),
  ) as { quote: string };
  const hex = envelope.quote;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const ADDRESS = '0x83df4B8EbA7c0B3B740019b8c9a77ffF77D508cF';

describe('the pinned Intel SGX Root CA', () => {
  test('hashes to the documented digest', () => {
    // If this fails the vendored root was altered. It is the anchor of every
    // attestation claim in the system, so it fails the build rather than
    // quietly becoming a different root.
    expect(sha256(INTEL_SGX_ROOT_CA_DER)).toBe(INTEL_SGX_ROOT_CA_SHA256);
  });

  test('is self-signed, P-256, and valid until 2049', () => {
    const root = parseCertificate(INTEL_SGX_ROOT_CA_DER);
    expect(root.issuer).toEqual(root.subject);
    expect(root.publicKey.length).toBe(65);
    expect(root.publicKey[0]).toBe(0x04);
    expect(root.notBefore.getUTCFullYear()).toBe(2018);
    expect(root.notAfter.getUTCFullYear()).toBe(2049);
  });

  test('is byte-identical to the root the real quotes carry', () => {
    // The cross-check that justifies pinning: Intel's published root and the
    // root inside a live quote are the same certificate.
    const chain = parsePemChain(parseQuote(capturedQuote(CAPTURES[0]!.provider)).pckChainPem);
    expect(Buffer.from(chain[chain.length - 1]!)).toEqual(Buffer.from(INTEL_SGX_ROOT_CA_DER));
  });
});

describe('the real captured quotes', () => {
  test.each(CAPTURES)('$provider parses as TDX v4', ({ provider }) => {
    const parsed = parseQuote(capturedQuote(provider));
    expect(parsed.version).toBe(4);
    expect(parsed.teeType).toBe(0x81);
    expect(parsed.signedBody.length).toBe(48 + 584);
    expect(parsed.attestationKey.length).toBe(64);
    expect(parsed.qeReport.length).toBe(384);
    expect(parsePemChain(parsed.pckChainPem)).toHaveLength(3);
  });

  test.each(CAPTURES)('$provider verifies against the pinned Intel root', ({ provider }) => {
    const result = verifyQuote(capturedQuote(provider));
    expect(result.failures).toEqual([]);
    expect(result.verified).toBe(true);
  });

  test.each(CAPTURES)('$provider commits to its signing address', ({ provider, signer }) => {
    const parsed = parseQuote(capturedQuote(provider));
    const text = new TextDecoder().decode(parsed.measurements.reportData).replace(/\0+$/, '');
    expect(text).toBe(signer);
  });

  test('the QE report commits to the attestation key', () => {
    const parsed = parseQuote(capturedQuote(CAPTURES[0]!.provider));
    const expected = createHash('sha256')
      .update(Buffer.concat([Buffer.from(parsed.attestationKey), Buffer.from(parsed.qeAuthData)]))
      .digest();
    expect(Buffer.from(parsed.qeReport.subarray(320, 352))).toEqual(expected);
  });

  test('both providers run the same TD image but differ at runtime', () => {
    // Same mrtd (same measured image), different rtmr0 (different runtime
    // state). Worth pinning: if these ever matched entirely, the measurements
    // would not be distinguishing anything.
    const a = parseQuote(capturedQuote(CAPTURES[0]!.provider)).measurements;
    const b = parseQuote(capturedQuote(CAPTURES[1]!.provider)).measurements;
    expect(a.mrtd).toBe(b.mrtd);
    expect(a.rtmr[0]).not.toBe(b.rtmr[0]);
  });

  test('a flipped byte in any security-relevant field breaks verification', () => {
    const quote = capturedQuote(CAPTURES[0]!.provider);
    // Offsets derived from the v4 layout rather than guessed, so this names
    // the field it is protecting.
    const fields: [string, number][] = [
      ['header version', 0],
      ['mrtd', 48 + 136],
      ['rtmr0', 48 + 328],
      ['report_data', 48 + 520],
      ['quote signature', 636],
      ['attestation key', 700],
      ['QE report', 770],
      ['QE signature', 1154],
      ['QE auth data', 1220],
      ['PCK certificate body', 1400],
      ['root certificate body', quote.length - 100],
    ];

    for (const [name, offset] of fields) {
      const tampered = new Uint8Array(quote);
      tampered[offset] = tampered[offset]! ^ 0x01;
      expect(verifyQuote(tampered).verified, `${name} @ ${offset}`).toBe(false);
    }
  });

  test('PEM whitespace and trailing padding are not covered — and need not be', () => {
    // Honest accounting of what the quote signature does NOT cover. A PEM
    // newline flipped to a vertical tab strips identically, and the bytes
    // after the declared chain length are padding no signature spans.
    //
    // Neither is a hole: attestationRef digests the whole document, so a
    // change here is caught one level up, at the receipt.
    const quote = capturedQuote(CAPTURES[0]!.provider);

    const newline = 2000;
    expect(quote[newline]).toBe(0x0a);
    const whitespaceFlipped = new Uint8Array(quote);
    whitespaceFlipped[newline] = 0x0b;
    expect(verifyQuote(whitespaceFlipped).verified).toBe(true);

    const padding = quote.length - 20;
    expect(quote[padding]).toBe(0x00);
    const paddingFlipped = new Uint8Array(quote);
    paddingFlipped[padding] = 0x01;
    expect(verifyQuote(paddingFlipped).verified).toBe(true);

    // But the document digest does change, so the receipt would not match.
    expect(sha256(paddingFlipped)).not.toBe(sha256(quote));
  });

  test('report_data cannot be edited without breaking the quote signature', () => {
    // This is what makes report_data trustworthy at all, and therefore what
    // makes the whole binding chain mean anything.
    const quote = capturedQuote(CAPTURES[0]!.provider);
    const tampered = new Uint8Array(quote);
    tampered.set(addressReportData('0x' + 'de'.repeat(20)), 48 + 520);

    const result = verifyQuote(tampered);
    expect(result.verified).toBe(false);
    expect(result.failures.join(' ')).toContain('quote signature does not verify');
  });
});

describe('minted quotes: each check is load-bearing', () => {
  test('a well-formed minted quote verifies under its own root', () => {
    const minted = mintQuote({ reportData: addressReportData(ADDRESS) });
    const result = verifyQuote(minted.quote, { trustedRootDer: minted.rootDer });
    expect(result.failures).toEqual([]);
    expect(result.verified).toBe(true);
  });

  test('and does NOT verify against the real Intel root', () => {
    // The property that keeps the test seam honest: re-anchoring cannot be
    // used to sneak a forged quote past production verification.
    const minted = mintQuote({ reportData: addressReportData(ADDRESS) });
    const result = verifyQuote(minted.quote);
    expect(result.verified).toBe(false);
    expect(result.failures.join(' ')).toContain('does not terminate at the pinned Intel SGX Root CA');
  });

  test.each([
    ['quote-signature', 'quote signature does not verify'],
    ['qe-signature', 'QE report signature does not verify'],
    ['attestation-key-commitment', 'does not commit to this attestation key'],
    ['chain-root', 'does not terminate at the pinned'],
  ] as const)('tampering with %s is caught', (tamper, expected) => {
    const minted = mintQuote({ reportData: addressReportData(ADDRESS), tamper });
    const result = verifyQuote(minted.quote, { trustedRootDer: minted.rootDer });

    expect(result.verified).toBe(false);
    expect(result.failures.join(' ')).toContain(expected);
  });

  test('an expired PCK certificate is rejected', () => {
    const minted = mintQuote({ reportData: addressReportData(ADDRESS), tamper: 'expired-cert' });
    const result = verifyQuote(minted.quote, {
      trustedRootDer: minted.rootDer,
      at: new Date('2026-01-01T00:00:00Z'),
    });
    expect(result.verified).toBe(false);
    expect(result.failures.join(' ')).toContain('validity window');
  });

  test('the same certificate passes inside its validity window', () => {
    const minted = mintQuote({ reportData: addressReportData(ADDRESS), tamper: 'expired-cert' });
    const result = verifyQuote(minted.quote, {
      trustedRootDer: minted.rootDer,
      at: new Date('2020-06-01T00:00:00Z'),
    });
    expect(result.verified).toBe(true);
  });

  test('measurements are carried through', () => {
    const mrtd = new Uint8Array(48).fill(0x5a);
    const minted = mintQuote({ reportData: addressReportData(ADDRESS), mrtd });
    const result = verifyQuote(minted.quote, { trustedRootDer: minted.rootDer });
    expect(result.measurements?.mrtd).toBe('0x' + '5a'.repeat(48));
  });
});

describe('malformed input is a finding, not an exception', () => {
  test.each([
    [new Uint8Array(0), 'too short'],
    [new Uint8Array(10), 'too short'],
  ])('a truncated quote reports a failure', (quote, expected) => {
    const result = verifyQuote(quote);
    expect(result.verified).toBe(false);
    expect(result.failures.join(' ')).toContain(expected);
  });

  test('an unsupported version is refused rather than misparsed', () => {
    // v5 moves fields. Reading it with v4 offsets would produce measurements
    // from the wrong bytes and still look like a success.
    const minted = mintQuote({ reportData: addressReportData(ADDRESS) });
    const wrongVersion = new Uint8Array(minted.quote);
    wrongVersion[0] = 5;
    expect(() => parseQuote(wrongVersion)).toThrow(TdxError);
    expect(verifyQuote(wrongVersion).failures.join(' ')).toContain('unsupported quote version 5');
  });

  test('an SGX quote is refused: it is a different structure', () => {
    const minted = mintQuote({ reportData: addressReportData(ADDRESS) });
    const sgx = new Uint8Array(minted.quote);
    sgx[4] = 0x00;
    expect(verifyQuote(sgx).failures.join(' ')).toContain('expected 0x81 (TDX)');
  });
});

describe('caveats are always reported', () => {
  test('even a fully verified quote carries them', () => {
    const minted = mintQuote({ reportData: addressReportData(ADDRESS) });
    const result = verifyQuote(minted.quote, { trustedRootDer: minted.rootDer });

    expect(result.verified).toBe(true);
    // Nothing may read "verified" as "this enclave is trustworthy".
    const text = result.caveats.join(' ');
    expect(text).toContain('revocation');
    expect(text).toContain('TCB status');
    expect(text).toContain('policy decision');
  });

  test('and on a real quote too', () => {
    expect(verifyQuote(capturedQuote(CAPTURES[0]!.provider)).caveats.length).toBeGreaterThan(0);
  });
});

describe('the DER parser refuses what it does not understand', () => {
  test('indefinite-length encoding', () => {
    expect(() => parseCertificate(Uint8Array.from([0x30, 0x80, 0x00, 0x00]))).toThrow(
      'indefinite-length',
    );
  });

  test('an element running past the buffer', () => {
    expect(() => parseCertificate(Uint8Array.from([0x30, 0x20, 0x01]))).toThrow(DerError);
  });

  test('a PEM bundle with no certificates', () => {
    expect(() => parsePemChain('not a pem file')).toThrow('no PEM certificates found');
  });
});
