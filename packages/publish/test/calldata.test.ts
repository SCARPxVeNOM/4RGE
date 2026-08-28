/**
 * The hand-written encoders in `calldata.ts`, checked against viem.
 *
 * These bytes go to a wallet, which signs whatever it is handed. There is no
 * layer below this that would notice a wrong offset: a malformed
 * `registerAdapter` does not revert, it stores a listing with a mangled
 * endpoint, and the first sign of trouble is an agent nobody can reach.
 *
 * viem is the oracle because it is an independent implementation of the same
 * specification, present in this workspace already. The point is not that viem
 * is authoritative — it is that two implementations agreeing byte for byte is
 * evidence, and one implementation agreeing with itself is not.
 */

import { describe, expect, it } from 'vitest';
import { encodeFunctionData, toFunctionSelector } from 'viem';
import {
  REGISTER_SELECTOR,
  REGISTER_ADAPTER_SELECTOR,
  encodeRegisterIdentity,
  encodeRegisterAdapter,
  dataUri,
  registrationTokenURI,
  listingMetadataURI,
  type AdapterInput,
} from '../src/calldata.js';

const ADAPTER_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'agentId', type: 'uint256' },
    { name: 'kind', type: 'uint8' },
    { name: 'endpoint', type: 'string' },
    { name: 'schemaRoot', type: 'bytes32' },
    { name: 'version', type: 'uint32' },
    { name: 'active', type: 'bool' },
    { name: 'payTo', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'pricePerCall', type: 'uint256' },
    { name: 'metadataURI', type: 'string' },
  ],
} as const;

const REGISTRY_ABI = [
  {
    type: 'function',
    name: 'registerAdapter',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'a', ...ADAPTER_TUPLE }],
    outputs: [],
  },
] as const;

const IDENTITY_ABI = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenURI', type: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
] as const;

const BASE: AdapterInput = {
  agentId: 12n,
  kind: 0,
  endpoint: 'https://agents.example/agents/audit',
  schemaRoot: '0x1111111111111111111111111111111111111111111111111111111111111111',
  version: 1,
  active: true,
  payTo: '0x2222222222222222222222222222222222222222',
  signer: '0x3333333333333333333333333333333333333333',
  pricePerCall: 1_000_000_000_000_000n,
  metadataURI: 'data:application/json;base64,eyJuYW1lIjoiYSJ9',
};

describe('selectors', () => {
  it('register(string) is the one the deployed identity registry answers to', () => {
    // Not derived from the ABI at runtime: this constant is what a browser
    // sends, and it is the address of a *deployed* contract's function. Pinning
    // it means a change to the local ABI cannot silently retarget it.
    expect(REGISTER_SELECTOR).toBe(toFunctionSelector('register(string)'));
  });

  it('registerAdapter matches the tuple the registry declares', () => {
    expect(REGISTER_ADAPTER_SELECTOR).toBe(
      toFunctionSelector(
        'registerAdapter((uint256,uint8,string,bytes32,uint32,bool,address,address,uint256,string))',
      ),
    );
  });
});

describe('encodeRegisterIdentity', () => {
  it('agrees with viem on a plain token URI', () => {
    const uri = 'data:application/json;base64,eyJuYW1lIjoiVGVzdCJ9';
    expect(encodeRegisterIdentity(uri)).toBe(
      encodeFunctionData({ abi: IDENTITY_ABI, functionName: 'register', args: [uri] }),
    );
  });

  it('agrees on a string that lands exactly on a word boundary', () => {
    // 32 bytes: the padding branch that is skipped entirely, and therefore the
    // one most likely to be wrong.
    const uri = 'a'.repeat(32);
    expect(encodeRegisterIdentity(uri)).toBe(
      encodeFunctionData({ abi: IDENTITY_ABI, functionName: 'register', args: [uri] }),
    );
  });

  it('agrees on the empty string', () => {
    expect(encodeRegisterIdentity('')).toBe(
      encodeFunctionData({ abi: IDENTITY_ABI, functionName: 'register', args: [''] }),
    );
  });

  it('agrees on multi-byte characters, where length and byte count differ', () => {
    const uri = 'café — naïve — 東京';
    expect(encodeRegisterIdentity(uri)).toBe(
      encodeFunctionData({ abi: IDENTITY_ABI, functionName: 'register', args: [uri] }),
    );
  });
});

