import { describe, expect, test } from 'vitest';
import {
  resolveTemplates,
  referencedSteps,
  TemplateError,
  type TemplateContext,
} from '../src/template.js';

const ctx: TemplateContext = {
  inputs: { repoUrl: 'https://example.test/repo', depth: 3, flags: { deep: true } },
  steps: {
    audit: {
      output: {
        report: 'findings',
        score: 7,
        ratio: 0.5,
        ok: false,
        nothing: null,
        items: ['a', 'b'],
        nested: { deep: { value: 'found' } },
      },
    },
    score: { output: { value: 42 } },
  },
};

describe('whole-string references', () => {
  test('resolves an input reference', () => {
    expect(resolveTemplates('{{ inputs.repoUrl }}', ctx)).toBe('https://example.test/repo');
  });

  test('resolves a step output reference', () => {
    expect(resolveTemplates('{{ steps.audit.output.report }}', ctx)).toBe('findings');
  });

  test('preserves the referenced value type rather than stringifying it', () => {
    // Coercing 7 to "7" here would change the canonical form and therefore the
    // inputHash, breaking linkage against an otherwise correct upstream output.
    expect(resolveTemplates('{{ steps.audit.output.score }}', ctx)).toBe(7);
    expect(resolveTemplates('{{ steps.audit.output.ok }}', ctx)).toBe(false);
    expect(resolveTemplates('{{ steps.audit.output.nothing }}', ctx)).toBe(null);
    expect(resolveTemplates('{{ steps.audit.output.items }}', ctx)).toStrictEqual(['a', 'b']);
    expect(resolveTemplates('{{ inputs.flags }}', ctx)).toStrictEqual({ deep: true });
  });

  test('tolerates surrounding whitespace in the expression', () => {
    expect(resolveTemplates('{{inputs.repoUrl}}', ctx)).toBe('https://example.test/repo');
    expect(resolveTemplates('{{   inputs.repoUrl   }}', ctx)).toBe('https://example.test/repo');
  });

  test('traverses nested paths and array indices', () => {
    expect(resolveTemplates('{{ steps.audit.output.nested.deep.value }}', ctx)).toBe('found');
    expect(resolveTemplates('{{ steps.audit.output.items.1 }}', ctx)).toBe('b');
  });
});

describe('interpolation into surrounding text', () => {
  test('substitutes scalars inside a larger string', () => {
    expect(resolveTemplates('repo={{ inputs.repoUrl }} depth={{ inputs.depth }}', ctx)).toBe(
      'repo=https://example.test/repo depth=3',
    );
  });

  test('renders booleans and null in their JSON form', () => {
    expect(resolveTemplates('ok={{ steps.audit.output.ok }}', ctx)).toBe('ok=false');
    expect(resolveTemplates('n={{ steps.audit.output.nothing }}', ctx)).toBe('n=null');
  });

  test('renders numbers canonically', () => {
    expect(resolveTemplates('r={{ steps.audit.output.ratio }}', ctx)).toBe('r=0.5');
  });

  test('rejects interpolating an object or array into a string', () => {
    // There is no single obvious textual form for a composite value, and
    // picking one silently would make the inputHash depend on that choice.
    expect(() => resolveTemplates('x={{ steps.audit.output.items }}', ctx)).toThrow(TemplateError);
    expect(() => resolveTemplates('x={{ inputs.flags }}', ctx)).toThrow(TemplateError);
  });
});

describe('structural resolution', () => {
  test('resolves templates at any depth of an object graph', () => {
    const input = {
      body: '{{ steps.audit.output.report }}',
      meta: { grade: '{{ steps.score.output.value }}', list: ['{{ inputs.depth }}', 'literal'] },
    };
    expect(resolveTemplates(input, ctx)).toStrictEqual({
      body: 'findings',
      meta: { grade: 42, list: [3, 'literal'] },
    });
  });

  test('leaves non-template values untouched', () => {
    const input = { a: 1, b: 'plain', c: [true, null], d: {} };
    expect(resolveTemplates(input, ctx)).toStrictEqual(input);
  });

  test('rejects templates in object keys', () => {
    // Templated keys would let an upstream output rename fields and change the
    // shape of the canonical form.
    expect(() => resolveTemplates({ '{{ inputs.depth }}': 1 }, ctx)).toThrow(TemplateError);
  });
});

