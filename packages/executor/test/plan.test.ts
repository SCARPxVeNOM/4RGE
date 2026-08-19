import { describe, expect, test } from 'vitest';
import { planFlow, PlanError, type FlowSpec } from '../src/plan.js';

/**
 * §5.1: "Unresolvable references fail validation before execution begins."
 *
 * Everything here is about failing early. A flow that is going to break should
 * break before it spends gas, before it calls an agent, and before it anchors
 * a receipt that will never verify.
 */

const AUDIT_SUMMARIZE_PUBLISH: FlowSpec = {
  version: '0gflow/1',
  name: 'audit-summarize-publish',
  inputs: { repoUrl: { type: 'string' } },
  steps: [
    { id: 'audit', agent: '1', input: { repo: '{{ inputs.repoUrl }}' } },
    { id: 'summarize', agent: '1', needs: ['audit'], input: { text: '{{ steps.audit.output.report }}' } },
    { id: 'score', agent: '1', needs: ['audit'], input: { report: '{{ steps.audit.output.report }}' } },
    {
      id: 'publish',
      agent: '1',
      needs: ['summarize', 'score'],
      input: { body: '{{ steps.summarize.output.text }}', grade: '{{ steps.score.output.value }}' },
    },
  ],
  outputs: { url: '{{ steps.publish.output.url }}' },
};

describe('planning the reference flow', () => {
  test('assigns stepIndex in declaration order', () => {
    // The verifier folds the chain root by stepIndex, so declaration order is
    // load-bearing and must not depend on the topological sort.
    const plan = planFlow(AUDIT_SUMMARIZE_PUBLISH);
    expect(plan.steps.map((s) => [s.id, s.stepIndex])).toStrictEqual([
      ['audit', 0],
      ['summarize', 1],
      ['score', 2],
      ['publish', 3],
    ]);
  });

  test('groups independent steps into the same wave', () => {
    const plan = planFlow(AUDIT_SUMMARIZE_PUBLISH);
    expect(plan.waves.map((w) => w.map((s) => s.id))).toStrictEqual([
      ['audit'],
      ['summarize', 'score'],
      ['publish'],
    ]);
  });

  test('reports the flow as having a parallel branch', () => {
    expect(planFlow(AUDIT_SUMMARIZE_PUBLISH).maxParallelism).toBe(2);
  });

  test('records the dependencies each step actually reads', () => {
    const plan = planFlow(AUDIT_SUMMARIZE_PUBLISH);
    expect(plan.steps[3]!.reads.sort()).toStrictEqual(['score', 'summarize']);
  });
});

describe('a linear flow', () => {
  const linear: FlowSpec = {
    version: '0gflow/1',
    name: 'linear',
    inputs: { x: { type: 'string' } },
    steps: [
      { id: 'a', agent: '1', input: { v: '{{ inputs.x }}' } },
      { id: 'b', agent: '1', needs: ['a'], input: { v: '{{ steps.a.output.v }}' } },
    ],
  };

  test('produces one step per wave', () => {
    expect(planFlow(linear).waves.map((w) => w.length)).toStrictEqual([1, 1]);
    expect(planFlow(linear).maxParallelism).toBe(1);
  });
});

describe('structural rejection', () => {
  const base = AUDIT_SUMMARIZE_PUBLISH;
  const withSteps = (steps: FlowSpec['steps']): FlowSpec => ({ ...base, steps });

  test('rejects duplicate step ids', () => {
    expect(() =>
      planFlow(
        withSteps([
          { id: 'a', agent: '1', input: {} },
          { id: 'a', agent: '1', input: {} },
        ]),
      ),
    ).toThrow(/duplicate/i);
  });

  test('rejects a needs entry naming an unknown step', () => {
    expect(() =>
      planFlow(withSteps([{ id: 'a', agent: '1', needs: ['ghost'], input: {} }])),
    ).toThrow(/unknown step "ghost"/i);
  });

  test('rejects a cycle', () => {
    expect(() =>
      planFlow(
        withSteps([
          { id: 'a', agent: '1', needs: ['b'], input: {} },
          { id: 'b', agent: '1', needs: ['a'], input: {} },
        ]),
      ),
    ).toThrow(/cycle/i);
  });

  test('rejects a step that depends on itself', () => {
    expect(() =>
      planFlow(withSteps([{ id: 'a', agent: '1', needs: ['a'], input: {} }])),
    ).toThrow(/cycle|itself/i);
  });

  test('rejects an empty flow', () => {
    expect(() => planFlow(withSteps([]))).toThrow(/at least one step/i);
  });

  test('rejects a step with no id', () => {
    expect(() => planFlow(withSteps([{ id: '', agent: '1', input: {} }]))).toThrow(/id/i);
  });
});

