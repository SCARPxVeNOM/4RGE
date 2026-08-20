import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * core must run anywhere — Node, a browser, a bundler, a worker.
 *
 * §5.2 makes this module the single implementation shared by the executor,
 * the verifier, the indexer and both SDKs; §8.2 adds the explorer, which
 * performs client-side verification in a browser. A `node:` import anywhere in
 * core means the browser cannot fold a chain root, and the explorer is reduced
 * to asking to be trusted.
 *
 * This was not hypothetical: core imported createHash from node:crypto, and
 * the explorer build failed with "createHash is not exported by
 * __vite-browser-external". Hence a pure implementation, and this guard.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

const sources = readdirSync(SRC)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => [f, readFileSync(join(SRC, f), 'utf8')] as const);

describe('core has no platform-specific imports', () => {
  test('there are source files to check', () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  test.each(sources)('%s imports nothing from node:', (_name, source) => {
    const nodeImports = [...source.matchAll(/from\s+['"](node:[^'"]+)['"]/g)].map((m) => m[1]!);
    expect(nodeImports).toStrictEqual([]);
  });

  test.each(sources)('%s uses no bare require()', (_name, source) => {
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  test.each(sources)('%s references no Node globals', (_name, source) => {
    // Buffer is the easy one to reach for and the easy one to forget is
    // absent in a browser.
    expect(source).not.toMatch(/\bBuffer\./);
    expect(source).not.toMatch(/\bprocess\./);
  });
});
