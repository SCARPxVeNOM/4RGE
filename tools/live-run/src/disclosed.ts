/**
 * An agent disclosing runs it hired, on Galileo.
 *
 * Different from `hired.ts`, and the difference is the whole point. There the
 * executor opened the child run as a `kind: 'flow'` step, so the parent's
 * output *is* the child's on-chain result and the claim can be checked.
 * Here the agent decided for itself and is telling us where it went.
 *
 * A verifier checks each run named — it exists, it is sealed, it verifies —
 * and stops short of concluding this output came from them. Anyone can name
 * any run id. The disclosure is still tamper-evident, because it lands in the
 * trace and the trace hashes into the receipt.
 *
 *   ZG_PRIVATE_KEY=0x… AGENT_ENDPOINT=https://…/agents/delegates npx tsx src/disclosed.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
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

const AGENT = process.env['MARKETPLACE_AGENT'] ?? '13';

const SPEC: FlowSpec = {
  version: '0gflow/1',
  name: 'delegating-flow',
  inputs: { topic: { type: 'string' } },
  steps: [
    {
      id: 'delegate',
      agent: AGENT,
      input: { text: '{{ inputs.topic }}' },
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
    console.error('the v2 contracts are not configured');
    return 2;
  }

  const runId = keccak256(new TextEncoder().encode(`disclosed-${Date.now()}`)) as Hex;
  const inputs = { topic: 'the quarterly audit' };

  console.log(`\n  run      ${runId}`);
  console.log(`  agent    ${AGENT} (resolved from the registry)\n`);

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
    schemas: new ZgStorageSchemaSource({ indexerUrl: GALILEO.storageIndexerUrl }),
  });

  mkdirSync('artifacts/runs', { recursive: true });
  writeFileSync(`artifacts/runs/${runId}.json`, JSON.stringify({ ...SPEC, inputs }, null, 2));

  const step = result.steps[0];
  console.log(`  [0] status ${step?.status}   sealed ${result.sealed}`);
  if (step?.error != null) console.log(`      error: ${step.error}`);
  console.log('');

  console.log('  verify — the disclosure is reported as a disclosure:');
  console.log(`    node packages/verify/dist/verify.mjs ${runId} \\`);
  console.log(`      --contract ${receipts} --adapters ${adapterRegistry} \\`);
  console.log(`      --spec tools/live-run/artifacts/runs/${runId}.json\n`);
  return result.succeeded ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: Error) => {
    console.error(error);
    process.exit(1);
  });
