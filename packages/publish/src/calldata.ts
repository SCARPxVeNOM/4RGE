/**
 * The two transactions that publish an agent, as bytes.
 *
 * Publishing has always been a terminal command holding a private key. The
 * browser flow does the same two writes from the user's own wallet, and the
 * wallet wants calldata, not an ABI. Encoding it twice would be encoding it
 * two ways: the divergence would not show up as an error, it would show up as
 * a listing whose endpoint or signer differs depending on which path published
 * it, which is the kind of bug that is only found by the person who gets paid
 * to the wrong address.
 *
 * So both paths call these functions. `publish.ts` uses them instead of viem's
 * `encodeFunctionData`, and every encoder here is pinned against viem in
 * `test/calldata.test.ts` — the encoding is hand-written, so the test is the
 * only thing standing between it and a silently malformed transaction.
 *
 * Deliberately free of imports. This module is loaded into a browser bundle,
 * where `Buffer` does not exist and pulling in viem or the 0G storage SDK to
 * concatenate some hex would be absurd.
 */

export type Hex = `0x${string}`;

/** `register(string)` on the ERC-8004 identity registry. */
export const REGISTER_SELECTOR = '0xf2c298be' as const;
/** `registerAdapter((uint256,uint8,string,bytes32,uint32,bool,address,address,uint256,string))`. */
export const REGISTER_ADAPTER_SELECTOR = '0x0c8f4393' as const;

/** The listing as the registry stores it. */
export interface AdapterInput {
  readonly agentId: bigint;
  readonly kind: number;
  readonly endpoint: string;
  readonly schemaRoot: Hex;
  readonly version: number;
  readonly active: boolean;
  readonly payTo: Hex;
  readonly signer: Hex;
  readonly pricePerCall: bigint;
  readonly metadataURI: string;
}

const WORD = 32;

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** A uint256 as one 32-byte word. */
function word(value: bigint): string {
  if (value < 0n) throw new Error(`cannot abi-encode a negative value: ${value}`);
  const encoded = value.toString(16);
  if (encoded.length > WORD * 2) throw new Error(`value does not fit in 32 bytes: ${value}`);
  return encoded.padStart(WORD * 2, '0');
}

/**
 * An address as one 32-byte word, left-padded.
 *
 * Case is normalised away rather than preserved: a checksummed address and its
 * lowercase form must produce identical calldata, or the same listing
 * published twice would look like two different listings to anyone diffing
 * transactions.
 */
function addressWord(value: string): string {
  const cleaned = value.replace(/^0[xX]/, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(cleaned)) throw new Error(`not an address: ${value}`);
  return cleaned.padStart(WORD * 2, '0');
}

function bytes32Word(value: string): string {
  const cleaned = value.replace(/^0[xX]/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(cleaned)) throw new Error(`not 32 bytes of hex: ${value}`);
  return cleaned;
}

/**
 * A dynamic `string`: length word, then the UTF-8 bytes padded up to a word.
 *
 * Encoded from `TextEncoder` output rather than from the string's length,
 * because a `.length` of 5 and five bytes are the same number only until
 * someone puts an em dash in a description — and the registry would then be
 * handed a string whose declared length does not match its bytes.
 */
function stringTail(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const padded = bytes.length % WORD === 0 ? bytes.length : (Math.floor(bytes.length / WORD) + 1) * WORD;
  return word(BigInt(bytes.length)) + hex(bytes).padEnd(padded * 2, '0');
}

/** Calldata for minting an ERC-8004 identity whose token URI is `tokenURI`. */
export function encodeRegisterIdentity(tokenURI: string): Hex {
  // One dynamic argument: a head holding the offset to it, then the tail.
  return `${REGISTER_SELECTOR}${word(32n)}${stringTail(tokenURI)}`;
}

/**
 * Calldata for listing (or re-listing) an adapter.
 *
 * The argument is a struct with two dynamic members, so it is itself dynamic:
 * the outer head is a single offset to the tuple, the tuple's own head is ten
 * words with offsets in place of the two strings, and the strings follow.
 * Tuple-internal offsets are relative to the start of the tuple, not to the
 * start of the calldata — getting that wrong yields a transaction that
 * succeeds and stores garbage.
 */
export function encodeRegisterAdapter(adapter: AdapterInput): Hex {
  const HEAD_WORDS = 10;
  const endpoint = stringTail(adapter.endpoint);
  const metadata = stringTail(adapter.metadataURI);

  const endpointOffset = BigInt(HEAD_WORDS * WORD);
  const metadataOffset = endpointOffset + BigInt(endpoint.length / 2);

  const tuple =
    word(adapter.agentId) +
    word(BigInt(adapter.kind)) +
    word(endpointOffset) +
    bytes32Word(adapter.schemaRoot) +
    word(BigInt(adapter.version)) +
    word(adapter.active ? 1n : 0n) +
    addressWord(adapter.payTo) +
    addressWord(adapter.signer) +
    word(adapter.pricePerCall) +
    word(metadataOffset) +
    endpoint +
    metadata;

  return `${REGISTER_ADAPTER_SELECTOR}${word(32n)}${tuple}`;
}

/**
 * base64 without `Buffer`, so the same token URI is produced in both runtimes.
 *
 * Encodes the UTF-8 bytes, not the code units: `btoa` throws on anything above
 * U+00FF, and a description with an accent in it is not an unreasonable thing
 * for someone to write.
 */
export function dataUri(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 =
    typeof btoa === 'function'
      ? btoa(binary)
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).Buffer.from(bytes).toString('base64');
  return `data:application/json;base64,${base64}`;
}

/** The ERC-8004 registration document a newly minted identity points at. */
export function registrationTokenURI(input: {
  readonly name: string;
  readonly description: string;
  readonly endpoint: string;
}): string {
  return dataUri({
    name: input.name,
    description: input.description,
    endpoints: [{ name: 'invoke', endpoint: input.endpoint, protocol: '0gflow/1' }],
  });
}

/**
 * The listing's off-chain metadata.
 *
 * The conformance result travels with the listing because it is the only thing
 * a browser can show about an agent it has never hired. It is a claim by
 * whoever published, not a proof — the explorer says so, and anyone can re-run
 * `npx @0gflow/conform` against the endpoint to check it.
 */
export function listingMetadataURI(input: {
  readonly name: string;
  readonly description: string;
  readonly conformant: boolean;
  readonly checks: number;
}): string {
  return dataUri({
    name: input.name,
    description: input.description,
    conformance: { conformant: input.conformant, checks: input.checks },
  });
}
