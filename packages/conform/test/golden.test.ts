import { describe, expect, it } from 'vitest';
import { goldenInput, synthesise } from '../src/golden.js';

describe('synthesise', () => {
  it('prefers what the agent supplied over anything invented', () => {
    // const > default > example > enum > type. Each layer is closer to the
    // agent's own intent than the one below it.
    expect(synthesise({ type: 'string', const: 'fixed' })).toEqual({ kind: 'value', value: 'fixed' });
    expect(synthesise({ type: 'string', default: 'd', example: 'e' })).toEqual({
      kind: 'value',
      value: 'd',
    });
    expect(synthesise({ type: 'string', example: 'e', enum: ['a'] })).toEqual({
      kind: 'value',
      value: 'e',
    });
    expect(synthesise({ type: 'string', examples: ['x', 'y'] })).toEqual({ kind: 'value', value: 'x' });
    expect(synthesise({ type: 'string', enum: ['a', 'b'] })).toEqual({ kind: 'value', value: 'a' });
  });

  it('builds a value for each scalar type', () => {
    expect(synthesise({ type: 'string' })).toMatchObject({ kind: 'value' });
    expect(synthesise({ type: 'number' })).toEqual({ kind: 'value', value: 1.5 });
    expect(synthesise({ type: 'integer' })).toEqual({ kind: 'value', value: 1 });
    expect(synthesise({ type: 'boolean' })).toEqual({ kind: 'value', value: true });
    expect(synthesise({ type: 'null' })).toEqual({ kind: 'value', value: null });
  });

  it('respects numeric bounds rather than emitting an out-of-range value', () => {
    expect(synthesise({ type: 'integer', minimum: 10 })).toEqual({ kind: 'value', value: 10 });
    expect(synthesise({ type: 'integer', maximum: -5 })).toEqual({ kind: 'value', value: -5 });
    expect(synthesise({ type: 'number', minimum: 100, maximum: 200 })).toEqual({
      kind: 'value',
      value: 100,
    });
  });

  it('pads a string to minLength', () => {
    const result = synthesise({ type: 'string', minLength: 40 });
    expect(result.kind).toBe('value');
    expect((result as { value: string }).value.length).toBeGreaterThanOrEqual(40);
  });

  it('uses a format-appropriate sample so realistic parsing is exercised', () => {
    // An agent that parses its input with new URL() would pass against
    // "conformance-probe" only by accident.
    expect(synthesise({ type: 'string', format: 'uri' })).toEqual({
      kind: 'value',
      value: 'https://example.test/conformance',
    });
    expect(synthesise({ type: 'string', format: 'date' })).toEqual({
      kind: 'value',
      value: '2026-01-01',
    });
  });

  it('builds arrays honouring minItems', () => {
    expect(synthesise({ type: 'array', items: { type: 'integer' } })).toEqual({
      kind: 'value',
      value: [1],
    });
    expect(synthesise({ type: 'array', items: { type: 'boolean' }, minItems: 3 })).toEqual({
      kind: 'value',
      value: [true, true, true],
    });
    expect(synthesise({ type: 'array' })).toEqual({ kind: 'value', value: [] });
  });

  it('builds only the required properties of an object', () => {
    const result = synthesise({
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'string' }, b: { type: 'number' } },
    });
    // Sending optional fields the agent did not ask for would test the agent's
    // tolerance for noise, not its declared contract.
    expect(result).toEqual({ kind: 'value', value: { a: 'conformance-probe' } });
  });

  it('treats every property as required when the schema says nothing', () => {
    expect(
      synthesise({ type: 'object', properties: { a: { type: 'boolean' }, b: { type: 'integer' } } }),
    ).toEqual({ kind: 'value', value: { a: true, b: 1 } });
  });

  it('recurses into nested objects and arrays of objects', () => {
    expect(
      synthesise({
        type: 'object',
        properties: {
          outer: {
            type: 'object',
            properties: { inner: { type: 'array', items: { type: 'string', const: 'z' } } },
          },
        },
      }),
    ).toEqual({ kind: 'value', value: { outer: { inner: ['z'] } } });
  });

  it('infers an object when properties are present but type is not', () => {
    expect(synthesise({ properties: { a: { type: 'boolean' } } })).toEqual({
      kind: 'value',
      value: { a: true },
    });
  });

  it('picks the non-null member of a union type', () => {
    expect(synthesise({ type: ['null', 'integer'] })).toEqual({ kind: 'value', value: 1 });
  });

  it('reports opacity rather than guessing', () => {
    expect(synthesise({ type: 'object' })).toMatchObject({ kind: 'opaque' });
    expect(synthesise({})).toMatchObject({ kind: 'opaque' });
    expect(synthesise('not a schema')).toMatchObject({ kind: 'opaque' });
    expect(synthesise({ type: 'object', properties: {} })).toMatchObject({ kind: 'opaque' });
  });

  it('names the required property it could not construct', () => {
    const result = synthesise({
      type: 'object',
      required: ['weird'],
      properties: { weird: { type: 'object' } },
    });
    expect(result).toMatchObject({ kind: 'opaque' });
    expect((result as { reason: string }).reason).toContain('"weird"');
  });
});

describe('goldenInput', () => {
  it('returns the constructed object and no opacity note', () => {
    expect(
      goldenInput({
        type: 'object',
        required: ['repo'],
        properties: { repo: { type: 'string' } },
      }),
    ).toEqual({ input: { repo: 'conformance-probe' }, opaque: null });
  });

  it('falls back to {} with a stated reason when the schema constrains nothing', () => {
    const result = goldenInput({ type: 'object' });
    expect(result.input).toEqual({});
    expect(result.opaque).toContain('no properties');
  });

  it('refuses a schema that does not describe an object', () => {
    // /invoke takes an input object; a schema declaring a bare string cannot
    // be the input schema whatever else it says.
    expect(goldenInput({ type: 'string' }).opaque).toContain('does not describe an object');
  });
});
