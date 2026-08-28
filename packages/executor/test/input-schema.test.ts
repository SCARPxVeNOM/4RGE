/**
 * Validating a step's input against the schema its agent published — §7 step 3.
 *
 * The schema comes from the registry's `schemaRoot`, so it is the one the
 * agent committed to rather than whatever it is serving right now. An agent
 * cannot widen its contract after being hired against a narrower one.
 *
 * Two outcomes have to stay distinct, and the tests are mostly about keeping
 * them apart:
 *
 *   the schema was read and the input does not satisfy it   → Failed
 *   the schema could not be read                            → invoke anyway
 *
 * Collapsing the second into the first would make a storage outage look like
 * a bad flow. Collapsing the first into the second would make the check
 * decorative.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StepStatus, hashJson, ZERO_BYTES32, type Hex, type JsonValue, type Receipt } from '@0gflow/core';
import {
  executeRun,
  type AnchorReceipt,
  type ChainWriter,
  type SchemaResolver,
  type TraceStore,
} from '../src/execute.js';
import type { AdapterResolver, ResolvedAdapter } from '../src/adapters.js';
import type { FlowSpec } from '../src/plan.js';

const SCHEMA_ROOT = `0x${'99'.repeat(32)}` as Hex;

const PUBLISHED: JsonValue = {
  input: {
    type: 'object',
    required: ['repo'],
    properties: { repo: { type: 'string' }, depth: { type: 'integer' } },
  },
  output: { type: 'object' },
};

let server: Server;
let base: string;
let invocations = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      invocations += 1;
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
  async put(trace: JsonValue) {
    return { traceRoot: hashJson(trace) as Hex };
  }
}

class FakeAdapters implements AdapterResolver {
  constructor(private readonly schemaRoot: Hex = SCHEMA_ROOT) {}
  async resolve(agentId: bigint): Promise<ResolvedAdapter> {
    return {
      agentId,
      kind: 0,
      endpoint: `${base}/invoke`,
      schemaRoot: this.schemaRoot,
      version: 1,
      active: true,
      payTo: `0x${'11'.repeat(20)}` as Hex,
      signer: `0x${'22'.repeat(20)}` as Hex,
      pricePerCall: 0n,
      metadataURI: '',
    };
  }
}

class FakeSchemas implements SchemaResolver {
  readonly asked: string[] = [];
  constructor(private readonly doc: JsonValue | null, private readonly throws = false) {}
  async fetch(root: Hex): Promise<JsonValue | null> {
    this.asked.push(root.toLowerCase());
    if (this.throws) throw new Error('storage unreachable');
    return this.doc;
  }
}

const flow = (input: JsonValue): FlowSpec => ({
  version: '0gflow/1',
  name: 'schema-flow',
  inputs: {},
  steps: [{ id: 'work', agent: '7', input }],
});

async function run(options: {
  input: JsonValue;
  schemas?: SchemaResolver;
  adapters?: AdapterResolver;
}) {
  invocations = 0;
  const chain = new FakeChain();
  const result = await executeRun({
    spec: flow(options.input),
    inputs: {},
    runId: `0x${'22'.repeat(32)}` as Hex,
    chain,
    traces: new FakeTraces(),
    adapters: options.adapters ?? new FakeAdapters(),
    ...(options.schemas === undefined ? {} : { schemas: options.schemas }),
  });
  return { result, chain, invocations };
}

describe('input that satisfies the published schema', () => {
  test('is invoked normally', async () => {
    const { result, invocations: calls } = await run({
      input: { repo: 'https://example.test/r', depth: 2 },
      schemas: new FakeSchemas(PUBLISHED),
    });
    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
    expect(calls).toBe(1);
  });

  test('the schema is fetched by the root the registry published', async () => {
    const schemas = new FakeSchemas(PUBLISHED);
    await run({ input: { repo: 'x' }, schemas });
    expect(schemas.asked).toEqual([SCHEMA_ROOT.toLowerCase()]);
  });
});

describe('input that does not', () => {
  /// The point of checking before invoking: the agent is never called, so a
  /// flow that could not have worked costs nothing but the receipt that says
  /// so.
  test('fails the step without invoking the agent', async () => {
    const { result, invocations: calls } = await run({
      input: { depth: 2 },
      schemas: new FakeSchemas(PUBLISHED),
    });

    expect(result.steps[0]?.status).toBe(StepStatus.Failed);
    expect(calls).toBe(0);
  });

  test('the error names the agent, the schema and the problem', async () => {
    const { result } = await run({ input: { depth: 2 }, schemas: new FakeSchemas(PUBLISHED) });
    const error = result.steps[0]?.error ?? '';

    expect(error).toMatch(/agent 7/);
    expect(error).toMatch(new RegExp(SCHEMA_ROOT, 'i'));
    expect(error).toMatch(/\$\.repo is required but missing/);
  });

  test('a wrong type is caught too', async () => {
    const { result } = await run({ input: { repo: 42 }, schemas: new FakeSchemas(PUBLISHED) });
    expect(result.steps[0]?.error).toMatch(/expected string, got integer/);
  });

  /// §1.3: a run that fails is still a well-formed, verifiable object.
  test('the run is still sealed as a verifiable failure', async () => {
    const { result, chain } = await run({ input: {}, schemas: new FakeSchemas(PUBLISHED) });
    expect(result.sealed).toBe(true);
    expect(result.succeeded).toBe(false);
    expect(chain.anchored).toHaveLength(1);
  });
});

describe('when the check cannot be made, the step still runs', () => {
  /// A storage outage must not look like a bad flow. The agent will reject
  /// genuinely wrong input itself.
  test('the schema could not be fetched', async () => {
    const { result, invocations: calls } = await run({
      input: { nothing: 'valid' },
      schemas: new FakeSchemas(null),
    });
    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
    expect(calls).toBe(1);
  });

  test('the resolver threw', async () => {
    const { result } = await run({ input: {}, schemas: new FakeSchemas(null, true) });
    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
  });

  test('the agent published no schema root', async () => {
    const schemas = new FakeSchemas(PUBLISHED);
    const { result } = await run({
      input: {},
      schemas,
      adapters: new FakeAdapters(ZERO_BYTES32 as Hex),
    });
    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
    // Not even asked for: a zero root names no document.
    expect(schemas.asked).toEqual([]);
  });

  test('the published document has no input half', async () => {
    const { result } = await run({
      input: {},
      schemas: new FakeSchemas({ output: { type: 'object' } }),
    });
    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
  });

  /// Every flow written before this existed passes no resolver.
  test('no resolver was configured', async () => {
    const { result } = await run({ input: { anything: true } });
    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
  });
});
