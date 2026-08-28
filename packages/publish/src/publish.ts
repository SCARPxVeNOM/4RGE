/**
 * Publishing an agent to the marketplace.
 *
 * This is the front door. Everything else in the project assumes agents
 * exist; this is how one comes to exist, for someone who has no relationship
 * with whoever runs the executor.
 *
 * Five steps, in an order chosen so that nothing irreversible happens before
 * the reversible checks have passed:
 *
 *   1. mint an ERC-8004 identity, if the caller has none
 *   2. upload the agent's JSON Schema to 0G Storage, yielding schemaRoot
 *   3. run the §6.4 conformance suite against the live endpoint
 *   4. register the adapter on AgentAdapterRegistryV2
 *   5. read the listing back from chain and confirm it resolves
 *
 * Step 3 is a gate, not a report. A non-conformant agent is refused, because
 * §6.4 makes passing the criterion for composability: a flow that hires an
 * agent which mishandles the adapter contract produces receipts that cannot be
 * verified, and the person hurt is the one who hired it, not the one who
 * published it.
 *
 * Step 5 exists because §1.3 applies to this tool as much as to a run: it must
 * not report a successful publish on the strength of a transaction receipt. A
 * transaction can succeed and still leave a listing nobody can resolve.
 */

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeFunctionData,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, nonceManager } from 'viem/accounts';
import { runConformance, createHttpProbe, type ConformanceReport } from '@0gflow/conform';
import { ZgStorageTraceStore } from '@0gflow/storage';
import type { JsonValue } from '@0gflow/core';
import type { Network } from '@0gflow/config';

export class PublishError extends Error {
  override readonly name = 'PublishError';
}

export interface PublishOptions {
  readonly network: Network;
  readonly privateKey: string;
  /** Base URL of the running agent, e.g. https://agent.example/agents/audit. */
  readonly endpoint: string;
  /** Reuse an identity you already own. Omitted means mint a new one. */
  readonly agentId?: bigint;
  /** Where payment goes. Defaults to the publisher's own address. */
  readonly payTo?: `0x${string}`;
  /** The key that will sign this agent's outputs. */
  readonly signer: `0x${string}`;
  readonly name: string;
  readonly description: string;
  readonly pricePerCall?: bigint;
  /** Skip the conformance gate. Refuses to be silent about it. */
  readonly force?: boolean;
  readonly log?: (line: string) => void;
}

export interface PublishResult {
  readonly agentId: bigint;
  readonly owner: `0x${string}`;
  readonly endpoint: string;
  readonly schemaRoot: `0x${string}`;
  readonly conformance: ConformanceReport;
  readonly registrationTx: `0x${string}`;
  readonly mintTx: `0x${string}` | null;
  readonly explorerUrl: string;
}

/** Galileo rejects transactions below a minimum tip; viem's estimate lands under it. */
const GAS_PRICE = 5_000_000_000n;
/**
 * Galileo can take well over viem's default to surface a receipt. Giving up
 * early would report a failed publish for a registration that succeeded, and
 * the retry would then revert on the version check — an error pointing
 * nowhere near the cause.
 */
const RECEIPT_TIMEOUT_MS = 180_000;

