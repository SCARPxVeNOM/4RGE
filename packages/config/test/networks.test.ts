import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GALILEO,
  ARISTOTLE,
  getNetwork,
  requireResolved,
  requireAddress,
  ConfigError,
  type ContractAddresses,
} from '../src/index.js';

describe('Galileo testnet', () => {
  // Verified live: eth_chainId returned 0x40da against the configured RPC.
  test('carries the values from spec §2', () => {
    expect(GALILEO.chainId).toBe(16602);
    expect(GALILEO.rpcUrl).toBe('https://evmrpc-testnet.0g.ai');
    expect(GALILEO.explorerUrl).toBe('https://chainscan-galileo.0g.ai');
    expect(GALILEO.nativeToken).toBe('A0GI');
    expect(GALILEO.resolved).toBe(true);
  });

  test('names a storage indexer', () => {
    expect(GALILEO.storageIndexerUrl).toBe('https://indexer-storage-testnet-turbo.0g.ai');
  });
});

describe('Aristotle mainnet', () => {
  // These two tests used to assert the opposite: that Aristotle was
  // unresolved and refused use. That guard existed so a *guessed* mainnet
  // endpoint could never carry real funds, and it did its job — every value
  // below was confirmed against the live chain before being written. What the
  // tests must now guard is that the confirmed values stay confirmed.

  test('is resolved, and every endpoint is actually filled in', () => {
    expect(ARISTOTLE.resolved).toBe(true);
    expect(ARISTOTLE.chainId).toBe(16661);
    expect(ARISTOTLE.rpcUrl).toBe('https://evmrpc.0g.ai');
    expect(ARISTOTLE.explorerUrl).toBe('https://chainscan.0g.ai');
    expect(ARISTOTLE.storageIndexerUrl).toBe('https://indexer-storage-turbo.0g.ai');
    // An empty string is falsy and would sail through a truthiness check while
    // producing a request to nowhere.
    for (const url of [ARISTOTLE.rpcUrl, ARISTOTLE.explorerUrl, ARISTOTLE.storageIndexerUrl]) {
      expect(url).toMatch(/^https:\/\/\S+$/);
    }
  });

  test('carries the mainnet deployment', () => {
    expect(ARISTOTLE.contracts.executionReceiptsV2).toBe(
      '0xC93BFC19a69248EefbF74F92961D49DE302E6174',
    );
    expect(ARISTOTLE.contracts.agentAdapterRegistryV2).toBe(
      '0xFb4AE891dafD88998dDfa76a0417238a60ea9374',
    );
    expect(ARISTOTLE.contracts.flowEscrowV2).toBe('0xC2cA8fde0575FbFf83Dd98F38B1Ee19e1B6B8DE9');
    expect(ARISTOTLE.contracts.agentReputation).toBe('0x0B919E17e9433B824867B351037d7b7c416aD6Fe');
    expect(ARISTOTLE.contracts.flowRegistry).toBe('0x41660B0216Bb13388f5622e9d2550F543C5F265e');
    expect(ARISTOTLE.deploymentBlockV2).toBe(42941679);
  });

  test('uses our own permissionless identity registry, not the Galileo one', () => {
    // There is no code at the Galileo ERC-8004 address on mainnet. Pointing
    // there would make every publish revert with something unhelpful.
    expect(ARISTOTLE.contracts.identityRegistry).toBe(
      '0x048E54685269dCda692122F5d9562F779810682A',
    );
    expect(ARISTOTLE.contracts.identityRegistry).not.toBe(GALILEO.contracts.identityRegistry);
  });

  test('points at the 0G InferenceServing contract for attestation', () => {
    // Theirs, not ours, and different per chain — the TEE trust anchor is 0G's
    // registry, so getting this wrong would silently fail every bound step.
    expect(ARISTOTLE.contracts.inferenceServing).toBe(
      '0x47340d900bdFec2BD393c626E12ea0656F938d84',
    );
    expect(ARISTOTLE.contracts.inferenceServing).not.toBe(GALILEO.contracts.inferenceServing);
  });

  test('can now be used', () => {
    expect(requireResolved(ARISTOTLE)).toBe(ARISTOTLE);
  });

  test('and Galileo is still a different chain entirely', () => {
    // The bug this catches is a copy-paste that leaves mainnet pointing at
    // testnet contracts, which would look completely normal until judged.
    expect(ARISTOTLE.chainId).not.toBe(GALILEO.chainId);
    expect(ARISTOTLE.rpcUrl).not.toBe(GALILEO.rpcUrl);
    expect(ARISTOTLE.contracts.executionReceiptsV2).not.toBe(
      GALILEO.contracts.executionReceiptsV2,
    );
  });

  test('does not block use of a resolved network', () => {
    expect(requireResolved(GALILEO)).toBe(GALILEO);
  });
});

