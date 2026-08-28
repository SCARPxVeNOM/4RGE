import { describe, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, loadSpec } from '../src/cli.js';
import { renderReport, exitCodeFor } from '../src/report.js';
import { StepStatus, type Hex } from '@0gflow/core';
import { GALILEO } from '@0gflow/config';
import type { VerificationReport } from '../src/verify.js';

describe('parseArgs', () => {
  test('takes the runId positionally and normalises it', () => {
    expect(parseArgs(['0xAB']).runId).toBe('0xab');
    expect(parseArgs(['ab']).runId).toBe('0xab');
  });

  test('parses options', () => {
    const args = parseArgs(['0xab', '--rpc', 'https://x', '--trace-dir', '/t', '--tamper', '--json']);
    expect(args.rpc).toBe('https://x');
    expect(args.traceDir).toBe('/t');
    expect(args.tamper).toBe(true);
    expect(args.json).toBe(true);
  });

  test('rejects unknown options rather than ignoring them', () => {
    // Silently ignoring a typo'd flag would mean verifying something other
    // than what the operator asked for.
    expect(() => parseArgs(['0xab', '--rcp', 'x'])).toThrow(/unknown option/);
  });

  test('rejects an option with no value', () => {
    expect(() => parseArgs(['0xab', '--rpc'])).toThrow(/needs a value/);
  });
});

describe('loadSpec', () => {
  const dir = mkdtempSync(join(tmpdir(), '0gflow-spec-'));

  test('reads a bare flow spec', () => {
    const p = join(dir, 'spec.json');
    writeFileSync(p, JSON.stringify({ steps: [{ id: 'a', input: { x: 1 } }] }));
    expect(loadSpec(p, undefined).steps[0]!.id).toBe('a');
  });

  test('reads a run bundle carrying spec and inputs', () => {
    const p = join(dir, 'bundle.json');
    writeFileSync(p, JSON.stringify({ spec: { steps: [{ id: 'a', input: {}, needs: ['b'] }] }, runInputs: { k: 1 } }));
    const loaded = loadSpec(p, undefined);
    expect(loaded.steps[0]!.needs).toStrictEqual(['b']);
    expect(loaded.inputs).toStrictEqual({ k: 1 });
  });

  test('prefers spec.steps over a sibling steps key', () => {
    // A run artifact carries both the flow spec and a summary of what each
    // step did. Picking the summary array yields steps with no id or input,
    // and linkage then fails against a run that is actually sound.
    const p = join(dir, 'ambiguous.json');
    writeFileSync(
      p,
      JSON.stringify({
        steps: [{ stepId: 'audit', stepIndex: 0, status: 0 }],
        spec: { steps: [{ id: 'audit', input: { repo: '{{ inputs.repoUrl }}' } }] },
        runInputs: { repoUrl: 'x' },
      }),
    );
    const loaded = loadSpec(p, undefined);
    expect(loaded.steps).toHaveLength(1);
    expect(loaded.steps[0]!.id).toBe('audit');
    expect(loaded.steps[0]!.input).toStrictEqual({ repo: '{{ inputs.repoUrl }}' });
  });

  test('rejects steps that carry no id', () => {
    // Better to refuse than to silently check linkage for step "undefined".
    const p = join(dir, 'noid.json');
    writeFileSync(p, JSON.stringify({ steps: [{ stepIndex: 0, status: 0 }] }));
    expect(() => loadSpec(p, undefined)).toThrow(/id/i);
  });

  test('rejects a file with no steps', () => {
    const p = join(dir, 'bad.json');
    writeFileSync(p, JSON.stringify({ nope: true }));
    expect(() => loadSpec(p, undefined)).toThrow(/steps/);
  });
});

describe('exit codes', () => {
  // §9: non-zero on anything that is not a full pass.
  test('map verdicts to 0/1/2', () => {
    expect(exitCodeFor('verified')).toBe(0);
    expect(exitCodeFor('failed')).toBe(1);
    expect(exitCodeFor('incomplete')).toBe(2);
  });
});

const baseReport: VerificationReport = {
  runId: `0x${'22'.repeat(32)}` as Hex,
  flowId: `0x${'11'.repeat(32)}` as Hex,
  verdict: 'verified',
  stepCount: 1,
  computedChainRoot: `0x${'33'.repeat(32)}` as Hex,
  sealedChainRoot: `0x${'33'.repeat(32)}` as Hex,
  sealedStepCount: 1,
  sealedOutcome: 0,
  runSucceeded: true,
  steps: [
    {
      stepIndex: 0, stepId: 'audit', agentId: 1n, status: StepStatus.Ok,
      receiptHash: `0x${'44'.repeat(32)}` as Hex, txHash: `0x${'55'.repeat(32)}` as Hex,
      identityResolved: true, identityOwner: `0x${'aa'.repeat(20)}` as Hex,
      traceOrigin: 'storage', inclusionProofVerified: true, hashesMatch: true,
      attestation: 'not-required', binding: null, notes: [],
      outputIdentity: 'absent', recoveredAgentSigner: null,
    },
  ],
  linkage: { ok: true, totalSteps: 1, linkedSteps: 1, steps: [], failures: [] },
  linkageSkipped: null,
  failures: [],
  incomplete: [],
  traceSource: '0G Storage',
  hired: [],
};

const ctx = {
  networkName: GALILEO.displayName,
  chainId: GALILEO.chainId,
  contract: `0x${'99'.repeat(20)}`,
};

describe('renderReport', () => {
  test('reports a verified run', () => {
    const out = renderReport(baseReport, ctx);
    expect(out).toMatch(/VERIFIED/);
    expect(out).toMatch(/Linkage\s+✓/);
    expect(out).toContain(String(GALILEO.chainId));
    expect(out).toMatch(/matches on-chain seal/);
  });

  test('never prints VERIFIED when checks did not run', () => {
    // The §1.3 rule expressed in the output layer.
    const out = renderReport(
      {
        ...baseReport,
        verdict: 'incomplete',
        linkage: null,
        linkageSkipped: 'some traces were unavailable',
        incomplete: ['trace unavailable'],
      },
      ctx,
    );
    expect(out).not.toMatch(/VERIFIED/);
    expect(out).toMatch(/INCOMPLETE/);
    expect(out).toMatch(/Not checked:/);
    expect(out).toMatch(/trace unavailable/);
    // The stated reason must be the real one, not a default.
    expect(out).toMatch(/not checked \(some traces were unavailable\)/);
    expect(out).not.toMatch(/flow spec not supplied/);
  });

  test('lists each failure', () => {
    const out = renderReport(
      { ...baseReport, verdict: 'failed', failures: ['chain root mismatch: a vs b'] },
      ctx,
    );
    expect(out).toMatch(/FAILED/);
    expect(out).toMatch(/chain root mismatch/);
  });

  test('flags an unattested step without guessing why it is unattested', () => {
    // A zero attestationRef means no attestation was anchored. Since agent
    // signatures exist, a step can be Unattested because its identity went
    // unproven instead, so the label must not claim an attestation was
    // required — it cannot know that from the receipt.
    const out = renderReport(
      {
        ...baseReport,
        steps: [{ ...baseReport.steps[0]!, status: StepStatus.Unattested }],
      },
      ctx,
    );
    expect(out).toMatch(/none anchored/);
    expect(out).not.toMatch(/required but absent/);
    expect(out).toMatch(/status: unattested/);
  });
});
