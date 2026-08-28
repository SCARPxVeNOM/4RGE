/**
 * Distinct identities for the reference agents.
 *
 * WHY THIS FILE EXISTS
 *
 * Every reference agent used to hardcode `agentId: '1'`. On Galileo, `ownerOf`
 * says token 1 belongs to a stranger, so six agents were all claiming one
 * person's identity — and because nothing checked, the receipts anchored
 * happily. In a marketplace where reputation is derived from receipts and
 * payment is released against them, that is not untidiness: it is how you
 * poison someone else's record.
 *
 * So each agent gets its own id and its own key, and signs its own outputs.
 *
 * WHAT THESE KEYS ARE, AND ARE NOT
 *
 * The keys are derived deterministically from the agent's name. That makes a
 * local run reproducible and means nobody has to manage six secrets to try the
 * project out. It also means they are **public** — anyone reading this file
 * can compute them. That is fine for reference agents, whose job is to make
 * the executor observable, and unacceptable for anything else.
 *
 * A real agent supplies `AGENT_KEY_<NAME>` and `AGENT_ID_<NAME>` from its own
 * environment. The ids below are placeholders in the same sense: they are not
 * minted, and until an identity is minted and listed with a matching signer,
 * `agentSigner` returns null and a step requiring a signed output records
 * Unattested. That is the honest outcome, and it is what `packages/publish`
 * exists to change.
 */

import { keccak256 } from '@0gflow/core';
import { privateKeyToAccount } from 'viem/accounts';

export interface AgentIdentity {
  /** ERC-721 token id, decimal string. */
  readonly agentId: string;
  readonly address: string;
  sign(digest: string): Promise<string>;
}

const envName = (name: string): string => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

/**
 * A deterministic development key. Public by construction — see the header.
 *
 * Domain-separated from every other digest in the system so that a value
 * derived here can never coincide with one that means something elsewhere.
 */
function devKey(name: string): `0x${string}` {
  return keccak256(new TextEncoder().encode(`0gflow-reference-agent-key:${name}`)) as `0x${string}`;
}

export function identityFor(name: string, fallbackAgentId: string): AgentIdentity {
  const key = (process.env[`AGENT_KEY_${envName(name)}`] ?? devKey(name)) as `0x${string}`;
  const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);

  return {
    agentId: process.env[`AGENT_ID_${envName(name)}`] ?? fallbackAgentId,
    address: account.address,
    sign: (digest: string) => account.signMessage({ message: { raw: digest as `0x${string}` } }),
  };
}
