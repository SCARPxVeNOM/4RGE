/**
 * The browser's half of publishing: an injected wallet, and nothing else.
 *
 * The explorer is otherwise read-only and asks for no wallet at all. This
 * module is the single exception, loaded only by the publish page. It is
 * deliberately small and dependency-free — no wallet SDK, no connector
 * library, no bundled RPC client. Everything here is `window.ethereum` and the
 * JSON-RPC methods every injected wallet has implemented for years.
 *
 * That is a design choice, not laziness. A wallet library is a large amount of
 * third-party code standing between a user and a transaction they are about to
 * sign, in a project whose entire argument is that you should not have to take
 * anyone's word for what happened. The calldata this sends is built by
 * `@0gflow/publish/calldata`, which is pinned against viem in that package's
 * tests, and the user's wallet shows them the bytes before they approve.
 */

import { keccak256 } from '@0gflow/core';

/** The subset of EIP-1193 used here. */
interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export class WalletError extends Error {
  override readonly name = 'WalletError';
}

/**
 * Hashes a function or event signature.
 *
 * The `TextEncoder` is not decoration. `keccak256` takes bytes or a *hex*
 * string, so handing it a signature directly hashes it as hex — which for
 * `Transfer(address,address,uint256)` throws, and for a signature that happens
 * to be even-length and hex-shaped would silently produce a topic that matches
 * nothing. Encoding first is what makes it the UTF-8 hash Ethereum defines.
 */
export const hashSignature = (signature: string): string =>
  keccak256(new TextEncoder().encode(signature));

/**
 * `Transfer(address,address,uint256)`, computed rather than pasted.
 *
 * The constant is well known enough that writing it from memory feels safe,
 * which is exactly why it is worth not doing: a single wrong nibble would make
 * the mint appear to emit nothing, and the page would report a successful
 * transaction whose agent id it could not find.
 */
const TRANSFER_TOPIC = hashSignature('Transfer(address,address,uint256)');

export interface ChainSpec {
  readonly chainId: number;
  readonly name: string;
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  readonly nativeToken: string;
}

function provider(): Eip1193Provider {
  const injected = window.ethereum;
  if (injected === undefined) {
    throw new WalletError(
      'no wallet found in this browser. Install MetaMask, or publish from a terminal with npx @0gflow/publish.',
    );
  }
  return injected;
}

export function hasWallet(): boolean {
  return typeof window !== 'undefined' && window.ethereum !== undefined;
}

/** Accounts already authorised, without prompting. */
export async function currentAccount(): Promise<string | null> {
  if (!hasWallet()) return null;
  const accounts = (await provider().request({ method: 'eth_accounts' })) as string[];
  return accounts[0] ?? null;
}

export async function connect(): Promise<string> {
  const accounts = (await provider().request({ method: 'eth_requestAccounts' })) as string[];
  const account = accounts[0];
  if (account === undefined) throw new WalletError('the wallet returned no accounts');
  return account;
}

export function onAccountsChanged(handler: (account: string | null) => void): () => void {
  const injected = window.ethereum;
  if (injected?.on === undefined) return () => {};
  const listener = (...args: unknown[]) => {
    const accounts = args[0] as string[];
    handler(accounts[0] ?? null);
  };
  injected.on('accountsChanged', listener);
  return () => injected.removeListener?.('accountsChanged', listener);
}

/**
 * Puts the wallet on the right chain, adding it if the wallet has never seen it.
 *
 * Switching is not a nicety. A transaction signed on the wrong chain is a
 * transaction that either fails or — if the same address exists elsewhere —
 * succeeds somewhere the publisher did not intend, and the listing would be
 * missing with nothing to show why.
 */
