/**
 * Bundles the verifier into a single dependency-free file.
 *
 * §9 requires the published artifact to have zero dependencies so it can be
 * audited. @0gflow/core and @0gflow/config are devDependencies precisely
 * because they are inlined here rather than installed by consumers — the
 * shipped file imports nothing but node: builtins.
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

await build({
  entryPoints: [`${root}src/index.ts`],
  outfile: `${root}dist/verify.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'inline',
  // Keep it readable: this file is meant to be read by people who do not
  // trust us, so minification would defeat the purpose.
  minify: false,
});

console.log('bundled -> packages/verify/dist/verify.mjs');
