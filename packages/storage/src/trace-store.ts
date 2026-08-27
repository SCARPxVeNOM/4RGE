/**
 * 0G Storage trace store — spec §7.3, §7.6.
 *
 * The receipt's `traceRoot` is the 0G Storage Merkle root of the trace, so a
 * verifier can fetch the exact bytes back with an inclusion proof and
 * recompute `inputHash` and `outputHash` from them. That retrievability is
 * what separates a verdict of VERIFIED from INCOMPLETE: a locally stored trace
 * proves the executor kept a copy, not that anyone else can obtain one.
 *
 * §7.3 says the receipt is anchored once the storage root is confirmed, never
 * before. `put` therefore does not resolve until the upload has landed —
 * anchoring a root nobody can resolve would produce a permanently
 * unverifiable receipt.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { Indexer, ZgFile } from '@0glabs/0g-ts-sdk';
import { canonicalize, type Hex, type JsonValue } from '@0gflow/core';
import { needsSubmitFix, withSubmitFix } from './submit-fix.js';

export interface ZgStorageOptions {
  readonly rpcUrl: string;
  readonly indexerUrl: string;
  readonly privateKey: string;
  /** Wait for the log entry to finalise before returning. Default true. */
  readonly finalityRequired?: boolean;
}

export class StorageError extends Error {
  override readonly name = 'StorageError';
}

/**
 * A duplicate upload is a success, not a failure.
 *
 * Roots are deterministic: the same trace bytes always produce the same root,
 * so re-running a flow with identical inputs legitimately collides with an
 * earlier upload. The data is already retrievable, which is all `traceRoot`
 * claims.
 */
function isAlreadyStored(message: string): boolean {
  return /already exists|Duplicate|already uploaded|already finalized/i.test(message);
}

export class ZgStorageTraceStore {
  readonly describe: string;
  private readonly provider: ethers.JsonRpcProvider;
  private readonly signer: ethers.Wallet;
  private readonly indexer: Indexer;
  private readonly finalityRequired: boolean;
  /** Resolved once: it costs three RPC reads through the beacon proxy. */
  private submitFix: boolean | null = null;
  /**
   * Uploads run one at a time.
   *
   * Every upload sends a `submit` transaction from the same key, and the
   * executor runs a wave's steps concurrently — so without this, two traces
   * race for one nonce and the second is rejected as "replacement transaction
   * underpriced". It is the same rule §7.2 states for anchoring: one signer,
   * one nonce sequence. Serialising here rather than in the executor keeps the
   * constraint next to the signer it applies to.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: ZgStorageOptions) {
    this.provider = new ethers.JsonRpcProvider(options.rpcUrl);
    this.signer = new ethers.Wallet(
      options.privateKey.startsWith('0x') ? options.privateKey : `0x${options.privateKey}`,
      this.provider,
    );
    this.indexer = new Indexer(options.indexerUrl);
    this.finalityRequired = options.finalityRequired ?? true;
    this.describe = `0G Storage (${options.indexerUrl})`;
  }

  put(trace: JsonValue): Promise<{ traceRoot: Hex }> {
    // Chain onto the queue whether or not the previous upload succeeded, so
    // one failure does not wedge every later trace.
    const next = this.queue.then(
      () => this.upload(trace),
      () => this.upload(trace),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async upload(trace: JsonValue): Promise<{ traceRoot: Hex }> {
    // The canonical bytes are the artifact. Writing anything else here would
    // store a document whose hash the verifier cannot reproduce.
    const bytes = Buffer.from(canonicalize(trace), 'utf8');

    // The SDK reads from a file handle, so the bytes go through a temp file
    // that is removed whatever happens.
    const dir = mkdtempSync(join(tmpdir(), '0gflow-trace-'));
    const path = join(dir, 'trace.json');
    writeFileSync(path, bytes);

    try {
      const file = await ZgFile.fromFilePath(path);
      try {
        const [tree, treeErr] = await file.merkleTree();
        if (treeErr !== null || tree === null) {
          throw new StorageError(`could not build a Merkle tree for the trace: ${String(treeErr)}`);
        }
        const localRoot = tree.rootHash();
        if (localRoot === null) throw new StorageError('the Merkle tree produced no root');

        const submitter = await this.signer.getAddress();
        // The cast is a type-level artifact, not a behavioural one: the SDK's
        // published types point at ethers' CommonJS build while this package
        // resolves the ESM one, and the two Signer types do not unify under
        // exactOptionalPropertyTypes. Same class at runtime.
        const [uploader, uploaderErr] = await this.indexer.newUploaderFromIndexerNodes(
          this.options.rpcUrl,
          this.signer as unknown as Parameters<
            Indexer['newUploaderFromIndexerNodes']
          >[1],
          1,
        );
        if (uploaderErr !== null || uploader === null) {
          throw new StorageError(`could not reach the storage nodes: ${String(uploaderErr)}`);
        }

        if (this.submitFix === null) {
          this.submitFix = await needsSubmitFix(this.provider, await uploader.flow.getAddress());
        }
        if (this.submitFix) uploader.flow = withSubmitFix(uploader.flow, submitter);

        const [, uploadErr] = await uploader.uploadFile(file, {
          tags: '0x',
          finalityRequired: this.finalityRequired,
          taskSize: 10,
          expectedReplica: 1,
          skipTx: false,
          fee: BigInt(0),
        });

        if (uploadErr !== null && !isAlreadyStored(String((uploadErr as Error).message ?? uploadErr))) {
          throw new StorageError(`trace upload failed: ${String(uploadErr)}`);
        }

        // The locally computed root is what gets anchored. Taking the SDK's
        // returned root instead would mean anchoring a value we did not derive
        // from the bytes we stored.
        return { traceRoot: localRoot as Hex };
      } finally {
        await file.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
