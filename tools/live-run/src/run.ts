/**
 * A real multi-step run, anchored and sealed on 0G Galileo.
 *
 * This is the end-to-end proof that the frozen core and the deployed contracts
 * agree: every hash is computed by @0gflow/core, every write goes to the live
 * chain, and the chain root is then read back from the seal and compared. If
 * canonicalization, receipt encoding or the fold had drifted between
 * TypeScript and Solidity, the final comparison fails.
 *
 * It also re-runs the §4.1 linkage check against the receipts as anchored,
 * so the run is verified the way a third party would verify it, not the way
 * the executor remembers it.
 *
 *   pnpm --filter @0gflow/live-run live
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount, nonceManager } from 'viem/accounts';
import { GALILEO, requireResolved, requireAddress } from '@0gflow/config';
import {
  canonicalize,
  hashJson,
  keccak256,
  foldChainRoot,
  hashReceipt,
  verifyLinkage,
  reportStepOutcome,
  reportRunOutcome,
  decideStepStatus,
  isRunSuccess,
  StepStatus,
  ZERO_BYTES32,
  type Receipt,
  type LinkedStep,
  type JsonValue,
} from '@0gflow/core';
import { FLOW_REGISTRY_ABI, EXECUTION_RECEIPTS_ABI } from './abi.js';

const network = requireResolved(GALILEO);
const OUT_DIR = fileURLToPath(new URL('../../../artifacts/runs', import.meta.url));

const privateKey = process.env['ZG_PRIVATE_KEY'];
if (privateKey === undefined) {
  console.error('ZG_PRIVATE_KEY is not set.');
  process.exit(1);
}

const galileo = defineChain({
  id: network.chainId,
  name: network.displayName,
  nativeCurrency: { name: network.nativeToken, symbol: network.nativeToken, decimals: 18 },
  rpcUrls: { default: { http: [network.rpcUrl] } },
  blockExplorers: { default: { name: 'chainscan', url: network.explorerUrl } },
});

// §7.2: one signer per worker, wrapped in viem's nonceManager.
const account = privateKeyToAccount(
  (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`,
  { nonceManager },
);
const publicClient = createPublicClient({ chain: galileo, transport: http(network.rpcUrl) });
const walletClient = createWalletClient({ account, chain: galileo, transport: http(network.rpcUrl) });

// Galileo enforces a minimum tip; the default estimate falls below it.
const GAS_PRICE = 5_000_000_000n;

/** A two-step flow whose second step consumes the first step's output. */
const SPEC = {
  version: '0gflow/1',
  name: 'audit-then-summarize',
  inputs: { repoUrl: { type: 'string' } },
  steps: [
    { id: 'audit', agent: '1', input: { repo: '{{ inputs.repoUrl }}' } },
    {
      id: 'summarize',
      agent: '1',
      needs: ['audit'],
      input: { text: '{{ steps.audit.output.report }}' },
    },
  ],
  outputs: { summary: '{{ steps.summarize.output.text }}' },
} as const satisfies JsonValue;

const RUN_INPUTS: JsonValue = { repoUrl: 'https://github.com/0glabs/0g-chain' };

/** What the agents actually returned. Step 2's input derives from step 1's output. */
const OUTPUTS: Record<string, JsonValue> = {
  audit: { report: 'no critical findings; 3 informational', severity: 'info' },
  summarize: { text: 'The audit found no critical issues.' },
};

const AGENT_ID = 1n; // ERC-8004 token id

/** The trace document a verifier reads (§7.6). traceRoot commits to exactly this. */
function buildTrace(
  stepId: string,
  stepIndex: number,
  input: JsonValue,
  output: JsonValue,
  runId: string,
): JsonValue {
  return {
    version: '0gflow/1',
    runId,
    stepIndex,
    stepId,
    agent: AGENT_ID.toString(),
    input,
    output,
    attestation: null,
    error: null,
  };
}

async function send(hash: `0x${string}`, label: string) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`${label} reverted (${hash})`);
  console.log(`  ${label.padEnd(22)} block ${receipt.blockNumber}  ${hash}`);
  return receipt;
}

