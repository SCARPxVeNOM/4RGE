/**
 * TEE attestation probe — Phase 1 open item.
 *
 * Captures a real TEE attestation from 0G Compute and documents its byte
 * structure, so that the `attestationRef` field of a receipt (§4.1) is
 * designed against an observed artifact rather than an assumed one.
 *
 * The questions this exists to answer:
 *   1. What exactly comes back — binary quote, JSON envelope, or both?
 *   2. How large is it? (It goes in the trace; only its digest goes on chain.)
 *   3. Is it stable enough to hash directly, or does it need canonicalising?
 *   4. What identity does it bind to, and can we check that binding?
 *
 * Requires no wallet and no funds: the provider list is readable from chain
 * without authentication, and the attestation endpoint is a plain GET.
 *
 *   pnpm --filter @0gflow/attestation-probe probe
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider } from 'ethers';
import { createZGComputeNetworkReadOnlyBroker } from '@0gfoundation/0g-compute-ts-sdk';
import { GALILEO, requireResolved } from '@0gflow/config';
import { claimedSigner, type AcknowledgedSigner } from '@0gflow/core';

const RPC_URL = process.env['ZG_RPC_URL'] ?? requireResolved(GALILEO).rpcUrl;
// Resolved against the repo root, not the CWD: pnpm --filter runs with the
// package as CWD, which would otherwise scatter artifacts per-tool.
const OUT_DIR =
  process.env['ZG_PROBE_OUT'] ??
  fileURLToPath(new URL('../../../artifacts/attestation', import.meta.url));
const TIMEOUT_MS = 30_000;

interface ProviderService {
  provider: string;
  url: string;
  model: string;
}

function sha256(bytes: Uint8Array): string {
  return '0x' + createHash('sha256').update(bytes).digest('hex');
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The TEE signer 0G acknowledges for a provider — the trust anchor (§6.3).
 * Read with the SDK's read-only broker, which needs no wallet.
 */
async function acknowledgedSignerOf(provider: string): Promise<AcknowledgedSigner | null> {
  try {
    const broker = await createZGComputeNetworkReadOnlyBroker(RPC_URL);
    const services = (await broker.inference.listService(0, 50, true)) as {
      provider: string;
      teeSignerAddress?: string;
      teeSignerAcknowledged?: boolean;
    }[];
    const match = services.find((s) => s.provider.toLowerCase() === provider.toLowerCase());
    if (match?.teeSignerAddress === undefined) return null;
    return {
      provider: provider.toLowerCase() as `0x${string}`,
      teeSignerAddress: match.teeSignerAddress.toLowerCase() as `0x${string}`,
      acknowledged: match.teeSignerAcknowledged === true,
    };
  } catch {
    return null;
  }
}

async function listServices(): Promise<ProviderService[]> {
  const provider = new JsonRpcProvider(RPC_URL);
  const broker = await createZGComputeNetworkReadOnlyBroker(RPC_URL);
  const services = await broker.inference.listService(0, 50, true);
  await provider.destroy();

  return services.map((s: { provider: string; url: string; model: string }) => ({
    provider: s.provider,
    url: s.url,
    model: s.model,
  }));
}

/** Walks a JSON value and reports its shape without dumping the payload. */
function describeShape(value: unknown, path = '', depth = 0): string[] {
  if (depth > 3) return [`${path}: …`];
  if (value === null) return [`${path}: null`];
  if (Array.isArray(value)) {
    const head = value.length > 0 ? describeShape(value[0], `${path}[0]`, depth + 1) : [];
    return [`${path}: array(${value.length})`, ...head];
  }
  if (typeof value === 'object') {
    const out: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(...describeShape(child, path ? `${path}.${key}` : key, depth + 1));
    }
    return out;
  }
  if (typeof value === 'string') {
    const looksHex = /^(0x)?[0-9a-fA-F]{64,}$/.test(value);
    return [`${path}: string(${value.length})${looksHex ? ' [hex blob]' : ''}`];
  }
  return [`${path}: ${typeof value}`];
}

/**
 * Providers do not all expose the same path. Observed on Galileo:
 * `/v1/quote` serves the full TDX report, while
 * `/v1/proxy/attestation/report` returned 501 on the same host. Try both
 * rather than concluding a provider has no attestation.
 */
function candidateEndpoints(service: ProviderService): string[] {
  const model = encodeURIComponent(service.model);
  return [
    `${service.url}/v1/quote`,
    `${service.url}/v1/proxy/attestation/report?model=${model}`,
    `${service.url}/v1/proxy/attestation/report`,
  ];
}

