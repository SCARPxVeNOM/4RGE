/**
 * Reading 0G's InferenceServing registry — the attestation trust anchor (§6.3).
 *
 * `getService(provider)` returns the TEE signer 0G has acknowledged for that
 * provider. Without it a response signature has nothing to be checked against,
 * so a step can reach no more than `present`.
 *
 * The decoding is deliberately the same shape as the verifier's
 * (`packages/verify/src/sources.ts`): both read the two static members out of a
 * dynamic tuple at fixed head offsets. If the executor and the verifier read
 * that struct differently, a run could be anchored `ok` and then fail to
 * verify, which is the §5.2 failure mode applied to a different field.
 */

import { createPublicClient, http, type PublicClient } from 'viem';
import type { AcknowledgedSigner, Hex } from '@0gflow/core';
import type { SignerRegistry } from './execute.js';

/** keccak256('getService(address)')[0:4]. */
const GET_SERVICE = '0x15a52302';

export interface ViemSignerRegistryOptions {
  readonly rpcUrl: string;
  /** 0G InferenceServing. */
  readonly inferenceServing: Hex;
}

export class ViemSignerRegistry implements SignerRegistry {
  private readonly client: PublicClient;
  /** Providers do not change their signer mid-run; one read each is enough. */
  private readonly cache = new Map<string, AcknowledgedSigner | null>();

  constructor(private readonly options: ViemSignerRegistryOptions) {
    this.client = createPublicClient({ transport: http(options.rpcUrl) });
  }

  async acknowledgedSigner(provider: Hex): Promise<AcknowledgedSigner | null> {
    const key = provider.toLowerCase();
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    const resolved = await this.read(provider);
    this.cache.set(key, resolved);
    return resolved;
  }

  private async read(provider: Hex): Promise<AcknowledgedSigner | null> {
    const data = `${GET_SERVICE}${provider.replace(/^0x/, '').toLowerCase().padStart(64, '0')}` as Hex;

    let result: Hex;
    try {
      const raw = await this.client.call({
        to: this.options.inferenceServing as `0x${string}`,
        data: data as `0x${string}`,
      });
      if (raw.data === undefined) return null;
      result = raw.data;
    } catch {
      // Unregistered providers revert. A negative answer, not an error the
      // caller should confuse with a pass.
      return null;
    }

    const body = result.replace(/^0x/, '');
    if (body.length < 12 * 64) return null;

    const word = (index: number): string => body.slice(index * 64, (index + 1) * 64);
    // A layout not starting with the expected pointer is not the return this
    // decoder was written against; guessing past that yields a plausible
    // address from the wrong field.
    if (BigInt(`0x${word(0)}`) !== 32n) return null;

    const signerWord = word(10);
    const acknowledgedWord = word(11);
    if (!/^0{24}[0-9a-fA-F]{40}$/.test(signerWord)) return null;
    if (!/^0{63}[01]$/.test(acknowledgedWord)) return null;

    return {
      provider: provider.toLowerCase() as Hex,
      teeSignerAddress: `0x${signerWord.slice(24)}`.toLowerCase() as Hex,
      acknowledged: acknowledgedWord.endsWith('1'),
    };
  }
}
