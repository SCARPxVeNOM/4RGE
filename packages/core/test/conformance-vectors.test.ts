import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalize, type JsonValue } from '../src/canonicalize.js';
import { hashJson, keccak256 } from '../src/hash.js';

/**
 * The cross-language contract for §5.2.
 *
 * `vectors/canonicalization.json` is what every other implementation is held
 * to — the Python SDK, the adapter SDK, the indexer, and any third-party
 * verifier. This test asserts that the TypeScript core still agrees with it.
 *
 * If this fails, either core changed behaviour (a consensus break) or a vector
 * was edited. Regenerating the file to make it pass defeats its purpose.
 */

interface Vector {
  name: string;
  note: string;
  value: JsonValue;
  canonical: string;
  sha256: string;
  keccak256: string;
}

const file = fileURLToPath(new URL('../vectors/canonicalization.json', import.meta.url));
const { vectors } = JSON.parse(readFileSync(file, 'utf8')) as { vectors: Vector[] };

describe('conformance vectors', () => {
  test('the vector file is populated', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(15);
  });

  test.each(vectors.map((v) => [v.name, v] as const))(
    'core reproduces vector %s',
    (_name, vector) => {
      expect(canonicalize(vector.value)).toBe(vector.canonical);
      expect(hashJson(vector.value)).toBe(vector.sha256);
      expect(keccak256(new TextEncoder().encode(vector.canonical))).toBe(vector.keccak256);
    },
  );

  test('every vector documents why it exists', () => {
    // A vector without a rationale gets deleted by someone during a future
    // cleanup, taking its guarantee with it.
    for (const vector of vectors) {
      expect(vector.note.length, `vector ${vector.name} has no note`).toBeGreaterThan(10);
    }
  });

  test('vector names are unique', () => {
    expect(new Set(vectors.map((v) => v.name)).size).toBe(vectors.length);
  });

  test('the non-BMP ordering trap is covered', () => {
    // This is the single most likely cross-language divergence, so its
    // presence is asserted rather than left to convention.
    const vector = vectors.find((v) => v.name === 'key-ordering-non-bmp');
    expect(vector, 'the non-BMP key ordering vector must not be removed').toBeDefined();
    expect(vector!.canonical.indexOf('\u{1F600}')).toBeLessThan(
      vector!.canonical.indexOf('￿'),
    );
  });
});
