/**
 * Explorer API server — spec §8.2.
 *
 *   DATABASE_URL=postgres://… pnpm --filter @0gflow/explorer-api serve
 *   … serve --memory   serve an empty in-memory index (for a smoke test)
 */

import { GALILEO, requireResolved } from '@0gflow/config';
import { MemoryStore, PostgresStore } from '@0gflow/indexer';
import type { Store } from '@0gflow/indexer';
import { createServer } from './server.js';

const PORT = Number(process.env['EXPLORER_PORT'] ?? 8711);
const HOST = process.env['EXPLORER_HOST'] ?? '127.0.0.1';

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
  await app.listen({ port: PORT, host: HOST });

  const stats = await store.stats();
  console.log(`0G Flow explorer API on http://${HOST}:${PORT}`);
  console.log(`  serving ${stats.runs} run(s), ${stats.steps} step(s) indexed to block ${stats.cursor}`);
  console.log(`  GET /api/health  /api/runs  /api/runs/:runId  /api/flows/:flowId  /api/agents/:agentId`);
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
