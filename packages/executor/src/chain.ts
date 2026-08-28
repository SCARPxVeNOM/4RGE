/**
 * The on-chain half of the executor — spec §7.2, §7.7, §7.9.
 *
 * One signer per worker, wrapped in viem's nonceManager: §13's mitigation for
 * nonce collisions is that signers are never shared, and this class owns
 * exactly one.
 *
 * Anchoring is idempotent by design. `anchorStep` reverts on a duplicate
 * (runId, stepIndex), so a worker resuming after a crash must check before it
 * writes rather than discovering the collision as a failed transaction.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { nonceManager, privateKeyToAccount } from 'viem/accounts';
import { requireAddress, requireResolved, type Network } from '@0gflow/config';
import type { Hex, Receipt } from '@0gflow/core';
import { EXECUTION_RECEIPTS_ABI, FLOW_REGISTRY_ABI } from './abi.js';
import type { AnchorReceipt, ChainWriter } from './execute.js';

export class ChainError extends Error {
  override readonly name = 'ChainError';
}

export interface ViemChainWriterOptions {
  readonly network: Network;
  readonly privateKey: string;
  /**
   * Galileo rejects transactions below a minimum tip; viem's estimate lands
   * under it, so an explicit price is required rather than optional.
   */
  readonly gasPrice?: bigint;
  /**
   * Anchor to a different receipts contract than the network default.
   *
   * v1 and v2 are both deployed and both live, so which one a run anchors to
   * is a per-run choice rather than a property of the network. The address is
   * also what an agent's signature commits to, so it must be the same value
   * the executor hands to agents — which is why it lives here, on the object
   * that already knows it, rather than being passed separately.
   */
  readonly receiptsContract?: Hex;
}

const DEFAULT_GAS_PRICE = 5_000_000_000n;

/**
 * Core models a hash as `string`; viem wants the `0x${string}` template type.
 * One conversion point at the boundary, so the cast is not sprinkled through
 * every call site where it would be easy to apply to the wrong argument.
 */
const hx = (value: string): `0x${string}` =>
  (value.startsWith('0x') ? value : `0x${value}`) as `0x${string}`;

export class ViemChainWriter implements ChainWriter {
  readonly executorAddress: Hex;
  /** What an agent's signature must commit to for this run's receipts. */
  readonly chainId: number;
  readonly receiptsAddress: Hex;

  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly chain: Chain;
  private readonly account: Account;
  private readonly flowRegistry: `0x${string}`;
  private readonly executionReceipts: `0x${string}`;
  private readonly gasPrice: bigint;

  constructor(options: ViemChainWriterOptions) {
    const network = requireResolved(options.network);
    this.flowRegistry = hx(requireAddress(network, 'flowRegistry'));
    this.executionReceipts = hx(
      options.receiptsContract ?? requireAddress(network, 'executionReceipts'),
    );
    this.gasPrice = options.gasPrice ?? DEFAULT_GAS_PRICE;

    this.chain = defineChain({
      id: network.chainId,
      name: network.displayName,
      nativeCurrency: { name: network.nativeToken, symbol: network.nativeToken, decimals: 18 },
      rpcUrls: { default: { http: [network.rpcUrl] } },
      blockExplorers: { default: { name: 'explorer', url: network.explorerUrl } },
    });

    const key = options.privateKey.startsWith('0x') ? options.privateKey : `0x${options.privateKey}`;
    this.account = privateKeyToAccount(key as `0x${string}`, { nonceManager });
    this.executorAddress = this.account.address as Hex;
    this.chainId = network.chainId;
    this.receiptsAddress = this.executionReceipts as Hex;

    this.publicClient = createPublicClient({ chain: this.chain, transport: http(network.rpcUrl) });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: this.chain,
      transport: http(network.rpcUrl),
    });
  }

  private async send(hash: `0x${string}`, label: string) {
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new ChainError(`${label} reverted (${hash})`);
    }
    return receipt;
  }

  async isFlowPublished(flowId: Hex): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.flowRegistry,
      abi: FLOW_REGISTRY_ABI,
      functionName: 'isPublished',
      args: [hx(flowId)],
    }) as Promise<boolean>;
  }

  async publishFlow(flowId: Hex, specRoot: Hex, name: string): Promise<void> {
    const hash = await this.walletClient.writeContract({
      address: this.flowRegistry,
      abi: FLOW_REGISTRY_ABI,
      functionName: 'publishFlow',
      args: [hx(flowId), hx(specRoot), name],
      gasPrice: this.gasPrice,
      chain: this.chain,
      account: this.account,
    });
    await this.send(hash, 'publishFlow');
  }

  async startRun(flowId: Hex, runId: Hex, executor: Hex): Promise<void> {
    const hash = await this.walletClient.writeContract({
      address: this.flowRegistry,
      abi: FLOW_REGISTRY_ABI,
      functionName: 'startRun',
      args: [hx(flowId), hx(runId), hx(executor)],
      gasPrice: this.gasPrice,
      chain: this.chain,
      account: this.account,
    });
    await this.send(hash, 'startRun');
  }

  async anchorStep(receipt: Receipt): Promise<AnchorReceipt> {
    // §4.1 idempotency: check first so a resumed worker does not spend gas
    // discovering that the step is already on chain.
    const already = (await this.publicClient.readContract({
      address: this.executionReceipts,
      abi: EXECUTION_RECEIPTS_ABI,
      functionName: 'isAnchored',
      args: [hx(receipt.runId), receipt.stepIndex],
    })) as boolean;
    if (already) {
      throw new ChainError(
        `step ${receipt.stepIndex} of run ${receipt.runId} is already anchored; resuming must not double-anchor`,
      );
    }

    const hash = await this.walletClient.writeContract({
      address: this.executionReceipts,
      abi: EXECUTION_RECEIPTS_ABI,
      functionName: 'anchorStep',
      args: [{ ...receipt, flowId: hx(receipt.flowId), runId: hx(receipt.runId), inputHash: hx(receipt.inputHash), outputHash: hx(receipt.outputHash), traceRoot: hx(receipt.traceRoot), attestationRef: hx(receipt.attestationRef) }],
      gasPrice: this.gasPrice,
      chain: this.chain,
      account: this.account,
    });
    const mined = await this.send(hash, `anchorStep(${receipt.stepIndex})`);

    const log = mined.logs.find((l) => l.address.toLowerCase() === this.executionReceipts.toLowerCase());
    return {
      txHash: hash as Hex,
      blockNumber: mined.blockNumber,
      logIndex: log?.logIndex ?? 0,
    };
  }

  async sealRun(
    runId: Hex,
    chainRoot: Hex,
    stepCount: number,
    outcome: number,
  ): Promise<{ txHash: Hex; blockNumber: bigint }> {
    const hash = await this.walletClient.writeContract({
      address: this.executionReceipts,
      abi: EXECUTION_RECEIPTS_ABI,
      functionName: 'sealRun',
      args: [hx(runId), hx(chainRoot), stepCount, outcome],
      gasPrice: this.gasPrice,
      chain: this.chain,
      account: this.account,
    });
    const mined = await this.send(hash, 'sealRun');
    return { txHash: hash as Hex, blockNumber: mined.blockNumber };
  }

  async balance(): Promise<bigint> {
    return this.publicClient.getBalance({ address: this.account.address });
  }
}
