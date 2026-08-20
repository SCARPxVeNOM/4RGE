/**
 * Indexer CLI — spec §8.1.
 *
 *   DATABASE_URL=postgres://… pnpm --filter @0gflow/indexer index
 *   … index --once     backfill to head and exit
 *   … index --memory   run against an in-memory store (no database)
 *
 * Backfills from the deployment block recorded in @0gflow/config, then polls.
 */

import { GALILEO, requireAddress, requireResolved } from '@0gflow/config';
import { catchUp } from './ingest.js';
import { MemoryStore } from './memory-store.js';
import { PostgresStore } from './postgres-store.js';
import { JsonRpcChainReader } from './rpc.js';
import type { Store } from './store.js';

/** Galileo finalises quickly; 32 blocks is a deliberately conservative margin. */
const FINALITY_DEPTH = Number(process.env['ZG_FINALITY_DEPTH'] ?? 32);
const POLL_MS = Number(process.env['ZG_POLL_MS'] ?? 5_000);

export async function main(argv: readonly string[]): Promise<number> {
  const once = argv.includes('--once');
  const useMemory = argv.includes('--memory');
  const network = requireResolved(GALILEO);
  const contract = requireAddress(network, 'executionReceipts');
  const deploymentBlock = BigInt(network.deploymentBlock ?? 0);

  let store: Store;
  if (useMemory) {
    store = new MemoryStore();
  } else {
    const url = process.env['DATABASE_URL'];
    if (url === undefined) {
      console.error('DATABASE_URL is not set. Pass --memory to run without a database.');
      return 2;
    }
    const pg = new PostgresStore(url);
    await pg.migrate();
    store = pg;
  }

  const chain = new JsonRpcChainReader(network.rpcUrl);

  console.log(`0G Flow indexer`);
  console.log(`  network   ${network.displayName} (${network.chainId})`);
  console.log(`  contract  ${contract}`);
  console.log(`  store     ${useMemory ? 'memory' : 'postgres'}`);
  console.log(`  from      block ${deploymentBlock}`);
  console.log(`  finality  ${FINALITY_DEPTH} blocks\n`);

  const pass = async () => {
    const results = await catchUp({
      store,
      chain,
      contract,
      deploymentBlock,
      finalityDepth: FINALITY_DEPTH,
      onProgress: (r) => {
        if (r.steps > 0 || r.seals > 0 || r.reorgedFrom !== null) {
          const reorg = r.reorgedFrom === null ? '' : `  REORG from ${r.reorgedFrom}`;
          console.log(
            `  ${r.scannedFrom}–${r.scannedTo}  ${r.steps} step(s)  ${r.seals} seal(s)${reorg}`,
          );
        }
      },
    });
    return results;
  };

  await pass();
  const stats = await store.stats();
  console.log(
    `\n  indexed: ${stats.runs} run(s), ${stats.steps} step(s), ${stats.agents} agent(s) — cursor at block ${stats.cursor}`,
  );

  if (once) {
    await store.close?.();
    return 0;
  }

  console.log(`\n  following head, polling every ${POLL_MS}ms (ctrl-c to stop)`);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    try {
      await pass();
    } catch (error) {
      // Keep following: a transient RPC failure must not end the process, or
      // the index silently stops updating while looking healthy.
      console.error(`  ! ${(error as Error).message}`);
    }
  }
}

if (process.argv[1]?.includes('cli') === true) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`\n✗ ${(error as Error).message}`);
      process.exitCode = 1;
    });
}
