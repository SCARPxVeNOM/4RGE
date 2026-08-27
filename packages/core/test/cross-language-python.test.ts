/**
 * Cross-language agreement between the TypeScript core and the Python SDK.
 *
 * §5.2 says one implementation is shared by five components, and the frozen
 * vectors are how that is enforced. But fifteen vectors are fifteen values:
 * they pin the cases someone thought of. This runs both implementations over
 * randomly generated JSON and asserts they agree on every one — the same
 * canonical bytes, the same digests, and the same *rejections*.
 *
 * Agreeing on what to refuse matters as much as agreeing on what to emit. An
 * implementation that quietly accepts a value the other rejects produces a
 * receipt no verifier written in the other language can reproduce.
 *
 * Skipped, with a printed note, when Python is unavailable. A test that
 * silently passes because it did not run is worse than one that is absent.
 */

import { describe, expect, test, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { canonicalize, type JsonValue } from '../src/canonicalize.js';
import { hashJson, keccak256 } from '../src/hash.js';

const SDK_SRC = fileURLToPath(new URL('../../python-sdk/src', import.meta.url));

function findPython(): string | null {
  for (const candidate of ['python', 'python3', 'py']) {
    const probe = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[0])'], {
      encoding: 'utf8',
    });
    if (probe.status === 0 && probe.stdout.trim() === '3') return candidate;
  }
  return null;
}

const python = findPython();

/**
 * Canonicalises a batch in one Python process. Per-value spawning would make
 * this test take minutes and get deleted.
 */
const SCRIPT = `
import json, sys
sys.path.insert(0, sys.argv[1])
from zgflow import canonicalize, hash_json, keccak256
from zgflow.canonical import CanonicalizationError

values = json.load(open(sys.argv[2], encoding="utf-8"))
out = []
for value in values:
    try:
        canonical = canonicalize(value)
        out.append({
            "ok": True,
            "canonical": canonical,
            "sha256": hash_json(value),
            "keccak256": keccak256(canonical.encode("utf-8")),
        })
    except CanonicalizationError as error:
        out.append({"ok": False, "error": str(error)})
json.dump(out, open(sys.argv[3], "w", encoding="utf-8"), ensure_ascii=False)
`;

type PyResult =
  | { ok: true; canonical: string; sha256: string; keccak256: string }
  | { ok: false; error: string };

let workdir: string;

