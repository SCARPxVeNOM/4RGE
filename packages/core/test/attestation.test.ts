/**
 * Attestation binding.
 *
 * The tests that matter most are the ones where a *genuine* attestation is
 * paired with an output it does not cover. That is the attack the binding
 * exists to stop, and the level it produces must never be `bound`.
 *
 * The quote fixtures are the real captures in artifacts/attestation/, taken
 * from two live 0G Compute providers on Galileo. A hand-written envelope would
 * only prove this parses hand-written envelopes.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AttestationError,
  attestationRefFor,
  describeBinding,
  legacyAttestationRef,
  meetsBinding,
  parseQuoteEnvelope,
  resolveOutputPath,
  signerFromReportData,
  verifyAttestation,
  type AttestationBundle,
  type BindingLevel,
} from '../src/attestation.js';
import { decideStepStatus } from '../src/outcome.js';
import { StepStatus } from '../src/receipt.js';
import { sha256, type Hex } from '../src/hash.js';

const artifact = (provider: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../../artifacts/attestation/${provider}.raw.json`, import.meta.url)),
    'utf8',
  );

const CAPTURES: { provider: string; expectedSigner: Hex }[] = [
  {
    provider: '0xa48f01287233509fd694a22bf840225062e67836',
    expectedSigner: '0x83df4b8eba7c0b3b740019b8c9a77fff77d508cf',
  },
  {
    provider: '0x4b2a941929e39adbea5316ddf2b9bd8ff3134389',
    expectedSigner: '0x2a94d671f1a5e080f75a8164087cdd35c8442e69',
  },
];

const QUOTE = artifact(CAPTURES[0]!.provider);
const SIGNER = CAPTURES[0]!.expectedSigner;

/**
 * The enclave key. The real one is inside a TEE, so a test key stands in — the
 * property under test is that a signature by the key named in report_data
 * binds, and by any other key does not.
 */
const ENCLAVE = privateKeyToAccount(
  '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
);
const IMPOSTER = privateKeyToAccount(
  '0x0123456789012345678901234567890123456789012345678901234567890123',
);

/** A quote envelope whose report_data names an arbitrary address. */
function quoteBinding(address: string): string {
  const parsed = JSON.parse(QUOTE) as Record<string, unknown>;
  const padded = new Uint8Array(64);
  const ascii = new TextEncoder().encode(address);
  padded.set(ascii, 0);
  let binary = '';
  for (const byte of padded) binary += String.fromCharCode(byte);
  return JSON.stringify({ ...parsed, report_data: btoa(binary) });
}

const ENCLAVE_QUOTE = quoteBinding(ENCLAVE.address);

async function bundleFor(
  text: string,
  outputPath = '$.text',
  signer = ENCLAVE,
): Promise<AttestationBundle> {
  return {
    quote: ENCLAVE_QUOTE,
    response: {
      chatID: 'chat-123',
      model: 'qwen/qwen2.5-omni-7b',
      text,
      signature: (await signer.signMessage({ message: text })) as Hex,
      outputPath,
    },
  };
}

// ---------------------------------------------------------------------------

describe('report_data', () => {
  test.each(CAPTURES)(
    'reads the signing address from the real capture $provider',
    ({ provider, expectedSigner }) => {
      const envelope = JSON.parse(artifact(provider)) as { report_data: string };
      expect(signerFromReportData(envelope.report_data)).toBe(expectedSigner);
    },
  );

  test('the two providers bind different keys', () => {
    // If they were the same, the whole per-provider binding would be vacuous.
    expect(CAPTURES[0]!.expectedSigner).not.toBe(CAPTURES[1]!.expectedSigner);
  });

  test('rejects report_data that is not 64 bytes', () => {
    expect(() => signerFromReportData(btoa('short'))).toThrow('must be 64 bytes');
  });

  test('rejects report_data that does not hold an address', () => {
    // It is 64 bytes of *something*, and the something matters. Treating a
    // hash as an address would recover a key nobody controls.
    let binary = '';
    for (let i = 0; i < 64; i++) binary += String.fromCharCode(i + 1);
    expect(() => signerFromReportData(btoa(binary))).toThrow('does not hold an Ethereum address');
  });

  test('rejects non-base64', () => {
    expect(() => signerFromReportData('not base64!!!')).toThrow(AttestationError);
  });
});