async function probe(service: ProviderService) {
  console.log(`\n→ ${service.provider}`);
  console.log(`  model:    ${service.model}`);

  let response: Response | null = null;
  let endpoint = '';
  for (const candidate of candidateEndpoints(service)) {
    try {
      const attempt = await fetchWithTimeout(candidate);
      if (attempt.ok) {
        response = attempt;
        endpoint = candidate;
        break;
      }
      console.log(`  · ${candidate} → HTTP ${attempt.status}`);
    } catch (error) {
      console.log(`  · ${candidate} → ${(error as Error).message}`);
    }
  }

  if (response === null) {
    console.log('  ✗ no attestation endpoint responded');
    return null;
  }
  console.log(`  endpoint: ${endpoint}`);

  const raw = new Uint8Array(await response.arrayBuffer());
  console.log(`  ✓ HTTP 200 · ${raw.length} bytes · content-type: ${response.headers.get('content-type')}`);

  // These are the exact bytes that go into the trace, and the exact preimage
  // of attestationRef. Do NOT re-serialise before hashing: the digest must
  // commit to what the provider actually sent, byte for byte.
  const digest = sha256(raw);
  console.log(`  sha256(raw): ${digest}`);

  const text = new TextDecoder().decode(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.log('  payload is not JSON — treating as an opaque binary quote');
    return { service, raw, digest, parsed: null };
  }

  console.log('  structure:');
  for (const line of describeShape(parsed)) console.log(`    ${line}`);

  const obj = parsed as Record<string, unknown>;
  const signingAddress = obj['signing_address'];
  if (typeof signingAddress === 'string') {
    console.log(`  signing_address: ${signingAddress}`);
  }

  // Verify the quote against the pinned Intel SGX Root CA. Everything else
  // this tool prints is description; this is the only line that is evidence.
  const quoteHex = obj['quote'];
  if (typeof quoteHex === 'string') {
    const quoteBytes = Uint8Array.from(Buffer.from(quoteHex.replace(/^0x/, ''), 'hex'));
    const check = verifyQuote(quoteBytes);

    if (check.verified) {
      console.log(`  quote: VERIFIED to the Intel SGX Root CA (TDX v${check.quoteVersion})`);
      const m = check.measurements!;
      console.log(`    mrtd  ${m.mrtd}`);
      console.log(`    rtmr0 ${m.rtmr[0]}`);
      // The binding that makes the attestation mean anything: report_data
      // carries the ASCII of the enclave's Ethereum signing address, and it
      // is read from inside the *signed* report, never from the envelope's
      // unauthenticated copy.
      const address = new TextDecoder().decode(m.reportData).replace(/\0+$/, '');
      console.log(`    report_data binds ${address}`);
    } else {
      console.log('  quote: NOT VERIFIED');
      for (const failure of check.failures) console.log(`    ✗ ${failure}`);
    }
    for (const caveat of check.caveats) console.log(`    note: ${caveat}`);
  }

  return { service, raw, digest, parsed };
}

async function main() {
  console.log(`0G Flow — TEE attestation probe`);
  console.log(`RPC: ${RPC_URL}\n`);

  const services = await listServices();
  console.log(`Found ${services.length} inference service(s) on chain.`);
  for (const s of services) console.log(`  ${s.provider}  ${s.model}  ${s.url}`);

  if (services.length === 0) {
    console.error('\nNo services listed; cannot capture an attestation.');
    process.exitCode = 1;
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const captured: Array<{ service: ProviderService; digest: string; bytes: number }> = [];

  for (const service of services) {
    try {
      const result = await probe(service);
      if (result === null) continue;

      const stem = `${OUT_DIR}/${service.provider.toLowerCase()}`;
      writeFileSync(`${stem}.raw.json`, result.raw);
      writeFileSync(
        `${stem}.meta.json`,
        JSON.stringify(
          {
            provider: service.provider,
            model: service.model,
            url: service.url,
            capturedAt: new Date().toISOString(),
            byteLength: result.raw.length,
            sha256: result.digest,
            note: 'sha256 is taken over the raw response bytes exactly as received; this is the attestationRef preimage',
          },
          null,
          2,
        ) + '\n',
      );
      captured.push({ service, digest: result.digest, bytes: result.raw.length });
      console.log(`  saved: ${stem}.raw.json`);
    } catch (error) {
      console.log(`  ✗ ${(error as Error).message}`);
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`Captured ${captured.length} attestation(s) into ${OUT_DIR}/`);
  for (const c of captured) {
    console.log(`  ${c.service.provider}  ${c.bytes} bytes  ${c.digest}`);
  }

  if (captured.length === 0) {
    console.error('\nNo attestation captured — attestationRef design remains unverified.');
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
