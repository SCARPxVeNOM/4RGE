/**
 * An agent hiring other agents, on Galileo.
 *
 * The parent flow has one step that is not an agent call at all: it is a whole
 * sub-workflow. The executor opens a second run for it, executes it, and the
 * parent step's output is that child run's on-chain result.
 *
 * That is what makes the hiring verifiable instead of merely convenient. An
 * agent that quietly called three others inside its own process would produce
 * one receipt for work four parties did, and nobody downstream could tell
 * which of them to credit or blame. Here both runs are sealed on chain, and
 * the parent's output names the child's root — so anyone can fetch that seal
 * and check it.
 *
 *   ZG_PRIVATE_KEY=0x… npx tsx src/hired.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { GALILEO } from '@0gflow/config';
import {
  executeRun,
  ViemChainWriter,
  ViemAdapterRegistry,
  ViemAgentRegistry,
  type FlowSpec,
} from '@0gflow/executor';
import { ZgStorageTraceStore } from '@0gflow/storage';
import { keccak256, type Hex } from '@0gflow/core';

const AGENT = process.env['MARKETPLACE_AGENT'] ?? '12';

/** What the hiring agent subcontracts out. */
const SUBCONTRACT: FlowSpec = {
  version: '0gflow/1',
  name: 'subcontracted-audit',
  inputs: { repo: { type: 'string' } },
  steps: [
    {
      id: 'audit',
      agent: AGENT,
      input: { repo: '{{ inputs.repo }}' },
      requireSignedOutput: true,
    },
  ],
};

const SPEC: FlowSpec = {
  version: '0gflow/1',
  name: 'hiring-flow',
  inputs: { repoUrl: { type: 'string' } },
  steps: [
    {
      id: 'delegate',
      // The agent doing the hiring. Its receipt records that it delegated,
      // and to which run — not a result it did not produce itself.
      agent: AGENT,
      kind: 'flow',
      flow: SUBCONTRACT,
      input: { repo: '{{ inputs.repoUrl }}' },
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

  const runId = keccak256(new TextEncoder().encode(`hired-${Date.now()}-${Math.random()}`)) as Hex;
  const inputs = { repoUrl: 'https://github.com/0glabs/0g-storage-node' };

  console.log(`\n  parent run  ${runId}`);
  console.log(`  hiring agent ${AGENT} to run a sub-workflow\n`);

  const result = await executeRun({
    spec: SPEC,
    inputs,
    runId,
    chain: new ViemChainWriter({ network: GALILEO, privateKey, receiptsContract: receipts }),
    traces: new ZgStorageTraceStore({
      rpcUrl: GALILEO.rpcUrl,
      indexerUrl: GALILEO.storageIndexerUrl,
      privateKey,
    }),
    adapters: new ViemAdapterRegistry({ rpcUrl: GALILEO.rpcUrl, adapterRegistry }),
    agents: new ViemAgentRegistry({ rpcUrl: GALILEO.rpcUrl, adapterRegistry }),
  });

  mkdirSync('artifacts/runs', { recursive: true });
  writeFileSync(`artifacts/runs/${runId}.json`, JSON.stringify({ ...SPEC, inputs }, null, 2));

  // The child run id is derived from the parent's, so it is reproducible.
  const childRunId = keccak256(new TextEncoder().encode(`0gflow-subflow:${runId}:0`)) as Hex;
  writeFileSync(
    `artifacts/runs/${childRunId}.json`,
    JSON.stringify({ ...SUBCONTRACT, inputs: { repo: inputs.repoUrl } }, null, 2),
  );

  for (const step of result.steps) {
    console.log(`  [${step.stepIndex}] ${step.stepId.padEnd(10)} status ${step.status}`);
  }
  console.log(`\n  parent chainRoot ${result.chainRoot}`);
  console.log(`  parent sealed    ${result.sealed}   outcome ${result.outcome}`);
  console.log(`  child run        ${childRunId}\n`);
  console.log('  verify BOTH — the parent, and the child it hired:');
  console.log(
    `    node packages/verify/dist/verify.mjs ${runId} \\\n      --contract ${receipts} --adapters ${adapterRegistry} --spec tools/live-run/artifacts/runs/${runId}.json`,
  );
  console.log(
    `    node packages/verify/dist/verify.mjs ${childRunId} \\\n      --contract ${receipts} --adapters ${adapterRegistry} --spec tools/live-run/artifacts/runs/${childRunId}.json\n`,
  );

  return result.succeeded ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: Error) => {
    console.error(error);
    process.exit(1);
  });