describe('getNetwork', () => {
  test('resolves by name', () => {
    expect(getNetwork('galileo')).toBe(GALILEO);
    expect(getNetwork('aristotle')).toBe(ARISTOTLE);
  });

  test('rejects an unknown network by name', () => {
    expect(() => getNetwork('mainnet' as never)).toThrow(ConfigError);
  });
});

describe('contract addresses', () => {
  test('carry the Galileo deployment', () => {
    // Deployed via CREATE2 with salt keccak256("0gflow.v1"); each address was
    // confirmed to hold code on chain before being written here.
    expect(GALILEO.contracts.executionReceipts).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(GALILEO.contracts.flowRegistry).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(GALILEO.contracts.agentAdapterRegistry).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(GALILEO.contracts.flowEscrow).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(GALILEO.deploymentBlock).toBe(50316677);
  });

  test('name both ERC-721 agent registries resolved on chain', () => {
    // Resolved by probing name()/symbol()/supportsInterface(), not assumed.
    expect(GALILEO.contracts.identityRegistry).toBe(
      '0x7177a6867296406881E20d6647232314736Dd09A',
    );
    expect(GALILEO.contracts.agenticIdRegistry).toBe(
      '0x2700F6A3e505402C9daB154C5c6ab9cAEC98EF1F',
    );
  });

  test('leave genuinely unresolved addresses null', () => {
    // §10.4: null rather than a plausible-looking placeholder.
    expect(GALILEO.contracts.reputationRegistry).toBeNull();
  });

  test('requireAddress fails loudly rather than returning the zero address', () => {
    // reputationRegistry is still unresolved, so it stands in for the case.
    expect(() => requireAddress(GALILEO, 'reputationRegistry')).toThrow(ConfigError);
    expect(() => requireAddress(GALILEO, 'reputationRegistry')).toThrow(/not deployed|not set/i);
  });

  test('requireAddress returns a configured address', () => {
    const deployed: ContractAddresses = {
      ...GALILEO.contracts,
      executionReceipts: '0x00000000000000000000000000000000000000aa',
    };
    expect(requireAddress({ ...GALILEO, contracts: deployed }, 'executionReceipts')).toBe(
      '0x00000000000000000000000000000000000000aa',
    );
  });
});

// ---------------------------------------------------------------------------
// §2 / §12: network values are referenced nowhere else in the codebase.
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (['node_modules', 'dist', '.git', 'out', 'cache', 'lib', 'vectors'].includes(entry)) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|mjs|sol)$/.test(entry)) acc.push(full);
  }
  return acc;
}

/** Everything outside packages/config, which is the one place these may live. */
function filesOutsideConfig(): string[] {
  const roots = ['packages', 'tools', 'contracts'].map((d) => join(REPO_ROOT, d));
  return roots
    .filter((r) => {
      try {
        return statSync(r).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap((r) => sourceFiles(r))
    .filter((f) => !f.includes(join('packages', 'config')));
}

describe('network values are confined to this package', () => {
  // This is what makes §12 true: mainnet migration updates packages/config and
  // nothing else. Each leak found here is an application-code change that
  // migration would otherwise require.

  test('no other source file hardcodes a 0g.ai endpoint', () => {
    const offenders = filesOutsideConfig().filter((f) =>
      /['"`]https?:\/\/[^'"`]*\.0g\.ai/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders, 'import the endpoint from @0gflow/config instead').toStrictEqual([]);
  });

  test('no other source file hardcodes a 0G chain id', () => {
    const offenders = filesOutsideConfig().filter((f) => /\b16602\b/.test(readFileSync(f, 'utf8')));
    expect(offenders, 'import chainId from @0gflow/config instead').toStrictEqual([]);
  });
});