describe('quote envelope', () => {
  test.each(CAPTURES)('parses the real capture $provider as TDX v4', ({ provider }) => {
    const envelope = parseQuoteEnvelope(artifact(provider));
    expect(envelope.quoteVersion).toBe(4);
    expect(envelope.teeType).toBe(0x81);
  });

  test('rejects a self-signed agent blob, which is not a hardware attestation', () => {
    // The reference agents return exactly this shape. Accepting it as a quote
    // would be the claim §1.3 forbids.
    const selfSigned = btoa(JSON.stringify({ kind: 'reference-agent-self-signed', agentId: '1' }));
    expect(() => parseQuoteEnvelope(selfSigned)).toThrow('not a JSON quote envelope');
  });

  test('rejects an envelope with no report_data', () => {
    expect(() => parseQuoteEnvelope(JSON.stringify({ quote: 'ab' }))).toThrow('no report_data');
  });
});

describe('attestationRef', () => {
  test('is domain-separated from the legacy quote-only digest', async () => {
    // So a pre-binding receipt can never be replayed as though it carried one.
    const bundle = await bundleFor('hello');
    expect(attestationRefFor(bundle)).not.toBe(legacyAttestationRef(bundle.quote));
    expect(attestationRefFor({ quote: QUOTE, response: null })).not.toBe(
      legacyAttestationRef(QUOTE),
    );
  });

  test('changes when any field of the bundle changes', async () => {
    const base = await bundleFor('hello');
    const digests = new Set([attestationRefFor(base)]);

    const variants: AttestationBundle[] = [
      { ...base, quote: QUOTE },
      { ...base, response: { ...base.response!, chatID: 'other' } },
      { ...base, response: { ...base.response!, model: 'other' } },
      { ...base, response: { ...base.response!, text: 'hello ' } },
      { ...base, response: { ...base.response!, outputPath: '$.other' } },
      { ...base, response: null },
    ];
    for (const variant of variants) {
      const digest = attestationRefFor(variant);
      expect(digests.has(digest), 'a bundle field is not covered by the digest').toBe(false);
      digests.add(digest);
    }
  });

  test('length prefixes stop two fields from being shifted between each other', () => {
    // Without them, {chatID:"ab", model:"c"} and {chatID:"a", model:"bc"}
    // would share a preimage and therefore an attestationRef.
    const a: AttestationBundle = {
      quote: QUOTE,
      response: { chatID: 'ab', model: 'c', text: 't', signature: `0x${'11'.repeat(65)}`, outputPath: '$' },
    };
    const b: AttestationBundle = {
      quote: QUOTE,
      response: { chatID: 'a', model: 'bc', text: 't', signature: `0x${'11'.repeat(65)}`, outputPath: '$' },
    };
    expect(attestationRefFor(a)).not.toBe(attestationRefFor(b));
  });

  test('the legacy digest reproduces what was actually anchored', () => {
    // sha256 over the base64-*decoded* attestation, because that is what the
    // executor hashed before binding existed. Hashing the string instead would
    // report every pre-binding receipt as tampered.
    const attestation = btoa('a self-signed agent blob');
    expect(legacyAttestationRef(attestation)).toBe(
      sha256(new Uint8Array(Buffer.from(attestation, 'base64'))),
    );
  });

  test('the legacy decode tolerates the same junk Node tolerated', () => {
    // Characters outside the alphabet are dropped, not treated as an error:
    // a stricter decode would compute a different digest for stored bytes.
    expect(legacyAttestationRef('attest:summarize')).toBe(
      sha256(new Uint8Array(Buffer.from('attest:summarize', 'base64'))),
    );
  });
});

describe('resolveOutputPath', () => {
  const output = { text: 'hi', nested: { deep: 'value' }, list: [{ k: 'first' }, 'second'] };

  test('resolves the whole output, fields, nesting and array indices', () => {
    expect(resolveOutputPath(output, '$')).toBe(output);
    expect(resolveOutputPath(output, '$.text')).toBe('hi');
    expect(resolveOutputPath(output, '$.nested.deep')).toBe('value');
    expect(resolveOutputPath(output, '$.list[0].k')).toBe('first');
    expect(resolveOutputPath(output, '$.list[1]')).toBe('second');
  });

  test('returns undefined rather than throwing on a path that does not resolve', () => {
    for (const path of ['$.missing', '$.nested.missing', '$.list[9]', '$.text.deeper', 'text']) {
      expect(resolveOutputPath(output, path), path).toBeUndefined();
    }
  });
});

