/**
 * Attestation binding, anchored on 0G.
 *
 * The trust anchor is the TEE signer 0G's InferenceServing contract
 * acknowledges for a provider — not a vendor PKI. The addresses used here are
 * the real ones read from Galileo, and they are byte-identical to the
 * `report_data` inside the captured quotes, which is what makes anchoring on
 * 0G a change of *who vouches*, not of *which key*.
 *
 * The tests that matter most are the ones where a genuine attestation is
 * paired with an output it does not cover. That is the attack the binding
 * exists to stop, and the level it produces must never be `bound`.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AttestationError,
  attestationRefFor,
  claimedSigner,
  describeBinding,
  legacyAttestationRef,
  meetsBinding,
  resolveOutputPath,
  signerFromReportData,
  verifyAttestation,
  type AcknowledgedSigner,
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

/**
 * Read from Galileo's InferenceServing contract on 2026-08-27. Both are
 * acknowledged, and both match the `report_data` of the captured quotes.
 */
const CAPTURES = [
  {
    provider: '0xa48f01287233509fd694a22bf840225062e67836' as Hex,
    teeSigner: '0x83df4b8eba7c0b3b740019b8c9a77fff77d508cf' as Hex,
  },
  {
    provider: '0x4b2a941929e39adbea5316ddf2b9bd8ff3134389' as Hex,
    teeSigner: '0x2a94d671f1a5e080f75a8164087cdd35c8442e69' as Hex,
  },
];

const QUOTE = artifact(CAPTURES[0]!.provider);

/**
 * The enclave key. A real one lives inside a TEE, so a test key stands in and
 * the registry is stubbed to acknowledge it. What is under test is the rule —
 * only the signer 0G acknowledges can bind — not the identity of the key.
 */
const ENCLAVE = privateKeyToAccount(
  '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
);
const IMPOSTER = privateKeyToAccount(
  '0x0123456789012345678901234567890123456789012345678901234567890123',
);

const PROVIDER = '0x00000000000000000000000000000000000000a1' as Hex;

const REGISTRY: AcknowledgedSigner = {
  provider: PROVIDER,
  teeSignerAddress: ENCLAVE.address.toLowerCase() as Hex,
  acknowledged: true,
};

/**
 * Builds a bundle whose enclave "answered" `answer`.
 *
 * Shaped like a real 0G Compute exchange: the response body is what the
 * provider served, and the signed text is a digest envelope committing to its
 * exact bytes — not the answer itself. See zg-compute-binding.test.ts for the
 * live capture this mirrors.
 */
async function bundleFor(
  answer: string,
  outputPath = '$.text',
  signer = ENCLAVE,
  overrides: { responseBody?: string; signedText?: string } = {},
): Promise<AttestationBundle> {
  const responseBody =
    overrides.responseBody ?? JSON.stringify({ choices: [{ message: { content: answer } }] });
  const digest = sha256(new TextEncoder().encode(responseBody)).slice(2);
  const signedText = overrides.signedText ?? `${'aa'.repeat(32)}:${digest}:centralized:test:${'bb'.repeat(32)}`;

  return {
    quote: QUOTE,
    provider: PROVIDER,
    response: {
      chatID: 'chat-123',
      model: 'qwen/qwen2.5-omni-7b',
      text: signedText,
      signature: (await signer.signMessage({ message: signedText })) as Hex,
      responseBody,
      responsePath: '$.choices[0].message.content',
      outputPath,
    },
  };
}

type Input = Parameters<typeof verifyAttestation>[0];

/** verifyAttestation with the registry stubbed to acknowledge ENCLAVE. */
const check = (input: Omit<Input, 'acknowledgedSigner'> & Partial<Input>) =>
  verifyAttestation({ acknowledgedSigner: REGISTRY, ...input });

// ---------------------------------------------------------------------------

describe('report_data is advisory, not the anchor', () => {
  test.each(CAPTURES)(
    'the captured quote for $provider names the signer 0G acknowledges',
    ({ provider, teeSigner }) => {
      // The evidence that anchoring on 0G does not change which key is
      // trusted: the chain's acknowledged signer and the quote's report_data
      // are the same address.
      expect(claimedSigner(artifact(provider))).toBe(teeSigner);
    },
  );

  test('the two providers use different keys', () => {
    expect(CAPTURES[0]!.teeSigner).not.toBe(CAPTURES[1]!.teeSigner);
  });

  test('claimedSigner returns null rather than throwing on junk', () => {
    // The envelope is unauthenticated, so a malformed one is uninteresting.
    for (const junk of ['not json', '{}', '{"report_data":"zzz"}', btoa('blob')]) {
      expect(claimedSigner(junk)).toBeNull();
    }
  });

  test('signerFromReportData still validates the shape it does parse', () => {
    expect(() => signerFromReportData(btoa('short'))).toThrow('must be 64 bytes');
    let binary = '';
    for (let i = 0; i < 64; i++) binary += String.fromCharCode(i + 1);
    expect(() => signerFromReportData(btoa(binary))).toThrow('does not hold an Ethereum address');
    expect(() => signerFromReportData('not base64!!!')).toThrow(AttestationError);
  });
});

