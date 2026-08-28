/**
 * Explorer API server — spec §8.2.
 *
 *   DATABASE_URL=postgres://… pnpm --filter @0gflow/explorer-api serve
 *   … serve --memory   serve an empty in-memory index (for a smoke test)
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { GALILEO, requireResolved } from '@0gflow/config';
import { MemoryStore, PostgresStore } from '@0gflow/indexer';
import type { Store } from '@0gflow/indexer';
import { createServer } from './server.js';

// Railway (and most hosts) inject PORT and expect the process to bind
// 0.0.0.0. Defaulting HOST to loopback locally is the safer choice; a
// container that binds loopback is simply unreachable, so the platform's own
// signal has to win.
const PORT = Number(process.env['PORT'] ?? process.env['EXPLORER_PORT'] ?? 8711);
const HOST = process.env['EXPLORER_HOST'] ?? (process.env['PORT'] === undefined ? '127.0.0.1' : '0.0.0.0');

/**
 * Where the built explorer UI lives, when it is being served from here.
 *
 * The UI fetches relative paths (`/api/...`), so serving it from the same
 * origin as the API is what it was written for — the Vite proxy exists only so
 * `pnpm dev` works without it. One origin also means no CORS policy to get
 * wrong.
 *
 * Optional: with no build present the API serves itself alone, which is what
 * the tests and local development do.
 */
const UI_DIR = process.env['EXPLORER_UI_DIR'];

export async function main(argv: readonly string[]): Promise<number> {
  const network = requireResolved(GALILEO);

  let store: Store;
  if (argv.includes('--memory')) {
    store = new MemoryStore();
  } else {
    const url = process.env['DATABASE_URL'];
    if (url === undefined) {
      console.error('DATABASE_URL is not set. Pass --memory to serve an empty index.');
      return 2;
    }
    const pg = new PostgresStore(url);
    await pg.migrate();
    store = pg;
  }

  const app = createServer({ store, network });

  if (UI_DIR !== undefined && existsSync(UI_DIR)) {
    const { default: fastifyStatic } = await import('@fastify/static');
    await app.register(fastifyStatic, { root: resolve(UI_DIR), wildcard: false });

    // The explorer routes on the URL hash (`#/agents`), so every path is the
    // same document. Anything that is not /api and not a real file is the
    // app itself — without this, a deep link 404s.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'no such endpoint' });
      }
      return reply.sendFile('index.html');
    });
  }

  await app.listen({ port: PORT, host: HOST });

  const stats = await store.stats();
  console.log(`0G Flow explorer API on http://${HOST}:${PORT}`);
  console.log(`  serving ${stats.runs} run(s), ${stats.steps} step(s) indexed to block ${stats.cursor}`);
  console.log(`  GET /api/health  /api/runs  /api/agents  /api/agents/:agentId`);
  if (UI_DIR !== undefined && existsSync(UI_DIR)) console.log(`  serving the explorer UI from ${UI_DIR}`);
  return 0;
}

if (process.argv[1]?.includes('cli') === true) {
  main(process.argv.slice(2))
    .then((code) => { if (code !== 0) process.exitCode = code; })
    .catch((error: unknown) => {
      console.error(`\n✗ ${(error as Error).message}`);
      process.exitCode = 1;
    });
}
