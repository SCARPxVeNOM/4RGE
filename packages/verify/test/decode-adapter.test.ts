/**
 * Decoding `AdapterRegistered`, against a log Galileo actually emitted.
 *
 * The fixture is real — transaction 0xed42e70d… on Galileo, registering agent
 * 12 — and that matters more than usual here. `AdapterRegistered` is the first
 * event in this project with dynamic members, so its head words are offsets
 * rather than values, and getting the layout wrong produces a decoder that
 * passes any fixture you invent to match it.
 *
 * That is not hypothetical: the first version of this decoder skipped head
 * word 3, shifting every field after `schemaRoot`. A hand-written fixture
 * would have been built to match the mistake. Real chain data found it in one
 * call.
 */

import { describe, expect, test } from 'vitest';
import {
  ADAPTER_REGISTERED_TOPIC,
  DecodeError,
  decodeAdapterRegistered,
  type RawLog,
} from '../src/decode.js';

const LOG: RawLog = {
  address: '0xb9b587d30740dd1197f6bc0e2ff56ee82e6c8a66',
  topics: [
    '0x7841a05145134b51446329e66ce55a14e98ef2ccd37cb7784470d2d4a9176bf0',
    '0x000000000000000000000000000000000000000000000000000000000000000c',
    '0x0000000000000000000000003274e860fa4d3372bd120b61367a7555713417a8',
  ],
  data:
    '0x0000000000000000000000000000000000000000000000000000000000000000' +
    '0000000000000000000000000000000000000000000000000000000000000120' +
    'cf0c701ed2020bddd75150ed1461d4fb58f48f6a80aeec45317ae5432bf26641' +
    '0000000000000000000000000000000000000000000000000000000000000004' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    '000000000000000000000000dea0d514ebcc0a2b9bc3b2129445b4f07d0503ec' +
    '000000000000000000000000dea0d514ebcc0a2b9bc3b2129445b4f07d0503ec' +
    '00000000000000000000000000000000000000000000000000038d7ea4c68000' +
    '0000000000000000000000000000000000000000000000000000000000000180' +
    '0000000000000000000000000000000000000000000000000000000000000022' +
    '687474703a2f2f3132372e302e302e313a383732352f6167656e74732f617564' +
    '6974000000000000000000000000000000000000000000000000000000000000' +
    '00000000000000000000000000000000000000000000000000000000000000cd' +
    '646174613a6170706c69636174696f6e2f6a736f6e3b6261736536342c65794a' +
    '755957316c496a6f69556d5677627942426457527064473979496977695a4756' +
    '7a59334a7063485270623234694f694a535a57466b6379426849484a6c634739' +
    '7a61585276636e6b6756564a4d494746755a4342795a584276636e527a49475a' +
    '70626d5270626d647a4c694973496d4e76626d5a76636d3168626d4e6c496a70' +
    '37496d4e76626d5a76636d3168626e51694f6e527964575573496d4e6f5a574e' +
    '72637949364d54423966513d3d00000000000000000000000000000000000000',
  blockNumber: '0x3163a33',
  transactionHash: '0xed42e70dd1e45f5800f054a6547caa90820705684bfa622ef74f3626f99018e3',
  logIndex: '0x0',
};

describe('AdapterRegistered', () => {
  test('the topic is derived from the signature, not pasted', () => {
    // A pasted topic that drifts from the deployed contract makes eth_getLogs
    // return nothing, and "no logs" looks exactly like "no agents published".
    expect(ADAPTER_REGISTERED_TOPIC).toBe(LOG.topics[0]);
  });

  test('decodes every field of a real Galileo listing', () => {
    const a = decodeAdapterRegistered(LOG);

    expect(a.agentId).toBe(12n);
    expect(a.owner).toBe('0x3274e860fa4d3372bd120b61367a7555713417a8');
    expect(a.kind).toBe(0);
    expect(a.endpoint).toBe('http://127.0.0.1:8725/agents/audit');
    expect(a.schemaRoot).toBe(
      '0xcf0c701ed2020bddd75150ed1461d4fb58f48f6a80aeec45317ae5432bf26641',
    );
    expect(a.version).toBe(4);
    expect(a.active).toBe(true);
    // payTo and signer are the same address here but are different fields;
    // the off-by-one that shipped first read one where the other belonged.
    expect(a.payTo).toBe('0xdea0d514ebcc0a2b9bc3b2129445b4f07d0503ec');
    expect(a.signer).toBe('0xdea0d514ebcc0a2b9bc3b2129445b4f07d0503ec');
    expect(a.pricePerCall).toBe(1_000_000_000_000_000n);
    expect(a.metadataURI.startsWith('data:application/json;base64,')).toBe(true);
    expect(a.blockNumber).toBe(0x3163a33n);
    expect(a.logIndex).toBe(0);
  });

  test('the metadata decodes to the published name and description', () => {
    const a = decodeAdapterRegistered(LOG);
    const json = Buffer.from(a.metadataURI.split(',')[1]!, 'base64').toString('utf8');
    expect(JSON.parse(json)).toMatchObject({
      name: 'Repo Auditor',
      conformance: { conformant: true },
    });
  });

  test('a truncated log is refused rather than decoded short', () => {
    // Reading past the end would fabricate a plausible-looking short endpoint,
    // and a directory entry with a silently truncated URL is worse than one
    // that fails to decode.
    const truncated: RawLog = { ...LOG, data: LOG.data.slice(0, 600) };
    expect(() => decodeAdapterRegistered(truncated)).toThrow(DecodeError);
  });

  test('a log with the wrong topic count is refused', () => {
    expect(() => decodeAdapterRegistered({ ...LOG, topics: [LOG.topics[0]!] })).toThrow(
      /expected 3 topics/,
    );
  });
});
