/**
 * Reference agents — spec §6.1.
 *
 * Each implements the HTTP adapter contract: POST /invoke, GET /schema,
 * GET /health. They are deliberately boring and deterministic, because their
 * job is to make the *executor's* behaviour observable, not to be clever.
 *
 * Two of them misbehave on purpose. §11 requires the failure and unattested
 * paths to produce correct statuses, and the only honest way to demonstrate
 * that is with an agent that genuinely fails and one that genuinely declines
 * to attest — not with a flag that makes the executor pretend.
 */

import type { JsonValue } from '@0gflow/core';

export interface AgentError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface AgentResult {
  readonly output?: JsonValue;
  readonly attestation?: string | null;
  readonly error?: AgentError;
  /** HTTP status to answer with; defaults to 200, or 500 when error is set. */
  readonly status?: number;
}

export interface Agent {
  readonly id: string;
  /** ERC-721 token id of this agent's identity. */
  readonly agentId: string;
  readonly description: string;
  readonly schema: { input: JsonValue; output: JsonValue };
  invoke(input: Record<string, JsonValue>): AgentResult;
}

const str = (v: JsonValue | undefined, field: string): string => {
  if (typeof v !== 'string') throw new Error(`"${field}" must be a string`);
  return v;
};

/**
 * A fabricated attestation. It is deliberately NOT a real TEE quote: a real
 * one requires 0G Compute (§6.3), and dressing an HTTP agent's response up as
 * hardware-attested would be exactly the kind of claim §1.3 forbids. The
 * executor still hashes the raw bytes, so the attestationRef path is genuinely
 * exercised — it just attests provenance from this agent, not from an enclave.
 */
function selfAttestation(agentId: string, output: JsonValue): string {
  return Buffer.from(
    JSON.stringify({ kind: 'reference-agent-self-signed', agentId, output }),
  ).toString('base64');
}

export const AGENTS: Agent[] = [
  {
    id: 'audit',
    agentId: '1',
    description: 'Reads a repository URL and reports findings.',
    schema: {
      input: { type: 'object', required: ['repo'], properties: { repo: { type: 'string' } } },
      output: {
        type: 'object',
        required: ['report', 'severity'],
        properties: { report: { type: 'string' }, severity: { type: 'string' } },
      },
    },
    invoke(input) {
      const repo = str(input['repo'], 'repo');
      // Deterministic: the same repo must always give the same output, or the
      // run is not reproducible and linkage means nothing.
      const findings = repo.length % 3;
      return {
        output: {
          report: findings === 0 ? 'no critical findings' : `${findings} issues requiring review`,
          severity: findings === 0 ? 'info' : 'medium',
          repo,
        },
      };
    },
  },
  {
    id: 'summarize',
    agentId: '1',
    description: 'Summarises a report. Returns a self-signed attestation.',
    schema: {
      input: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
      output: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    },
    invoke(input) {
      const text = str(input['text'], 'text');
      const output = { text: `Summary: ${text}.`, words: text.split(/\s+/).length };
      return { output, attestation: selfAttestation('1', output) };
    },
  },
  {
    id: 'score',
    agentId: '1',
    description: 'Grades a report out of 100.',
    schema: {
      input: { type: 'object', required: ['report'], properties: { report: { type: 'string' } } },
      output: { type: 'object', required: ['value'], properties: { value: { type: 'number' } } },
    },
    invoke(input) {
      const report = str(input['report'], 'report');
      return { output: { value: report.includes('no critical') ? 95 : 60, basis: report.length } };
    },
  },
  {
    id: 'publish',
    agentId: '1',
    description: 'Publishes a body and grade, returning a URL.',
    schema: {
      input: {
        type: 'object',
        required: ['body', 'grade'],
        properties: { body: { type: 'string' }, grade: { type: 'number' } },
      },
      output: { type: 'object', required: ['url'], properties: { url: { type: 'string' } } },
    },
    invoke(input) {
      const body = str(input['body'], 'body');
      const grade = input['grade'];
      if (typeof grade !== 'number') throw new Error('"grade" must be a number');
      const slug = Buffer.from(body).toString('hex').slice(0, 12);
      return { output: { url: `https://reports.example.test/${slug}`, grade } };
    },
  },

  // --- agents that misbehave on purpose ---------------------------------

  {
    id: 'always-fails',
    agentId: '1',
    description: 'Always returns a non-retryable error. Exercises the failure path.',
    schema: { input: { type: 'object' }, output: { type: 'object' } },
    invoke() {
      return {
        status: 422,
        error: {
          code: 'unprocessable',
          message: 'this agent fails deliberately, to exercise the failure path',
          // Not retryable: the executor must not spend four attempts learning
          // what the first one said.
          retryable: false,
        },
      };
    },
  },
  {
    id: 'never-attests',
    agentId: '1',
    description: 'Succeeds but returns no attestation. Exercises the unattested path.',
    schema: {
      input: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
      output: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
    },
    invoke(input) {
      const text = str(input['text'], 'text');
      // A perfectly good answer with no proof of who produced it. A step that
      // required an attestation must record status 3, never 0.
      return { output: { text: `Unverified summary: ${text}.` }, attestation: null };
    },
  },
];

export const AGENTS_BY_ID = new Map(AGENTS.map((a) => [a.id, a]));
