/**
 * The executor settling payment as it anchors.
 *
 * Two rules shape all of this.
 *
 * Payment comes *after* anchoring, and it has to: the escrow reads the step's
 * status from the receipt, so releasing first would revert on a step the chain
 * has never heard of.
 *
 * And a payment failure never fails the run. The work was done and the receipt
 * is anchored; whether the money moved is a separate fact, and a funding
 * problem must not retroactively turn a good step into a bad one. It is
 * recorded rather than swallowed, because silence would be indistinguishable
 * from an agent that was paid.
 */

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { privateKeyToAccount } from 'viem/accounts';
import { StepStatus, hashJson, type Hex, type JsonValue, type Receipt } from '@0gflow/core';
import { handleInvoke, signOutput, type AgentDefinition } from '@0gflow/adapter-sdk';
import {
  executeRun,
  type AnchorReceipt,
  type ChainWriter,
  type EscrowClient,
  type TraceStore,
} from '../src/execute.js';
import type { AdapterResolver, ResolvedAdapter } from '../src/adapters.js';
import type { FlowSpec } from '../src/plan.js';

const ACCOUNT = privateKeyToAccount(
  '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318',
);
const CHAIN_ID = 31337;
const RECEIPTS = '0x741a36faba40ee71223539a5a062fdedc8574e30' as Hex;
const PRICE = 1_000_000_000_000_000n;

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const failing = (req.url ?? '').includes('/broken/');
        const unsigned = (req.url ?? '').includes('/unsigned/');

        const agent: AgentDefinition = {
          agentId: '7',
          schema: { input: {}, output: {} },
          async invoke(request) {
            if (failing) {
              return Promise.reject(new Error('deliberate failure')) as never;
            }
            const output = { text: 'done' };
            if (unsigned) return { output };
            const { signature } = await signOutput(
              { request, agentId: '7', output },
              (digest) => ACCOUNT.signMessage({ message: { raw: digest as `0x${string}` } }),
            );
            return { output, outputSignature: signature };
          },
        };

        const body = chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString()) as unknown) : {};
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
  /** Records the order of anchors and releases, so §7.3 ordering is testable. */
  readonly journal: string[] = [];

  async isFlowPublished() { return true; }
  async publishFlow() {}
  async startRun() {}
  async anchorStep(receipt: Receipt): Promise<AnchorReceipt> {
    this.anchored.push(receipt);
    this.journal.push(`anchor:${receipt.stepIndex}`);
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
  constructor(private readonly price: bigint) {}
  async resolve(agentId: bigint): Promise<ResolvedAdapter> {
    return {
      agentId,
      kind: 0,
      endpoint: '',
      schemaRoot: `0x${'00'.repeat(32)}` as Hex,
      version: 1,
      active: true,
      payTo: `0x${'11'.repeat(20)}` as Hex,
      signer: ACCOUNT.address as Hex,
      pricePerCall: this.price,
      metadataURI: '',
    };
  }
}

class FakeEscrow implements EscrowClient {
  readonly allocated: { stepIndex: number; amount: bigint }[] = [];
  readonly released: { stepIndex: number; signature: Hex }[] = [];
  constructor(
    private readonly journal: string[] = [],
    private readonly failOn: 'none' | 'allocate' | 'release' = 'none',
  ) {}
  async allocate(_runId: Hex, stepIndex: number, amount: bigint) {
    if (this.failOn === 'allocate') throw new Error('RunNotFunded');
    this.allocated.push({ stepIndex, amount });
    this.journal.push(`allocate:${stepIndex}`);
  }
  async releaseStep(_runId: Hex, stepIndex: number, signature: Hex) {
    if (this.failOn === 'release') throw new Error('BadSignature');
    this.released.push({ stepIndex, signature });
    this.journal.push(`release:${stepIndex}`);
  }
}

const flow = (agentPath: string): FlowSpec => ({
  version: '0gflow/1',
  name: 'paid-flow',
  inputs: { topic: { type: 'string' } },
  steps: [{ id: 'work', agent: '7', input: { topic: '{{ inputs.topic }}' } }],
});

