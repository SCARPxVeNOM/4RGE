/**
 * The verifier's end of attestation binding — spec §9 step 5.
 *
 * The point of these tests is one scenario: a run whose every other check
 * passes, carrying a genuine TEE quote and a genuine signature by the very key
 * that quote binds — over a *different* response. Every hash matches, the
 * chain root folds, linkage holds, and the attestation is real. The only thing
 * wrong is that the attestation describes an output the step did not produce.
 *
 * That run must not verify. It is exactly what a matching `attestationRef`
 * used to accept, and exactly what the 0G SDK's own signature check still
 * accepts, because that check compares the signature against text supplied by
 * the same endpoint that supplied the signature.
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import {
  attestationRefFor,
  canonicalize,
  foldChainRoot,
  hashJson,
  legacyAttestationRef,
  StepStatus,
  ZERO_BYTES32,
  type AttestationBundle,
  type Hex,
  type JsonValue,
  type Receipt,
} from '@0gflow/core';
import { verifyRun } from '../src/verify.js';
import { STEP_ANCHORED_TOPIC, RUN_SEALED_TOPIC, type RawLog } from '../src/decode.js';
import type { ChainSource, FetchedTrace, TraceSource } from '../src/sources.js';

const RUN_ID = `0x${'22'.repeat(32)}` as Hex;
const FLOW_ID = `0x${'11'.repeat(32)}` as Hex;
const REGISTRY = '0x7177a6867296406881e20d6647232314736dd09a' as Hex;

const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');
const bare = (h: string) => h.replace(/^0x/, '');

const ENCLAVE = privateKeyToAccount(
  '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
);

/** A real captured quote, re-pointed at the test key. */
const CAPTURED = readFileSync(
  fileURLToPath(
    new URL(
      '../../../artifacts/attestation/0xa48f01287233509fd694a22bf840225062e67836.raw.json',
      import.meta.url,
    ),
  ),
  'utf8',
);

function quoteBinding(address: string): string {
  const parsed = JSON.parse(CAPTURED) as Record<string, unknown>;
  const padded = new Uint8Array(64);
  padded.set(new TextEncoder().encode(address), 0);
  let binary = '';
  for (const byte of padded) binary += String.fromCharCode(byte);
  return JSON.stringify({ ...parsed, report_data: btoa(binary) });
}

const QUOTE = quoteBinding(ENCLAVE.address);

const INPUT: JsonValue = { text: 'the findings' };
const OUTPUT: JsonValue = { text: 'Summary: no critical findings.' };

async function bundleOver(signedText: string, outputPath = '$.text'): Promise<AttestationBundle> {
  return {
    quote: QUOTE,
    response: {
      chatID: 'chat-abc',
      model: 'qwen/qwen2.5-omni-7b',
      text: signedText,
      signature: (await ENCLAVE.signMessage({ message: signedText })) as Hex,
      outputPath,
    },
  };
}

function encodeStepAnchoredLog(r: Receipt): RawLog {
  return {
    address: '0x741a36faba40ee71223539a5a062fdedc8574e30',
    topics: [STEP_ANCHORED_TOPIC, r.flowId, r.runId, `0x${word(r.stepIndex)}`],
    data:
      '0x' +
      word(r.agentId) +
      bare(r.inputHash) +
      bare(r.outputHash) +
      bare(r.traceRoot) +
      bare(r.attestationRef) +
      word(r.startedAt) +
      word(r.endedAt) +
      word(r.status),
    blockNumber: '0xa',
    transactionHash: `0x${'01'.repeat(32)}`,
    logIndex: '0x0',
  };
}

class FakeChain implements ChainSource {
  constructor(
    private readonly stepLogs: RawLog[],
    private readonly sealLogs: RawLog[],
  ) {}
  async getStepAnchoredLogs() {
    return this.stepLogs;
  }
  async getRunSealedLogs() {
    return this.sealLogs;
  }
  async ownerOf() {
    return '0x00000000000000000000000000000000000000aa' as Hex;
  }
}

