/**
 * The suite run over real HTTP against the reference agents.
 *
 * The unit tests prove each check reacts correctly to a fabricated response.
 * This proves the suite works against a server that was written without any
 * knowledge of it — including two agents that misbehave on purpose, where the
 * interesting question is not whether the suite complains but whether it
 * complains about the right thing.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createAgentServer } from '../../../tools/reference-agents/src/serve.js';
import { runConformance, type ConformanceReport } from '../src/checks.js';
import { createHttpProbe, joinEndpoint } from '../src/probe.js';
import { renderJson, renderReport } from '../src/report.js';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createAgentServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
});

// Built lazily: `base` is not assigned until beforeAll runs, and a URL
// computed at collection time would be "undefined/agents/...".
const conform = (agent: string): Promise<ConformanceReport> => {
  const endpoint = `${base}/agents/${agent}`;
  return runConformance({ endpoint, probe: createHttpProbe(endpoint, 10_000) });
};

const detailOf = (report: ConformanceReport, id: string): string =>
  report.results.find((r) => r.id === id)?.detail ?? `<no check "${id}">`;

const failed = (report: ConformanceReport): string[] =>
  report.results.filter((r) => !r.passed && r.severity === 'fail').map((r) => `${r.id}: ${r.detail}`);

describe('the well-behaved reference agents', () => {
  for (const agent of ['audit', 'summarize', 'score', 'publish']) {
    it(`${agent} is conformant`, async () => {
      const report = await conform(agent);
      expect(failed(report)).toEqual([]);
      expect(report.conformant).toBe(true);
    });
  }

  it('builds a working input for publish, whose schema has two typed fields', async () => {
    // The strongest evidence the golden-input synthesiser earns its place: a
    // string and a number, both required, neither guessable from the field
    // name — constructed from /schema alone and accepted by /invoke.
    const report = await conform('publish');
    expect(detailOf(report, 'golden-input')).toContain('"body"');
    expect(detailOf(report, 'golden-input')).toContain('"grade"');
    expect(report.results.find((r) => r.id === 'invoke')?.passed).toBe(true);
  });

  it('confirms summarize returns a real attestation', async () => {
    expect(detailOf(await conform('summarize'), 'attestation')).toContain('characters');
  });

  it('finds every agent deterministic, as linkage requires', async () => {
    for (const agent of ['audit', 'summarize', 'score', 'publish']) {
      const report = await conform(agent);
      expect(report.results.find((r) => r.id === 'determinism')?.passed, agent).toBe(true);
    }
  });
});

describe('the agents that misbehave on purpose', () => {
  it('rejects always-fails, and names invocation as the reason', async () => {
    const report = await conform('always-fails');

    expect(report.conformant).toBe(false);
    // Precision matters here. It must not be rejected for a bad error shape —
    // its error shape is exemplary. It is rejected because it cannot answer.
    expect(failed(report).map((f) => f.split(':')[0])).toEqual(['invoke']);
    expect(detailOf(report, 'invoke')).toContain('422');
    expect(report.results.find((r) => r.id === 'error-shape')?.passed).toBe(true);
    expect(report.results.find((r) => r.id === 'error-retryable')?.passed).toBe(true);
  });

  it('warns that always-fails publishes a schema nothing can be built from', async () => {
    const report = await conform('always-fails');
    const golden = report.results.find((r) => r.id === 'golden-input');
    expect(golden).toMatchObject({ passed: false, severity: 'warn' });
  });

  it('accepts never-attests: not attesting is a limitation, not a defect', async () => {
    const report = await conform('never-attests');

    // §7.7 handles this agent by anchoring status 3 when a step requires an
    // attestation. That is the executor's job, and it presupposes the agent is
    // composable — so rejecting it here would be wrong.
    expect(failed(report)).toEqual([]);
    expect(report.conformant).toBe(true);
    expect(detailOf(report, 'attestation')).toContain('does not attest');
  });
});

describe('the suite against things that are not agents', () => {
  it('fails cleanly on a path with no agent behind it', async () => {
    const endpoint = `${base}/agents/does-not-exist`;
    const report = await runConformance({ endpoint, probe: createHttpProbe(endpoint, 5_000) });

    expect(report.conformant).toBe(false);
    expect(detailOf(report, 'health')).toContain('unknown-agent');
  });

  it('fails cleanly on a closed port rather than throwing', async () => {
    // Port 1 is reserved and nothing listens on it.
    const endpoint = 'http://127.0.0.1:1/agents/nobody';
    const report = await runConformance({ endpoint, probe: createHttpProbe(endpoint, 3_000) });

    expect(report.conformant).toBe(false);
    expect(report.results.length).toBeGreaterThan(0);
  });
});

describe('reporting', () => {
  it('renders a report naming the endpoint and every check', async () => {
    const report = await conform('audit');
    const text = renderReport(report, { colour: false });

    expect(text).toContain(report.endpoint);
    expect(text).toContain('CONFORMANT');
    for (const result of report.results) expect(text).toContain(result.title);
    // No escape codes when colour is off, so CI logs stay readable.
    expect(text).not.toContain('\x1b[');
  });

  it('says NOT CONFORMANT for a failing agent', async () => {
    const text = renderReport(await conform('always-fails'), { colour: false });
    expect(text).toContain('NOT CONFORMANT');
  });

  it('emits JSON that parses and carries the verdict', async () => {
    const parsed = JSON.parse(renderJson(await conform('audit'))) as {
      conformant: boolean;
      failures: number;
      checks: { id: string; result: string }[];
    };

    expect(parsed.conformant).toBe(true);
    expect(parsed.failures).toBe(0);
    expect(parsed.checks.every((c) => ['pass', 'fail', 'warn'].includes(c.result))).toBe(true);
  });
});

describe('joinEndpoint', () => {
  it('preserves a mount prefix', () => {
    // `new URL('/health', base)` would discard /agents/audit and probe the
    // server root, which is how a suite reports a conformant agent as broken.
    expect(joinEndpoint('http://h/agents/audit', 'health')).toBe('http://h/agents/audit/health');
    expect(joinEndpoint('http://h/agents/audit/', '/health')).toBe('http://h/agents/audit/health');
    expect(joinEndpoint('http://h', 'invoke')).toBe('http://h/invoke');
  });
});
