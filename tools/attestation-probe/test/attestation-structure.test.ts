import { describe, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pins the TEE attestation structure observed on Galileo (see
 * docs/attestation-structure.md) against the real artifacts captured by the
 * probe.
 *
 * These run over committed evidence rather than the live network, so they stay
 * deterministic and offline. When 0G Compute changes the payload, re-run the
 * probe: a diff here is the signal to revisit the attestationRef design rather
 * than to relax the assertions.
 */

const ARTIFACT_DIR = fileURLToPath(new URL('../../../artifacts/attestation', import.meta.url));

interface Attestation {
  quote: string;
  report_data: string;
  tcb_info: string;
  event_log: string;
  vm_config: string;
}

const files = existsSync(ARTIFACT_DIR)
  ? readdirSync(ARTIFACT_DIR).filter((f) => f.endsWith('.raw.json'))
  : [];

describe('captured attestations', () => {
  test('at least one real attestation is committed as evidence', () => {
    expect(files.length).toBeGreaterThan(0);
  });
});

describe.each(files)('%s', (file) => {
  const raw = readFileSync(join(ARTIFACT_DIR, file));
  const attestation = JSON.parse(raw.toString('utf8')) as Attestation;

  test('carries the five documented top-level fields', () => {
    expect(Object.keys(attestation).sort()).toStrictEqual([
      'event_log',
      'quote',
      'report_data',
      'tcb_info',
      'vm_config',
    ]);
  });

  test('quote is a 5006-byte Intel TDX v4 quote', () => {
    expect(attestation.quote).toMatch(/^[0-9a-f]+$/);
    const quote = Buffer.from(attestation.quote, 'hex');
    expect(quote.length).toBe(5006);
    expect(quote.readUInt16LE(0)).toBe(4); // version
    expect(quote.readUInt16LE(2)).toBe(2); // ECDSA-P256 attestation key
    expect(quote.readUInt32LE(4)).toBe(0x81); // TEE type: TDX
  });

  test('report_data is exactly 64 bytes', () => {
    expect(Buffer.from(attestation.report_data, 'base64').length).toBe(64);
  });

  // The binding the whole design depends on: Intel's hardware root of trust
  // attests that an enclave with these measurements controls this key.
  test('report_data binds a zero-padded ASCII Ethereum address', () => {
    const decoded = Buffer.from(attestation.report_data, 'base64');
    const text = decoded.toString('utf8');
    const address = text.replace(/\0+$/, '');

    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Everything after the address must be padding, not truncated content.
    expect(decoded.subarray(address.length).every((b) => b === 0)).toBe(true);
  });

  test('tcb_info exposes SHA-384 measurement registers', () => {
    const tcb = JSON.parse(attestation.tcb_info) as Record<string, string>;
    for (const register of ['mrtd', 'rtmr0', 'rtmr1', 'rtmr2', 'rtmr3']) {
      expect(tcb[register], register).toMatch(/^[0-9a-f]{96}$/); // 48 bytes
    }
    for (const digest of ['mr_aggregated', 'compose_hash', 'device_id']) {
      expect(tcb[digest], digest).toMatch(/^[0-9a-f]{64}$/); // 32 bytes
    }
  });

  test('event_log is a non-empty list of measurement events', () => {
    const events = JSON.parse(attestation.event_log) as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toHaveProperty('imr');
    expect(events[0]).toHaveProperty('digest');
  });

  test('the payload is too large to anchor and so must be digested', () => {
    // The reason attestationRef is a digest and the blob lives in the trace.
    expect(raw.length).toBeGreaterThan(32_000);
  });
});

describe('attestationRef derivation', () => {
  const file = files[0];

  test('is sha256 over the raw bytes exactly as received', () => {
    const raw = readFileSync(join(ARTIFACT_DIR, file!));
    const meta = JSON.parse(
      readFileSync(join(ARTIFACT_DIR, file!.replace('.raw.json', '.meta.json')), 'utf8'),
    ) as { sha256: string; byteLength: number };

    expect(raw.length).toBe(meta.byteLength);
    expect('0x' + createHash('sha256').update(raw).digest('hex')).toBe(meta.sha256);
  });

  test('re-serialising the JSON changes the bytes, so it must not be re-serialised', () => {
    // The concrete reason docs/attestation-structure.md forbids canonicalising
    // this field: a round trip through JSON.parse/stringify yields a different
    // digest for a semantically identical document.
    const raw = readFileSync(join(ARTIFACT_DIR, file!));
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))), 'utf8');

    expect(reserialised.equals(raw)).toBe(false);
    expect(createHash('sha256').update(reserialised).digest('hex')).not.toBe(
      createHash('sha256').update(raw).digest('hex'),
    );
  });
});
