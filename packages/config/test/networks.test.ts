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
  test('is present but explicitly unresolved', () => {
    // §12: the migration path is defined, but the chain id, RPC and indexer
    // must be confirmed rather than assumed. Shipping a guessed mainnet
    // endpoint is how funds go to the wrong chain.
    expect(ARISTOTLE.resolved).toBe(false);
  });

  test('refuses to be used until its values are confirmed', () => {
    expect(() => requireResolved(ARISTOTLE)).toThrow(ConfigError);
    expect(() => requireResolved(ARISTOTLE)).toThrow(/confirm/i);
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
  test('are unset until deployment', () => {
    // §10.4 requires deployed, source-verified addresses in the README. Until
    // then these are null rather than a plausible-looking placeholder.
    expect(GALILEO.contracts.executionReceipts).toBeNull();
    expect(GALILEO.contracts.flowRegistry).toBeNull();
  });

  test('requireAddress fails loudly rather than returning the zero address', () => {
    expect(() => requireAddress(GALILEO, 'executionReceipts')).toThrow(ConfigError);
    expect(() => requireAddress(GALILEO, 'executionReceipts')).toThrow(/not deployed|not set/i);
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
