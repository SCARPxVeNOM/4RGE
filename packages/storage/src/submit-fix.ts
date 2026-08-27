/**
 * Makes `@0glabs/0g-ts-sdk@0.3.3` work against the deployed 0G Storage flow
 * contract, which has moved on from the struct the SDK encodes.
 *
 * THE MISMATCH
 *
 * Upstream refactored the submission type (0g-storage-contracts,
 * contracts/interfaces/Submission.sol):
 *
 *   // what the SDK still encodes
 *   struct Submission { uint length; bytes tags; SubmissionNode[] nodes; }
 *
 *   // what the chain now expects
 *   struct SubmissionData { uint length; bytes tags; SubmissionNode[] nodes; }
 *   struct Submission     { SubmissionData data; address submitter; }
 *
 * so the selector moved:
 *
 *   0xef3e12dc  submit((uint256,bytes,(bytes32,uint256)[]))            <- SDK
 *   0xbc8c11f8  submit(((uint256,bytes,(bytes32,uint256)[]),address))  <- chain
 *
 * The old entrypoint still exists and reverts unconditionally with a bare
 * `require(false)`, which is why the failure carries no reason string and looks
 * like a network problem. It is not: the contract is unpaused, the market is
 * wired, and other submissions land in the same blocks.
 *
 * THE FIX
 *
 * The SDK builds the submission correctly — Merkle tree, node list, tags — and
 * only the final encoding is wrong. So rather than reimplement uploading, this
 * intercepts the one call that is wrong. `Uploader` dispatches through
 * `contract.getFunction('submit').send(submission, txOpts)`; this wraps the
 * flow contract so that call re-encodes against the current ABI and adds the
 * `submitter` the new struct requires. Segment upload, proof generation and
 * log processing are untouched.
 *
 * Delete this the day the SDK is republished against the deployed contract.
 */

import { ethers } from 'ethers';

/** The submission shape the SDK produces. */
interface LegacySubmission {
  length: bigint | number;
  tags: string;
  nodes: { root: string; height: bigint | number }[];
}

const CURRENT_FLOW_ABI = [
  'function submit(((uint256 length, bytes tags, (bytes32 root, uint256 height)[] nodes) data, address submitter) submission) payable returns (uint256, bytes32, uint256, uint256)',
];

export const LEGACY_SUBMIT_SELECTOR = '0xef3e12dc';
export const CURRENT_SUBMIT_SELECTOR = '0xbc8c11f8';

/**
 * Whether the deployed contract has moved past the SDK's encoding.
 *
 * Checked rather than assumed, so this shim disables itself once upstream
 * catches up instead of silently rewriting calls forever.
 *
 * The flow address is a *beacon proxy* — 295 bytes of runtime that read
 * `implementation()` from a beacon and delegatecall it — so its own bytecode
 * contains no function selectors at all. Looking there finds nothing and would
 * make this return a confident wrong answer; the beacon has to be followed.
 */
export async function needsSubmitFix(
  provider: ethers.Provider,
  flowAddress: string,
): Promise<boolean> {
  const implementation = await resolveImplementation(provider, flowAddress);
  const code = await provider.getCode(implementation);

  const has = (selector: string) => code.includes(selector.slice(2));
  if (has(LEGACY_SUBMIT_SELECTOR)) return false;
  if (has(CURRENT_SUBMIT_SELECTOR)) return true;

  // Neither selector is visible. Rather than guess, leave the SDK alone and
  // let its own error surface: a wrong guess here would rewrite calls against
  // an ABI nobody has confirmed.
  return false;
}

/** EIP-1967 beacon slot: keccak256('eip1967.proxy.beacon') - 1. */
const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
/** EIP-1967 implementation slot. */
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

const addressFromSlot = (word: string): string | null => {
  const address = `0x${word.slice(-40)}`;
  return /^0x0+$/.test(address) ? null : address;
};

/** Follows a beacon or transparent proxy to the contract that holds the code. */
async function resolveImplementation(
  provider: ethers.Provider,
  address: string,
): Promise<string> {
  const direct = addressFromSlot(await provider.getStorage(address, IMPLEMENTATION_SLOT));
  if (direct !== null) return direct;

  const beacon = addressFromSlot(await provider.getStorage(address, BEACON_SLOT));
  if (beacon === null) return address;

  // IBeacon.implementation()
  const result = await provider.call({ to: beacon, data: '0x5c60da1b' });
  return addressFromSlot(result) ?? address;
}

/**
 * Wraps a flow contract so `submit` encodes against the deployed ABI.
 *
 * Everything other than `submit` passes straight through, so the Uploader's
 * receipt handling, log parsing and market lookups behave exactly as before.
 */
export function withSubmitFix<T extends object>(flow: T, submitter: string): T {
  const target = flow as unknown as ethers.BaseContract;

  return new Proxy(flow, {
    get(object, property, receiver) {
      if (property !== 'getFunction') return Reflect.get(object, property, receiver);

      return (name: string) => {
        if (name !== 'submit') return target.getFunction(name);

        // Re-encode this one call against the current struct.
        const current = new ethers.Contract(
          target.target as string,
          CURRENT_FLOW_ABI,
          target.runner,
        );
        const method = current.getFunction('submit');

        const rewrap = (submission: LegacySubmission) => ({
          data: {
            length: submission.length,
            tags: submission.tags,
            nodes: submission.nodes.map((n) => ({ root: n.root, height: n.height })),
          },
          submitter,
        });

        // A fresh object rather than a Proxy over the ethers function: ethers
        // defines `send` as a non-configurable own property, and proxy
        // invariants forbid a trap returning anything else for one of those.
        return {
          send: (submission: LegacySubmission, ...rest: unknown[]) =>
            method.send(rewrap(submission), ...rest),
          staticCall: (submission: LegacySubmission, ...rest: unknown[]) =>
            method.staticCall(rewrap(submission), ...rest),
          estimateGas: (submission: LegacySubmission, ...rest: unknown[]) =>
            method.estimateGas(rewrap(submission), ...rest),
          populateTransaction: (submission: LegacySubmission, ...rest: unknown[]) =>
            method.populateTransaction(rewrap(submission), ...rest),
        };
      };
    },
  }) as T;
}