class FakeTraces implements TraceSource {
  readonly describe = 'fake';
  constructor(private readonly traces: Map<string, JsonValue>) {}
  async fetch(root: Hex): Promise<FetchedTrace | null> {
    const found = this.traces.get(root.toLowerCase());
    if (found === undefined) return null;
    return {
      bytes: new TextEncoder().encode(canonicalize(found)),
      origin: 'storage',
      inclusionProofVerified: true,
    };
  }
}

/**
 * A single-step run whose trace and receipt are internally consistent — only
 * the attestation varies.
 */
function scenario(traceExtras: Record<string, JsonValue | null>, attestationRef: Hex) {
  const trace = {
    version: '0gflow/1',
    runId: RUN_ID,
    stepIndex: 0,
    stepId: 'summarize',
    agent: '1',
    input: INPUT,
    output: OUTPUT,
    ...traceExtras,
  } as unknown as JsonValue;

  const traceRoot = hashJson(trace) as Hex;
  const receipt: Receipt = {
    flowId: FLOW_ID,
    runId: RUN_ID,
    stepIndex: 0,
    agentId: 1n,
    inputHash: hashJson(INPUT),
    outputHash: hashJson(OUTPUT),
    traceRoot,
    attestationRef,
    startedAt: 100n,
    endedAt: 101n,
    status: StepStatus.Ok,
  };

  const chainRoot = foldChainRoot([receipt]) as Hex;
  const sealLog: RawLog = {
    address: '0x741a36faba40ee71223539a5a062fdedc8574e30',
    topics: [RUN_SEALED_TOPIC, RUN_ID],
    data: '0x' + bare(chainRoot) + word(1) + word(0),
    blockNumber: '0xb',
    transactionHash: `0x${'ee'.repeat(32)}`,
    logIndex: '0x0',
  };

  return {
    runId: RUN_ID,
    chain: new FakeChain([encodeStepAnchoredLog(receipt)], [sealLog]),
    traces: new FakeTraces(new Map([[traceRoot.toLowerCase(), trace]])),
    identityRegistry: REGISTRY,
    spec: { steps: [{ id: 'summarize', input: { text: '{{ inputs.text }}' } }], inputs: { text: 'the findings' } },
  };
}

describe('an attestation that covers the output', () => {
  test('verifies, and reports the binding', async () => {
    const bundle = await bundleOver('Summary: no critical findings.');
    const report = await verifyRun(
      scenario(
        { attestationBundle: bundle as unknown as JsonValue },
        attestationRefFor(bundle),
      ),
    );

    expect(report.failures).toEqual([]);
    expect(report.verdict).toBe('verified');
    expect(report.steps[0]!.binding?.level).toBe('bound');
    expect(report.steps[0]!.binding?.signerAddress).toBe(ENCLAVE.address.toLowerCase());
  });

  test('never claims the Intel chain was checked', async () => {
    const bundle = await bundleOver('Summary: no critical findings.');
    const report = await verifyRun(
      scenario({ attestationBundle: bundle as unknown as JsonValue }, attestationRefFor(bundle)),
    );

    expect(report.steps[0]!.binding?.quoteSignatureVerified).toBe(false);
    expect(report.steps[0]!.notes.join(' ')).toContain('Intel PCS roots');
  });
});

describe('THE SUBSTITUTION: a genuine attestation over a different response', () => {
  test('fails verification, even though every other check passes', async () => {
    // The signature is real, by the key the real quote binds. The digest
    // matches. The hashes match. The chain root folds. Only the signed text
    // is not this step's output.
    const bundle = await bundleOver('Summary: seventeen critical findings.');
    const report = await verifyRun(
      scenario({ attestationBundle: bundle as unknown as JsonValue }, attestationRefFor(bundle)),
    );

    expect(report.verdict).toBe('failed');
    expect(report.failures.join(' ')).toContain('does not cover this step output');
    expect(report.steps[0]!.binding?.level).toBe('attested');

    // The digest itself is fine — which is precisely why digest-checking alone
    // was never enough.
    expect(report.steps[0]!.attestation).toBe('verified');
  });

  test('the recovered signer is still the attested key, so the failure is about coverage', async () => {
    const bundle = await bundleOver('Summary: seventeen critical findings.');
    const report = await verifyRun(
      scenario({ attestationBundle: bundle as unknown as JsonValue }, attestationRefFor(bundle)),
    );

    const binding = report.steps[0]!.binding!;
    expect(binding.recoveredAddress).toBe(ENCLAVE.address.toLowerCase());
    expect(binding.signerAddress).toBe(binding.recoveredAddress);
  });
});

