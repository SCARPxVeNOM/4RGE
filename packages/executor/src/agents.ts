/**
 * Reading `AgentAdapterRegistryV2` — the identity trust anchor.
 *
 * `signerOf(agentId)` returns the key an agent published for itself. That key
 * is what an output signature must recover to for the receipt's `agentId` to
 * mean anything, and it is the same value `FlowEscrowV2.releaseStep` reads
 * before paying.
 *
 * The call is hand-encoded rather than built from an ABI, matching
 * `signers.ts`: one static argument in, one address out, and no dependency on
 * an artifact file that could drift from the deployed contract.
 *
 * Note the deliberate asymmetry with `signers.ts`. `getService` reverts for an
 * unregistered provider; `signerOf` returns the zero address for an unlisted
 * agent, because the escrow needs a comparable value rather than a revert.
 * Both are mapped to null here — "this agent published no key" — which
 * `verifyAgentSignature` refuses to treat as a pass.
 */

import { createPublicClient, http, type PublicClient } from 'viem';
import type { Hex } from '@0gflow/core';
import type { AgentRegistry } from './execute.js';

/** keccak256('signerOf(uint256)')[0:4] — `cast sig "signerOf(uint256)"`. */
const SIGNER_OF = '0x5161fdf5';

const ZERO_ADDRESS = `0x${'00'.repeat(20)}`;

export interface ViemAgentRegistryOptions {
  readonly rpcUrl: string;
  /** AgentAdapterRegistryV2. */
  readonly adapterRegistry: Hex;
}

export class ViemAgentRegistry implements AgentRegistry {
  private readonly client: PublicClient;
  /**
   * An agent does not rotate its key mid-run, and a flow may call the same
   * agent in several steps. One read each.
   */
  private readonly cache = new Map<string, Hex | null>();

  constructor(private readonly options: ViemAgentRegistryOptions) {
    this.client = createPublicClient({ transport: http(options.rpcUrl) });
  }

  async agentSigner(agentId: bigint): Promise<Hex | null> {
    const key = agentId.toString();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const resolved = await this.read(agentId);
    this.cache.set(key, resolved);
    return resolved;
  }

  private async read(agentId: bigint): Promise<Hex | null> {
    if (agentId < 0n || agentId >= 1n << 256n) return null;
    const data = `${SIGNER_OF}${agentId.toString(16).padStart(64, '0')}` as Hex;

    let raw: Hex;
    try {
      const result = await this.client.call({
        to: this.options.adapterRegistry as `0x${string}`,
        data: data as `0x${string}`,
      });
      if (result.data === undefined) return null;
      raw = result.data;
    } catch {
      // An unreachable node or a wrong address. Nothing is established, which
      // is not the same as a signature having failed — the caller reports the
      // identity as unproven either way, and never as forged.
      return null;
    }

    // One 32-byte word, address in the low 20 bytes.
    const body = raw.replace(/^0x/, '');
    if (body.length < 64) return null;
    const address = `0x${body.slice(24, 64)}` as Hex;

    // The registry refuses to list a zero signer, so zero means "no such
    // listing" — an agent that published no key, which cannot verify to true.
    return address.toLowerCase() === ZERO_ADDRESS ? null : (address.toLowerCase() as Hex);
  }
}