describe('rejected references', () => {
  test('rejects an unknown root namespace', () => {
    expect(() => resolveTemplates('{{ env.SECRET }}', ctx)).toThrow(TemplateError);
    expect(() => resolveTemplates('{{ process.env.HOME }}', ctx)).toThrow(TemplateError);
  });

  test('rejects reading anything but output from a step', () => {
    // Only declared outputs are hashed into a receipt, so only outputs can
    // carry linkage.
    expect(() => resolveTemplates('{{ steps.audit.input.repo }}', ctx)).toThrow(TemplateError);
    expect(() => resolveTemplates('{{ steps.audit.status }}', ctx)).toThrow(TemplateError);
  });

  test('rejects an unknown step id', () => {
    expect(() => resolveTemplates('{{ steps.missing.output.x }}', ctx)).toThrow(TemplateError);
  });

  test('rejects a missing path rather than resolving to undefined', () => {
    expect(() => resolveTemplates('{{ inputs.absent }}', ctx)).toThrow(TemplateError);
    expect(() => resolveTemplates('{{ steps.audit.output.absent }}', ctx)).toThrow(TemplateError);
    expect(() => resolveTemplates('{{ steps.audit.output.items.9 }}', ctx)).toThrow(TemplateError);
  });

  test('rejects traversing into a scalar', () => {
    expect(() => resolveTemplates('{{ steps.audit.output.report.length }}', ctx)).toThrow(
      TemplateError,
    );
  });

  test('rejects prototype-walking paths', () => {
    expect(() => resolveTemplates('{{ inputs.constructor }}', ctx)).toThrow(TemplateError);
    expect(() => resolveTemplates('{{ inputs.flags.__proto__ }}', ctx)).toThrow(TemplateError);
    expect(() => resolveTemplates('{{ inputs.repoUrl.toString }}', ctx)).toThrow(TemplateError);
  });

  test('rejects malformed expressions', () => {
    expect(() => resolveTemplates('{{ }}', ctx)).toThrow(TemplateError);
    expect(() => resolveTemplates('{{ inputs. }}', ctx)).toThrow(TemplateError);
    expect(() => resolveTemplates('{{ inputs..x }}', ctx)).toThrow(TemplateError);
    expect(() => resolveTemplates('{{ unterminated', ctx)).toThrow(TemplateError);
    expect(() => resolveTemplates('{{ a }} }}', ctx)).toThrow(TemplateError);
  });

  test('does not evaluate expressions', () => {
    // §5.1: no expression evaluation, no dynamic code paths. These are
    // rejected as malformed paths, never executed.
    expect(() => resolveTemplates('{{ 1 + 1 }}', ctx)).toThrow(TemplateError);
    expect(() => resolveTemplates('{{ inputs.depth | upper }}', ctx)).toThrow(TemplateError);
  });
});

describe('referencedSteps', () => {
  test('extracts step dependencies from a template graph', () => {
    const input = {
      body: '{{ steps.summarize.output.text }}',
      grade: '{{ steps.score.output.value }}',
      url: '{{ inputs.repoUrl }}',
    };
    expect(referencedSteps(input).sort()).toStrictEqual(['score', 'summarize']);
  });

  test('returns each step once regardless of reference count', () => {
    expect(referencedSteps(['{{ steps.a.output.x }}', '{{ steps.a.output.y }}'])).toStrictEqual([
      'a',
    ]);
  });

  test('returns nothing when only inputs are referenced', () => {
    expect(referencedSteps({ a: '{{ inputs.x }}' })).toStrictEqual([]);
  });

  test('rejects a step reference that does not read output', () => {
    // §5.1 requires unresolvable references to fail validation before
    // execution. Collecting the step id without checking the keyword would
    // defer this to run time, after the flow has already started spending.
    expect(() => referencedSteps({ a: '{{ steps.x.input.v }}' })).toThrow(TemplateError);
    expect(() => referencedSteps({ a: '{{ steps.x.status }}' })).toThrow(TemplateError);
  });

  test('rejects a malformed reference rather than ignoring it', () => {
    expect(() => referencedSteps({ a: '{{ 1 + 1 }}' })).toThrow(TemplateError);
    expect(() => referencedSteps({ a: '{{ unterminated' })).toThrow(TemplateError);
  });
});