describe('other ways the binding fails', () => {
  test('a signature by a key the quote does not name is not a binding', async () => {
    const imposter = privateKeyToAccount(
      '0x0123456789012345678901234567890123456789012345678901234567890123',
    );
    const text = 'Summary: no critical findings.';
    const bundle: AttestationBundle = {
      quote: QUOTE,
      response: {
        chatID: 'c',
        model: 'm',
        text,
        signature: (await imposter.signMessage({ message: text })) as Hex,
        outputPath: '$.text',
      },
    };

    const report = await verifyRun(
      scenario({ attestationBundle: bundle as unknown as JsonValue }, attestationRefFor(bundle)),
    );
    expect(report.steps[0]!.binding?.level).toBe('present');
    expect(report.steps[0]!.notes.join(' ')).toContain('not the key the quote binds');
  });

  test('an outputPath pointing at the wrong field does not bind', async () => {
    const bundle = await bundleOver('Summary: no critical findings.', '$.somewhereElse');
    const report = await verifyRun(
      scenario({ attestationBundle: bundle as unknown as JsonValue }, attestationRefFor(bundle)),
    );
    expect(report.verdict).toBe('failed');
    expect(report.steps[0]!.binding?.level).toBe('attested');
  });

  test('a tampered bundle breaks the digest before the binding is even considered', async () => {
    const bundle = await bundleOver('Summary: no critical findings.');
    // Anchor the digest of one bundle, store another.
    const swapped = await bundleOver('Summary: something else entirely.');
    const report = await verifyRun(
      scenario({ attestationBundle: swapped as unknown as JsonValue }, attestationRefFor(bundle)),
    );

    expect(report.verdict).toBe('failed');
    expect(report.steps[0]!.attestation).toBe('mismatched');
  });

  test('a referenced attestation absent from the trace fails', async () => {
    const bundle = await bundleOver('Summary: no critical findings.');
    const report = await verifyRun(scenario({}, attestationRefFor(bundle)));

    expect(report.verdict).toBe('failed');
    expect(report.steps[0]!.attestation).toBe('absent-but-referenced');
  });
});

describe('receipts anchored before binding existed', () => {
  test('still verify, but are reported as unbound rather than as TEE-verified', async () => {
    // A pre-binding receipt is not evidence of tampering, and must not be
    // failed. It simply never carried a claim about its output, and the report
    // has to say so instead of showing a tick.
    const raw = btoa('an older self-signed attestation');
    const report = await verifyRun(
      scenario({ attestation: raw }, legacyAttestationRef(raw)),
    );

    expect(report.failures).toEqual([]);
    expect(report.verdict).toBe('verified');
    expect(report.steps[0]!.attestation).toBe('verified');
    expect(report.steps[0]!.binding?.level).toBe('present');
    expect(report.steps[0]!.notes.join(' ')).toContain('pre-binding format');
  });

  test('a legacy digest cannot be passed off as a bundle digest', async () => {
    // Domain separation: the same bytes hash differently under the two
    // schemes, so an old receipt cannot be replayed as a bound one.
    const raw = btoa('an older self-signed attestation');
    expect(legacyAttestationRef(raw)).not.toBe(
      attestationRefFor({ quote: raw, response: null }),
    );
  });
});

describe('a step with no attestation at all', () => {
  test('is unaffected', async () => {
    const report = await verifyRun(scenario({}, ZERO_BYTES32));
    expect(report.verdict).toBe('verified');
    expect(report.steps[0]!.attestation).toBe('not-required');
    expect(report.steps[0]!.binding).toBeNull();
  });
});