function runPython(values: JsonValue[]): PyResult[] {
  const inputPath = join(workdir, 'in.json');
  const outputPath = join(workdir, 'out.json');
  const scriptPath = join(workdir, 'run.py');

  writeFileSync(scriptPath, SCRIPT, 'utf8');
  writeFileSync(inputPath, JSON.stringify(values), 'utf8');
  // Results travel through a file, not stdout. On Windows the console codec is
  // cp1252, so piping a canonical form containing U+FFFF or an emoji through
  // stdout fails inside Python before this side ever sees it.
  execFileSync(python!, [scriptPath, SDK_SRC, inputPath, outputPath], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

  return JSON.parse(readFileSync(outputPath, 'utf8')) as PyResult[];
}

/** What TypeScript does with a value: the same shape Python reports. */
function runTypeScript(value: JsonValue): PyResult {
  try {
    const canonical = canonicalize(value);
    return {
      ok: true,
      canonical,
      sha256: hashJson(value),
      keccak256: keccak256(new TextEncoder().encode(canonical)),
    };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

const describeOrSkip = python === null ? describe.skip : describe;

if (python === null) {
  // eslint-disable-next-line no-console
  console.warn(
    'note: the Python SDK cross-language check was NOT exercised (no Python 3 on PATH)',
  );
}

describeOrSkip('TypeScript and Python agree', () => {
  beforeAll(() => {
    workdir = mkdtempSync(join(tmpdir(), '0gflow-xlang-'));
    // Fail loudly here rather than reporting every value as a mismatch if the
    // SDK cannot even be imported.
    const probe = spawnSync(
      python!,
      ['-c', 'import sys;sys.path.insert(0,sys.argv[1]);import zgflow;print(zgflow.__version__)', SDK_SRC],
      { encoding: 'utf8' },
    );
    expect(probe.status, `could not import the Python SDK: ${probe.stderr}`).toBe(0);

    return () => rmSync(workdir, { recursive: true, force: true });
  });

  test('on 300 randomly generated JSON values', () => {
    const values = fc.sample(fc.jsonValue(), { numRuns: 300, seed: 20260827 }) as JsonValue[];
    const pythonResults = runPython(values);

    expect(pythonResults).toHaveLength(values.length);

    for (const [index, value] of values.entries()) {
      const ts = runTypeScript(value);
      const py = pythonResults[index]!;

      // Both must agree on whether the value is canonicalisable at all.
      expect(py.ok, `disagreement on acceptance for ${JSON.stringify(value)}`).toBe(ts.ok);

      if (ts.ok && py.ok) {
        expect(py.canonical, `canonical form differs for ${JSON.stringify(value)}`).toBe(
          ts.canonical,
        );
        expect(py.sha256).toBe(ts.sha256);
        expect(py.keccak256).toBe(ts.keccak256);
      }
    }
  }, 120_000);

  test('on unicode-heavy values, where key ordering diverges', () => {
    // fc.jsonValue() produces mostly ASCII keys, and ASCII is exactly the
    // range where the two sort orders agree. This targets the range where
    // they do not.
    const exotic = fc.sample(fc.unicodeJsonValue(), { numRuns: 200, seed: 20260828 });

    const values = exotic as JsonValue[];
    const pythonResults = runPython(values);

    for (const [index, value] of values.entries()) {
      const ts = runTypeScript(value);
      const py = pythonResults[index]!;
      expect(py.ok).toBe(ts.ok);
      if (ts.ok && py.ok) expect(py.canonical).toBe(ts.canonical);
    }
  }, 120_000);

  test('on the ordering cases that a code-point sort gets wrong', () => {
    // Constructed rather than generated: the probability of a random generator
    // producing a key pair that straddles the BMP boundary is too low to rely
    // on, and this is the divergence that matters most.
    const values: JsonValue[] = [
      { '￿': 1, '\u{1F600}': 2 },
      { '\u{10000}': 1, '�': 2 },
      { '\u{1F600}': 1, '\u{1F601}': 2, '': 3 },
      { z: 1, '\u{1F4A9}': 2, a: 3 },
      { '퟿': 1, '': 2, '\u{20000}': 3 },
    ];

    const pythonResults = runPython(values);
    for (const [index, value] of values.entries()) {
      const ts = runTypeScript(value);
      expect(ts.ok).toBe(true);
      const py = pythonResults[index]!;
      expect(py.ok).toBe(true);
      expect((py as { canonical: string }).canonical).toBe(
        (ts as { canonical: string }).canonical,
      );
    }
  }, 60_000);

  test('on the frozen vectors, through the Python implementation', () => {
    // The Python suite asserts this too. Asserting it from the JavaScript side
    // as well means `pnpm test` alone catches a divergence, without anyone
    // remembering to run pytest.
    const file = fileURLToPath(new URL('../vectors/canonicalization.json', import.meta.url));
    const { vectors } = JSON.parse(readFileSync(file, 'utf8')) as {
      vectors: { name: string; value: JsonValue; canonical: string; sha256: string }[];
    };

    const results = runPython(vectors.map((v) => v.value));
    for (const [index, vector] of vectors.entries()) {
      const py = results[index]!;
      expect(py.ok, `Python rejected vector ${vector.name}`).toBe(true);
      if (py.ok) {
        expect(py.canonical, `vector ${vector.name}`).toBe(vector.canonical);
        expect(py.sha256, `vector ${vector.name}`).toBe(vector.sha256);
      }
    }
  }, 60_000);
});
