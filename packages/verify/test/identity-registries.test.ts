/**
 * Resolving an agentId against more than one identity registry.
 *
 * 0G ships two agent identity standards and this system accepts both:
 * ERC-8004 for public discovery and reputation, and ERC-7857 Agentic ID for
 * agents whose intelligence is tokenised with encrypted metadata. Both are
 * ERC-721 keyed by uint256, so `ownerOf` answers for either.
 *
 * Which creates the problem these tests are mostly about. Token 1 of ERC-8004
 * and token 1 of Agentic ID are *different agents*, and a receipt records only
 * the bare number. The verifier must therefore say which registry answered —
 * and when both do, it must refuse to guess rather than attribute the work to
 * whichever happened to be configured first.
 */

import { describe, expect, test } from 'vitest';
import {
  canonicalize,
  hashJson,
  foldChainRoot,
  StepStatus,
  ZERO_BYTES32,
  type Hex,
  type JsonValue,
  type Receipt,
} from '@0gflow/core';
import { verifyRun } from '../src/verify.js';
import { STEP_ANCHORED_TOPIC, RUN_SEALED_TOPIC, type RawLog } from '../src/decode.js';
import type { ChainSource, FetchedTrace, TraceSource } from '../src/sources.js';

const RUN_ID = `0x${'22'.repeat(32)}` as Hex;
const FLOW_ID = `0x${'11'.repeat(32)}` as Hex;

const ERC8004 = '0x7177a6867296406881e20d6647232314736dd09a' as Hex;
const AGENTIC_ID = '0x2700f6a3e505402c9dab154c5c6ab9caec98ef1f' as Hex;

const OWNER_A = '0x00000000000000000000000000000000000000aa' as Hex;
const OWNER_B = '0x00000000000000000000000000000000000000bb' as Hex;

const IN = { q: 'x' } as JsonValue;
const OUT = { a: 'y' } as JsonValue;
const TRACE: JsonValue = {
  version: '0gflow/1',
  runId: RUN_ID,
  stepIndex: 0,
  stepId: 'audit',
  agent: '1',
  input: IN,
  output: OUT,
};
/** The root IS the hash of the trace — anything else fails the hash check. */
const TRACE_ROOT = hashJson(TRACE) as Hex;

const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0');
const bare = (h: string) => h.replace(/^0x/, '');

function receipt(): Receipt {
  return {
    flowId: FLOW_ID,
    runId: RUN_ID,
    stepIndex: 0,
    agentId: 1n,
    inputHash: hashJson(IN),
    outputHash: hashJson(OUT),
    traceRoot: TRACE_ROOT,
    attestationRef: ZERO_BYTES32,
    startedAt: 100n,
    endedAt: 101n,
    status: StepStatus.Ok,
  };
}

function stepLog(r: Receipt): RawLog {
  return {
    address: '0x741a36faba40ee71223539a5a062fdedc8574e30',
    topics: [STEP_ANCHORED_TOPIC, r.flowId, r.runId, `0x${word(r.stepIndex)}`],
    data:
      '0x' +
      word(r.agentId) +
      bare(r.inputHash) +
      bare(r.outputHash) +
      bare(r.traceRoot) +
      bare(r.attestationRef) +
      word(r.startedAt) +
      word(r.endedAt) +
      word(r.status),
    blockNumber: '0xa',
    transactionHash: `0x${'01'.repeat(32)}`,
    logIndex: '0x0',
  };
}

function sealLog(root: Hex): RawLog {
  return {
    address: '0x741a36faba40ee71223539a5a062fdedc8574e30',
    topics: [RUN_SEALED_TOPIC, RUN_ID],
    data: '0x' + bare(root) + word(1) + word(0),
    blockNumber: '0xb',
    transactionHash: `0x${'02'.repeat(32)}`,
    logIndex: '0x1',
  };
}

/** A chain whose `ownerOf` actually depends on which registry is asked. */
class PerRegistryChain implements ChainSource {
  constructor(
    private readonly logs: RawLog[],
    private readonly seals: RawLog[],
    /** registry address (lowercase) → agentId → owner */
    private readonly byRegistry: Map<string, Map<string, Hex>>,
  ) {}
  async getStepAnchoredLogs() {
    return this.logs;
  }
  async getRunSealedLogs() {
    return this.seals;
  }
  async ownerOf(registry: Hex, agentId: bigint) {
    return this.byRegistry.get(registry.toLowerCase())?.get(agentId.toString()) ?? null;
  }
}

class OneTrace implements TraceSource {
  readonly describe = 'fake';
  async fetch(root: Hex): Promise<FetchedTrace | null> {
    if (root.toLowerCase() !== TRACE_ROOT.toLowerCase()) return null;
    return {
      bytes: new TextEncoder().encode(canonicalize(TRACE)),
      origin: 'storage',
      inclusionProofVerified: true,
    };
  }
}

