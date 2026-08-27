/**
 * 0G Storage round trip — Phase 1 deliverable.
 *
 * Uploads a realistic execution trace, downloads it back with Merkle proof
 * verification, and checks that what came back is byte-identical to what went
 * up and that the root matches what we computed locally.
 *
 * This is the `traceRoot` field of a receipt (§4.1) proven end to end. If the
 * root the SDK returns does not match the root we compute before upload, the
 * verifier can never reproduce it and §9 step 2 is unimplementable.
 *
 *   pnpm --filter @0gflow/storage-roundtrip roundtrip
 *
 * Requires a funded key in ZG_PRIVATE_KEY (upload pays a storage fee).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ethers } from 'ethers';
import { Indexer, ZgFile } from '@0glabs/0g-ts-sdk';
import { GALILEO, requireResolved } from '@0gflow/config';
import { needsSubmitFix, withSubmitFix } from '@0gflow/storage';
import { canonicalize, hashJson, type JsonValue } from '@0gflow/core';

const network = requireResolved(GALILEO);
const RPC_URL = process.env['ZG_RPC_URL'] ?? network.rpcUrl;
const INDEXER_URL = process.env['ZG_INDEXER_URL'] ?? network.storageIndexerUrl;
const WORK_DIR = fileURLToPath(new URL('../../../artifacts/storage', import.meta.url));

const privateKey = process.env['ZG_PRIVATE_KEY'];
if (privateKey === undefined || privateKey.length === 0) {
  console.error('ZG_PRIVATE_KEY is not set. Upload pays a storage fee and needs a funded key.');
  process.exit(1);
}

/**
 * A trace shaped the way the executor will actually write them (§7.6):
 * request, response, timings, retry history, attestation and errors.
 */
function buildTrace(): JsonValue {
  return {
    version: '0gflow/1',
    runId: '0x2222222222222222222222222222222222222222222222222222222222222222',
    stepIndex: 0,
    stepId: 'audit',
    agent: '0x00000000000000000000000000000000000000aa',
    request: {
      endpoint: 'https://agent.example.test/invoke',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { repo: 'https://example.test/repo' },
    },
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: { report: 'the findings', severity: 'low', findings: [] },
    },
    timings: { startedAt: 1755600000, endedAt: 1755600123, durationMs: 123000 },
    retries: [],
    attestation: null,
    error: null,
    // Unicode and awkward numbers so the round trip exercises canonicalization
    // rather than only ASCII.
    notes: { 'é': 'composed', '😀': 1e-27, ratio: 0.1 },
  };
}

async function main() {
  console.log('0G Flow — 0G Storage round trip');
  console.log(`RPC:     ${RPC_URL}`);
  console.log(`Indexer: ${INDEXER_URL}\n`);

  mkdirSync(WORK_DIR, { recursive: true });

  // 1. Canonicalize the trace. These bytes are the artifact; everything
  //    downstream must agree on them exactly.
  const trace = buildTrace();
  const canonical = canonicalize(trace);
  const bytes = Buffer.from(canonical, 'utf8');
  const contentHash = hashJson(trace);

  const uploadPath = `${WORK_DIR}/trace.canonical.json`;
  writeFileSync(uploadPath, bytes);
  console.log(`trace:        ${bytes.length} bytes canonical`);
  console.log(`sha256:       ${contentHash}`);

  // 2. Compute the Merkle root locally, before upload.
  const file = await ZgFile.fromFilePath(uploadPath);
  const [tree, treeErr] = await file.merkleTree();
  if (treeErr !== null || tree === null) {
    throw new Error(`merkle tree failed: ${String(treeErr)}`);
  }
  const localRoot = tree.rootHash();
  console.log(`local root:   ${localRoot}`);

  // 3. Upload.
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const signer = new ethers.Wallet(privateKey!, provider);
  const indexer = new Indexer(INDEXER_URL);

  const submitter = await signer.getAddress();
  console.log(`\nuploading as ${submitter} …`);

  // The SDK builds the submission correctly but encodes it against a struct
  // the deployed contract has moved past; see submit-fix.ts. Build the
  // uploader here so its flow contract can be corrected before use.
  const [uploader, uploaderErr] = await indexer.newUploaderFromIndexerNodes(
    RPC_URL,
    signer,
    1,
  );
  if (uploaderErr !== null || uploader === null) {
    throw new Error(`could not build an uploader: ${String(uploaderErr)}`);
  }

  const flowAddress = await uploader.flow.getAddress();
  if (await needsSubmitFix(provider, flowAddress)) {
    console.log(`note: flow ${flowAddress} expects the current Submission struct; correcting the SDK encoding`);
    uploader.flow = withSubmitFix(uploader.flow, submitter);
  }

  const [result, uploadErr] = await uploader.uploadFile(file, {
    tags: '0x',
    finalityRequired: true,
    taskSize: 10,
    expectedReplica: 1,
    skipTx: false,
    fee: BigInt(0),
  });
  await file.close();

  if (uploadErr !== null) {
    // An already-uploaded file is a success for our purposes: the root is
    // deterministic, so a repeat run legitimately collides.
    const message = String((uploadErr as Error).message ?? uploadErr);
    if (!/already exists|Duplicate/i.test(message)) {
      throw new Error(`upload failed: ${message}`);
    }
    console.log(`note: ${message}`);
  }

  const rootHash = result?.rootHash ?? localRoot;
  console.log(`tx:           ${result?.txHash ?? '(already stored)'}`);
  console.log(`root:         ${rootHash}`);

  if (rootHash.toLowerCase() !== localRoot.toLowerCase()) {
    throw new Error(
      `root mismatch: computed ${localRoot} locally but storage returned ${rootHash}; ` +
        'the verifier could never reproduce traceRoot',
    );
  }
  console.log('✓ storage root matches the locally computed Merkle root');

  // 4. Download with proof verification (§9 step 2).
  const downloadPath = `${WORK_DIR}/trace.downloaded.json`;
  console.log('\ndownloading with proof verification …');
  const downloadErr = await indexer.download(rootHash, downloadPath, true);
  if (downloadErr !== null) throw new Error(`download failed: ${String(downloadErr)}`);
  console.log('✓ downloaded and Merkle inclusion proof verified');

  // 5. Compare bytes.
  const returned = readFileSync(downloadPath);
  if (!returned.equals(bytes)) {
    throw new Error(
      `round trip changed the bytes: uploaded ${bytes.length}, got back ${returned.length}`,
    );
  }
  console.log(`✓ ${returned.length} bytes returned byte-identical`);

  const returnedHash = '0x' + createHash('sha256').update(returned).digest('hex');
  if (returnedHash !== contentHash) throw new Error('content hash changed across the round trip');
  console.log(`✓ sha256 unchanged: ${returnedHash}`);

  writeFileSync(
    `${WORK_DIR}/roundtrip.json`,
    JSON.stringify(
      {
        network: network.name,
        indexer: INDEXER_URL,
        verifiedAt: new Date().toISOString(),
        byteLength: bytes.length,
        traceRoot: rootHash,
        contentSha256: contentHash,
        txHash: result?.txHash ?? null,
      },
      null,
      2,
    ) + '\n',
  );

  console.log(`\ntraceRoot ${rootHash} is reproducible end to end.`);
  await provider.destroy();
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}`);
  process.exitCode = 1;
});