async function run(options: {
  agentPath?: string;
  price?: bigint;
  escrow?: FakeEscrow;
  adapters?: AdapterResolver;
  chain?: FakeChain;
}) {
  const chain = options.chain ?? new FakeChain();
  const result = await executeRun({
    spec: flow(options.agentPath ?? 'ok'),
    inputs: { topic: 'markets' },
    runId: `0x${'22'.repeat(32)}` as Hex,
    chain,
    traces: new FakeTraces(),
    endpointFor: () => `${base}/${options.agentPath ?? 'ok'}/invoke`,
    adapters: options.adapters ?? new FakeAdapters(options.price ?? PRICE),
    ...(options.escrow === undefined ? {} : { escrow: options.escrow }),
  });
  return { result, chain };
}

describe('a funded run pays its agents', () => {
  test('allocates the listed price and releases against the signature', async () => {
    const escrow = new FakeEscrow();
    const { result } = await run({ escrow });

    expect(escrow.allocated).toEqual([{ stepIndex: 0, amount: PRICE }]);
    expect(escrow.released[0]?.stepIndex).toBe(0);
    // The very signature the agent produced, not one the executor invented.
    expect(escrow.released[0]?.signature).toBe(result.steps[0]?.outputSignature);
    expect(result.steps[0]?.payment).toEqual({ amount: PRICE, released: true, error: null });
  });

  /// The escrow reads the step's status from the receipt, so releasing before
  /// the receipt exists would revert on a step the chain has never heard of.
  test('anchors before it pays', async () => {
    const chain = new FakeChain();
    const escrow = new FakeEscrow(chain.journal);
    await run({ escrow, chain });

    expect(chain.journal).toEqual(['anchor:0', 'allocate:0', 'release:0']);
  });
});

describe('what is not paid', () => {
  test('a step whose agent did not sign', async () => {
    const escrow = new FakeEscrow();
    const { result } = await run({ agentPath: 'unsigned', escrow });

    expect(escrow.released).toHaveLength(0);
    expect(result.steps[0]?.payment?.error).toMatch(/no signature/);
    // The step itself is fine — it did not ask to prove its identity.
    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
  });

  test('a step that failed', async () => {
    const escrow = new FakeEscrow();
    const { result } = await run({ agentPath: 'broken', escrow });

    expect(escrow.allocated).toHaveLength(0);
    expect(result.steps[0]?.status).toBe(StepStatus.Failed);
    expect(result.steps[0]?.payment).toBeNull();
  });

  /// A free agent is an ordinary listing, not a failure to pay.
  test('an agent listed at zero, and nothing is recorded as owed', async () => {
    const escrow = new FakeEscrow();
    const { result } = await run({ price: 0n, escrow });

    expect(escrow.allocated).toHaveLength(0);
    expect(result.steps[0]?.payment).toBeNull();
  });

  test('a run with no escrow configured', async () => {
    const { result } = await run({});
    expect(result.steps[0]?.payment).toBeNull();
    expect(result.succeeded).toBe(true);
  });
});

describe('a payment failure is recorded, never swallowed and never fatal', () => {
  /// The commonest real case: the run was never funded. The work still
  /// happened and the receipt still stands.
  test('an unfunded run still succeeds, and says the money did not move', async () => {
    const escrow = new FakeEscrow([], 'allocate');
    const { result } = await run({ escrow });

    expect(result.succeeded).toBe(true);
    expect(result.sealed).toBe(true);
    expect(result.steps[0]?.status).toBe(StepStatus.Ok);
    expect(result.steps[0]?.payment).toEqual({
      amount: PRICE,
      released: false,
      error: 'RunNotFunded',
    });
  });

  test('a rejected release is reported with the escrow’s own reason', async () => {
    const escrow = new FakeEscrow([], 'release');
    const { result } = await run({ escrow });

    expect(result.steps[0]?.payment?.released).toBe(false);
    expect(result.steps[0]?.payment?.error).toBe('BadSignature');
    expect(result.succeeded).toBe(true);
  });

  /// An unreachable registry means no price, which must not be read as free.
  test('a registry that cannot be read reports the reason rather than paying zero', async () => {
    const escrow = new FakeEscrow();
    const broken: AdapterResolver = {
      async resolve() {
        throw new Error('rpc unreachable');
      },
    };
    const { result } = await run({ escrow, adapters: broken });

    expect(escrow.allocated).toHaveLength(0);
    expect(result.steps[0]?.payment?.error).toMatch(/could not read the agent's price/);
  });
});
