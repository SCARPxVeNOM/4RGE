#!/usr/bin/env node
/**
 * Explorer API server — spec §8.2.
 *
 *   DATABASE_URL=postgres://… pnpm --filter @0gflow/explorer-api serve
 *   … serve --memory   serve an empty in-memory index (for a smoke test)
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { networkFromEnv } from '@0gflow/config';
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

/**
 * One Postgres schema per network.
 *
 * The index has no chain column: a run row records a runId, a chain root and
 * block numbers, none of which say which chain they came from. Point a single
 * index at two networks and the directory silently mixes them — a mainnet run
 * and a testnet run sitting in one list, indistinguishable, on a site whose
 * entire claim is that you can check where a number came from. That is a worse
 * failure than showing nothing.
 *
 * Separating by schema also means the cursor is per-network, which matters
 * mechanically: Galileo's head is around 50M and Aristotle's is around 43M, so
 * a shared cursor would ask one chain for a block range that ends before it
 * starts, and eth_getLogs would refuse.
 *
 * Galileo keeps `public` so an existing deployment is untouched by this change.
 */
function schemaFor(network: { name: string }): string {
  return network.name === 'galileo' ? 'public' : network.name;
}

export async function main(argv: readonly string[]): Promise<number> {
  const network = networkFromEnv();

  let store: Store;
  if (argv.includes('--memory')) {
    store = new MemoryStore();
  } else {
    const url = process.env['DATABASE_URL'];
    if (url === undefined) {
      console.error('DATABASE_URL is not set. Pass --memory to serve an empty index.');
      return 2;
    }
    const pg = new PostgresStore(url, schemaFor(network));
    await pg.migrate();
    store = pg;
  }

  // Pays for schema storage when someone publishes from the browser. Optional
  // by design: without it the publish page still runs the conformance gate and
  // says why it cannot finish, rather than failing at the last step.
  const storageKey = process.env['ZG_STORAGE_KEY'] ?? process.env['ZG_PRIVATE_KEY'];
  const app = createServer({ store, network, storageKey });

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

/**
 * Whether this module is the program being run, rather than imported.
 *
 * Compared as resolved real paths. npm's bin shim execs through
 * `node_modules/.bin/../@0gflow/<pkg>/dist/cli.js`, a symlinked install
 * resolves somewhere else again, and a relative invocation is shorter still —
 * all the same file under different names. Matching on the *shape* of the path,
 * which this used to do, silently ran nothing the moment that shape changed.
 * Running nothing and exiting 0 is the worst failure available to a CLI.
 */
function isEntrypoint(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => { if (code !== 0) process.exitCode = code; })
    .catch((error: unknown) => {
      console.error(`\n✗ ${(error as Error).message}`);
      process.exitCode = 1;
    });
}
