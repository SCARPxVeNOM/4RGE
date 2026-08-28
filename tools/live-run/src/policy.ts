/**
 * A flow that refuses to hire below its bar — spec §7 step 2, on Galileo.
 *
 * Two runs against the same live agent: one with a bond requirement the agent
 * meets, and one with a requirement it does not. The second is skipped with
 * the reason and never invoked, because the agent did not fail — it was never
 * asked.
 *
 *   ZG_PRIVATE_KEY=0x… npx tsx src/policy.ts
 */

import { GALILEO } from '@0gflow/config';
import {
  executeRun,
  ViemChainWriter,
  ViemAdapterRegistry,
  ViemStakeSource,
  type FlowSpec,
} from '@0gflow/executor';
import { ZgStorageTraceStore } from '@0gflow/storage';
import { keccak256, type Hex } from '@0gflow/core';

const AGENT = process.env['MARKETPLACE_AGENT'] ?? '12';

const spec = (minStake: string): FlowSpec => ({
  version: '0gflow/1',
  name: `policy-${minStake}`,
  inputs: { repoUrl: { type: 'string' } },
  steps: [{ id: 'audit', agent: AGENT, input: { repo: '{{ inputs.repoUrl }}' } }],
  policy: { minStake },
});

async function main(): Promise<number> {
  const privateKey = process.env['ZG_PRIVATE_KEY'];
  const receipts = GALILEO.contracts.executionReceiptsV2;
  const adapterRegistry = GALILEO.contracts.agentAdapterRegistryV2;
  const reputation = GALILEO.contracts.agentReputation;
  if (!privateKey || receipts === null || adapterRegistry === null || reputation === null) {
    console.error('missing key or contract configuration');
    return 2;
  }

  const stakes = new ViemStakeSource({ rpcUrl: GALILEO.rpcUrl, reputation });
  const bond = await stakes.stakeOf(BigInt(AGENT));
  console.log(`\n  agent ${AGENT} has bonded ${bond} wei\n`);

  for (const [label, minStake] of [
    ['a bar it meets      ', '1000000000000000'],
    ['a bar it does not   ', '999000000000000000'],
  ] as const) {
    const runId = keccak256(new TextEncoder().encode(`policy-${minStake}-${Date.now()}`)) as Hex;
    const result = await executeRun({
      spec: spec(minStake),
      inputs: { repoUrl: 'https://github.com/0glabs/0g-chain' },
      runId,
      chain: new ViemChainWriter({ network: GALILEO, privateKey, receiptsContract: receipts }),
      traces: new ZgStorageTraceStore({
        rpcUrl: GALILEO.rpcUrl,
        indexerUrl: GALILEO.storageIndexerUrl,
        privateKey,
      }),
      adapters: new ViemAdapterRegistry({ rpcUrl: GALILEO.rpcUrl, adapterRegistry }),
      // A fresh source per run, so the second is not answered from the first's
      // cache — the point is that each run reads the chain.
      stakes: new ViemStakeSource({ rpcUrl: GALILEO.rpcUrl, reputation }),
    });

    const step = result.steps[0];
    console.log(`  ${label} minStake ${minStake}`);
    console.log(`    run    ${runId}`);
    console.log(`    status ${step?.status}  ${step?.status === 2 ? '(skipped)' : '(ok)'}`);
    if (step?.error != null) console.log(`    reason ${step.error}`);
    console.log('');
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: Error) => {
    console.error(error);
    process.exit(1);
  });