describe('binding levels', () => {
  test('absent when there is no attestation', () => {
    const result = verifyAttestation({ bundle: null, output: { text: 'x' } });
    expect(result.level).toBe('absent');
  });

  test('present when the payload is not a quote envelope', () => {
    const result = verifyAttestation({
      bundle: { quote: btoa('{"kind":"self-signed"}'), response: null },
      output: { text: 'x' },
    });
    expect(result.level).toBe('present');
    expect(result.notes.join(' ')).toContain('quote not parsed');
  });

  test('present when a real quote carries no per-response signature', () => {
    // This is the state the executor was in before this work: a genuine
    // attestation that says nothing about the output.
    const result = verifyAttestation({ bundle: { quote: QUOTE, response: null }, output: { text: 'x' } });
    expect(result.level).toBe('present');
    expect(result.signerAddress).toBe(SIGNER);
    expect(result.notes.join(' ')).toContain('nothing ties this quote to the step output');
  });

  test('bound when the enclave key signed exactly this output', async () => {
    const result = verifyAttestation({
      bundle: await bundleFor('Summary: no critical findings.'),
      output: { text: 'Summary: no critical findings.' },
    });
    expect(result.level).toBe('bound');
    expect(result.recoveredAddress).toBe(ENCLAVE.address.toLowerCase());
    expect(result.signerAddress).toBe(ENCLAVE.address.toLowerCase());
  });

  test('attested, not bound, when the signed text is not the output', async () => {
    // THE ATTACK. A genuine quote, a genuine signature by the genuine enclave
    // key — over a different response. This is precisely what the 0G SDK's own
    // verifySignature would accept, because it only ever checks the text the
    // signature endpoint hands back.
    const result = verifyAttestation({
      bundle: await bundleFor('Summary: no critical findings.'),
      output: { text: 'Summary: seventeen critical findings.' },
    });

    expect(result.level).toBe('attested');
    expect(result.level).not.toBe('bound');
    expect(result.notes.join(' ')).toContain('belongs to a different response');
  });

  test('present when the signature is by a key the quote does not name', async () => {
    const result = verifyAttestation({
      bundle: await bundleFor('text', '$.text', IMPOSTER),
      output: { text: 'text' },
    });
    expect(result.level).toBe('present');
    expect(result.notes.join(' ')).toContain('not the key the quote binds');
  });

  test('present when the quote names a key the provider never acknowledged', async () => {
    const result = verifyAttestation({
      bundle: await bundleFor('text'),
      output: { text: 'text' },
      acknowledgedSigner: '0x000000000000000000000000000000000000dead',
    });
    expect(result.level).toBe('present');
    expect(result.notes.join(' ')).toContain('acknowledged TEE signer');
  });

  test('bound when the acknowledged signer does match', async () => {
    const result = verifyAttestation({
      bundle: await bundleFor('text'),
      output: { text: 'text' },
      acknowledgedSigner: ENCLAVE.address as Hex,
    });
    expect(result.level).toBe('bound');
  });

  test('attested when the output is unavailable to compare against', async () => {
    // A verifier that could not fetch the trace must not guess.
    const result = verifyAttestation({ bundle: await bundleFor('text'), output: null });
    expect(result.level).toBe('attested');
    expect(result.notes.join(' ')).toContain('output unavailable');
  });

  test('attested when outputPath does not resolve', async () => {
    const result = verifyAttestation({
      bundle: await bundleFor('text', '$.missing'),
      output: { text: 'text' },
    });
    expect(result.level).toBe('attested');
    expect(result.notes.join(' ')).toContain('does not resolve');
  });

  test('binds a whole-output signature via $', async () => {
    const output = { grade: 95, text: 'ok' };
    const canonical = '{"grade":95,"text":"ok"}';
    const result = verifyAttestation({
      bundle: await bundleFor(canonical, '$'),
      output,
    });
    // The signed text is compared against the canonical form, so key order in
    // the stored output cannot break a genuine binding.
    expect(result.level).toBe('bound');
  });

  test('a malformed signature degrades rather than throwing', async () => {
    const bundle = await bundleFor('text');
    const result = verifyAttestation({
      bundle: { ...bundle, response: { ...bundle.response!, signature: '0xdeadbeef' } },
      output: { text: 'text' },
    });
    expect(result.level).toBe('present');
    expect(result.notes.join(' ')).toContain('could not be recovered');
  });
});