function options(byRegistry: Map<string, Map<string, Hex>>, registries: { address: Hex; standard: string }[]) {
  const r = receipt();
  return {
    runId: RUN_ID,
    chain: new PerRegistryChain([stepLog(r)], [sealLog(foldChainRoot([r]) as Hex)], byRegistry),
    traces: new OneTrace(),
    identityRegistries: registries,
    spec: null,
  };
}

const only = (registry: Hex, owner: Hex) =>
  new Map([[registry.toLowerCase(), new Map([['1', owner]])]]);

describe('one registry answers', () => {
  test('resolves, and names the standard that vouched for the agent', async () => {
    const result = await verifyRun(
      options(only(ERC8004, OWNER_A), [{ address: ERC8004, standard: 'ERC-8004' }]),
    );
    expect(result.steps[0]!.identityResolved).toBe(true);
    expect(result.steps[0]!.identityOwner).toBe(OWNER_A);
    expect(result.steps[0]!.identityStandard).toBe('ERC-8004');
  });

  test('an agent registered only in Agentic ID resolves just the same', async () => {
    // The point of accepting both: an agent whose intelligence is tokenised as
    // an ERC-7857 Agentic ID is a real agent, and a receipt naming it must
    // resolve. Before this, only ERC-8004 was ever consulted.
    const result = await verifyRun(
      options(only(AGENTIC_ID, OWNER_B), [
        { address: ERC8004, standard: 'ERC-8004' },
        { address: AGENTIC_ID, standard: 'Agentic ID (ERC-7857)' },
      ]),
    );
    expect(result.steps[0]!.identityResolved).toBe(true);
    expect(result.steps[0]!.identityOwner).toBe(OWNER_B);
    expect(result.steps[0]!.identityStandard).toBe('Agentic ID (ERC-7857)');
  });
});

describe('no registry answers', () => {
  test('fails, and lists every registry that was actually asked', async () => {
    const result = await verifyRun(
      options(new Map(), [
        { address: ERC8004, standard: 'ERC-8004' },
        { address: AGENTIC_ID, standard: 'Agentic ID (ERC-7857)' },
      ]),
    );
    expect(result.steps[0]!.identityResolved).toBe(false);
    expect(result.verdict).toBe('failed');
    const said = result.failures.join(' ');
    expect(said).toContain('ERC-8004');
    expect(said).toContain('Agentic ID (ERC-7857)');
  });
});

describe('both registries answer', () => {
  const both = new Map([
    [ERC8004.toLowerCase(), new Map([['1', OWNER_A]])],
    [AGENTIC_ID.toLowerCase(), new Map([['1', OWNER_B]])],
  ]);
  const registries = [
    { address: ERC8004, standard: 'ERC-8004' },
    { address: AGENTIC_ID, standard: 'Agentic ID (ERC-7857)' },
  ];

  test('refuses to resolve, because the receipt does not say which agent', async () => {
    // Token 1 in two registries is two different agents. Picking one would
    // attribute work to whoever was listed first in a config file.
    const result = await verifyRun(options(both, registries));
    expect(result.steps[0]!.identityResolved).toBe(false);
    expect(result.steps[0]!.identityOwner).toBeNull();
    expect(result.steps[0]!.identityStandard).toBeNull();
  });

  test('says why, rather than failing with a generic message', async () => {
    const result = await verifyRun(options(both, registries));
    const said = result.failures.join(' ');
    expect(said).toMatch(/more than one identity registry/i);
    expect(said).toMatch(/does not say which agent/i);
  });

  test('the ambiguity is a failure, not a note', async () => {
    // Reporting this as merely "not checked" would let a run whose authorship
    // is genuinely undetermined pass as INCOMPLETE-but-fine.
    const result = await verifyRun(options(both, registries));
    expect(result.verdict).toBe('failed');
  });

  test('order does not change the answer', async () => {
    const forward = await verifyRun(options(both, registries));
    const reversed = await verifyRun(options(both, [...registries].reverse()));
    expect(reversed.steps[0]!.identityResolved).toBe(forward.steps[0]!.identityResolved);
    expect(reversed.steps[0]!.identityOwner).toBe(forward.steps[0]!.identityOwner);
  });
});

describe('no registry configured', () => {
  test('does not resolve and does not fail — it says the check did not run', async () => {
    const result = await verifyRun(options(new Map(), []));
    expect(result.steps[0]!.identityResolved).toBeNull();
    // Not a failure: the check did not run, which is a different claim from
    // the check running and finding nothing.
    expect(result.failures).toEqual([]);
    // The note lives on the step, where the check would have run.
    expect(result.steps[0]!.notes.join(' ')).toMatch(/no identity registry configured/i);
  });
});
