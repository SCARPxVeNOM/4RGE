/**
 * The flows used to demonstrate §11's Phase 3 gate.
 *
 * Three runs, because one success proves less than a success plus the two ways
 * a run is allowed to not succeed. §10.4 asks for a deliberately failed run
 * that is still sealed and verifiable, and §1.3 asks that a missing
 * attestation is recorded as `unattested` rather than quietly as `ok`.
 */

import type { FlowSpec } from '@0gflow/executor';
import type { JsonValue } from '@0gflow/core';

export interface Scenario {
  readonly key: string;
  readonly description: string;
  readonly spec: FlowSpec;
  readonly inputs: JsonValue;
  /** Maps each step to the reference agent that should serve it. */
  readonly agentFor: Readonly<Record<string, string>>;
  readonly expect: string;
}

/** audit → (summarize ‖ score) → publish. The parallel branch §11 asks for. */
const DIAMOND: FlowSpec = {
  version: '0gflow/1',
  name: 'audit-summarize-publish',
  inputs: { repoUrl: { type: 'string' } },
  steps: [
    { id: 'audit', agent: '1', input: { repo: '{{ inputs.repoUrl }}' } },
    {
      id: 'summarize',
      agent: '1',
      needs: ['audit'],
      input: { text: '{{ steps.audit.output.report }}' },
    },
    {
      id: 'score',
      agent: '1',
      needs: ['audit'],
      input: { report: '{{ steps.audit.output.report }}' },
    },
    {
      id: 'publish',
      agent: '1',
      needs: ['summarize', 'score'],
      input: { body: '{{ steps.summarize.output.text }}', grade: '{{ steps.score.output.value }}' },
    },
  ],
  outputs: { url: '{{ steps.publish.output.url }}' },
};

/** The same shape, but `summarize` must be attested and its agent will not. */
const REQUIRES_ATTESTATION: FlowSpec = {
  version: '0gflow/1',
  name: 'audit-summarize-attested',
  inputs: { repoUrl: { type: 'string' } },
  steps: [
    { id: 'audit', agent: '1', input: { repo: '{{ inputs.repoUrl }}' } },
    {
      id: 'summarize',
      agent: '1',
      needs: ['audit'],
      requireAttestation: true,
      input: { text: '{{ steps.audit.output.report }}' },
    },
  ],
};

/** A middle step that always fails, with a downstream step behind it. */
const FAILING: FlowSpec = {
  version: '0gflow/1',
  name: 'audit-fail-publish',
  inputs: { repoUrl: { type: 'string' } },
  steps: [
    { id: 'audit', agent: '1', input: { repo: '{{ inputs.repoUrl }}' } },
    {
      id: 'review',
      agent: '1',
      needs: ['audit'],
      input: { text: '{{ steps.audit.output.report }}' },
    },
    {
      id: 'publish',
      agent: '1',
      needs: ['review'],
      input: { body: '{{ steps.review.output.text }}', grade: 1 },
    },
  ],
};

/**
 * A step whose attestation must actually cover its output.
 *
 * `requireBinding: 'bound'` is the strong form: an attestation that merely
 * exists, or that is signed by the right key over some *other* response, is
 * anchored status 3 rather than 0. Served by the 0G Compute agent, so the
 * signature comes from a live enclave.
 */
const REQUIRES_BINDING: FlowSpec = {
  version: '0gflow/1',
  name: 'audit-summarize-bound',
  inputs: { repoUrl: { type: 'string' } },
  steps: [
    { id: 'audit', agent: '1', input: { repo: '{{ inputs.repoUrl }}' } },
    {
      id: 'summarize',
      agent: '1',
      needs: ['audit'],
      requireAttestation: true,
      requireBinding: 'bound',
      // The enclave can be slow, and a retry needs fresh billing headers.
      timeoutMs: 120_000,
      input: { text: '{{ steps.audit.output.report }}' },
    },
  ],
};

const INPUTS: JsonValue = { repoUrl: 'https://github.com/0glabs/0g-chain' };

export const SCENARIOS: Scenario[] = [
  {
    key: 'success',
    description: 'four steps with a parallel branch; every step succeeds',
    spec: DIAMOND,
    inputs: INPUTS,
    agentFor: { audit: 'audit', summarize: 'summarize', score: 'score', publish: 'publish' },
    expect: 'all four steps ok, run sealed with outcome 0',
  },
  {
    key: 'unattested',
    description: 'a step requires an attestation and the agent does not provide one',
    spec: REQUIRES_ATTESTATION,
    inputs: INPUTS,
    agentFor: { audit: 'audit', summarize: 'never-attests' },
    expect: 'summarize anchored status 3 (unattested), never 0; run outcome 3',
  },
  {
    key: 'failure',
    description: 'a middle step fails; the step behind it is skipped',
    spec: FAILING,
    inputs: INPUTS,
    agentFor: { audit: 'audit', review: 'always-fails', publish: 'publish' },
    expect: 'review status 1 (failed), publish status 2 (skipped), run sealed with outcome 1',
  },
];

export const BOUND_SCENARIO: Scenario = {
  key: 'bound',
  description: 'a step requires its attestation to cover its output, served by a real enclave',
  spec: REQUIRES_BINDING,
  inputs: INPUTS,
  // 'tee' is served by @0gflow/tee-agent, not by the reference agents.
  agentFor: { audit: 'audit', summarize: 'tee' },
  expect: 'summarize anchored status 0 with binding level bound; run outcome 0',
};

/**
 * `bound` is registered but kept out of `SCENARIOS`, so `all` does not
 * silently spend on paid inference. Ask for it by name.
 */
export const SCENARIOS_BY_KEY = new Map(
  [...SCENARIOS, BOUND_SCENARIO].map((s) => [s.key, s]),
);
