/**
 * Paying agents against verified work — spec §4.4, on `FlowEscrowV2`.
 *
 * The interesting property is what this client *cannot* do. It allocates from
 * a budget and submits release transactions, but it cannot decide who gets
 * paid: the escrow reads the agent from the receipt, reads that agent's payee
 * and signing key from the registry, and pays only against a signature by
 * that key. An executor running this code could name any agent in a receipt
 * and still not misdirect a single wei.
 *
 * That is why funding a run does not require trusting whoever executes it.
 */

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  type Account,
  type Chain,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, nonceManager } from 'viem/accounts';
import type { Hex } from '@0gflow/core';
import type { Network } from '@0gflow/config';

export class EscrowError extends Error {
  override readonly name = 'EscrowError';
}

const GAS_PRICE = 5_000_000_000n;

const ESCROW_ABI = [
  {
    type: 'function',
    name: 'fundRun',
    stateMutability: 'payable',
    inputs: [
      { name: 'runId', type: 'bytes32' },
      { name: 'deadline', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'allocate',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'runId', type: 'bytes32' },
      { name: 'stepIndex', type: 'uint32' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'releaseStep',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'runId', type: 'bytes32' },
      { name: 'stepIndex', type: 'uint32' },
      { name: 'agentSig', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'refundUnspent',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'runId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'refundExpired',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'runId', type: 'bytes32' }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'runId', type: 'bytes32' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allocationOf',
    stateMutability: 'view',
    inputs: [
      { name: 'runId', type: 'bytes32' },
      { name: 'stepIndex', type: 'uint32' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'isReleased',
    stateMutability: 'view',
    inputs: [
      { name: 'runId', type: 'bytes32' },
      { name: 'stepIndex', type: 'uint32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export interface ViemEscrowOptions {
  readonly network: Network;
  readonly privateKey: string;
  /** FlowEscrowV2. */
  readonly escrow: Hex;
  readonly gasPrice?: bigint;
}

export class ViemEscrow {
  readonly address: Hex;
  private readonly publicClient: PublicClient;
  private readonly wallet: WalletClient;
  private readonly chain: Chain;
  private readonly account: Account;
  private readonly gasPrice: bigint;

  constructor(options: ViemEscrowOptions) {
    const { network } = options;
    this.address = options.escrow;
    this.gasPrice = options.gasPrice ?? GAS_PRICE;

    this.chain = defineChain({
      id: network.chainId,
      name: network.displayName,
      nativeCurrency: { name: network.nativeToken, symbol: network.nativeToken, decimals: 18 },
      rpcUrls: { default: { http: [network.rpcUrl] } },
      blockExplorers: { default: { name: 'explorer', url: network.explorerUrl } },
    });

    const key = options.privateKey.startsWith('0x') ? options.privateKey : `0x${options.privateKey}`;
    this.account = privateKeyToAccount(key as `0x${string}`, { nonceManager });
    this.publicClient = createPublicClient({ chain: this.chain, transport: http(network.rpcUrl) });
    this.wallet = createWalletClient({
      account: this.account,
      chain: this.chain,
      transport: http(network.rpcUrl),
    });
  }

  /**
   * Escrows a budget, recoverable after `deadline`.
   *
   * The deadline is not optional in the contract and not defaulted here. A run
   * the executor abandons before sealing would otherwise hold the funder's
   * money with no path to recovery, which is exactly the v1 bug this replaces.
   */
  async fundRun(runId: Hex, amount: bigint, deadline: bigint): Promise<Hex> {
    return this.send('fundRun', [runId, deadline], amount);
  }

  async allocate(runId: Hex, stepIndex: number, amount: bigint): Promise<Hex> {
    return this.send('allocate', [runId, stepIndex, amount]);
  }

  /**
   * Pays the step's agent, against the agent's own signature.
   *
   * Permissionless on chain — anyone may submit — because the signature is the
   * authorisation, not the sender.
   */
  async releaseStep(runId: Hex, stepIndex: number, agentSignature: Hex): Promise<Hex> {
    return this.send('releaseStep', [runId, stepIndex, agentSignature]);
  }

  async refundUnspent(runId: Hex): Promise<Hex> {
    return this.send('refundUnspent', [runId]);
  }

  async refundExpired(runId: Hex): Promise<Hex> {
    return this.send('refundExpired', [runId]);
  }

  balanceOf(runId: Hex): Promise<bigint> {
    return this.read('balanceOf', [runId]) as Promise<bigint>;
  }

  allocationOf(runId: Hex, stepIndex: number): Promise<bigint> {
    return this.read('allocationOf', [runId, stepIndex]) as Promise<bigint>;
  }

  isReleased(runId: Hex, stepIndex: number): Promise<boolean> {
    return this.read('isReleased', [runId, stepIndex]) as Promise<boolean>;
  }

  private read(name: string, args: readonly unknown[]): Promise<unknown> {
    return this.publicClient.readContract({
      address: this.address as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: name as 'balanceOf',
      args: args as never,
    });
  }

  private async send(name: string, args: readonly unknown[], value = 0n): Promise<Hex> {
    const data = encodeFunctionData({
      abi: ESCROW_ABI,
      functionName: name as 'fundRun',
      args: args as never,
    });

    // Simulated first, so a revert surfaces as the contract's own named error
    // rather than as an out-of-gas or a silently failed transaction. The
    // escrow's errors say exactly what was wrong -- BadSignature,
    // StepNotSuccessful, NoAllocation -- and losing that to a generic failure
    // would make a payment problem very hard to diagnose.
    try {
      await this.publicClient.call({
        account: this.account,
        to: this.address as `0x${string}`,
        data,
        value,
      });
    } catch (error) {
      throw new EscrowError(`${name} would revert: ${(error as Error).message}`);
    }

    const hash = await this.wallet.sendTransaction({
      account: this.account,
      chain: this.chain,
      to: this.address as `0x${string}`,
      data,
      value,
      gasPrice: this.gasPrice,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new EscrowError(`${name} reverted on chain: ${hash}`);
    }
    return hash as Hex;
  }
}