describe('reference validation before execution', () => {
  const withSteps = (steps: FlowSpec['steps']): FlowSpec => ({
    ...AUDIT_SUMMARIZE_PUBLISH,
    steps,
  });

  test('rejects an input reading a step it did not declare in needs', () => {
    // The planner would otherwise schedule it before its data exists.
    expect(() =>
      planFlow(
        withSteps([
          { id: 'a', agent: '1', input: {} },
          { id: 'b', agent: '1', input: { v: '{{ steps.a.output.v }}' } },
        ]),
      ),
    ).toThrow(/does not declare .*needs/i);
  });

  test('rejects a reference to an input the flow does not declare', () => {
    expect(() =>
      planFlow(withSteps([{ id: 'a', agent: '1', input: { v: '{{ inputs.absent }}' } }])),
    ).toThrow(/inputs\.absent|not declared/i);
  });

  test('rejects a forward reference even when declared in needs', () => {
    expect(() =>
      planFlow(
        withSteps([
          { id: 'a', agent: '1', needs: ['b'], input: { v: '{{ steps.b.output.v }}' } },
          { id: 'b', agent: '1', input: {} },
        ]),
      ),
    ).toThrow(/cycle|before|order/i);
  });

  test('rejects a malformed template rather than failing at run time', () => {
    expect(() =>
      planFlow(withSteps([{ id: 'a', agent: '1', input: { v: '{{ 1 + 1 }}' } }])),
    ).toThrow();
  });

  test('rejects a reference to a step output that is not "output"', () => {
    expect(() =>
      planFlow(
        withSteps([
          { id: 'a', agent: '1', input: {} },
          { id: 'b', agent: '1', needs: ['a'], input: { v: '{{ steps.a.input.v }}' } },
        ]),
      ),
    ).toThrow();
  });

  test('accepts a declared need that is not read, as an ordering constraint', () => {
    // Depending on a step for sequencing without consuming its output is
    // legitimate; only the reverse is an error.
    const plan = planFlow(
      withSteps([
        { id: 'a', agent: '1', input: {} },
        { id: 'b', agent: '1', needs: ['a'], input: { v: 'literal' } },
      ]),
    );
    expect(plan.waves.map((w) => w.map((s) => s.id))).toStrictEqual([['a'], ['b']]);
    expect(plan.steps[1]!.reads).toStrictEqual([]);
  });
});

describe('flow identity', () => {
  test('flowId is keccak256 of the canonical spec', async () => {
    const { canonicalize, keccak256 } = await import('@0gflow/core');
    const plan = planFlow(AUDIT_SUMMARIZE_PUBLISH);
    expect(plan.flowId).toBe(
      keccak256(new TextEncoder().encode(canonicalize(AUDIT_SUMMARIZE_PUBLISH as never))),
    );
  });

  test('is stable across key reordering of the spec', () => {
    const reordered: FlowSpec = {
      name: AUDIT_SUMMARIZE_PUBLISH.name,
      version: AUDIT_SUMMARIZE_PUBLISH.version,
      outputs: AUDIT_SUMMARIZE_PUBLISH.outputs,
      inputs: AUDIT_SUMMARIZE_PUBLISH.inputs,
      steps: AUDIT_SUMMARIZE_PUBLISH.steps,
    };
    expect(planFlow(reordered).flowId).toBe(planFlow(AUDIT_SUMMARIZE_PUBLISH).flowId);
  });

  test('changes when any step changes', () => {
    const tweaked: FlowSpec = {
      ...AUDIT_SUMMARIZE_PUBLISH,
      steps: AUDIT_SUMMARIZE_PUBLISH.steps.map((s) =>
        s.id === 'audit' ? { ...s, input: { repo: '{{ inputs.repoUrl }}', extra: 1 } } : s,
      ),
    };
    expect(planFlow(tweaked).flowId).not.toBe(planFlow(AUDIT_SUMMARIZE_PUBLISH).flowId);
  });
});

describe('PlanError', () => {
  test('names the offending step', () => {
    try {
      planFlow({
        ...AUDIT_SUMMARIZE_PUBLISH,
        steps: [{ id: 'broken', agent: '1', needs: ['ghost'], input: {} }],
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PlanError);
      expect((error as PlanError).message).toMatch(/broken/);
    }
  });
});
