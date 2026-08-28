/**
 * npx @0gflow/verify <runId> — spec §9.
 *
 * Verifies a run from public data alone: chain logs, 0G Storage, and the agent
 * registry. Nothing here trusts the operator's account of what happened.
 */

import { mkdtempSync, copyFileSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GALILEO, requireAddress, type Network } from '@0gflow/config';
import { canonicalize, type Hex, type JsonValue } from '@0gflow/core';
import {
  FallbackTraceSource,
  JsonRpcChainSource,
  LocalTraceSource,
  ZgStorageTraceSource,
  type TraceSource,
} from './sources.js';
import { verifyRun, type SpecForLinkage, type VerificationReport } from './verify.js';
import { exitCodeFor, renderReport } from './report.js';

const USAGE = `
0gflow-verify — independently verify a 0G Flow run

  npx @0gflow/verify <runId> [options]

Options
  --rpc <url>          JSON-RPC endpoint          (default: Galileo)
  --contract <addr>    ExecutionReceipts address  (default: from config)
  --adapters <addr>    AgentAdapterRegistryV2, for checking agent signatures
  --registry <addr>    Agent identity registry    (default: from config)
  --from-block <n>     Log scan start             (default: deployment block)
  --indexer <url>      0G Storage indexer         (default: from config)
  --spec <file>        Flow spec, for the linkage check (§9 step 4)
  --inputs <file>      Run input values, if not carried in --spec
  --trace-dir <dir>    Read traces from disk when 0G Storage is unavailable
  --tamper             Mutate a stored trace and demonstrate detection
  --json               Emit the report as JSON
  --help

Exit codes
  0  VERIFIED    every check ran and passed against retrievable public data
  1  FAILED      a check ran and did not pass
  2  INCOMPLETE  evidence was missing, so some check could not run
`;

