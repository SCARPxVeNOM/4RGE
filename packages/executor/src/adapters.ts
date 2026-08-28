/**
 * Resolving an agent from the registry — spec §7 step 1.
 *
 * Until now the executor learned where to call an agent from `endpointFor`, a
 * callback the caller supplied. That is fine for a flow of agents you already
 * run, and useless for a marketplace: a flow naming agent 4211 has to be able
 * to find it without the person writing the flow knowing anything about who
 * operates it.
 *
 * So the endpoint comes from `AgentAdapterRegistryV2`, where the agent's owner
 * published it. With it come the fields that make a listing usable rather than
 * merely present: the signing key, the price, and whether the agent is still
 * active.
 *
 * `getAdapter` returns a struct with two dynamic members, so unlike
 * `signers.ts` and `agents.ts` this one decodes with viem rather than by hand.
 * A hand-rolled reader for a struct with strings in it would be a bug farm for
 * no benefit — the executor already depends on viem, and only the verifier has
 * to stay dependency-free.
 */

import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, type PublicClient } from 'viem';
import type { Hex } from '@0gflow/core';

/** Matching `AgentAdapterRegistryV2.Adapter`. */
export interface ResolvedAdapter {
  readonly agentId: bigint;
  /** 0 http · 1 contract · 2 0g-compute · 3 flow. */
  readonly kind: number;
  readonly endpoint: string;
  readonly schemaRoot: Hex;
  readonly version: number;
  readonly active: boolean;
  readonly payTo: Hex;
  readonly signer: Hex;
  readonly pricePerCall: bigint;
  readonly metadataURI: string;
}

/**
 * Looks up how to call an agent.
 *
 * Returns null for an agent nobody has listed, which is a normal answer — the
 * step then fails with a message naming the agent, rather than the executor
 * throwing somewhere less informative.
 */
export interface AdapterResolver {
  resolve(agentId: bigint): Promise<ResolvedAdapter | null>;
}

const ADAPTER_ABI = [
  {
    type: 'function',
    name: 'getAdapter',
    stateMutability: 'view',
    inputs: [{ name: 'agentId', type: 'uint256' }],
    outputs: [
      {
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
      },
    ],
  },
] as const;

export interface ViemAdapterRegistryOptions {
  readonly rpcUrl: string;
  /** AgentAdapterRegistryV2. */
  readonly adapterRegistry: Hex;
}

export class ViemAdapterRegistry implements AdapterResolver {
  private readonly client: PublicClient;
  /**
   * One read per agent per run.
   *
   * Deliberately per-instance rather than global, and never refreshed
   * mid-run: a flow that called agent 7 at step 0 and step 4 must have called
   * the same agent both times. An endpoint that changed underneath would
   * produce a run whose receipts describe two different things.
   */
  private readonly cache = new Map<string, ResolvedAdapter | null>();

  constructor(private readonly options: ViemAdapterRegistryOptions) {
    this.client = createPublicClient({ transport: http(options.rpcUrl) });
  }

  async resolve(agentId: bigint): Promise<ResolvedAdapter | null> {
    const key = agentId.toString();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const resolved = await this.read(agentId);
    this.cache.set(key, resolved);
    return resolved;
  }

  private async read(agentId: bigint): Promise<ResolvedAdapter | null> {
    if (agentId < 0n || agentId >= 1n << 256n) return null;

    try {
      const result = await this.client.call({
        to: this.options.adapterRegistry as `0x${string}`,
        data: encodeFunctionData({ abi: ADAPTER_ABI, functionName: 'getAdapter', args: [agentId] }),
      });
      if (result.data === undefined) return null;

      const adapter = decodeFunctionResult({
        abi: ADAPTER_ABI,
        functionName: 'getAdapter',
        data: result.data,
      });

      return {
        agentId: adapter.agentId,
        kind: adapter.kind,
        endpoint: adapter.endpoint,
        schemaRoot: adapter.schemaRoot as Hex,
        version: adapter.version,
        active: adapter.active,
        payTo: adapter.payTo as Hex,
        signer: adapter.signer as Hex,
        pricePerCall: adapter.pricePerCall,
        metadataURI: adapter.metadataURI,
      };
    } catch {
      // The registry reverts `NoAdapter` for an unlisted agent. That is a
      // negative answer, not an error — and an unreachable node reaches the
      // same conclusion, which is correct: an agent that cannot be resolved
      // cannot be invoked, whatever the reason.
      return null;
    }
  }
}
