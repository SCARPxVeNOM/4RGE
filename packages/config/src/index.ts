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
  /**
   * The v2 marketplace contracts, deployed alongside v1 rather than replacing
   * it. v1 stays live and every run anchored there keeps verifying (§10.2),
   * which is why these are separate slots and not new values in the old ones.
   *
   * `executionReceiptsV2` stores agentId and the hashes on chain;
   * `agentAdapterRegistryV2` carries the signing key, payee and price;
   * `flowEscrowV2` releases payment against an agent's own signature.
   */
  readonly executionReceiptsV2: Address | null;
  readonly agentAdapterRegistryV2: Address | null;
  readonly flowEscrowV2: Address | null;
  /**
   * ERC-8004 IdentityRegistry. Pre-deployed on Galileo (§2), resolved by
   * on-chain probe rather than assumed: name "ERC-8004 Trustless Agent",
   * symbol AGENT, ERC-721 + Metadata.
   */
  readonly identityRegistry: Address | null;
  /**
   * 0G's own agent identity (ERC-7857 "Agentic ID", symbol AID). An
   * alternative to ERC-8004 that is also ERC-721 keyed by uint256 token id,
   * so AgentAdapterRegistry can point at either without code changes.
   */
  readonly agenticIdRegistry: Address | null;
  readonly reputationRegistry: Address | null;
  /**
   * 0G's InferenceServing contract — the trust anchor for TEE attestation
   * (§6.3). `getService(provider)` returns the TEE signer 0G acknowledges for
   * that provider, which is what a response signature must recover to before
   * a step can be `bound`.
   *
   * Anchoring here rather than on a vendor PKI keeps attestation on the same
   * public data as everything else in §9, and makes revocation work: chain
   * state is live, so a de-acknowledged signer stops attesting immediately.
   */
  readonly inferenceServing: Address | null;
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
  executionReceiptsV2: null,
  agentAdapterRegistryV2: null,
  flowEscrowV2: null,
  flowEscrow: null,
  identityRegistry: null,
  agenticIdRegistry: null,
  reputationRegistry: null,
  inferenceServing: null,
};

/**
 * Agent registries already deployed on Galileo, each confirmed live by probing
 * name()/symbol()/supportsInterface() rather than taken from documentation.
 * Both are ERC-721, which is why Receipt.agentId is a uint256 token id and not
 * an address.
 */
const GALILEO_CONTRACTS: ContractAddresses = {
  // Deployed via CREATE2 with salt keccak256("0gflow.v1") at block 50316677,
  // so the same addresses are reproducible on Aristotle (§12).
  flowRegistry: '0xe09aC2F04Fc663dB9ddb2824d44d5B1AFe7fD53f',
  executionReceipts: '0x741A36fAba40ee71223539a5A062FDEDC8574e30',
  agentAdapterRegistry: '0x239E66ca972bdA91542BA78c12B3003EFED8389e',
  // Filled in by contracts/script/DeployV2.s.sol.
  executionReceiptsV2: null,
  agentAdapterRegistryV2: null,
  flowEscrowV2: null,
  flowEscrow: '0xC40aC67bF4d63D8CdFeCBb80cE1C357c90291C39',
  identityRegistry: '0x7177a6867296406881E20d6647232314736Dd09A',
  agenticIdRegistry: '0x2700F6A3e505402C9daB154C5c6ab9cAEC98EF1F',
  reputationRegistry: null,
  // 0G InferenceServing. Confirmed live: getService() for both attesting
  // providers returns an acknowledged teeSignerAddress equal to the address in
  // their captured quote's report_data.
  inferenceServing: '0xa79F4c8311FF93C06b8CfB403690cc987c93F91E',
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
  contracts: GALILEO_CONTRACTS,
  deploymentBlock: 50316677,
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
