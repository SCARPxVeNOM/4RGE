/**
 * Agent identity, end to end through the executor.
 *
 * The claim under test is narrow and load bearing: a receipt's `agentId` is a
 * fact rather than a claim, but only when the step asked for it and the agent
 * actually signed. Every other case must record Unattested — not Ok, and not
 * a crash.
 *
 * These run against a real HTTP agent using the real adapter SDK, because the
 * failure this guards against is precisely two components disagreeing about
 * what gets hashed. A fake agent that reimplemented the digest would test the
 * test.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { privateKeyToAccount } from 'viem/accounts';
import { StepStatus, hashJson, type Hex, type JsonValue, type Receipt } from '@0gflow/core';
import { handleInvoke, signOutput, type AgentDefinition } from '@0gflow/adapter-sdk';
import {
  executeRun,
  type AgentRegistry,
  type AnchorReceipt,
  type ChainWriter,
  type TraceStore,
} from '../src/execute.js';
import type { FlowSpec } from '../src/plan.js';

const AGENT_KEY = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';
const IMPOSTER_KEY = '0x0123456789012345678901234567890123456789012345678901234567890123';
const ACCOUNT = privateKeyToAccount(AGENT_KEY);
const IMPOSTER = privateKeyToAccount(IMPOSTER_KEY);

const CHAIN_ID = 31337;
const RECEIPTS = '0x741a36faba40ee71223539a5a062fdedc8574e30' as Hex;

/** The signing key each path uses, keyed by the agent's URL segment. */
const KEY_FOR: Record<string, typeof ACCOUNT> = {
  honest: ACCOUNT,
  imposter: IMPOSTER,
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const path = req.url ?? '';
        const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString()) as unknown) : {};
        const name = path.split('/')[2] ?? '';

        const agent: AgentDefinition = {
          agentId: '7',
          schema: { input: {}, output: {} },
          async invoke(request) {
            const output = { text: `handled ${String(request.input['topic'] ?? '')}` };

            // The unsigned agent is the pre-marketplace default: it works, it
            // just cannot prove who it is.
            if (name === 'unsigned') return { output };

            const account = KEY_FOR[name] ?? ACCOUNT;
            const { signature } = await signOutput(
              { request, agentId: '7', output },
              (digest) => account.signMessage({ message: { raw: digest as Hex } }),
            );
            return { output, outputSignature: signature };
          },
        };

        const result = await handleInvoke(agent, body);
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result.body));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

class FakeChain implements ChainWriter {
  readonly executorAddress = '0x00000000000000000000000000000000000000e1' as Hex;
  readonly chainId = CHAIN_ID;
  readonly receiptsAddress = RECEIPTS;
  readonly anchored: Receipt[] = [];
  sealed = false;

  async isFlowPublished() { return true; }
  async publishFlow() {}
  async startRun() {}
  async anchorStep(receipt: Receipt): Promise<AnchorReceipt> {
    this.anchored.push(receipt);
    return { txHash: `0x${'ab'.repeat(32)}` as Hex, blockNumber: 1n, logIndex: 0 };
  }
  async sealRun() {
    this.sealed = true;
    return { txHash: `0x${'ef'.repeat(32)}` as Hex, blockNumber: 2n };
  }
}

class FakeTraces implements TraceStore {
  readonly describe = 'fake';
  readonly stored = new Map<string, JsonValue>();
  async put(trace: JsonValue) {
    const root = hashJson(trace) as Hex;
    this.stored.set(root, trace);
    return { traceRoot: root };
  }
}

/** Stands in for AgentAdapterRegistryV2.signerOf. */
class FakeAgents implements AgentRegistry {
  readonly asked: bigint[] = [];
  constructor(private readonly signer: Hex | null) {}
  async agentSigner(agentId: bigint) {
    this.asked.push(agentId);
    return this.signer;
  }
}

/** A registry that is down, which must establish nothing rather than throw. */
class BrokenAgents implements AgentRegistry {
  async agentSigner(): Promise<Hex> {
    throw new Error('rpc unreachable');
  }
}

function flow(agentName: string, requireSignedOutput: boolean): FlowSpec {
  return {
    version: '0gflow/1',
    name: 'identity-flow',
    inputs: { topic: { type: 'string' } },
    steps: [{ id: 'work', agent: '7', input: { topic: '{{ inputs.topic }}' }, requireSignedOutput }],
  };
}

