/**
 * npx @0gflow/verify <runId> — spec §9.
 *
 * Verifies a run from public data alone: chain logs, 0G Storage, and the agent
 * registry. Nothing here trusts the operator's account of what happened.
 */
import { mkdtempSync, copyFileSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GALILEO, requireAddress } from '@0gflow/config';
import { canonicalize } from '@0gflow/core';
import { FallbackTraceSource, JsonRpcChainSource, LocalTraceSource, ZgStorageTraceSource, } from './sources.js';
import { verifyRun } from './verify.js';
import { exitCodeFor, renderReport } from './report.js';
const USAGE = `
0gflow-verify — independently verify a 0G Flow run

  npx @0gflow/verify <runId> [options]

Options
  --rpc <url>          JSON-RPC endpoint          (default: Galileo)
  --contract <addr>    ExecutionReceipts address  (default: from config)
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
export function parseArgs(argv) {
    const args = { runId: null, tamper: false, json: false, help: false };
    const flags = {
        '--rpc': 'rpc',
        '--contract': 'contract',
        '--registry': 'registry',
        '--from-block': 'fromBlock',
        '--indexer': 'indexer',
        '--spec': 'spec',
        '--inputs': 'inputs',
        '--trace-dir': 'traceDir',
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--tamper')
            args.tamper = true;
        else if (arg === '--json')
            args.json = true;
        else if (arg === '--help' || arg === '-h')
            args.help = true;
        else if (arg in flags) {
            const next = argv[++i];
            if (next === undefined)
                throw new Error(`${arg} needs a value`);
            args[flags[arg]] = next;
        }
        else if (arg.startsWith('--')) {
            throw new Error(`unknown option ${arg}`);
        }
        else if (args.runId === null) {
            args.runId = (arg.startsWith('0x') ? arg : `0x${arg}`).toLowerCase();
        }
        else {
            throw new Error(`unexpected argument ${arg}`);
        }
    }
    return args;
}
/**
 * Accepts either a flow spec (has `steps`) or a bundle carrying both the spec
 * and the run's input values, so a run artifact can be passed directly.
 */
export function loadSpec(specPath, inputsPath) {
    const raw = JSON.parse(readFileSync(specPath, 'utf8'));
    const body = ('steps' in raw ? raw : raw['spec']) ?? {};
    const steps = body['steps'];
    if (!Array.isArray(steps)) {
        throw new Error(`${specPath} has no "steps" array; expected a flow spec or a run bundle`);
    }
    let inputs = (raw['inputs'] ?? {});
    if (inputsPath !== undefined) {
        inputs = JSON.parse(readFileSync(inputsPath, 'utf8'));
    }
    else if ('runInputs' in raw) {
        inputs = raw['runInputs'];
    }
    return {
        steps: steps.map((s) => {
            const step = s;
            const needs = step['needs'];
            return {
                id: String(step['id']),
                input: (step['input'] ?? {}),
                ...(Array.isArray(needs) ? { needs: needs.map(String) } : {}),
            };
        }),
        inputs,
    };
}
function buildTraceSource(network, args) {
    const storage = new ZgStorageTraceSource(args.indexer ?? network.storageIndexerUrl);
    if (args.traceDir === undefined)
        return storage;
    // Storage first: a local copy is only a fallback, and must never mask a
    // trace that is genuinely retrievable.
    return new FallbackTraceSource([storage, new LocalTraceSource(args.traceDir)]);
}
/**
 * §9 `--tamper`: copy the traces, mutate one, and verify against the mutated
 * copy. Detection means the run FAILS — so a clean exit here would mean the
 * tampering went unnoticed.
 */
async function runTamperDemo(network, args, base) {
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
    for (const file of files)
        copyFileSync(join(args.traceDir, file), join(scratch, file));
    const target = files[0];
    const path = join(scratch, target);
    const trace = JSON.parse(readFileSync(path, 'utf8'));
    const before = canonicalize(trace['output']);
    trace['output'] = { ...trace['output'], tamperedBy: '0gflow-verify --tamper' };
    writeFileSync(path, JSON.stringify(trace));
    console.log('\n  --tamper: mutating a stored trace to demonstrate detection');
    console.log(`  trace   ${target}`);
    console.log(`  before  ${before}`);
    console.log(`  after   ${canonicalize(trace['output'])}`);
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
export async function main(argv) {
    let args;
    try {
        args = parseArgs(argv);
    }
    catch (error) {
        console.error(`${error.message}\n${USAGE}`);
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
    const contract = (args.contract ?? requireAddress(network, 'executionReceipts'));
    const registry = (args.registry ?? network.contracts.identityRegistry);
    const fromBlock = BigInt(args.fromBlock ?? network.deploymentBlock ?? 0);
    let spec = null;
    if (args.spec !== undefined) {
        if (!existsSync(args.spec)) {
            console.error(`--spec file not found: ${args.spec}`);
            return 2;
        }
        try {
            spec = loadSpec(args.spec, args.inputs);
        }
        catch (error) {
            console.error(`--spec: ${error.message}`);
            return 2;
        }
    }
    const base = {
        runId: args.runId,
        chain: new JsonRpcChainSource(args.rpc ?? network.rpcUrl, contract, fromBlock),
        traces: buildTraceSource(network, args),
        identityRegistry: registry,
        spec,
    };
    if (args.tamper)
        return runTamperDemo(network, args, base);
    let report;
    try {
        report = await verifyRun(base);
    }
    catch (error) {
        console.error(`\n  verification could not run: ${error.message}\n`);
        return 2;
    }
    if (args.json) {
        console.log(JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
    }
    else {
        console.log(renderReport(report, {
            networkName: network.displayName,
            chainId: network.chainId,
            contract,
        }));
    }
    return exitCodeFor(report.verdict);
}
//# sourceMappingURL=cli.js.map