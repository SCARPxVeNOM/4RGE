/**
 * A paid marketplace run on Galileo.
 *
 * The claim being demonstrated: funding a run does not require trusting the
 * executor. The executor here allocates the budget and submits the release,
 * and it still cannot send the money anywhere except to the address the agent
 * registered — because the escrow reads the payee from the registry and pays
 * only against a signature by the key that agent published.
 *
 *   ZG_PRIVATE_KEY=0x… npx tsx src/paid.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { GALILEO } from '@0gflow/config';
import {
  executeRun,
  ViemChainWriter,
  ViemAdapterRegistry,
  ViemAgentRegistry,
  ViemEscrow,
  type FlowSpec,
} from '@0gflow/executor';
import { ZgStorageTraceStore } from '@0gflow/storage';
import { createPublicClient, defineChain, http } from 'viem';
import { keccak256, type Hex } from '@0gflow/core';

const AGENT = process.env['MARKETPLACE_AGENT'] ?? '12';
/** Small enough to run repeatedly on testnet, large enough to see move. */
const PRICE = 1_000_000_000_000_000n; // 0.001 OG

const SPEC: FlowSpec = {
  version: '0gflow/1',
  name: 'paid-audit',
  inputs: { repoUrl: { type: 'string' } },
  steps: [
    {
      id: 'audit',
      agent: AGENT,
      input: { repo: '{{ inputs.repoUrl }}' },
      requireSignedOutput: true,
    },
  ],
};

const og = (wei: bigint): string => `${(Number(wei) / 1e18).toFixed(6)} OG`;

async function main(): Promise<number> {
  const privateKey = process.env['ZG_PRIVATE_KEY'];
  if (privateKey === undefined || privateKey === '') {
    console.error('ZG_PRIVATE_KEY is not set');
    return 2;
  }

  const receipts = GALILEO.contracts.executionReceiptsV2;
  const adapterRegistry = GALILEO.contracts.agentAdapterRegistryV2;
  const escrowAddress = GALILEO.contracts.flowEscrowV2;
  if (receipts === null || adapterRegistry === null || escrowAddress === null) {
    console.error('the v2 contracts are not configured for this network');
    return 2;
  }

  const runId = keccak256(new TextEncoder().encode(`paid-${Date.now()}-${Math.random()}`)) as Hex;
  const chain = new ViemChainWriter({ network: GALILEO, privateKey, receiptsContract: receipts });
  const escrow = new ViemEscrow({ network: GALILEO, privateKey, escrow: escrowAddress });

  const adapters = new ViemAdapterRegistry({ rpcUrl: GALILEO.rpcUrl, adapterRegistry });
  const listing = await adapters.resolve(BigInt(AGENT));
  if (listing === null) {
    console.error(`agent ${AGENT} is not listed`);
    return 2;
  }

  const rpc = createPublicClient({
    chain: defineChain({
      id: GALILEO.chainId,
      name: GALILEO.displayName,
      nativeCurrency: { name: GALILEO.nativeToken, symbol: GALILEO.nativeToken, decimals: 18 },
      rpcUrls: { default: { http: [GALILEO.rpcUrl] } },
    }),
    transport: http(GALILEO.rpcUrl),
  });

  const balanceBefore = await rpc.getBalance({ address: listing.payTo as `0x${string}` });

  console.log(`\n  run     ${runId}`);
  console.log(`  agent   ${AGENT}  ->  payTo ${listing.payTo}`);
  console.log(`  escrow  ${escrowAddress}`);
  console.log(`  balance before  ${og(balanceBefore)}\n`);

  // 1. Fund. The deadline is mandatory: without it a run the executor never
  //    seals would hold this money forever.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  console.log(`  funding ${og(PRICE * 2n)} with a one-hour deadline…`);
  await escrow.fundRun(runId, PRICE * 2n, deadline);

  // 2. Execute.
  console.log('  executing…');
  const result = await executeRun({
    spec: SPEC,
    inputs: { repoUrl: 'https://github.com/0glabs/0g-chain' },
    runId,
    chain,
    traces: new ZgStorageTraceStore({
      rpcUrl: GALILEO.rpcUrl,
      indexerUrl: GALILEO.storageIndexerUrl,
      privateKey,
    }),
    adapters,
    agents: new ViemAgentRegistry({ rpcUrl: GALILEO.rpcUrl, adapterRegistry }),
    // The executor allocates and releases as it anchors. Previously this file
    // drove that by hand, which meant the payment path only worked for
    // callers who knew to write the loop.
    escrow,
  });

  // Written so the verify command printed below can re-derive linkage; a
  // report that says "not checked" is a weaker claim than one that does not
  // have to.
  mkdirSync('artifacts/runs', { recursive: true });
  writeFileSync(
    `artifacts/runs/${runId}.json`,
    JSON.stringify({ ...SPEC, inputs: { repoUrl: 'https://github.com/0glabs/0g-chain' } }, null, 2),
  );

  // 3. Report what the executor already settled.
  for (const step of result.steps) {
    const paid = step.payment;
    if (paid === null) {
      console.log(`  [${step.stepIndex}] ${step.stepId}: nothing to pay`);
    } else if (paid.released) {
      console.log(
        `  [${step.stepIndex}] ${step.stepId}: paid ${og(paid.amount)} against the agent's own signature`,
      );
    } else {
      console.log(`  [${step.stepIndex}] ${step.stepId}: NOT paid — ${paid.error ?? 'no reason given'}`);
    }
  }

  // 4. Recover what was not earned. The v1 escrow could not do this for a
  //    successful run; the remainder was trapped forever.
  const remaining = await escrow.balanceOf(runId);
  if (remaining > 0n) {
    console.log(`  refunding the unspent ${og(remaining)}…`);
    await escrow.refundUnspent(runId);
  }

  const balanceAfter = await rpc.getBalance({ address: listing.payTo as `0x${string}` });

  console.log('');
  console.log(`  balance after   ${og(balanceAfter)}`);
  console.log(`  agent earned    ${og(balanceAfter - balanceBefore)}`);
  console.log(`  escrow left     ${og(await escrow.balanceOf(runId))}`);
  console.log(`  released[0]     ${await escrow.isReleased(runId, 0)}`);
  console.log('');
  console.log(`  verify with:`);
  console.log(
    `    node packages/verify/dist/verify.mjs ${runId} \\\n      --contract ${receipts} --adapters ${adapterRegistry} \\\n      --spec tools/live-run/artifacts/runs/${runId}.json\n`,
  );

  return result.succeeded ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: Error) => {
    console.error(error);
    process.exit(1);
  });