describe('encodeRegisterAdapter', () => {
  const viemEncode = (adapter: AdapterInput) =>
    encodeFunctionData({ abi: REGISTRY_ABI, functionName: 'registerAdapter', args: [adapter] });

  it('agrees with viem on a realistic listing', () => {
    expect(encodeRegisterAdapter(BASE)).toBe(viemEncode(BASE));
  });

  it('agrees when both dynamic members are empty', () => {
    const adapter = { ...BASE, endpoint: '', metadataURI: '' };
    expect(encodeRegisterAdapter(adapter)).toBe(viemEncode(adapter));
  });

  it('agrees when the first dynamic member shifts the second', () => {
    // The metadata offset is computed from the endpoint's encoded length. A
    // long endpoint is what makes a wrong offset visible.
    const adapter = { ...BASE, endpoint: `https://example.com/${'x'.repeat(200)}` };
    expect(encodeRegisterAdapter(adapter)).toBe(viemEncode(adapter));
  });

  it('agrees on a false bool and a zero price', () => {
    const adapter = { ...BASE, active: false, pricePerCall: 0n, kind: 0 };
    expect(encodeRegisterAdapter(adapter)).toBe(viemEncode(adapter));
  });

  it('agrees on the largest values each field can hold', () => {
    const adapter: AdapterInput = {
      ...BASE,
      agentId: 2n ** 256n - 1n,
      kind: 255,
      version: 2 ** 32 - 1,
      pricePerCall: 2n ** 256n - 1n,
    };
    expect(encodeRegisterAdapter(adapter)).toBe(viemEncode(adapter));
  });

  it('encodes a checksummed address identically to its lowercase form', () => {
    const checksummed = { ...BASE, payTo: '0xD3dF323f6d651d4C827a0143b89b98dD52101c7E' as const };
    const lower = { ...BASE, payTo: '0xd3df323f6d651d4c827a0143b89b98dd52101c7e' as const };
    expect(encodeRegisterAdapter(checksummed)).toBe(encodeRegisterAdapter(lower));
    expect(encodeRegisterAdapter(checksummed)).toBe(viemEncode(checksummed));
  });
});

describe('rejections', () => {
  it('refuses an address that is not one', () => {
    expect(() => encodeRegisterAdapter({ ...BASE, payTo: '0xnope' as `0x${string}` })).toThrow(
      /not an address/,
    );
  });

  it('refuses a schemaRoot that is not 32 bytes', () => {
    expect(() => encodeRegisterAdapter({ ...BASE, schemaRoot: '0x1234' as `0x${string}` })).toThrow(
      /not 32 bytes/,
    );
  });

  it('refuses a value too large for its word', () => {
    expect(() => encodeRegisterAdapter({ ...BASE, agentId: 2n ** 256n })).toThrow(/does not fit/);
  });

  it('refuses a negative value rather than encoding it as an enormous one', () => {
    // Two's complement would make -1 encode as type(uint256).max. Silently
    // publishing a price of 1.15e77 OG is worse than failing.
    expect(() => encodeRegisterAdapter({ ...BASE, pricePerCall: -1n })).toThrow(/negative/);
  });
});

describe('data URIs', () => {
  it('produces what Buffer produces', () => {
    const value = { name: 'Auditor', description: 'checks things' };
    expect(dataUri(value)).toBe(
      `data:application/json;base64,${Buffer.from(JSON.stringify(value)).toString('base64')}`,
    );
  });

  it('round-trips non-ASCII, which btoa alone cannot', () => {
    const value = { name: 'café', description: '東京 — a description' };
    const encoded = dataUri(value);
    const base64 = encoded.slice('data:application/json;base64,'.length);
    expect(JSON.parse(Buffer.from(base64, 'base64').toString('utf8'))).toEqual(value);
  });

  it('builds a registration document the explorer can read back', () => {
    const uri = registrationTokenURI({
      name: 'Auditor',
      description: 'checks things',
      endpoint: 'https://agents.example/a',
    });
    const decoded = JSON.parse(
      Buffer.from(uri.slice('data:application/json;base64,'.length), 'base64').toString('utf8'),
    ) as { endpoints: { endpoint: string; protocol: string }[] };
    expect(decoded.endpoints[0]).toEqual({
      name: 'invoke',
      endpoint: 'https://agents.example/a',
      protocol: '0gflow/1',
    });
  });

  it('carries the conformance claim into the listing metadata', () => {
    const uri = listingMetadataURI({
      name: 'Auditor',
      description: 'checks things',
      conformant: true,
      checks: 11,
    });
    const decoded = JSON.parse(
      Buffer.from(uri.slice('data:application/json;base64,'.length), 'base64').toString('utf8'),
    ) as { conformance: { conformant: boolean; checks: number } };
    expect(decoded.conformance).toEqual({ conformant: true, checks: 11 });
  });
});
