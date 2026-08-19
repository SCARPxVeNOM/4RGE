/**
 * Chain root folding — spec §1.1.
 *
 *   chainRoot[0] = keccak256(abi.encode(receipt[0]))
 *   chainRoot[n] = keccak256(chainRoot[n-1] ‖ keccak256(abi.encode(receipt[n])))
 *
 * The fold is over ascending stepIndex, never over completion order, so a run
 * with parallel branches produces the same root no matter which branch lands
 * first. The fold is deliberately not commutative: reordering the *contents*
 * of two steps must change the root even though reordering their arrival
 * must not.
 */

import { keccak256, type Hex } from './hash.js';
import { hashReceipt, type Receipt } from './receipt.js';

export class ChainRootError extends Error {
  override readonly name = 'ChainRootError';
}

/**
 * Receipts must form a complete, contiguous set 0..n-1. A missing index would
 * otherwise let an executor drop a step it would rather not disclose and still
 * present a well-formed root.
 */
function assertContiguous(receipts: readonly Receipt[]): void {
  if (receipts.length === 0) {
    throw new ChainRootError('cannot fold a chain root over zero receipts');
  }
  const seen = new Set<number>();
  for (const r of receipts) {
    if (seen.has(r.stepIndex)) {
      throw new ChainRootError(`duplicate receipt for stepIndex ${r.stepIndex}`);
    }
    seen.add(r.stepIndex);
  }
  for (let i = 0; i < receipts.length; i++) {
    if (!seen.has(i)) {
      throw new ChainRootError(
        `missing receipt for stepIndex ${i}: run has ${receipts.length} receipts but indices are not contiguous from 0`,
      );
    }
  }
}

/** Folds a complete receipt set into the run's chain root. */
export function foldChainRoot(receipts: readonly Receipt[]): Hex {
  assertContiguous(receipts);
  const ordered = [...receipts].sort((a, b) => a.stepIndex - b.stepIndex);

  let root = hashReceipt(ordered[0]!);
  for (let i = 1; i < ordered.length; i++) {
    root = keccak256(`${root}${hashReceipt(ordered[i]!).slice(2)}`);
  }
  return root;
}

/**
 * The intermediate root after each step, for progressive verification and for
 * showing per-step state in the explorer. The last element equals
 * foldChainRoot(receipts).
 */
export function chainRootProgression(receipts: readonly Receipt[]): Hex[] {
  assertContiguous(receipts);
  const ordered = [...receipts].sort((a, b) => a.stepIndex - b.stepIndex);

  const roots: Hex[] = [hashReceipt(ordered[0]!)];
  for (let i = 1; i < ordered.length; i++) {
    roots.push(keccak256(`${roots[i - 1]!}${hashReceipt(ordered[i]!).slice(2)}`));
  }
  return roots;
}
