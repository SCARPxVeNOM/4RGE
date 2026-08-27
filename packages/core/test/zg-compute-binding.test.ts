/**
 * Attestation binding against a REAL 0G Compute response.
 *
 * The fixture is a live capture from Galileo: a genuine completion, the
 * enclave's signature over it, and the TEE signer 0G acknowledges for that
 * provider. Everything else in the binding path was tested against constructed
 * data, and constructed data is exactly what got the design wrong.
 *
 * WHAT THE CAPTURE CORRECTED
 *
 * The signed text is not the answer. It is a colon-delimited envelope:
 *
 *   <sha256(request)>:<sha256(response)>:centralized:aliyun:<provider hash>
 *
 * An earlier version of this module compared the signed text against the step
 * output directly, so `bound` was unreachable against any real provider — the
 * comparison could only ever fail. Two captures with different prompts showed
 * fields 0 and 1 changing and 2-4 constant, and field 1 turned out to be
 * sha256 of the exact response bytes. That is what a verifier can reproduce,
 * and it is what the binding now checks.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  signedTextCommitsTo,
  verifyAttestation,
  type AcknowledgedSigner,
  type AttestationBundle,
  type Hex,
} from '../src/index.js';
import { recoverMessageAddress, addressesEqual } from '../src/secp256k1.js';

interface Fixture {
  provider: string;
  teeSignerAddress: string;
  chatID: string;
  model: string;
  text: string;
  signature: string;
  responseBody: string;
  responsePath: string;
  responseContent: string;
}

const capture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/zg-compute-binding.json', import.meta.url)), 'utf8'),
) as Fixture;

const REGISTRY: AcknowledgedSigner = {
  provider: capture.provider as Hex,
  teeSignerAddress: capture.teeSignerAddress as Hex,
  acknowledged: true,
};

/** The step output an agent would build from this completion. */
const OUTPUT = { text: capture.responseContent };

const bundle = (overrides: Partial<Fixture> = {}): AttestationBundle => {
  const f = { ...capture, ...overrides };
  return {
    quote: '{"note":"attestation document"}',
    provider: capture.provider as Hex,
    response: {
      chatID: f.chatID,
      model: f.model,
      text: f.text,
      signature: f.signature as Hex,
      responseBody: f.responseBody,
      responsePath: f.responsePath,
      outputPath: '$.text',
    },
  };
};

const verify = (b: AttestationBundle, output: unknown = OUTPUT) =>
  verifyAttestation({
    bundle: b,
    output: output as never,
    acknowledgedSigner: REGISTRY,
  });

describe('the captured signature is genuine', () => {
  test('it recovers to the TEE signer 0G acknowledges for the provider', () => {
    // The live fact the whole feature rests on, checked directly.
    const recovered = recoverMessageAddress(capture.text, capture.signature as Hex);
    expect(addressesEqual(recovered, capture.teeSignerAddress)).toBe(true);
  });

  test('the signed envelope commits to sha256 of the exact response bytes', () => {
    const digest = createHash('sha256').update(capture.responseBody, 'utf8').digest('hex');
    const fields = capture.text.split(':');
    expect(fields).toHaveLength(5);
    expect(fields[1]).toBe(digest);
  });

  test('the signed text is NOT the completion', () => {
    // The assumption that broke the original design.
    expect(capture.text).not.toBe(capture.responseContent);
    expect(capture.text).not.toContain(capture.responseContent);
  });
});

describe('binding a real response', () => {
  test('reaches bound', () => {
    const result = verify(bundle());
    expect(result.notes).toEqual([]);
    expect(result.level).toBe('bound');
    expect(result.recoveredAddress).toBe(capture.teeSignerAddress.toLowerCase());
  });

  test('a re-serialised response body breaks the commitment', () => {
    // Semantically identical JSON, different bytes. The digest is over bytes,
    // so this must fail — and it is why the trace stores the response verbatim.
    const reserialised = JSON.stringify(JSON.parse(capture.responseBody), null, 2);
    const result = verify(bundle({ responseBody: reserialised }));

    expect(result.level).toBe('attested');
    expect(result.notes.join(' ')).toContain('does not commit to the stored response');
  });

  test('a different response with a valid signature does not bind', () => {
    // THE SUBSTITUTION, with real data: the signature is genuine and by the
    // right key, but over another exchange.
    const other = capture.responseBody.replace('"cherry"', '"banana"');
    const result = verify(bundle({ responseBody: other }));

    expect(result.level).toBe('attested');
    expect(result.notes.join(' ')).toContain('does not commit to the stored response');
  });

  test('an output that is not what the enclave answered does not bind', () => {
    const result = verify(bundle(), { text: 'something else entirely' });
    expect(result.level).toBe('attested');
    expect(result.notes.join(' ')).toContain('not what the signed response carried');
  });

  test('a responsePath that misses the answer does not bind', () => {
    const result = verify(bundle({ responsePath: '$.choices[0].message.role' }));
    expect(result.level).toBe('attested');
    expect(result.notes.join(' ')).toContain('not what the signed response carried');
  });

  test('a signature by another key does not bind, however good the digests are', () => {
    const result = verifyAttestation({
      bundle: bundle(),
      output: OUTPUT as never,
      acknowledgedSigner: {
        ...REGISTRY,
        teeSignerAddress: '0x000000000000000000000000000000000000dead',
      },
    });
    expect(result.level).toBe('present');
    expect(result.notes.join(' ')).toContain('not the signer 0G acknowledges');
  });
});

describe('signedTextCommitsTo', () => {
  test('accepts the 0G Compute digest envelope', () => {
    expect(signedTextCommitsTo(capture.text, capture.responseBody)).toBe(true);
  });

  test('accepts a provider that signs its response directly', () => {
    // The envelope is the provider's choice, so the simple shape is allowed.
    expect(signedTextCommitsTo('the answer', 'the answer')).toBe(true);
  });

  test('rejects a text that merely contains the digest as a substring', () => {
    // Field-wise, not substring: a longer field that happens to embed the
    // digest is not a commitment to it.
    const digest = createHash('sha256').update(capture.responseBody, 'utf8').digest('hex');
    expect(signedTextCommitsTo(`x${digest}`, capture.responseBody)).toBe(false);
    expect(signedTextCommitsTo(`a:${digest}x:b`, capture.responseBody)).toBe(false);
  });

  test('rejects an unrelated text', () => {
    expect(signedTextCommitsTo('a:b:c', capture.responseBody)).toBe(false);
    expect(signedTextCommitsTo('', capture.responseBody)).toBe(false);
  });

  test('is case-insensitive about the digest, as hex is', () => {
    const digest = createHash('sha256').update(capture.responseBody, 'utf8').digest('hex');
    expect(signedTextCommitsTo(`a:${digest.toUpperCase()}:b`, capture.responseBody)).toBe(true);
  });
});