interface Args {
  [key: string]: unknown;
  runId: Hex | null;
  rpc?: string;
  contract?: string;
  registry?: string;
  fromBlock?: string;
  indexer?: string;
  spec?: string;
  inputs?: string;
  traceDir?: string;
  tamper: boolean;
  json: boolean;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { runId: null, tamper: false, json: false, help: false };
  const flags: Record<string, keyof Args> = {
    '--rpc': 'rpc',
    '--contract': 'contract',
    '--adapters': 'adapters',
    '--registry': 'registry',
    '--from-block': 'fromBlock',
    '--indexer': 'indexer',
    '--spec': 'spec',
    '--inputs': 'inputs',
    '--trace-dir': 'traceDir',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--tamper') args.tamper = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg in flags) {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      args[flags[arg]!] = next;
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option ${arg}`);
    } else if (args.runId === null) {
      args.runId = (arg.startsWith('0x') ? arg : `0x${arg}`).toLowerCase() as Hex;
    } else {
      throw new Error(`unexpected argument ${arg}`);
    }
  }
  return args;
}

/**
 * Accepts either a flow spec (has `steps`) or a bundle carrying both the spec
 * and the run's input values, so a run artifact can be passed directly.
 */
export function loadSpec(specPath: string, inputsPath: string | undefined): SpecForLinkage {
  const raw = JSON.parse(readFileSync(specPath, 'utf8')) as Record<string, unknown>;
  // An explicit `spec` wrapper wins. A run artifact carries both the flow spec
  // and a per-step summary of what happened, and both are plausibly called
  // "steps"; picking the summary yields steps with no id or input, and linkage
  // then fails against a run that is actually sound.
  const wrapper = raw['spec'] as Record<string, unknown> | undefined;
  const body = (wrapper !== undefined && Array.isArray(wrapper['steps']) ? wrapper : raw) ?? {};
  const steps = body['steps'];
  if (!Array.isArray(steps)) {
    throw new Error(`${specPath} has no "steps" array; expected a flow spec or a run bundle`);
  }

  let inputs: JsonValue = (raw['inputs'] ?? {}) as JsonValue;
  if (inputsPath !== undefined) {
    inputs = JSON.parse(readFileSync(inputsPath, 'utf8')) as JsonValue;
  } else if ('runInputs' in raw) {
    inputs = raw['runInputs'] as JsonValue;
  }

  return {
    steps: steps.map((s, i) => {
      const step = s as Record<string, unknown>;
      const needs = step['needs'];
      if (typeof step['id'] !== 'string' || step['id'].length === 0) {
        // Refusing beats checking linkage for a step called "undefined".
        throw new Error(
          `${specPath}: step ${i} has no "id"; this looks like a run summary rather than a flow spec`,
        );
      }
      return {
        id: String(step['id']),
        input: (step['input'] ?? {}) as JsonValue,
        ...(Array.isArray(needs) ? { needs: needs.map(String) } : {}),
      };
    }),
    inputs,
  };
}

function buildTraceSource(network: Network, args: Args): TraceSource {
  const storage = new ZgStorageTraceSource(args.indexer ?? network.storageIndexerUrl);
  if (args.traceDir === undefined) return storage;
  // Storage first: a local copy is only a fallback, and must never mask a
  // trace that is genuinely retrievable.
  return new FallbackTraceSource([storage, new LocalTraceSource(args.traceDir)]);
}

/**
 * §9 `--tamper`: copy the traces, mutate one, and verify against the mutated
 * copy. Detection means the run FAILS — so a clean exit here would mean the
 * tampering went unnoticed.
 */
async function runTamperDemo(
  network: Network,
  args: Args,
  base: Parameters<typeof verifyRun>[0],
): Promise<number> {
  if (args.traceDir === undefined) {
    console.error('--tamper needs --trace-dir: it mutates a copy of the stored traces.');
    return 2;
  }

  const files = readdirSync(args.traceDir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    console.error(`--tamper found no traces in ${args.traceDir}`);
    return 2;
  }

  const scratch = mkdtempSync(join(tmpdir(), '0gflow-tamper-'));
  for (const file of files) copyFileSync(join(args.traceDir, file), join(scratch, file));

  const target = files[0]!;
  const path = join(scratch, target);
  const trace = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const before = canonicalize(trace['output'] as JsonValue);
  trace['output'] = { ...(trace['output'] as object), tamperedBy: '0gflow-verify --tamper' };
  writeFileSync(path, JSON.stringify(trace));

  console.log('\n  --tamper: mutating a stored trace to demonstrate detection');
  console.log(`  trace   ${target}`);
  console.log(`  before  ${before}`);
  console.log(`  after   ${canonicalize(trace['output'] as JsonValue)}`);

  const tampered = await verifyRun({
    ...base,
    traces: new LocalTraceSource(scratch),
  });

  console.log(renderReport(tampered, {
    networkName: network.displayName,
    chainId: network.chainId,
    contract: args.contract ?? requireAddress(network, 'executionReceipts'),
  }));

  if (tampered.verdict === 'failed') {
    console.log('  TAMPER DETECTED — the mutated trace no longer matches the anchored receipt.\n');
    return 0;
  }
  console.error('  TAMPERING WENT UNDETECTED — this is a defect in the verifier.\n');
  return 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }

  if (args.help || args.runId === null) {
    console.log(USAGE);
    return args.help ? 0 : 2;
  }
  if (!/^0x[0-9a-f]{64}$/.test(args.runId)) {
    console.error(`runId must be 32 bytes of hex, got ${args.runId}`);
    return 2;
  }

  const network = GALILEO;
  const contract = (args.contract ?? requireAddress(network, 'executionReceipts')) as Hex;
  const registry = (args.registry ?? network.contracts.identityRegistry) as Hex | null;
  const fromBlock = BigInt(args.fromBlock ?? network.deploymentBlock ?? 0);
  const adapters = (args.adapters ?? network.contracts.agentAdapterRegistryV2 ?? null) as Hex | null;

  let spec: SpecForLinkage | null = null;
  if (args.spec !== undefined) {
    if (!existsSync(args.spec)) {
      console.error(`--spec file not found: ${args.spec}`);
      return 2;
    }
    try {
      spec = loadSpec(args.spec, args.inputs);
    } catch (error) {
      console.error(`--spec: ${(error as Error).message}`);
      return 2;
    }
  }

  const base = {
    runId: args.runId,
    chain: new JsonRpcChainSource(
      args.rpc ?? network.rpcUrl,
      contract,
      fromBlock,
      30_000,
      // 0G's InferenceServing, for resolving a provider's acknowledged TEE
      // signer. Without it attestations cannot rise above `present`.
      network.contracts.inferenceServing,
    ),
    traces: buildTraceSource(network, args),
    identityRegistry: registry,
    spec,
    // All three or none: a digest recomputed against the wrong chain or the
    // wrong receipts address fails in a way indistinguishable from forgery.
    ...(adapters === null
      ? {}
      : { agentIdentity: { registry: adapters, receipts: contract, chainId: network.chainId } }),
  };

  if (args.tamper) return runTamperDemo(network, args, base);

  let report: VerificationReport;
  try {
    report = await verifyRun(base);
  } catch (error) {
    console.error(`\n  verification could not run: ${(error as Error).message}\n`);
    return 2;
  }

  if (args.json) {
    console.log(
      JSON.stringify(report, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2),
    );
  } else {
    console.log(
      renderReport(report, {
        networkName: network.displayName,
        chainId: network.chainId,
        contract,
      }),
    );
  }
  return exitCodeFor(report.verdict);
}
