/**
 * Template resolution — spec §5.1.
 *
 * Templates resolve only against `inputs.*` and `steps.<id>.output.*`, over a
 * parsed object graph. There is no expression language here and there must
 * never be one: this code runs inside the executor and again inside the
 * verifier, and anything the two could evaluate differently becomes a run that
 * executes but cannot be verified.
 *
 * The resolver is deliberately loud. Every unresolvable reference throws
 * rather than yielding undefined, so a missing field fails validation before
 * execution instead of silently hashing a hole into the input.
 */

import { canonicalize, type JsonValue } from './canonicalize.js';

export class TemplateError extends Error {
  override readonly name = 'TemplateError';
  constructor(message: string, readonly location: string) {
    super(`${message}${location ? ` (at ${location})` : ''}`);
  }
}

export interface StepContext {
  readonly output: JsonValue;
}

export interface TemplateContext {
  readonly inputs: JsonValue;
  readonly steps: Readonly<Record<string, StepContext>>;
}

type Token = { kind: 'literal'; text: string } | { kind: 'expr'; expression: string };

const SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Splits a string into literal and `{{ … }}` tokens. Unbalanced delimiters are
 * an error rather than literal text: a stray `{{` almost always means a typo
 * in a reference, and treating it as a literal would hash the typo instead of
 * reporting it.
 */
function tokenize(input: string, location: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\{\{([^{}]*)\}\}/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(input)) !== null) {
    if (match.index > cursor) {
      tokens.push({ kind: 'literal', text: input.slice(cursor, match.index) });
    }
    tokens.push({ kind: 'expr', expression: match[1]! });
    cursor = pattern.lastIndex;
  }
  if (cursor < input.length) tokens.push({ kind: 'literal', text: input.slice(cursor) });

  for (const token of tokens) {
    if (token.kind === 'literal' && (token.text.includes('{{') || token.text.includes('}}'))) {
      throw new TemplateError(
        `unbalanced template delimiters in ${JSON.stringify(input)}`,
        location,
      );
    }
  }
  return tokens;
}

function parsePath(expression: string, location: string): string[] {
  const path = expression.trim().split('.');
  if (path.length < 2) {
    throw new TemplateError(`reference must name a path: {{ ${expression} }}`, location);
  }
  for (const segment of path) {
    if (!SEGMENT.test(segment)) {
      // Catches empty segments, spaces, operators and pipes — i.e. everything
      // that would be an expression rather than a path.
      throw new TemplateError(`not a valid reference path: {{ ${expression} }}`, location);
    }
  }
  return path;
}

/** Own-property traversal only: no prototype access, no method lookup. */
function traverse(root: JsonValue, path: readonly string[], expression: string, location: string) {
  let current: JsonValue = root;
  for (const segment of path) {
    if (current === null || typeof current !== 'object') {
      throw new TemplateError(
        `cannot read "${segment}" from a ${current === null ? 'null' : typeof current} value: {{ ${expression} }}`,
        location,
      );
    }
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) {
        throw new TemplateError(
          `array index expected, got "${segment}": {{ ${expression} }}`,
          location,
        );
      }
      const index = Number(segment);
      if (index >= current.length) {
        throw new TemplateError(
          `index ${index} out of range (length ${current.length}): {{ ${expression} }}`,
          location,
        );
      }
      current = current[index]!;
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) {
        throw new TemplateError(`no such field "${segment}": {{ ${expression} }}`, location);
      }
      current = (current as Record<string, JsonValue>)[segment]!;
    }
  }
  return current;
}

function resolveExpression(
  expression: string,
  context: TemplateContext,
  location: string,
): JsonValue {
  const path = parsePath(expression, location);
  const [root, ...rest] = path as [string, ...string[]];

  if (root === 'inputs') {
    return traverse(context.inputs, rest, expression, location);
  }
  if (root === 'steps') {
    const [stepId, outputKeyword, ...tail] = rest;
    if (stepId === undefined || outputKeyword === undefined) {
      throw new TemplateError(
        `step reference must be steps.<id>.output…: {{ ${expression} }}`,
        location,
      );
    }
    if (outputKeyword !== 'output') {
      // Only outputs are hashed into a receipt, so only outputs can carry
      // linkage. Reading a step's input or status would reference something no
      // verifier can re-derive.
      throw new TemplateError(
        `only step outputs are referenceable, not "${outputKeyword}": {{ ${expression} }}`,
        location,
      );
    }
    const step = context.steps[stepId];
    if (step === undefined) {
      throw new TemplateError(`unknown step "${stepId}": {{ ${expression} }}`, location);
    }
    return traverse(step.output, tail, expression, location);
  }

  throw new TemplateError(
    `unknown reference root "${root}": only inputs and steps are addressable`,
    location,
  );
}

/** Textual form used when a reference is embedded in surrounding text. */
function renderScalar(value: JsonValue, expression: string, location: string): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return canonicalize(value);
  }
  // No obvious textual form exists for a composite value, and silently picking
  // one would make the inputHash depend on that choice.
  throw new TemplateError(
    `cannot interpolate ${Array.isArray(value) ? 'an array' : 'an object'} into a string: {{ ${expression} }}`,
    location,
  );
}

function resolveString(input: string, context: TemplateContext, location: string): JsonValue {
  const tokens = tokenize(input, location);

  if (tokens.length === 0) return input;
  // A string that is exactly one reference yields the referenced value with
  // its type intact. Coercing it to text would change the canonical form and
  // break linkage against a correct upstream output.
  if (tokens.length === 1 && tokens[0]!.kind === 'expr') {
    return resolveExpression(tokens[0]!.expression, context, location);
  }

  let out = '';
  for (const token of tokens) {
    out +=
      token.kind === 'literal'
        ? token.text
        : renderScalar(
            resolveExpression(token.expression, context, location),
            token.expression,
            location,
          );
  }
  return out;
}

function resolve(value: JsonValue, context: TemplateContext, location: string): JsonValue {
  if (typeof value === 'string') return resolveString(value, context, location);
  if (Array.isArray(value)) {
    return value.map((item, i) => resolve(item, context, `${location}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key.includes('{{')) {
        // A templated key would let an upstream output rename fields and
        // change the shape of the canonical form.
        throw new TemplateError(`templates are not permitted in object keys: "${key}"`, location);
      }
      out[key] = resolve(child, context, location ? `${location}.${key}` : key);
    }
    return out;
  }
  return value;
}

/** Resolves every template in `value` against `context`. */
export function resolveTemplates(value: JsonValue, context: TemplateContext): JsonValue {
  return resolve(value, context, '');
}

/**
 * Step ids referenced anywhere in `value`. Used to check that a step's
 * declared `needs` actually covers what its input reads — an undeclared
 * dependency would let the planner schedule a step before its data exists.
 */
export function referencedSteps(value: JsonValue): string[] {
  const found = new Set<string>();

  const walk = (node: JsonValue, location: string): void => {
    if (typeof node === 'string') {
      for (const token of tokenize(node, location)) {
        if (token.kind !== 'expr') continue;
        const path = parsePath(token.expression, location);
        if (path[0] === 'steps') {
          const stepId = path[1];
          if (stepId === undefined) {
            throw new TemplateError(
              `step reference must name a step: {{ ${token.expression} }}`,
              location,
            );
          }
          found.add(stepId);
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${location}[${i}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        walk(child, location ? `${location}.${key}` : key);
      }
    }
  };

  walk(value, '');
  return [...found];
}