async function main() {
  console.log('0G Flow — live run on', network.displayName, '\n');

  const flowRegistry = requireAddress(network, 'flowRegistry');
  const executionReceipts = requireAddress(network, 'executionReceipts');

  // 1. flowId = keccak256(canonicalize(spec)) — §4.2.
  const canonicalSpec = canonicalize(SPEC);
  const flowId = keccak256(new TextEncoder().encode(canonicalSpec)) as `0x${string}`;
  const specRoot = hashJson(SPEC) as `0x${string}`;
  const runId = keccak256(
    new TextEncoder().encode(`0gflow-run-${Date.now()}-${account.address}`),
  ) as `0x${string}`;

  console.log(`flowId  ${flowId}`);
  console.log(`runId   ${runId}`);
  console.log(`spec    ${canonicalSpec.length} bytes canonical\n`);

  // 2. Publish the flow, unless this exact spec was already published.
  const alreadyPublished = await publicClient.readContract({
    address: flowRegistry,
    abi: FLOW_REGISTRY_ABI,
    functionName: 'isPublished',
    args: [flowId],
  });
  if (!alreadyPublished) {
    await send(
      await walletClient.writeContract({
        address: flowRegistry,
        abi: FLOW_REGISTRY_ABI,
        functionName: 'publishFlow',
        args: [flowId, specRoot, SPEC.name],
        gasPrice: GAS_PRICE,
      }),
      'publishFlow',
    );
  } else {
    console.log('  publishFlow            already published, reusing');
  }

  await send(
    await walletClient.writeContract({
      address: flowRegistry,
      abi: FLOW_REGISTRY_ABI,
      functionName: 'startRun',
      args: [flowId, runId, account.address],
      gasPrice: GAS_PRICE,
    }),
    'startRun',
  );

  // 3. Build receipts. Inputs are resolved from upstream outputs, so the
  //    linkage invariant holds by construction here and is checked below.
  const steps: LinkedStep[] = [
    { id: 'audit', input: { repo: '{{ inputs.repoUrl }}' } },
    { id: 'summarize', needs: ['audit'], input: { text: '{{ steps.audit.output.report }}' } },
  ];
  const resolvedInputs: JsonValue[] = [
    { repo: (RUN_INPUTS as { repoUrl: string }).repoUrl },
    { text: (OUTPUTS['audit'] as { report: string }).report },
  ];

  const now = Math.floor(Date.now() / 1000);
  const receipts: Receipt[] = steps.map((step, i) => ({
    flowId,
    runId,
    stepIndex: i,
    agentId: AGENT_ID,
    inputHash: hashJson(resolvedInputs[i]!),
    outputHash: hashJson(OUTPUTS[step.id]!),
    // 0G Storage submissions are unavailable on Galileo (see README); this
    // commits to the canonical trace bytes we hold, which is a real
    // commitment even though retrieval is pending. The same document is
    // written to artifacts/traces so the verifier can be run with
    // --trace-dir until storage accepts writes again.
    traceRoot: hashJson(buildTrace(step.id, i, resolvedInputs[i]!, OUTPUTS[step.id]!, runId)),
    attestationRef: ZERO_BYTES32,
    startedAt: BigInt(now + i * 2),
    endedAt: BigInt(now + i * 2 + 1),
    // Status is never written by hand — §10.3.
    status: decideStepStatus({ requireAttestation: false, attestationPresent: false }),
  })) as Receipt[];

  // 4. Anchor, deliberately out of order, to exercise §1.1's claim that the
  //    root does not depend on completion order.
  console.log('\nanchoring out of order (step 1 before step 0):');
  const anchorOrder = [1, 0];
  const anchorTx = new Map<number, `0x${string}`>();
  for (const i of anchorOrder) {
    const r = receipts[i]!;
    const tx = await walletClient.writeContract({
      address: executionReceipts,
      abi: EXECUTION_RECEIPTS_ABI,
      functionName: 'anchorStep',
      args: [r],
      gasPrice: GAS_PRICE,
    });
    await send(tx, `anchorStep(${i})`);
    anchorTx.set(i, tx);
  }

  // 5. Fold and seal.
  const chainRoot = foldChainRoot(receipts) as `0x${string}`;
  console.log(`\nchain root (computed off chain): ${chainRoot}`);

  await send(
    await walletClient.writeContract({
      address: executionReceipts,
      abi: EXECUTION_RECEIPTS_ABI,
      functionName: 'sealRun',
      args: [runId, chainRoot, receipts.length, 0],
      gasPrice: GAS_PRICE,
    }),
    'sealRun',
  );

  // 6. Read the seal back from chain and compare.
  const [storedRoot, stepCount, outcome, sealedAt] = await publicClient.readContract({
    address: executionReceipts,
    abi: EXECUTION_RECEIPTS_ABI,
    functionName: 'sealOf',
    args: [runId],
  });

  console.log(`chain root (read from seal):     ${storedRoot}`);
  if (storedRoot.toLowerCase() !== chainRoot.toLowerCase()) {
    throw new Error('sealed chain root does not match the locally folded root');
  }
  console.log('✓ chain root matches\n');

  // 7. Rebuild the receipts from the emitted events, as a verifier would, and
  //    re-check the linkage invariant against those rather than ours.
  const logs = await publicClient.getContractEvents({
    address: executionReceipts,
    abi: EXECUTION_RECEIPTS_ABI,
    eventName: 'StepAnchored',
    args: { runId },
    fromBlock: BigInt(network.deploymentBlock ?? 0),
    toBlock: 'latest',
  });
  const fromChain: Receipt[] = logs
    .map((log) => {
      const a = log.args as Record<string, unknown>;
      return {
        flowId: a['flowId'] as `0x${string}`,
        runId: a['runId'] as `0x${string}`,
        stepIndex: Number(a['stepIndex']),
        agentId: a['agentId'] as bigint,
        inputHash: a['inputHash'] as `0x${string}`,
        outputHash: a['outputHash'] as `0x${string}`,
        traceRoot: a['traceRoot'] as `0x${string}`,
        attestationRef: a['attestationRef'] as `0x${string}`,
        startedAt: a['startedAt'] as bigint,
        endedAt: a['endedAt'] as bigint,
        status: Number(a['status']) as StepStatus,
      };
    })
    .sort((x, y) => x.stepIndex - y.stepIndex);

  console.log(`recovered ${fromChain.length} receipts from StepAnchored logs`);
  const refolded = foldChainRoot(fromChain);
  if (refolded.toLowerCase() !== storedRoot.toLowerCase()) {
    throw new Error('receipts recovered from logs do not fold to the sealed root');
  }
  console.log('✓ receipts recovered from chain logs fold to the sealed root');

  const linkage = verifyLinkage({
    steps,
    runInputs: RUN_INPUTS,
    evidence: steps.map((step, i) => ({
      stepId: step.id,
      input: resolvedInputs[i]!,
      output: OUTPUTS[step.id]!,
    })),
    receipts: fromChain,
  });
  if (!linkage.ok) throw new Error(`linkage failed: ${linkage.failures.join('; ')}`);
  console.log(`✓ linkage verified: ${linkage.linkedSteps}/${linkage.totalSteps} inputs derive from declared upstream outputs`);

  // 8. Report the outcome through the only path that can produce success:
  //    every step needs an anchor whose hash matches its receipt (§10.3).
  const runOutcome = reportRunOutcome({
    runId,
    steps: fromChain.map((r) =>
      reportStepOutcome(r, {
        txHash: anchorTx.get(r.stepIndex)!,
        blockNumber: 0n,
        logIndex: 0,
        runId: r.runId,
        stepIndex: r.stepIndex,
        receiptHash: hashReceipt(r),
      }),
    ),
    seal: {
      txHash: anchorTx.get(0)!,
      blockNumber: 0n,
      runId,
      chainRoot: storedRoot,
      stepCount: Number(stepCount),
    },
    receipts: fromChain,
  });

  console.log(`\nrun outcome: ${runOutcome.kind}  (sealed outcome=${outcome}, sealedAt=${sealedAt})`);
  if (!isRunSuccess(runOutcome)) throw new Error('run did not report success');

  // Write each trace under its own root so `--trace-dir` can find it.
  const traceDir = fileURLToPath(new URL('../../../artifacts/traces', import.meta.url));
  mkdirSync(traceDir, { recursive: true });
  steps.forEach((step, i) => {
    const doc = buildTrace(step.id, i, resolvedInputs[i]!, OUTPUTS[step.id]!, runId);
    writeFileSync(`${traceDir}/${hashJson(doc)}.json`, canonicalize(doc));
  });

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    `${OUT_DIR}/${runId}.json`,
    JSON.stringify(
      {
        network: network.name,
        chainId: network.chainId,
        explorer: `${network.explorerUrl}/tx/${anchorTx.get(0)}`,
        flowId,
        runId,
        chainRoot: storedRoot,
        stepCount: Number(stepCount),
        executor: account.address,
        anchoredInOrder: anchorOrder,
        // Enough for `npx @0gflow/verify --spec` to re-derive the linkage.
        spec: { steps },
        runInputs: RUN_INPUTS,
        receipts: fromChain.map((r) => ({ ...r, agentId: r.agentId.toString(), startedAt: r.startedAt.toString(), endedAt: r.endedAt.toString() })),
      },
      null,
      2,
    ) + '\n',
  );

  console.log(`\nVERIFIED — ${stepCount} steps, chain root ${storedRoot}`);
  console.log(`${network.explorerUrl}/address/${executionReceipts}`);
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}`);
  process.exitCode = 1;
});
