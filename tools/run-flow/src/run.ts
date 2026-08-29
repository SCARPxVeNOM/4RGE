/**
 * Executes a flow against the deployed contracts on 0G Galileo, using the
 * reference agents over real HTTP — spec §11 Phase 3.
 *
 *   pnpm --filter @0gflow/run-flow flow -- success
 *   pnpm --filter @0gflow/run-flow flow -- unattested
 *   pnpm --filter @0gflow/run-flow flow -- failure
 *   pnpm --filter @0gflow/run-flow flow -- all
 *
 * Requires a funded key in ZG_PRIVATE_KEY. Writes each run's traces and a
 * bundle the verifier can consume with --spec and --trace-dir.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { networkFromEnv, requireAddress } from '@0gflow/config';

// One binding for the whole run. Reading ZG_NETWORK once and threading the
// result means a flow cannot end up half on one chain and half on another —
// which would anchor receipts a verifier could never find.
const NETWORK = networkFromEnv();
import { keccak256, StepStatus, type Hex } from '@0gflow/core';
import { executeRun, LocalTraceStore, ViemChainWriter } from '@0gflow/executor';
import { ZgStorageTraceStore } from '@0gflow/storage';
import { ViemSignerRegistry } from '@0gflow/executor';
import { createTeeAgentServer } from '@0gflow/tee-agent';
import { createAgentServer } from '@0gflow/reference-agents';
import { BOUND_SCENARIO, SCENARIOS, SCENARIOS_BY_KEY, type Scenario } from './flows.js';

const ARTIFACTS = fileURLToPath(new URL('../../../artifacts', import.meta.url));
const RUN_DIR = `${ARTIFACTS}/runs`;
const TRACE_DIR = `${ARTIFACTS}/traces`;

const privateKey = process.env['ZG_PRIVATE_KEY'];
if (privateKey === undefined || privateKey.length === 0) {
  console.error('ZG_PRIVATE_KEY is not set.');
  process.exit(1);
}

const STATUS_NAME = ['ok', 'failed', 'skipped', 'unattested'];

/**
 * 0G Storage when it will take the traces, the local directory when it will
 * not.
 *
 * The difference is the verdict: a locally stored trace proves the executor
 * kept a copy, not that a third party can fetch one, and the verifier reports
 * INCOMPLETE for exactly that reason. Falling back silently would hide which
 * of the two a given run actually achieved, so the choice is announced.
 */
async function chooseTraceStore(): Promise<{ describe: string; put: LocalTraceStore['put'] }> {
  const key = process.env['ZG_PRIVATE_KEY'];
  if (key === undefined || key.length === 0) return new LocalTraceStore(TRACE_DIR);

  const store = new ZgStorageTraceStore({
    rpcUrl: NETWORK.rpcUrl,
    indexerUrl: NETWORK.storageIndexerUrl,
    privateKey: key,
  });

  // Probe with a throwaway trace rather than discovering mid-run that storage
  // is unavailable, which would leave some steps anchored against roots
  // nobody can resolve.
  try {
    await store.put({ probe: '0gflow storage availability', at: new Date().toISOString() });
    console.log(`traces   ${store.describe}`);
    return store;
  } catch (error) {
    console.log(`traces   0G Storage unavailable (${(error as Error).message.slice(0, 90)})`);
    console.log('         falling back to the local directory; runs will verify as INCOMPLETE');
    return new LocalTraceStore(TRACE_DIR);
  }
}

async function runScenario(
  scenario: Scenario,
  agentBase: string,
  chain: ViemChainWriter,
  traces: Awaited<ReturnType<typeof chooseTraceStore>>,
  teeBase: string | null,
) {
  const runId = keccak256(randomBytes(32)) as Hex;

  console.log(`\n${'='.repeat(72)}`);
  console.log(`${scenario.key}: ${scenario.description}`);
  console.log(`expect: ${scenario.expect}`);
  console.log(`runId:  ${runId}`);
  console.log('');

  const result = await executeRun({
    spec: scenario.spec,
    inputs: scenario.inputs,
    runId,
    chain,
    traces,
    endpointFor: (step) => {
      const agent = scenario.agentFor[step.id] ?? step.id;
      // 'tee' is the 0G Compute agent on its own server, not a reference agent.
      if (agent === 'tee') {
        if (teeBase === null) throw new Error('the tee agent was not started');
        return teeBase;
      }
      return `${agentBase}/agents/${agent}`;
    },
    // Resolves each provider's acknowledged TEE signer from 0G's registry.
    // Without it a binding has nothing to be checked against and the step
    // could reach no more than `present`.
    signers: new ViemSignerRegistry({
      rpcUrl: NETWORK.rpcUrl,
      inferenceServing: requireAddress(NETWORK, 'inferenceServing'),
    }),
    // Off, so a failure does not mask what the rest of the run would have
    // done; the skip then demonstrably comes from the dependency, not a
    // global halt.
    failFast: false,
  });

  for (const step of result.steps) {
    const label = `[${step.stepIndex}] ${step.stepId}`.padEnd(18);
    console.log(
      `  ${label} ${STATUS_NAME[step.status]?.padEnd(11) ?? step.status}` +
        ` attestation ${step.attestationRef === `0x${'00'.repeat(32)}` ? 'none' : 'recorded'}` +
        (step.error === null ? '' : `\n      ${step.error}`),
    );
  }

  console.log('');
  console.log(`  chain root ${result.chainRoot}`);
  console.log(`  outcome    ${result.outcome} (${STATUS_NAME[result.outcome]})`);
  console.log(`  succeeded  ${result.succeeded}`);

  mkdirSync(RUN_DIR, { recursive: true });
  writeFileSync(
    `${RUN_DIR}/${runId}.json`,
    JSON.stringify(
      {
        scenario: scenario.key,
        description: scenario.description,
        network: NETWORK.name,
        chainId: NETWORK.chainId,
        runId,
        flowId: result.flowId,
        chainRoot: result.chainRoot,
        outcome: result.outcome,
        succeeded: result.succeeded,
        executor: chain.executorAddress,
        // Enough for `npx @0gflow/verify --spec <this file>` to re-derive
        // the linkage invariant independently.
        spec: { steps: scenario.spec.steps },
        runInputs: scenario.inputs,
        // Named stepResults, not steps: a sibling `steps` key would be
        // ambiguous with the flow spec's own steps.
        stepResults: result.steps.map((s) => ({
          stepId: s.stepId,
          stepIndex: s.stepIndex,
          status: s.status,
          statusName: STATUS_NAME[s.status],
          traceRoot: s.traceRoot,
          txHash: s.anchor.txHash,
          error: s.error,
        })),
      },
      null,
      2,
    ) + '\n',
  );

  return { runId, result };
}