describe('the Intel chain is never implied', () => {
  test('quoteSignatureVerified is false at every level', async () => {
    const cases = [
      verifyAttestation({ bundle: null, output: null }),
      verifyAttestation({ bundle: { quote: QUOTE, response: null }, output: null }),
      verifyAttestation({ bundle: await bundleFor('t'), output: { text: 't' } }),
    ];
    for (const result of cases) expect(result.quoteSignatureVerified).toBe(false);
  });

  test('even a bound result carries the unverified-chain note', async () => {
    const result = verifyAttestation({
      bundle: await bundleFor('t'),
      output: { text: 't' },
    });
    expect(result.level).toBe('bound');
    expect(result.notes.join(' ')).toContain('Intel PCS roots');
  });

  test('no description is an unqualified tick', async () => {
    const result = verifyAttestation({ bundle: await bundleFor('t'), output: { text: 't' } });
    const text = describeBinding(result);
    expect(text).toContain('Intel chain not checked');
    expect(text).not.toBe('TEE ✓');
  });
});

describe('meetsBinding', () => {
  const levels: BindingLevel[] = ['absent', 'present', 'attested', 'bound'];

  test('is a total order, weakest first', () => {
    for (let i = 0; i < levels.length; i++) {
      for (let j = 0; j < levels.length; j++) {
        expect(meetsBinding(levels[i]!, levels[j]!), `${levels[i]} >= ${levels[j]}`).toBe(i >= j);
      }
    }
  });
});

describe('status follows the binding, per §1.3', () => {
  test('a step requiring binding is Unattested when only attested', () => {
    // The attack case again, now at the status level: a genuine attestation
    // over a different response must not produce an ok step.
    expect(
      decideStepStatus({
        requireAttestation: true,
        attestationPresent: true,
        bindingLevel: 'attested',
        requireBinding: 'bound',
      }),
    ).toBe(StepStatus.Unattested);
  });

  test('a step requiring binding is Ok when bound', () => {
    expect(
      decideStepStatus({
        requireAttestation: true,
        attestationPresent: true,
        bindingLevel: 'bound',
        requireBinding: 'bound',
      }),
    ).toBe(StepStatus.Ok);
  });

  test('no binding level supplied is read as present, never better', () => {
    // Silence must not be optimism.
    expect(
      decideStepStatus({
        requireAttestation: true,
        attestationPresent: true,
        requireBinding: 'bound',
      }),
    ).toBe(StepStatus.Unattested);
    expect(
      decideStepStatus({ requireAttestation: true, attestationPresent: true }),
    ).toBe(StepStatus.Ok);
  });

  test('no combination of inputs promotes an unbound attestation to Ok', () => {
    // Exhaustive, in the spirit of the §10.3 test: when binding is required,
    // only `bound` may be ok.
    for (const bindingLevel of ['absent', 'present', 'attested', 'bound'] as BindingLevel[]) {
      const status = decideStepStatus({
        requireAttestation: true,
        attestationPresent: true,
        bindingLevel,
        requireBinding: 'bound',
      });
      if (bindingLevel === 'bound') expect(status).toBe(StepStatus.Ok);
      else expect(status).not.toBe(StepStatus.Ok);
    }
  });

  test('an error still outranks a perfect binding', () => {
    expect(
      decideStepStatus({
        requireAttestation: true,
        attestationPresent: true,
        bindingLevel: 'bound',
        requireBinding: 'bound',
        error: 'boom',
      }),
    ).toBe(StepStatus.Failed);
  });

  test('a flow that does not require attestation is unaffected', () => {
    expect(
      decideStepStatus({
        requireAttestation: false,
        attestationPresent: false,
        requireBinding: 'bound',
      }),
    ).toBe(StepStatus.Ok);
  });
});
