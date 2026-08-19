import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  decodeStepAnchored,
  decodeRunSealed,
  STEP_ANCHORED_TOPIC,
  RUN_SEALED_TOPIC,
  type RawLog,
} from '../src/decode.js';
import { StepStatus } from '@0gflow/core';

/**
 * Decoded against real logs captured from the live run on Galileo
 * (runId 0x530f4809…, blocks 50317376–50317415). Using real logs rather than
 * synthetic ones is the point: a decoder that only ever sees its own encoder's
 * output will happily agree with itself and disagree with the chain.
 */

const load = (name: string): RawLog[] =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'),
  ) as RawLog[];

const stepLogs = load('step-anchored');
const sealLogs = load('run-sealed');

const RUN_ID = '0x530f48096fd42536e4b9726c3d3a0a3126ff10270c7c77127071bd4fc831be52';
const FLOW_ID = '0xd0f3618976c4ae42150de06685cac0f4ee9dcf33043cb3d64ff2a11573914ab0';

describe('event topics', () => {
  // If these drift from the deployed contract, eth_getLogs silently returns
  // nothing and the verifier reports a run that does not exist.
  test('match the deployed contract signatures', () => {
    expect(STEP_ANCHORED_TOPIC).toBe(
      '0x3ffba092e8027b4e7b2c6b4ec2a0b1c480262d16c9d3eb11c4bda128cdae5b13',
    );
    expect(RUN_SEALED_TOPIC).toBe(
      '0xdf010652071f5c7fa03c53e3ab78080827e48ab7e1dc0d59daccbf1ad9288f43',
    );
  });

  test('the fixtures carry those topics', () => {
    for (const log of stepLogs) expect(log.topics[0]).toBe(STEP_ANCHORED_TOPIC);
    expect(sealLogs[0]!.topics[0]).toBe(RUN_SEALED_TOPIC);
  });
});

describe('decodeStepAnchored', () => {
  test('recovers the indexed fields from topics', () => {
    const decoded = stepLogs.map(decodeStepAnchored).sort((a, b) => a.stepIndex - b.stepIndex);
    expect(decoded).toHaveLength(2);
    for (const r of decoded) {
      expect(r.flowId).toBe(FLOW_ID);
      expect(r.runId).toBe(RUN_ID);
    }
    expect(decoded[0]!.stepIndex).toBe(0);
    expect(decoded[1]!.stepIndex).toBe(1);
  });

  test('recovers the non-indexed fields from data', () => {
    const [step0] = stepLogs.map(decodeStepAnchored).sort((a, b) => a.stepIndex - b.stepIndex);
    expect(step0!.agentId).toBe(1n);
    expect(step0!.inputHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(step0!.outputHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(step0!.traceRoot).toMatch(/^0x[0-9a-f]{64}$/);
    expect(step0!.attestationRef).toBe(`0x${'00'.repeat(32)}`);
    expect(step0!.status).toBe(StepStatus.Ok);
  });

  test('decodes uint64 timestamps as bigints', () => {
    const [step0] = stepLogs.map(decodeStepAnchored).sort((a, b) => a.stepIndex - b.stepIndex);
    expect(typeof step0!.startedAt).toBe('bigint');
    expect(step0!.endedAt).toBeGreaterThanOrEqual(step0!.startedAt);
  });

  test('carries provenance so the anchor can be checked against the receipt', () => {
    const [step0] = stepLogs.map(decodeStepAnchored);
    expect(step0!.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(typeof step0!.blockNumber).toBe('bigint');
    expect(typeof step0!.logIndex).toBe('number');
  });

  test('rejects a log whose topic is not StepAnchored', () => {
    const wrong = { ...stepLogs[0]!, topics: [RUN_SEALED_TOPIC, ...stepLogs[0]!.topics.slice(1)] };
    expect(() => decodeStepAnchored(wrong)).toThrow();
  });

  test('rejects a log with the wrong number of topics', () => {
    const wrong = { ...stepLogs[0]!, topics: stepLogs[0]!.topics.slice(0, 2) };
    expect(() => decodeStepAnchored(wrong)).toThrow();
  });

  test('rejects truncated data rather than decoding zeros', () => {
    // Silently reading past the end would fabricate a receipt that then fails
    // verification for an unrelated-looking reason.
    const wrong = { ...stepLogs[0]!, data: stepLogs[0]!.data.slice(0, 100) };
    expect(() => decodeStepAnchored(wrong)).toThrow();
  });
});

describe('decodeRunSealed', () => {
  test('recovers the seal from the live run', () => {
    const seal = decodeRunSealed(sealLogs[0]!);
    expect(seal.runId).toBe(RUN_ID);
    expect(seal.chainRoot).toBe(
      '0x0fa7e8ef4f15125b5f72648fd59051df1b4f9f50c28dbd1b51c846524fce07c1',
    );
    expect(seal.stepCount).toBe(2);
    expect(seal.outcome).toBe(0);
  });

  test('rejects a log whose topic is not RunSealed', () => {
    const wrong = { ...sealLogs[0]!, topics: [STEP_ANCHORED_TOPIC, ...sealLogs[0]!.topics.slice(1)] };
    expect(() => decodeRunSealed(wrong)).toThrow();
  });
});

describe('the decoded receipts reconstruct the run', () => {
  // The end-to-end point of the decoder: what comes off the chain must be
  // exactly what the core hashed.
  test('fold to the sealed chain root', async () => {
    const { foldChainRoot } = await import('@0gflow/core');
    const receipts = stepLogs.map(decodeStepAnchored);
    const seal = decodeRunSealed(sealLogs[0]!);
    expect(foldChainRoot(receipts)).toBe(seal.chainRoot);
  });
});
