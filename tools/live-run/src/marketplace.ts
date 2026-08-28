/**
 * A marketplace run, end to end on Galileo.
 *
 * What makes this different from every earlier live run: nothing here is told
 * where the agent is. The flow names agent 12 and the executor asks
 * `AgentAdapterRegistryV2` where to find it — the same lookup anyone else
 * would do. And the step demands a signed output, so the receipt's `agentId`
 * is a fact rather than a claim.
 *
 *   ZG_PRIVATE_KEY=0x… pnpm --filter @0gflow/run-flow marketplace
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { GALILEO } from '@0gflow/config';
import {
  executeRun,
  ViemChainWriter,
  ViemAdapterRegistry,
  ViemAgentRegistry,
  ZgStorageSchemaSource,
  type FlowSpec,
} from '@0gflow/executor';
import { ZgStorageTraceStore } from '@0gflow/storage';
import { keccak256, type Hex } from '@0gflow/core';

const AGENT = process.env['MARKETPLACE_AGENT'] ?? '12';

const SPEC: FlowSpec = {
  version: '0gflow/1',
  name: 'marketplace-audit',
  inputs: { repoUrl: { type: 'string' } },
  steps: [
    {
      id: 'audit',
      agent: AGENT,
      input: { repo: '{{ inputs.repoUrl }}' },
      // The point of the run. Without this the agent's signature would be
      // recorded but not required, and a receipt naming agent 12 would prove
      // nothing about agent 12.
      requireSignedOutput: true,
    },
  ],
};

async function main(): Promise<number> {
  const privateKey = process.env['ZG_PRIVATE_KEY'];
  if (privateKey === undefined || privateKey === '') {
    console.error('ZG_PRIVATE_KEY is not set');
    return 2;
  }

  const receipts = GALILEO.contracts.executionReceiptsV2;
  const adapterRegistry = GALILEO.contracts.agentAdapterRegistryV2;
  if (receipts === null || adapterRegistry === null) {
    console.error('the v2 contracts are not configured for this network');
    return 2;
  }

  const runId = keccak256(
    new TextEncoder().encode(`marketplace-${Date.now()}-${Math.random()}`),
  ) as Hex;

  console.log(`\n  run    ${runId}`);
  console.log(`  agent  ${AGENT} (resolved from ${adapterRegistry}, not configured here)`);
  console.log(`  anchor ${receipts}\n`);

  const chain = new ViemChainWriter({
    network: GALILEO,
    privateKey,
    receiptsContract: receipts,
  });

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
    // No endpointFor. The whole point.
    adapters: new ViemAdapterRegistry({
      rpcUrl: GALILEO.rpcUrl,
      adapterRegistry,
    }),
    agents: new ViemAgentRegistry({
      rpcUrl: GALILEO.rpcUrl,
      adapterRegistry,
    }),
  });

  mkdirSync('artifacts/runs', { recursive: true });
  writeFileSync(
    `artifacts/runs/${runId}.json`,
    JSON.stringify({ ...SPEC, inputs: { repoUrl: 'https://github.com/0glabs/0g-chain' } }, null, 2),
  );

  for (const step of result.steps) {
    console.log(
      `  [${step.stepIndex}] ${step.stepId.padEnd(10)} status ${step.status}   trace ${step.traceRoot}`,
    );
    if (step.error !== null) console.log(`        error: ${step.error}`);
  }
  console.log(`\n  chainRoot ${result.chainRoot}`);
  console.log(`  sealed    ${result.sealed}   outcome ${result.outcome}`);
  console.log(`  succeeded ${result.succeeded}\n`);
  console.log(`  verify with:`);
  console.log(
    `    node packages/verify/dist/verify.mjs ${runId} \\\n      --contract ${receipts} --adapters ${adapterRegistry} \\\n      --spec artifacts/runs/${runId}.json\n`,
  );

  return result.succeeded ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: Error) => {
    console.error(error);
    process.exit(1);
  });
