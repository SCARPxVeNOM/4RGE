/**
 * Bonding an agent, and slashing it for equivocation — on Galileo.
 *
 * Equivocation is the one thing this system can punish without an arbiter: the
 * agent's own registered key signing two different outputs for the same step
 * of the same run. A step has one answer, so offering two means telling
 * different parties different things about the same work, and anyone can prove
 * it from the two signatures alone.
 *
 * This mints a throwaway identity for the demonstration, because slashing is
 * permanent and burning a working agent to make a point would be a poor trade.
 *
 *   ZG_PRIVATE_KEY=0x… npx tsx src/slash.ts
 */

import { GALILEO } from '@0gflow/config';
import { agentOutputDigest, type Hex } from '@0gflow/core';
import { publishAgent } from '@0gflow/publish';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, nonceManager } from 'viem/accounts';

const ENDPOINT =
  process.env['AGENT_ENDPOINT'] ?? 'https://agents-production-1dcf.up.railway.app/agents/delegates';
const BOND = 2_000_000_000_000_000n; // 0.002 OG

const ABI = [
  { type: 'function', name: 'stake', stateMutability: 'payable', inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'stakeOf', stateMutability: 'view', inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'isSlashed', stateMutability: 'view', inputs: [{ name: 'agentId', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  {
    type: 'function',
    name: 'proveEquivocation',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'runId', type: 'bytes32' },
      { name: 'stepIndex', type: 'uint32' },
      {
        name: 'a',
        type: 'tuple',
        components: [
          { name: 'inputHash', type: 'bytes32' },
          { name: 'outputHash', type: 'bytes32' },
          { name: 'signature', type: 'bytes' },
        ],
      },
      {
        name: 'b',
        type: 'tuple',
        components: [
          { name: 'inputHash', type: 'bytes32' },
          { name: 'outputHash', type: 'bytes32' },
          { name: 'signature', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
  },
] as const;

const og = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(6)} OG`;

async function main(): Promise<number> {
  const privateKey = process.env['ZG_PRIVATE_KEY'];
  if (privateKey === undefined || privateKey === '') {
    console.error('ZG_PRIVATE_KEY is not set');
    return 2;
  }
  const reputation = process.env['REPUTATION'] ?? GALILEO.contracts.agentReputation;
  const receipts = GALILEO.contracts.executionReceiptsV2;
  if (reputation === null || reputation === undefined || receipts === null) {
    console.error('the reputation contract is not configured');
    return 2;
  }

  const chain = defineChain({
    id: GALILEO.chainId,
    name: GALILEO.displayName,
    nativeCurrency: { name: GALILEO.nativeToken, symbol: GALILEO.nativeToken, decimals: 18 },
    rpcUrls: { default: { http: [GALILEO.rpcUrl] } },
  });
  const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const account = privateKeyToAccount(key as `0x${string}`, { nonceManager });
  const rpc = createPublicClient({ chain, transport: http(GALILEO.rpcUrl) });
  const wallet = createWalletClient({ account, chain, transport: http(GALILEO.rpcUrl) });

  // The doomed agent gets its own key, generated here and thrown away.
  const agentKey = generatePrivateKey();
  const agentAccount = privateKeyToAccount(agentKey);

  console.log(`\n  minting a throwaway identity to slash…`);
  const published = await publishAgent({
    network: GALILEO,
    privateKey,
    endpoint: ENDPOINT,
    signer: agentAccount.address,
    payTo: agentAccount.address,
    name: 'Equivocation demo',
    description: 'Minted to be slashed. Do not hire.',
    log: () => {},
  });
  const agentId = published.agentId;
  console.log(`  agent    ${agentId}, signer ${agentAccount.address}`);

  const send = async (data: `0x${string}`, value = 0n) => {
    const hash = await wallet.sendTransaction({
      account, chain, to: reputation as `0x${string}`, data, value, gasPrice: 5_000_000_000n,
    });
    for (let i = 0; i < 90; i++) {
      try {
        return await rpc.getTransactionReceipt({ hash });
      } catch {
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    throw new Error(`no receipt for ${hash}`);
  };

  console.log(`  bonding  ${og(BOND)}…`);
  await send(encodeFunctionData({ abi: ABI, functionName: 'stake', args: [agentId] }), BOND);
  const staked = await rpc.readContract({ address: reputation as `0x${string}`, abi: ABI, functionName: 'stakeOf', args: [agentId] });
  console.log(`  staked   ${og(staked)}`);

  // The offence: two different answers, signed for the same step.
  const runId = `0x${'77'.repeat(32)}` as Hex;
  const inputHash = `0x${'33'.repeat(32)}` as Hex;
  const claim = async (outputHash: Hex) => {
    const digest = agentOutputDigest({
      chainId: GALILEO.chainId,
      receipts,
      runId,
      stepIndex: 0,
      agentId,
      inputHash,
      outputHash,
    });
    return {
      inputHash,
      outputHash,
      signature: await agentAccount.signMessage({ message: { raw: digest as `0x${string}` } }),
    };
  };
  const a = await claim(`0x${'aa'.repeat(32)}` as Hex);
  const b = await claim(`0x${'bb'.repeat(32)}` as Hex);

  console.log(`  the agent signs two different outputs for step 0 of the same run`);
  const before = await rpc.getBalance({ address: account.address });
  await send(
    encodeFunctionData({ abi: ABI, functionName: 'proveEquivocation', args: [agentId, runId, 0, a, b] }),
  );
  const after = await rpc.getBalance({ address: account.address });

  const remaining = await rpc.readContract({ address: reputation as `0x${string}`, abi: ABI, functionName: 'stakeOf', args: [agentId] });
  const slashed = await rpc.readContract({ address: reputation as `0x${string}`, abi: ABI, functionName: 'isSlashed', args: [agentId] });

  console.log('');
  console.log(`  bond remaining  ${og(remaining)}`);
  console.log(`  slashed         ${slashed}`);
  console.log(`  prover balance  ${after > before ? 'up' : 'down'} by ${og(after > before ? after - before : before - after)} (net of gas)`);
  console.log(`  half the bond was destroyed; the contract keeps it with no way out\n`);

  return slashed && remaining === 0n ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error: Error) => {
    console.error(error);
    process.exit(1);
  });
