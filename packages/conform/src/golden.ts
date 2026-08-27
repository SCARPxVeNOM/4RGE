/**
 * Golden input synthesis — spec §6.4, "golden-input invocation".
 *
 * The suite has to invoke the agent to learn anything, and it only knows what
 * the agent will accept from the schema the agent itself published at
 * /schema. So the golden input is derived from that schema rather than
 * configured: an agent whose declared schema cannot produce an input its own
 * /invoke accepts has a real defect, and that defect is exactly what §6.4 is
 * for. Composability means a *stranger* can build a call from your schema.
 *
 * Deliberately not a JSON Schema validator. It reads the subset that describes
 * a value concretely enough to construct one, and reports honestly when the
 * schema is too vague to construct from.
 */

import type { JsonValue } from '@0gflow/core';

export type Synthesised =
  | { readonly kind: 'value'; readonly value: JsonValue }
  /** The schema is well-formed but says nothing constructive. */
  | { readonly kind: 'opaque'; readonly reason: string };

interface Schema {
  readonly type?: string | string[];
  readonly properties?: Record<string, Schema>;
  readonly required?: string[];
  readonly items?: Schema;
  readonly enum?: JsonValue[];
  readonly const?: JsonValue;
  readonly default?: JsonValue;
  readonly examples?: JsonValue[];
  readonly example?: JsonValue;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly minItems?: number;
  readonly format?: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Values chosen to be plausible rather than minimal. A zero-length string
 * satisfies most schemas while exercising nothing, and an agent that only
 * breaks on realistic input would pass a suite built from empty values.
 */
const FORMAT_SAMPLES: Record<string, string> = {
  uri: 'https://example.test/conformance',
  url: 'https://example.test/conformance',
  'date-time': '2026-01-01T00:00:00Z',
  date: '2026-01-01',
  email: 'conformance@example.test',
  uuid: '00000000-0000-4000-8000-000000000000',
  hostname: 'example.test',
};

function sampleString(schema: Schema): string {
  const byFormat = schema.format === undefined ? undefined : FORMAT_SAMPLES[schema.format];
  const base = byFormat ?? 'conformance-probe';
  const min = schema.minLength ?? 0;
  return base.length >= min ? base : base.padEnd(min, 'x');
}

function sampleNumber(schema: Schema, integral: boolean): number {
  const low = schema.minimum;
  const high = schema.maximum;
  const candidate = integral ? 1 : 1.5;
  if (low !== undefined && candidate < low) return integral ? Math.ceil(low) : low;
  if (high !== undefined && candidate > high) return integral ? Math.floor(high) : high;
  return candidate;
}

function firstType(schema: Schema): string | undefined {
  const t = schema.type;
  if (Array.isArray(t)) return t.find((x) => x !== 'null') ?? t[0];
  return t;
}

/**
 * Builds one concrete value for a schema.
 *
 * Order of preference: `const`, then `default`, then a declared example, then
 * an `enum` member, then a value synthesised from `type`. Anything the agent
 * itself supplied beats anything invented here.
 */
export function synthesise(schemaValue: JsonValue): Synthesised {
  if (!isObject(schemaValue)) {
    return { kind: 'opaque', reason: 'schema is not an object' };
  }
  const schema = schemaValue as Schema;

  if (schema.const !== undefined) return { kind: 'value', value: schema.const };
  if (schema.default !== undefined) return { kind: 'value', value: schema.default };
  if (schema.example !== undefined) return { kind: 'value', value: schema.example };
  if (Array.isArray(schema.examples) && schema.examples.length > 0) {
    return { kind: 'value', value: schema.examples[0] as JsonValue };
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return { kind: 'value', value: schema.enum[0] as JsonValue };
  }

  switch (firstType(schema)) {
    case 'string':
      return { kind: 'value', value: sampleString(schema) };
    case 'number':
      return { kind: 'value', value: sampleNumber(schema, false) };
    case 'integer':
      return { kind: 'value', value: sampleNumber(schema, true) };
    case 'boolean':
      return { kind: 'value', value: true };
    case 'null':
      return { kind: 'value', value: null };
    case 'array': {
      if (schema.items === undefined) return { kind: 'value', value: [] };
      const item = synthesise(schema.items as unknown as JsonValue);
      if (item.kind === 'opaque') return { kind: 'value', value: [] };
      // One element unless the schema demands more; enough to exercise the
      // shape without inventing volume the agent never asked for.
      const count = Math.max(schema.minItems ?? 1, 1);
      return { kind: 'value', value: Array.from({ length: count }, () => item.value) };
    }
    case 'object':
      return synthesiseObject(schema);
    default:
      // No `type` but properties present is common enough to handle.
      return schema.properties === undefined
        ? { kind: 'opaque', reason: 'schema declares no type, const, default, example or enum' }
        : synthesiseObject(schema);
  }
}

function synthesiseObject(schema: Schema): Synthesised {
  const properties = schema.properties;
  if (properties === undefined || Object.keys(properties).length === 0) {
    // `{ "type": "object" }` accepts anything, so `{}` is a legitimate golden
    // input — but the caller is told the schema constrained nothing, because
    // a suite that "passed" against a schema this vague proved very little.
    return { kind: 'opaque', reason: 'object schema declares no properties' };
  }

  const out: Record<string, JsonValue> = {};
  const required = new Set(schema.required ?? Object.keys(properties));
  const unbuildable: string[] = [];

  for (const [name, sub] of Object.entries(properties)) {
    if (!required.has(name)) continue;
    const built = synthesise(sub as unknown as JsonValue);
    if (built.kind === 'opaque') unbuildable.push(name);
    else out[name] = built.value;
  }

  if (unbuildable.length > 0) {
    return {
      kind: 'opaque',
      reason: `required propert${unbuildable.length === 1 ? 'y' : 'ies'} ${unbuildable
        .map((n) => `"${n}"`)
        .join(', ')} cannot be constructed from the declared schema`,
    };
  }
  return { kind: 'value', value: out };
}

/** The golden input for an agent's declared input schema. */
export function goldenInput(
  inputSchema: JsonValue,
): { readonly input: Record<string, JsonValue>; readonly opaque: string | null } {
  const built = synthesise(inputSchema);
  if (built.kind === 'opaque') return { input: {}, opaque: built.reason };
  if (!isObject(built.value)) {
    return { input: {}, opaque: 'input schema does not describe an object' };
  }
  return { input: built.value as Record<string, JsonValue>, opaque: null };
}
