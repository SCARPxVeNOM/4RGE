/**
 * Validating input against a published schema — §7 step 3.
 *
 * The most important behaviour here is not what it rejects, it is what it
 * admits to not checking. A validator that silently ignores a keyword reports
 * "valid" for input the schema author believed was constrained, and the
 * executor would then invoke an agent with data that does not satisfy the
 * contract it published. `unsupportedKeywords` is how that stays visible.
 */

import { describe, expect, test } from 'vitest';
import { describeSchemaProblems, validateAgainstSchema } from '../src/schema.js';
import type { JsonValue } from '../src/canonicalize.js';

const AGENT_SCHEMA: JsonValue = {
  type: 'object',
  required: ['repo'],
  properties: {
    repo: { type: 'string' },
    depth: { type: 'integer' },
    tags: { type: 'array', items: { type: 'string' } },
    mode: { enum: ['fast', 'thorough'] },
  },
};

describe('accepting valid input', () => {
  test('a value satisfying every declared property', () => {
    const check = validateAgainstSchema(
      { repo: 'https://example.test/r', depth: 2, tags: ['a', 'b'], mode: 'fast' },
      AGENT_SCHEMA,
    );
    expect(check.valid).toBe(true);
    expect(check.problems).toEqual([]);
  });

  test('optional properties may be absent', () => {
    expect(validateAgainstSchema({ repo: 'x' }, AGENT_SCHEMA).valid).toBe(true);
  });

  /// `true` and `{}` both mean "no constraints" in JSON Schema. Refusing them
  /// would reject agents that legitimately take free-form input.
  test.each([[{}], [true], ['not a schema at all']])('an empty schema accepts anything', (schema) => {
    expect(validateAgainstSchema({ anything: [1, 2] }, schema as JsonValue).valid).toBe(true);
  });

  /// An integer satisfies `number`; that is the one widening JSON Schema has.
  test('an integer satisfies number', () => {
    expect(validateAgainstSchema(3, { type: 'number' }).valid).toBe(true);
  });

  test('but a fractional number does not satisfy integer', () => {
    const check = validateAgainstSchema(3.5, { type: 'integer' });
    expect(check.valid).toBe(false);
    expect(check.problems[0]?.message).toMatch(/expected integer, got number/);
  });
});

describe('rejecting invalid input', () => {
  test('a missing required property, named by path', () => {
    const check = validateAgainstSchema({ depth: 1 }, AGENT_SCHEMA);
    expect(check.valid).toBe(false);
    expect(check.problems).toContainEqual({ path: '$.repo', message: 'is required but missing' });
  });

  test('a property of the wrong type', () => {
    const check = validateAgainstSchema({ repo: 42 }, AGENT_SCHEMA);
    expect(check.valid).toBe(false);
    expect(check.problems[0]).toEqual({ path: '$.repo', message: 'expected string, got integer' });
  });

  test('an array element of the wrong type, with its index', () => {
    const check = validateAgainstSchema({ repo: 'x', tags: ['a', 7] }, AGENT_SCHEMA);
    expect(check.valid).toBe(false);
    expect(check.problems[0]?.path).toBe('$.tags[1]');
  });

  test('a value outside an enum', () => {
    const check = validateAgainstSchema({ repo: 'x', mode: 'sideways' }, AGENT_SCHEMA);
    expect(check.valid).toBe(false);
    expect(check.problems[0]?.message).toMatch(/not one of the permitted values/);
  });

  test('null is not an object', () => {
    expect(validateAgainstSchema(null, { type: 'object' }).valid).toBe(false);
  });

  /// An array is not a malformed object, so reporting every missing property
  /// of a thing that was never an object is noise.
  test('a type mismatch stops further complaints about the same value', () => {
    const check = validateAgainstSchema([1, 2, 3], AGENT_SCHEMA);
    expect(check.problems).toHaveLength(1);
    expect(check.problems[0]?.message).toMatch(/expected object, got array/);
  });

  test('additionalProperties: false refuses what the schema does not name', () => {
    const strict: JsonValue = {
      type: 'object',
      properties: { a: { type: 'string' } },
      additionalProperties: false,
    };
    const check = validateAgainstSchema({ a: 'x', b: 'y' }, strict);
    expect(check.valid).toBe(false);
    expect(check.problems[0]?.path).toBe('$.b');
  });

  /// Without it, an agent declaring `properties` would silently forbid extra
  /// keys — the opposite of what JSON Schema means.
  test('extra properties are allowed by default', () => {
    expect(validateAgainstSchema({ repo: 'x', extra: 1 }, AGENT_SCHEMA).valid).toBe(true);
  });

  test('nested objects are validated by path', () => {
    const nested: JsonValue = {
      type: 'object',
      properties: { outer: { type: 'object', required: ['inner'], properties: { inner: { type: 'string' } } } },
    };
    const check = validateAgainstSchema({ outer: { inner: 5 } }, nested);
    expect(check.problems[0]?.path).toBe('$.outer.inner');
  });
});

describe('what it does not enforce, it says', () => {
  /// The whole reason this field exists. Reporting a clean pass for a schema
  /// full of constraints nobody checked would be worse than not validating.
  test('unsupported keywords are reported rather than ignored', () => {
    const check = validateAgainstSchema(
      { repo: 'x' },
      { type: 'object', properties: { repo: { type: 'string', pattern: '^https://' } } },
    );
    expect(check.valid).toBe(true);
    expect(check.unsupportedKeywords).toContain('pattern');
  });

  test('they are collected from nested schemas too', () => {
    const check = validateAgainstSchema(
      { a: [1] },
      { type: 'object', properties: { a: { type: 'array', items: { type: 'integer', minimum: 5 } } } },
    );
    expect(check.unsupportedKeywords).toContain('minimum');
  });

  test('annotations are not reported, because they constrain nothing', () => {
    const check = validateAgainstSchema(
      { repo: 'x' },
      { type: 'object', title: 'Audit input', description: 'what to audit', properties: {} },
    );
    expect(check.unsupportedKeywords).toEqual([]);
  });

  test('a schema this validator fully understands reports none', () => {
    expect(validateAgainstSchema({ repo: 'x' }, AGENT_SCHEMA).unsupportedKeywords).toEqual([]);
  });
});

describe('the summary that lands in a receipt', () => {
  test('names the paths and truncates honestly', () => {
    const check = validateAgainstSchema(
      {},
      { type: 'object', required: ['a', 'b', 'c', 'd'] },
    );
    const summary = describeSchemaProblems(check);
    expect(summary).toMatch(/\$\.a is required but missing/);
    expect(summary).toMatch(/and 1 more/);
  });

  test('says nothing extra when everything fits', () => {
    const check = validateAgainstSchema({}, { type: 'object', required: ['a'] });
    expect(describeSchemaProblems(check)).toBe('$.a is required but missing');
  });
});