const IDENTITY_ABI = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenURI', type: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'ownerOf',
    stateMutability: 'view',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'tokenId', type: 'uint256', indexed: true },
    ],
  },
] as const;

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
  {
    type: 'function',
    name: 'getAdapter',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', ...ADAPTER_TUPLE }],
  },
  {
    type: 'function',
    name: 'hasAdapter',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

function requireContract(network: Network, key: 'agentAdapterRegistryV2' | 'identityRegistry'): `0x${string}` {
  const address = network.contracts[key];
  if (address === null) {
    throw new PublishError(`${key} is not configured for ${network.name}`);
  }
  return address as `0x${string}`;
}

export async function publishAgent(options: PublishOptions): Promise<PublishResult> {
  const log = options.log ?? (() => {});
  const { network } = options;

  const registryAddress = requireContract(network, 'agentAdapterRegistryV2');
  const identityAddress = requireContract(network, 'identityRegistry');

  const chain: Chain = defineChain({
    id: network.chainId,
    name: network.displayName,
    nativeCurrency: { name: network.nativeToken, symbol: network.nativeToken, decimals: 18 },
    rpcUrls: { default: { http: [network.rpcUrl] } },
    blockExplorers: { default: { name: 'explorer', url: network.explorerUrl } },
  });

  const key = options.privateKey.startsWith('0x') ? options.privateKey : `0x${options.privateKey}`;
  const account: Account = privateKeyToAccount(key as `0x${string}`, { nonceManager });
  const owner = account.address;

  const publicClient: PublicClient = createPublicClient({ chain, transport: http(network.rpcUrl) });
  const wallet: WalletClient = createWalletClient({ account, chain, transport: http(network.rpcUrl) });

  // --- 3 first, actually: conformance ------------------------------------
  //
  // Run before anything is minted or written. A failing agent should cost the
  // publisher nothing but time, and an identity minted for an agent that
  // cannot be listed is litter nobody can clean up.
  log('checking the agent against the §6.4 adapter contract…');
  const conformance = await runConformance({
    endpoint: options.endpoint,
    probe: createHttpProbe(options.endpoint, 15_000),
  });

  if (!conformance.conformant) {
    const failed = conformance.results.filter((r) => !r.passed && r.severity === 'fail');
    if (options.force !== true) {
      throw new PublishError(
        `the agent does not satisfy the adapter contract, so it is not safe to hire:\n` +
          failed.map((r) => `  · ${r.title}: ${r.detail}`).join('\n') +
          `\n\nFix these, or pass --force to publish anyway and accept that flows hiring it may produce unverifiable runs.`,
      );
    }
    log(`WARNING: publishing despite ${failed.length} conformance failure(s), because --force was given`);
  } else {
    log(`conformant: ${conformance.results.length} checks passed`);
  }

  // --- 1. identity --------------------------------------------------------
  let agentId: bigint;
  let mintTx: `0x${string}` | null = null;

  if (options.agentId !== undefined) {
    agentId = options.agentId;
    // Verified rather than trusted: registerAdapter would revert anyway, but
    // failing here says which of "no such agent" and "not your agent" it is.
    const actual = await publicClient
      .readContract({ address: identityAddress, abi: IDENTITY_ABI, functionName: 'ownerOf', args: [agentId] })
      .catch(() => null);
    if (actual === null) throw new PublishError(`agent ${agentId} does not exist in ${identityAddress}`);
    if (actual.toLowerCase() !== owner.toLowerCase()) {
      throw new PublishError(`agent ${agentId} belongs to ${actual}, not to you (${owner})`);
    }
    log(`using existing identity ${agentId}`);
  } else {
    log('minting an ERC-8004 identity…');
    const registration = JSON.stringify({
      name: options.name,
      description: options.description,
      endpoints: [{ name: 'invoke', endpoint: options.endpoint, protocol: '0gflow/1' }],
    });
    const tokenURI = `data:application/json;base64,${Buffer.from(registration).toString('base64')}`;

    mintTx = await wallet.sendTransaction({
      account,
      chain,
      to: identityAddress,
      data: encodeFunctionData({ abi: IDENTITY_ABI, functionName: 'register', args: [tokenURI] }),
      gasPrice: GAS_PRICE,
    });
    const minted = await publicClient.waitForTransactionReceipt({
      hash: mintTx,
      timeout: RECEIPT_TIMEOUT_MS,
      pollingInterval: 2_000,
    });
    if (minted.status !== 'success') throw new PublishError(`minting reverted: ${mintTx}`);

    // The token id comes from the Transfer log rather than from a return
    // value: sendTransaction cannot return one, and totalSupply() reverts on
    // this registry so it cannot be inferred either.
    agentId = mintedTokenId(minted.logs, identityAddress, owner);
    log(`minted identity ${agentId}`);
  }

  // --- 2. schema ----------------------------------------------------------
  log('fetching and storing the agent schema…');
  const schema = await fetchSchema(options.endpoint);
  const storage = new ZgStorageTraceStore({
    rpcUrl: network.rpcUrl,
    indexerUrl: network.storageIndexerUrl,
    privateKey: key,
  });
  const { traceRoot: schemaRoot } = await storage.put(schema);
  log(`schema stored at ${schemaRoot}`);

  // --- 4. register --------------------------------------------------------
  const existing = await publicClient.readContract({
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'hasAdapter',
    args: [agentId],
  });
  const version = existing
    ? (
        await publicClient.readContract({
          address: registryAddress,
          abi: REGISTRY_ABI,
          functionName: 'getAdapter',
          args: [agentId],
        })
      ).version + 1
    : 1;

  log(`registering adapter version ${version}…`);
  const registrationTx = await wallet.sendTransaction({
    account,
    chain,
    to: registryAddress,
    data: encodeFunctionData({
      abi: REGISTRY_ABI,
      functionName: 'registerAdapter',
      args: [
        {
          agentId,
          kind: 0,
          endpoint: options.endpoint,
          schemaRoot: schemaRoot as `0x${string}`,
          version,
          active: true,
          payTo: options.payTo ?? owner,
          signer: options.signer,
          pricePerCall: options.pricePerCall ?? 0n,
          metadataURI: `data:application/json;base64,${Buffer.from(
            JSON.stringify({
              name: options.name,
              description: options.description,
              conformance: { conformant: conformance.conformant, checks: conformance.results.length },
            }),
          ).toString('base64')}`,
        },
      ],
    }),
    gasPrice: GAS_PRICE,
  });

  const registered = await publicClient.waitForTransactionReceipt({
    hash: registrationTx,
    timeout: RECEIPT_TIMEOUT_MS,
    pollingInterval: 2_000,
  });
  if (registered.status !== 'success') {
    throw new PublishError(`registration reverted: ${registrationTx}`);
  }

  // --- 5. confirm ---------------------------------------------------------
  //
  // §1.3 applies here too: a successful transaction is not a successful
  // publish. Read the listing back and check it says what was intended.
  const listing = await publicClient.readContract({
    address: registryAddress,
    abi: REGISTRY_ABI,
    functionName: 'getAdapter',
    args: [agentId],
  });

  if (listing.endpoint !== options.endpoint) {
    throw new PublishError(
      `the registry resolves agent ${agentId} to ${listing.endpoint}, not to ${options.endpoint}`,
    );
  }
  if (listing.signer.toLowerCase() !== options.signer.toLowerCase()) {
    throw new PublishError(
      `the registry lists ${listing.signer} as the signer, not ${options.signer}; outputs signed by your key would not verify`,
    );
  }
  if (!listing.active) throw new PublishError(`agent ${agentId} registered but is not active`);

  return {
    agentId,
    owner,
    endpoint: options.endpoint,
    schemaRoot: schemaRoot as `0x${string}`,
    conformance,
    registrationTx,
    mintTx,
    explorerUrl: `${network.explorerUrl}/tx/${registrationTx}`,
  };
}

/**
 * The token id from the mint's `Transfer` log.
 *
 * Filtered on `from == 0x0` and `to == owner`, because a registry may emit
 * other events in the same transaction and picking the first Transfer would
 * be a guess.
 */
function mintedTokenId(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
  registry: string,
  owner: string,
): bigint {
  for (const entry of logs) {
    if (entry.address.toLowerCase() !== registry.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: IDENTITY_ABI,
        data: entry.data as `0x${string}`,
        topics: entry.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (decoded.eventName !== 'Transfer') continue;
      const { from, to, tokenId } = decoded.args;
      if (BigInt(from) === 0n && to.toLowerCase() === owner.toLowerCase()) return tokenId;
    } catch {
      // Not a Transfer, or not one this ABI describes. Keep looking.
    }
  }
  throw new PublishError(
    'the mint transaction succeeded but emitted no Transfer to this address, so the new agent id is unknown',
  );
}

async function fetchSchema(endpoint: string): Promise<JsonValue> {
  const url = `${endpoint.replace(/\/+$/, '')}/schema`;
  const response = await fetch(url).catch((error: Error) => {
    throw new PublishError(`could not fetch ${url}: ${error.message}`);
  });
  if (!response.ok) {
    throw new PublishError(`${url} returned HTTP ${response.status}`);
  }
  return (await response.json()) as JsonValue;
}