describe('attestationRef', () => {
  test('is domain-separated from the legacy quote-only digest', async () => {
    const bundle = await bundleFor('hello');
    expect(attestationRefFor(bundle)).not.toBe(legacyAttestationRef(bundle.quote));
  });

  test('changes when any field of the bundle changes', async () => {
    const base = await bundleFor('hello');
    const digests = new Set([attestationRefFor(base)]);

    const variants: AttestationBundle[] = [
      { ...base, quote: `${base.quote} ` },
      { ...base, provider: '0x00000000000000000000000000000000000000b2' },
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

  test('commits to the provider, so the anchor cannot be re-pointed', async () => {
    // Without provider in the digest, an operator could keep a stored bundle
    // and claim it came from whichever provider acknowledges the signing key.
    const a = await bundleFor('same text');
    const b: AttestationBundle = { ...a, provider: '0x00000000000000000000000000000000000000ff' };
    expect(attestationRefFor(a)).not.toBe(attestationRefFor(b));
  });

  test('length prefixes stop two fields from being shifted between each other', () => {
    const shared = { quote: QUOTE, provider: PROVIDER };
    const a: AttestationBundle = {
      ...shared,
      response: { chatID: 'ab', model: 'c', text: 't', signature: `0x${'11'.repeat(65)}`, outputPath: '$' },
    };
    const b: AttestationBundle = {
      ...shared,
      response: { chatID: 'a', model: 'bc', text: 't', signature: `0x${'11'.repeat(65)}`, outputPath: '$' },
    };
    expect(attestationRefFor(a)).not.toBe(attestationRefFor(b));
  });

  test('the legacy digest reproduces what was actually anchored', () => {
    const attestation = btoa('a self-signed agent blob');
    expect(legacyAttestationRef(attestation)).toBe(
      sha256(new Uint8Array(Buffer.from(attestation, 'base64'))),
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
    const result = check({ bundle: null, output: { text: 'x' } });
    expect(result.level).toBe('absent');
    expect(result.signerResolved).toBe(false);
  });

  test('bound when the acknowledged signer signed exactly this output', async () => {
    const result = check({
      bundle: await bundleFor('Summary: no critical findings.'),
      output: { text: 'Summary: no critical findings.' },
    });

    expect(result.level).toBe('bound');
    expect(result.signerResolved).toBe(true);
    expect(result.recoveredAddress).toBe(ENCLAVE.address.toLowerCase());
    expect(result.acknowledgedSigner).toBe(ENCLAVE.address.toLowerCase());
  });

  test('attested, not bound, when the output is not what was answered', async () => {
    // THE ATTACK. A genuine attestation, a genuine signature by the very key
    // 0G acknowledges — over a different response. This is exactly what the
    // 0G SDK's own verifySignature accepts, because it only ever checks the
    // text the signature endpoint hands back.
    const result = check({
      bundle: await bundleFor('Summary: no critical findings.'),
      output: { text: 'Summary: seventeen critical findings.' },
    });

    expect(result.level).toBe('attested');
    expect(result.level).not.toBe('bound');
    expect(result.notes.join(' ')).toContain('not what the signed response carried');
  });

  test('present when 0G has not acknowledged the signer', async () => {
    // Revocation. Chain state is live, so de-acknowledging a compromised
    // signer stops it attesting on the next read — the thing a pinned
    // certificate chain could not express without a network fetch.
    const result = check({
      bundle: await bundleFor('text'),
      output: { text: 'text' },
      acknowledgedSigner: { ...REGISTRY, acknowledged: false },
    });

    expect(result.level).toBe('present');
    expect(result.notes.join(' ')).toContain('has not acknowledged');
  });

  test('present when the registry could not be read', async () => {
    // Offline, or an unregistered provider. Nothing to check against, so
    // nothing is established — assuming otherwise is the promotion §1.3 forbids.
    const result = check({
      bundle: await bundleFor('text'),
      output: { text: 'text' },
      acknowledgedSigner: null,
    });

    expect(result.level).toBe('present');
    expect(result.signerResolved).toBe(false);
    expect(result.notes.join(' ')).toContain('could not be read');
  });

  test('present when the registry entry is for a different provider', async () => {
    // Reading the wrong provider's entry would check the signature against a
    // key that has nothing to do with this step.
    const result = check({
      bundle: await bundleFor('text'),
      output: { text: 'text' },
      acknowledgedSigner: { ...REGISTRY, provider: '0x00000000000000000000000000000000000000ee' },
    });

    expect(result.level).toBe('present');
    expect(result.notes.join(' ')).toContain('but the bundle names');
  });

  test('present when the signature is by a key 0G does not acknowledge', async () => {
    const result = check({
      bundle: await bundleFor('text', '$.text', IMPOSTER),
      output: { text: 'text' },
    });
    expect(result.level).toBe('present');
    expect(result.notes.join(' ')).toContain('not the signer 0G acknowledges');
  });

  test('present when a real attestation carries no per-response signature', () => {
    // The state the executor was in before this work: a genuine attestation
    // that says nothing about the output.
    const result = check({
      bundle: { quote: QUOTE, provider: PROVIDER, response: null },
      output: { text: 'x' },
    });
    expect(result.level).toBe('present');
    expect(result.notes.join(' ')).toContain('nothing ties this attestation to the step output');
  });

  test('attested when the output is unavailable to compare against', async () => {
    const result = check({ bundle: await bundleFor('text'), output: null });
    expect(result.level).toBe('attested');
    expect(result.notes.join(' ')).toContain('output unavailable');
  });

  test('attested when outputPath does not resolve', async () => {
    const result = check({
      bundle: await bundleFor('text', '$.missing'),
      output: { text: 'text' },
    });
    expect(result.level).toBe('attested');
    expect(result.notes.join(' ')).toContain('does not resolve');
  });

  test('attested when the signature does not commit to the stored response', async () => {
    // A genuine signature over a digest envelope for some other exchange.
    const result = check({
      bundle: await bundleFor('text', '$.text', ENCLAVE, {
        signedText: `${'aa'.repeat(32)}:${'cc'.repeat(32)}:centralized:test:${'bb'.repeat(32)}`,
      }),
      output: { text: 'text' },
    });
    expect(result.level).toBe('attested');
    expect(result.notes.join(' ')).toContain('does not commit to the stored response');
  });

  test('binds a whole output when the answer is the output', async () => {
    // outputPath '$' when the step's output IS the enclave's answer.
    const result = check({ bundle: await bundleFor('plain answer', '$'), output: 'plain answer' });
    expect(result.level).toBe('bound');
  });

  test('a malformed signature degrades rather than throwing', async () => {
    const bundle = await bundleFor('text');
    const result = check({
      bundle: { ...bundle, response: { ...bundle.response!, signature: '0xdeadbeef' } },
      output: { text: 'text' },
    });
    expect(result.level).toBe('present');
    expect(result.notes.join(' ')).toContain('could not be recovered');
  });

  test('an envelope naming a different key is noted, and the chain wins', async () => {
    // The captured quote names 0x83df…, but the stubbed registry acknowledges
    // the test key. The chain is authoritative; the disagreement is reported.
    const result = check({ bundle: await bundleFor('text'), output: { text: 'text' } });

    expect(result.level).toBe('bound');
    expect(result.notes.join(' ')).toContain('the attestation document names');
    expect(result.acknowledgedSigner).toBe(ENCLAVE.address.toLowerCase());
  });
});

describe('descriptions never overclaim', () => {
  test('no description is an unqualified tick', async () => {
    const result = check({ bundle: await bundleFor('t'), output: { text: 't' } });
    const text = describeBinding(result);
    expect(text).not.toBe('TEE ✓');
    expect(text).toContain('0G acknowledges');
  });

  test('every level has a distinct description', () => {
    const levels: BindingLevel[] = ['absent', 'present', 'attested', 'bound'];
    const seen = levels.map((level) =>
      describeBinding({
        level,
        acknowledgedSigner: null,
        recoveredAddress: null,
        signerResolved: false,
        notes: [],
      }),
    );
    expect(new Set(seen).size).toBe(levels.length);
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
    expect(
      decideStepStatus({ requireAttestation: true, attestationPresent: true, requireBinding: 'bound' }),
    ).toBe(StepStatus.Unattested);
    expect(decideStepStatus({ requireAttestation: true, attestationPresent: true })).toBe(
      StepStatus.Ok,
    );
  });

  test('no combination of inputs promotes an unbound attestation to Ok', () => {
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
