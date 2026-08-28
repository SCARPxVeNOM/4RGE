/**
 * Validating a value against the JSON Schema an agent published — spec §7
 * step 3.
 *
 * WHY A HAND-WRITTEN ONE
 *
 * The same reason as sha256, keccak256 and secp256k1 (see hash.ts): core is
 * dependency-free so the verifier stays a single auditable file and the same
 * code runs in a browser. A full validator is a large dependency to inherit
 * for schemas that are, in practice, a handful of typed properties.
 *
 * WHAT IT ENFORCES
 *
 *   type        object · array · string · number · integer · boolean · null,
 *               and an array of those meaning "any of"
 *   required    named properties must be present
 *   properties  each present property is validated against its subschema
 *   items       every element of an array
 *   enum        the value must be one of the listed constants
 *   additionalProperties: false  refuses properties the schema does not name
 *
 * WHAT IT DOES NOT
 *
 * Everything else — `oneOf`, `$ref`, `pattern`, `minimum`, `format` and the
 * rest. This is the important part, and the reason `unsupportedKeywords`
 * exists: a validator that silently ignores a keyword it does not understand
 * reports "valid" for input the schema author believed was constrained. The
 * caller is told which keywords went unchecked so it can say so rather than
 * imply a guarantee that was never made.
 *
 * Validation is advisory in exactly one direction: it can reject, and it never
 * promises that an accepted value satisfies constructs listed as unsupported.
 */

import type { JsonValue } from './canonicalize.js';

export interface SchemaProblem {
  /** JSON-Pointer-ish path to the offending value, e.g. `$.repo`. */
  readonly path: string;
  readonly message: string;
}

export interface SchemaCheck {
  readonly valid: boolean;
  readonly problems: readonly SchemaProblem[];
  /**
   * Keywords present in the schema that this validator does not enforce.
   *
   * Not a failure — a caller may reasonably proceed — but it must not be
   * reported as a clean pass either.
   */
  readonly unsupportedKeywords: readonly string[];
}

const SUPPORTED = new Set([
  'type',
  'required',
  'properties',
  'items',
  'enum',
  'additionalProperties',
  // Annotations, which constrain nothing.
  'title',
  'description',
  'default',
  'examples',
  '$schema',
  '$id',
]);

const isObject = (v: unknown): v is Record<string, JsonValue> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

function typeOf(value: JsonValue): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** `integer` satisfies `number`; nothing else widens. */
function matchesType(value: JsonValue, expected: string): boolean {
  const actual = typeOf(value);
  if (actual === expected) return true;
  return expected === 'number' && actual === 'integer';
}

/**
 * Checks `value` against `schema`.
 *
 * A schema that is not an object accepts everything: `true` and `{}` are both
 * "no constraints" in JSON Schema, and refusing them would reject agents that
 * legitimately take free-form input.
 */
export function validateAgainstSchema(value: JsonValue, schema: JsonValue): SchemaCheck {
  const problems: SchemaProblem[] = [];
  const unsupported = new Set<string>();

  walk(value, schema, '$', problems, unsupported);

  return {
    valid: problems.length === 0,
    problems,
    unsupportedKeywords: [...unsupported].sort(),
  };
}

function walk(
  value: JsonValue,
  schema: JsonValue,
  path: string,
  problems: SchemaProblem[],
  unsupported: Set<string>,
): void {
  if (!isObject(schema)) return;

  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) unsupported.add(keyword);
  }

  // --- type ---------------------------------------------------------------
  const type = schema['type'];
  if (typeof type === 'string') {
    if (!matchesType(value, type)) {
      problems.push({ path, message: `expected ${type}, got ${typeOf(value)}` });
      // Further checks would be noise: an array is not a malformed object.
      return;
    }
  } else if (Array.isArray(type) && type.length > 0) {
    const options = type.filter((t): t is string => typeof t === 'string');
    if (options.length > 0 && !options.some((t) => matchesType(value, t))) {
      problems.push({
        path,
        message: `expected one of ${options.join(', ')}, got ${typeOf(value)}`,
      });
      return;
    }
  }

  // --- enum ---------------------------------------------------------------
  const allowed = schema['enum'];
  if (Array.isArray(allowed)) {
    // Compared by serialisation so objects and arrays work; the values here
    // are small by construction.
    const encoded = JSON.stringify(value);
    if (!allowed.some((option) => JSON.stringify(option) === encoded)) {
      problems.push({ path, message: `${encoded} is not one of the permitted values` });
    }
  }

  // --- objects ------------------------------------------------------------
  if (isObject(value)) {
    const required = schema['required'];
    if (Array.isArray(required)) {
      for (const key of required) {
        if (typeof key === 'string' && !(key in value)) {
          problems.push({ path: `${path}.${key}`, message: 'is required but missing' });
        }
      }
    }

    const properties = schema['properties'];
    if (isObject(properties)) {
      for (const [key, sub] of Object.entries(properties)) {
        if (key in value) walk(value[key]!, sub, `${path}.${key}`, problems, unsupported);
      }

      if (schema['additionalProperties'] === false) {
        for (const key of Object.keys(value)) {
          if (!(key in properties)) {
            problems.push({ path: `${path}.${key}`, message: 'is not a property this schema allows' });
          }
        }
      }
    }
  }

  // --- arrays -------------------------------------------------------------
  const items = schema['items'];
  if (Array.isArray(value) && items !== undefined && isObject(items)) {
    value.forEach((element, index) => {
      walk(element, items, `${path}[${index}]`, problems, unsupported);
    });
  }
}

/** A one-line summary of why a value was rejected, for a receipt's error. */
export function describeSchemaProblems(check: SchemaCheck, limit = 3): string {
  const shown = check.problems
    .slice(0, limit)
    .map((p) => `${p.path} ${p.message}`)
    .join('; ');
  const extra = check.problems.length > limit ? ` (and ${check.problems.length - limit} more)` : '';
  return `${shown}${extra}`;
}
