/**
 * @0gflow/config — every network-specific value in 0G Flow.
 *
 * Spec §2: "All network values live in packages/config and are referenced
 * nowhere else in the codebase."
 * Spec §12: mainnet migration is "no application code changes" — it is an edit
 * to this file and nothing else.
 *
 * That claim is only true if it is enforced, so the test alongside this file
 * scans the rest of the repository for hardcoded endpoints and chain ids.
 * Adding a URL here is correct; adding one anywhere else fails the build.
 */

export type Address = `0x${string}`;
export type NetworkName = 'galileo' | 'aristotle';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface ContractAddresses {
  readonly executionReceipts: Address | null;
  readonly flowRegistry: Address | null;
  readonly agentAdapterRegistry: Address | null;
  readonly flowEscrow: Address | null;
  /** ERC-8004 registries. Pre-deployed on Galileo (§2); resolve before deploying replacements. */
  readonly identityRegistry: Address | null;
  readonly reputationRegistry: Address | null;
}

export interface Network {
  readonly name: NetworkName;
  readonly displayName: string;
  readonly chainId: number;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  readonly faucetUrl: string | null;
  readonly nativeToken: string;
  readonly storageIndexerUrl: string;
  readonly computeBrokerUrl: string | null;
  /**
   * False when any value here is still assumed rather than confirmed against
   * the live network. Nothing may transact on an unresolved network.
   */
  readonly resolved: boolean;
  readonly unresolvedReason?: string;
  readonly contracts: ContractAddresses;
  /** Block to backfill the indexer from (§8.1). Set at deployment. */
  readonly deploymentBlock: number | null;
}

const NO_CONTRACTS: ContractAddresses = {
  executionReceipts: null,
  flowRegistry: null,
  agentAdapterRegistry: null,
  flowEscrow: null,
  identityRegistry: null,
  reputationRegistry: null,
};

/**
 * 0G Galileo Testnet.
 *
 * chainId and rpcUrl verified live: eth_chainId returned 0x40da (16602).
 *
 * storageIndexerUrl: the turbo indexer host responds; the standard indexer
 * (indexer-storage-testnet-standard.0g.ai) was returning 503 when this was
 * configured. Confirm during the Phase 1 storage round-trip before relying on
 * it.
 */
export const GALILEO: Network = {
  name: 'galileo',
  displayName: '0G Galileo Testnet',
  chainId: 16602,
  rpcUrl: 'https://evmrpc-testnet.0g.ai',
  explorerUrl: 'https://chainscan-galileo.0g.ai',
  faucetUrl: 'https://faucet.0g.ai/',
  nativeToken: 'A0GI',
  storageIndexerUrl: 'https://indexer-storage-testnet-turbo.0g.ai',
  computeBrokerUrl: null,
  resolved: true,
  contracts: NO_CONTRACTS,
  deploymentBlock: null,
};

/**
 * 0G Aristotle Mainnet — §12.
 *
 * Deliberately unresolved. Contracts deploy via CREATE2 with a fixed salt, so
 * addresses carry across unchanged, but the chain id, RPC endpoint and storage
 * indexer URL must each be confirmed against the live network first. A guessed
 * mainnet endpoint is how real funds reach the wrong chain, so this network
 * refuses use until someone fills it in deliberately.
 */
export const ARISTOTLE: Network = {
  name: 'aristotle',
  displayName: '0G Aristotle Mainnet',
  chainId: 0,
  rpcUrl: '',
  explorerUrl: '',
  faucetUrl: null,
  nativeToken: '0G',
  storageIndexerUrl: '',
  computeBrokerUrl: null,
  resolved: false,
  unresolvedReason:
    'confirm the Aristotle chain id, RPC endpoint and storage indexer URL, and check whether the ERC-8004 registries are already deployed at their canonical addresses, before enabling this network (spec §12)',
  contracts: NO_CONTRACTS,
  deploymentBlock: null,
};

const NETWORKS: Readonly<Record<NetworkName, Network>> = {
  galileo: GALILEO,
  aristotle: ARISTOTLE,
};

export function getNetwork(name: NetworkName): Network {
  const network = NETWORKS[name];
  if (network === undefined) {
    throw new ConfigError(
      `unknown network "${name}"; known networks are ${Object.keys(NETWORKS).join(', ')}`,
    );
  }
  return network;
}

/** Gate for anything that transacts: refuses networks whose values are assumed. */
export function requireResolved(network: Network): Network {
  if (!network.resolved) {
    throw new ConfigError(
      `network "${network.name}" is not resolved: ${network.unresolvedReason ?? 'its values have not been confirmed'}`,
    );
  }
  return network;
}

/**
 * Reads a deployed contract address, failing loudly when it is unset. Never
 * falls back to the zero address: a transaction to 0x0 looks like a
 * configuration success until someone reads the explorer.
 */
export function requireAddress(network: Network, contract: keyof ContractAddresses): Address {
  const address = network.contracts[contract];
  if (address === null || address === undefined) {
    throw new ConfigError(
      `${contract} is not deployed on ${network.name}: set its address in packages/config after deployment`,
    );
  }
  return address;
}