async function main() {
  const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const keys = requested.length === 0 || requested[0] === 'all' ? SCENARIOS.map((s) => s.key) : requested;

  for (const key of keys) {
    if (!SCENARIOS_BY_KEY.has(key)) {
      console.error(`unknown scenario "${key}"; known: ${[...SCENARIOS_BY_KEY.keys()].join(', ')}, all`);
      process.exit(2);
    }
  }

  const agents = createAgentServer();
  await new Promise<void>((resolve) => agents.listen(0, '127.0.0.1', resolve));
  const agentBase = `http://127.0.0.1:${(agents.address() as AddressInfo).port}`;

  // The `bound` scenario needs a live enclave, so its agent is only started
  // when that scenario was asked for — every other run stays free of a paid
  // 0G Compute dependency.
  let tee: Awaited<ReturnType<typeof createTeeAgentServer>> | null = null;
  let teeBase: string | null = null;
  if (keys.includes('bound')) {
    tee = await createTeeAgentServer({ rpcUrl: NETWORK.rpcUrl, privateKey: privateKey! });
    await new Promise<void>((resolve) => tee!.server.listen(0, '127.0.0.1', resolve));
    teeBase = `http://127.0.0.1:${(tee.server.address() as AddressInfo).port}`;
  }

  const chain = new ViemChainWriter({ network: NETWORK, privateKey: privateKey! });

  console.log('0G Flow — live execution');
  console.log(`network  ${NETWORK.displayName} (${NETWORK.chainId})`);
  console.log(`executor ${chain.executorAddress}`);
  console.log(`balance  ${Number(await chain.balance()) / 1e18} ${NETWORK.nativeToken}`);
  console.log(`agents   ${agentBase}`);
  if (tee !== null) {
    console.log(`tee      ${teeBase}`);
    console.log(`         provider ${tee.provider}`);
    console.log(`         signer   ${tee.teeSigner} (acknowledged on chain)`);
    console.log(`         model    ${tee.model}`);
  }

  const traces = await chooseTraceStore();

  const completed: Array<{ key: string; runId: Hex; outcome: number }> = [];
  try {
    for (const key of keys) {
      const scenario = SCENARIOS_BY_KEY.get(key)!;
      const { runId, result } = await runScenario(
        scenario,
        agentBase,
        chain,
        traces,
        teeBase,
      );
      completed.push({ key, runId, outcome: result.outcome });
    }
  } finally {
    await new Promise<void>((resolve) => agents.close(() => resolve()));
    if (tee !== null) await new Promise<void>((resolve) => tee!.server.close(() => resolve()));
  }

  console.log(`\n${'='.repeat(72)}`);
  console.log('verify each of these independently:\n');
  for (const run of completed) {
    console.log(`  # ${run.key} (outcome ${run.outcome} ${STATUS_NAME[run.outcome]})`);
    console.log(
      `  node packages/verify/dist/verify.mjs ${run.runId} \\\n    --spec artifacts/runs/${run.runId}.json --trace-dir artifacts/traces\n`,
    );
  }
  console.log(`balance remaining ${Number(await chain.balance()) / 1e18} ${NETWORK.nativeToken}`);

  // A run that did not seal, or a scenario whose outcome contradicts what it
  // was built to demonstrate, is a failure of this harness.
  const expected: Record<string, number> = {
    success: StepStatus.Ok,
    // The point of the scenario: a real enclave signature that covers the
    // output must anchor ok, not unattested.
    bound: StepStatus.Ok,
    unattested: StepStatus.Unattested,
    failure: StepStatus.Failed,
  };
  for (const run of completed) {
    const want = expected[run.key];
    if (want !== undefined && run.outcome !== want) {
      console.error(`\n✗ ${run.key} sealed outcome ${run.outcome}, expected ${want}`);
      process.exitCode = 1;
    }
  }
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}`);
  process.exitCode = 1;
});
