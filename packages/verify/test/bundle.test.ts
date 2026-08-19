import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * §9: "a verification tool with a large transitive dependency tree is not
 * independently auditable". These tests enforce that claim rather than
 * trusting it — a dependency added later fails the build here.
 */

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
const bundlePath = `${pkgRoot}dist/verify.mjs`;

const pkg = JSON.parse(readFileSync(`${pkgRoot}package.json`, 'utf8')) as {
  dependencies?: Record<string, string>;
};

describe('the published package', () => {
  test('declares no runtime dependencies', () => {
    expect(Object.keys(pkg.dependencies ?? {})).toStrictEqual([]);
  });
});

describe('the bundle', () => {
  test('is built', () => {
    expect(existsSync(bundlePath), 'run `pnpm --filter @0gflow/verify build`').toBe(true);
  });

  test('imports nothing but node: builtins', () => {
    const source = readFileSync(bundlePath, 'utf8');
    const imports = [...source.matchAll(/(?:^|\n)\s*import\s+[^;]*?from\s*["']([^"']+)["']/g)].map(
      (m) => m[1]!,
    );
    const requires = [...source.matchAll(/require\(["']([^"']+)["']\)/g)].map((m) => m[1]!);
    const external = [...imports, ...requires].filter((s) => !s.startsWith('node:'));
    expect(external, 'the bundle must inline everything except node builtins').toStrictEqual([]);
  });

  test('is a single file', () => {
    // No sibling chunks: the whole tool is one thing you can read top to bottom.
    const source = readFileSync(bundlePath, 'utf8');
    expect(source).not.toMatch(/from\s*["']\.\//);
  });

  test('runs and prints usage without a network', () => {
    const out = execFileSync(process.execPath, [bundlePath, '--help'], { encoding: 'utf8' });
    expect(out).toMatch(/0gflow-verify/);
    expect(out).toMatch(/--tamper/);
    expect(out).toMatch(/Exit codes/);
  });

  test('exits non-zero for a malformed runId', () => {
    let code = 0;
    try {
      execFileSync(process.execPath, [bundlePath, 'not-a-run-id'], { stdio: 'pipe' });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).not.toBe(0);
  });
});