export async function ensureChain(spec: ChainSpec): Promise<void> {
  const wanted = `0x${spec.chainId.toString(16)}`;
  const current = (await provider().request({ method: 'eth_chainId' })) as string;
  if (current.toLowerCase() === wanted.toLowerCase()) return;

  try {
    await provider().request({ method: 'wallet_switchEthereumChain', params: [{ chainId: wanted }] });
  } catch (error) {
    // 4902: the wallet does not know this chain. Anything else — including a
    // rejection — is the user's answer and is passed through rather than
    // retried as an "add network" prompt they did not ask for.
    if ((error as { code?: number }).code !== 4902) throw error;
    await provider().request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: wanted,
          chainName: spec.name,
          nativeCurrency: { name: spec.nativeToken, symbol: spec.nativeToken, decimals: 18 },
          rpcUrls: [spec.rpcUrl],
          blockExplorerUrls: [spec.explorerUrl],
        },
      ],
    });
  }

  // Adding a chain does not always select it, and some wallets resolve the
  // switch before it has taken effect. Confirm rather than assume: sending to
  // the wrong chain is the failure this whole function exists to prevent.
  const after = (await provider().request({ method: 'eth_chainId' })) as string;
  if (after.toLowerCase() !== wanted.toLowerCase()) {
    throw new WalletError(`the wallet is on chain ${after}, not ${spec.name} (${wanted})`);
  }
}

export interface TxRequest {
  readonly from: string;
  readonly to: string;
  readonly data: string;
  /** Galileo rejects transactions below a minimum tip; wallets estimate under it. */
  readonly gasPrice?: bigint;
}

export async function sendTransaction(tx: TxRequest): Promise<string> {
  return (await provider().request({
    method: 'eth_sendTransaction',
    params: [
      {
        from: tx.from,
        to: tx.to,
        data: tx.data,
        ...(tx.gasPrice === undefined ? {} : { gasPrice: `0x${tx.gasPrice.toString(16)}` }),
      },
    ],
  })) as string;
}

export interface TxReceipt {
  readonly status: string;
  readonly logs: readonly { address: string; topics: string[]; data: string }[];
}

/**
 * Waits for a receipt until a deadline, not for a number of tries.
 *
 * Galileo can take well over a minute to surface one. Giving up on a retry
 * count reports a failed publish for a transaction that succeeded, and the
 * obvious response — publish again — then reverts on the version check, with
 * an error pointing nowhere near the cause. This has already happened twice in
 * this project through exactly that bug in a library helper.
 */
export async function waitForReceipt(hash: string, timeoutMs = 180_000): Promise<TxReceipt> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = (await provider()
      .request({ method: 'eth_getTransactionReceipt', params: [hash] })
      .catch(() => null)) as TxReceipt | null;

    if (receipt !== null) return receipt;
    if (Date.now() >= deadline) {
      throw new WalletError(
        `${hash} was submitted but no receipt appeared within ${Math.round(timeoutMs / 1000)}s. ` +
          `It may still confirm — check the transaction before sending it again.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/**
 * The token id from a mint's `Transfer` log.
 *
 * Matched on `from == 0x0` and `to == owner` rather than taking the first
 * Transfer in the transaction: a registry may emit others, and picking by
 * position would be a guess that happens to work until it does not.
 */
export function mintedTokenId(receipt: TxReceipt, registry: string, owner: string): bigint {
  const zero = `0x${'0'.repeat(64)}`;
  const ownerTopic = `0x${owner.replace(/^0x/i, '').toLowerCase().padStart(64, '0')}`;

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== registry.toLowerCase()) continue;
    if (log.topics.length < 4) continue;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) continue;
    if (log.topics[1]?.toLowerCase() !== zero) continue;
    if (log.topics[2]?.toLowerCase() !== ownerTopic) continue;
    return BigInt(log.topics[3]!);
  }

  throw new WalletError(
    'the mint confirmed but emitted no Transfer to your address, so the new agent id is unknown. ' +
      'Check the transaction on the explorer before minting again.',
  );
}

/** A read, through the wallet's own RPC connection. */
export async function call(to: string, data: string): Promise<string> {
  return (await provider().request({ method: 'eth_call', params: [{ to, data }, 'latest'] })) as string;
}