async function run(options: {
  agentName: string;
  requireSignedOutput: boolean;
  agents?: AgentRegistry;
}) {
  const chain = new FakeChain();
  const traces = new FakeTraces();
  const result = await executeRun({
    spec: flow(options.agentName, options.requireSignedOutput),
    inputs: { topic: 'markets' },
    runId: `0x${'22'.repeat(32)}` as Hex,
    chain,
    traces,
    endpointFor: () => `${base}/agents/${options.agentName}/invoke`,
    ...(options.agents === undefined ? {} : { agents: options.agents }),
  });
  const trace = [...traces.stored.values()][0] as Record<string, JsonValue>;
  return { result, chain, trace };
}

describe('a step that requires a signed output', () => {
  test('is Ok when the agent signs with its registered key', async () => {
    const { result } = await run({
      agentName: 'honest',
      requireSignedOutput: true,
      agents: new FakeAgents(ACCOUNT.address as Hex),
    });

    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
    expect(result.succeeded).toBe(true);
  });

  /// The attack the whole feature exists to stop: a receipt claiming an agent
  /// that did not do the work.
  test('is Unattested when another key signed', async () => {
    const { result } = await run({
      agentName: 'imposter',
      requireSignedOutput: true,
      agents: new FakeAgents(ACCOUNT.address as Hex),
    });

    expect(result.steps[0]?.status).toBe(StepStatus.Unattested);
    expect(result.succeeded).toBe(false);
  });

  test('is Unattested when the agent returned no signature at all', async () => {
    const { result } = await run({
      agentName: 'unsigned',
      requireSignedOutput: true,
      agents: new FakeAgents(ACCOUNT.address as Hex),
    });
    expect(result.steps[0]?.status).toBe(StepStatus.Unattested);
  });

  /// An agent that never published a key cannot be proven, however good its
  /// signature is. Unverifiable is not proven.
  test('is Unattested when the agent published no key', async () => {
    const { result } = await run({
      agentName: 'honest',
      requireSignedOutput: true,
      agents: new FakeAgents(null),
    });
    expect(result.steps[0]?.status).toBe(StepStatus.Unattested);
  });

  /// Omitting the registry is a configuration mistake, and it must fail
  /// closed. Treating "I could not check" as a pass is the promotion §1.3
  /// forbids.
  test('is Unattested when no registry was supplied', async () => {
    const { result } = await run({ agentName: 'honest', requireSignedOutput: true });
    expect(result.steps[0]?.status).toBe(StepStatus.Unattested);
  });

  test('is Unattested when the registry is unreachable, not a crash', async () => {
    const { result } = await run({
      agentName: 'honest',
      requireSignedOutput: true,
      agents: new BrokenAgents(),
    });
    expect(result.steps[0]?.status).toBe(StepStatus.Unattested);
    // Still a sealed, verifiable run — an RPC outage does not abandon it.
    expect(result.sealed).toBe(true);
  });
});

describe('a step that does not require one', () => {
  /// The backwards-compatible case. Every existing flow omits
  /// requireSignedOutput, and none of them may start failing.
  test('is Ok even though the agent signed nothing', async () => {
    const { result } = await run({ agentName: 'unsigned', requireSignedOutput: false });
    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
    expect(result.succeeded).toBe(true);
  });

  /// An unproven identity does not retroactively fail a step nobody asked to
  /// prove — but it must not be recorded as valid either.
  test('is Ok when an imposter signed, and the trace says so', async () => {
    const { result, trace } = await run({
      agentName: 'imposter',
      requireSignedOutput: false,
      agents: new FakeAgents(ACCOUNT.address as Hex),
    });
    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
    expect((trace['outputIdentity'] as Record<string, JsonValue>)['valid']).toBe(false);
  });
});

describe('the trace records the evidence, not just the verdict', () => {
  test('carries the signature and the registered signer', async () => {
    const { trace } = await run({
      agentName: 'honest',
      requireSignedOutput: true,
      agents: new FakeAgents(ACCOUNT.address as Hex),
    });

    const identity = trace['outputIdentity'] as Record<string, JsonValue>;
    expect(identity['valid']).toBe(true);
    expect(identity['signature']).toMatch(/^0x[0-9a-f]{130}$/);
    // A verifier recovers an address from the signature and compares it
    // against the registry itself; the recorded signer is what to compare to.
    expect(String(identity['registeredSigner']).toLowerCase()).toBe(
      ACCOUNT.address.toLowerCase(),
    );
  });

  test('names the agent the receipt claims, so a verifier looks up the right key', async () => {
    const agents = new FakeAgents(ACCOUNT.address as Hex);
    const { chain } = await run({ agentName: 'honest', requireSignedOutput: true, agents });

    expect(agents.asked).toEqual([7n]);
    expect(chain.anchored[0]?.agentId).toBe(7n);
  });
});
