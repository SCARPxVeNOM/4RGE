/**
 * Registry-driven execution — §7 step 1.
 *
 * The behaviour that makes a marketplace work: a flow names an agent by token
 * id and the executor finds it, without whoever wrote the flow knowing
 * anything about who operates it.
 *
 * The refusals matter as much as the happy path. An agent that is unlisted, or
 * that its operator has deactivated, must produce a Failed receipt naming the
 * reason — not a crash, and certainly not a call to a stale endpoint.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StepStatus, hashJson, type Hex, type JsonValue, type Receipt } from '@0gflow/core';
import {
  executeRun,
  type AnchorReceipt,
  type ChainWriter,
  type TraceStore,
} from '../src/execute.js';
import type { AdapterResolver, ResolvedAdapter } from '../src/adapters.js';
import type { FlowSpec } from '../src/plan.js';

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ output: { ok: true }, attestation: null }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

class FakeChain implements ChainWriter {
  readonly executorAddress = '0x00000000000000000000000000000000000000e1' as Hex;
  readonly chainId = 31337;
  readonly receiptsAddress = '0x741a36faba40ee71223539a5a062fdedc8574e30' as Hex;
  readonly anchored: Receipt[] = [];
  async isFlowPublished() { return true; }
  async publishFlow() {}
  async startRun() {}
  async anchorStep(receipt: Receipt): Promise<AnchorReceipt> {
    this.anchored.push(receipt);
    return { txHash: `0x${'ab'.repeat(32)}` as Hex, blockNumber: 1n, logIndex: 0 };
  }
  async sealRun() {
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

/** Stands in for AgentAdapterRegistryV2.getAdapter. */
class FakeAdapters implements AdapterResolver {
  readonly asked: bigint[] = [];
  constructor(private readonly listing: Partial<ResolvedAdapter> | null) {}
  async resolve(agentId: bigint): Promise<ResolvedAdapter | null> {
    this.asked.push(agentId);
    if (this.listing === null) return null;
    return {
      agentId,
      kind: 0,
      endpoint: '',
      schemaRoot: `0x${'00'.repeat(32)}` as Hex,
      version: 1,
      active: true,
      payTo: `0x${'11'.repeat(20)}` as Hex,
      signer: `0x${'22'.repeat(20)}` as Hex,
      pricePerCall: 0n,
      metadataURI: '',
      ...this.listing,
    };
  }
}

const SPEC: FlowSpec = {
  version: '0gflow/1',
  name: 'registry-flow',
  inputs: {},
  steps: [{ id: 'work', agent: '4211', input: { q: 'hello' } }],
};

const run = (options: Parameters<typeof executeRun>[0] extends infer T ? Partial<T> : never) =>
  executeRun({
    spec: SPEC,
    inputs: {},
    runId: `0x${'22'.repeat(32)}` as Hex,
    chain: new FakeChain(),
    traces: new FakeTraces(),
    ...options,
  } as Parameters<typeof executeRun>[0]);

describe('an agent resolved from the registry', () => {
  test('is invoked at the endpoint its owner published', async () => {
    const adapters = new FakeAdapters({ endpoint: `${base}/published/invoke` });
    const result = await run({ adapters });

    expect(adapters.asked).toEqual([4211n]);
    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
    expect(result.succeeded).toBe(true);
  });

  /// A flow naming an agent nobody listed must fail with a receipt that says
  /// so. The run stays a well-formed, verifiable failure (§1.3).
  test('that is unlisted produces a Failed receipt, not a crash', async () => {
    const result = await run({ adapters: new FakeAdapters(null) });

    expect(result.steps[0]?.status).toBe(StepStatus.Failed);
    expect(result.steps[0]?.error).toMatch(/not listed in the adapter registry/);
    expect(result.sealed).toBe(true);
  });

  /// Deactivation is the one signal an operator has for "do not hire me right
  /// now". Calling anyway would ignore it.
  test('that is deactivated is not called', async () => {
    const result = await run({
      adapters: new FakeAdapters({ endpoint: `${base}/published/invoke`, active: false }),
    });

    expect(result.steps[0]?.status).toBe(StepStatus.Failed);
    expect(result.steps[0]?.error).toMatch(/not active/);
  });

  test('that is listed with an empty endpoint is refused', async () => {
    const result = await run({ adapters: new FakeAdapters({ endpoint: '' }) });
    expect(result.steps[0]?.status).toBe(StepStatus.Failed);
    expect(result.steps[0]?.error).toMatch(/empty endpoint/);
  });
});

describe('the caller-supplied callback', () => {
  /// The offline path every existing flow and test uses. It must keep working
  /// with no registry in sight.
  test('still works with no registry at all', async () => {
    const result = await run({ endpointFor: () => `${base}/local/invoke` });
    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
  });

  /// An explicit local override is the more specific instruction, so it wins
  /// — and the registry is not even consulted.
  test('wins over the registry, which is not consulted', async () => {
    const adapters = new FakeAdapters({ endpoint: `${base}/published/invoke` });
    const result = await run({ endpointFor: () => `${base}/local/invoke`, adapters });

    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
    expect(adapters.asked).toEqual([]);
  });
});

describe('a run with no way to reach anything', () => {
  /// Refused before anything is published or anchored (§5.1). Discovering it
  /// at the first step would already have written a flow and a run to chain
  /// for a plan that was never executable.
  test('is refused up front, before touching the chain', async () => {
    const chain = new FakeChain();
    await expect(run({ chain })).rejects.toThrow(/supply endpointFor, or adapters/);
    expect(chain.anchored).toHaveLength(0);
  });
});
