/**
 * A real 0G Compute inference, with the per-response signature that binds the
 * answer to the enclave — spec §6.3.
 *
 * This is the piece attestation binding could never be exercised without: a
 * genuine `chatID` and a genuine signature by the TEE signer 0G acknowledges
 * for the provider. Everything else in the binding path had tests; this had
 * none, because the signature can only come from a live enclave.
 *
 *   ZG_PRIVATE_KEY=… pnpm --filter @0gflow/attestation-probe bind
 *
 * Writes artifacts/attestation/binding.json, which the reference agent then
 * serves as a real `attestationBinding`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import { createZGComputeNetworkBroker } from '@0gfoundation/0g-compute-ts-sdk';
import { GALILEO, requireResolved } from '@0gflow/config';
import { recoverMessageAddress, addressesEqual, type Hex } from '@0gflow/core';

const network = requireResolved(GALILEO);
const OUT_DIR = fileURLToPath(new URL('../../../artifacts/attestation', import.meta.url));

const privateKey = process.env['ZG_PRIVATE_KEY'];
if (privateKey === undefined || privateKey.length === 0) {
  console.error('ZG_PRIVATE_KEY is not set. Inference is paid for from a 0G Compute ledger.');
  process.exit(1);
}

/** Deposited into the ledger when it is empty. Small: one prompt costs far less. */
const LEDGER_TOP_UP = 0.05;

const PROMPT = 'Reply with exactly: 0G Flow attestation binding probe.';

async function main() {
  const provider = new ethers.JsonRpcProvider(network.rpcUrl);
  const wallet = new ethers.Wallet(
    privateKey!.startsWith('0x') ? privateKey! : `0x${privateKey!}`,
    provider,
  );

  console.log('0G Flow — attestation binding probe');
  console.log(`network  ${network.displayName} (${network.chainId})`);
  console.log(`account  ${wallet.address}\n`);

  const broker = await createZGComputeNetworkBroker(wallet);

  // 1. The ledger pays for inference.
  let balance = 0n;
  try {
    const ledger = await broker.ledger.getLedger();
    balance = BigInt(ledger.totalBalance ?? 0n);
  } catch {
    balance = 0n;
  }
  console.log(`ledger   ${ethers.formatEther(balance)} ${network.nativeToken}`);

  if (balance === 0n) {
    console.log(`         empty; depositing ${LEDGER_TOP_UP} …`);
    try {
      await broker.ledger.addLedger(LEDGER_TOP_UP);
    } catch (error) {
      // A ledger that already exists cannot be added again; top it up instead.
      if (!/exist/i.test(String((error as Error).message))) throw error;
      await broker.ledger.depositFund(LEDGER_TOP_UP);
    }
    const ledger = await broker.ledger.getLedger();
    console.log(`         now ${ethers.formatEther(BigInt(ledger.totalBalance ?? 0n))}`);
  }

  // 2. Pick a provider that serves a chat model and has an acknowledged signer.
  const services = await broker.inference.listService();
  const candidates = services.filter(
    (s: { verifiability?: string; model?: string }) =>
      (s.verifiability ?? '') !== '' && !/image|video|audio/i.test(s.model ?? ''),
  );
  if (candidates.length === 0) throw new Error('no verifiable chat provider is listed on chain');

  for (const service of candidates) {
    const providerAddress = service.provider as string;
    console.log(`\n→ provider ${providerAddress}`);
    console.log(`  model    ${service.model}`);

    const status = await broker.inference.checkProviderSignerStatus(providerAddress);
    console.log(`  0G acknowledges TEE signer ${status.teeSignerAddress} (${status.isAcknowledged})`);
    if (!status.isAcknowledged) {
      console.log('  skipped: 0G has not acknowledged this provider, so nothing it signs binds');
      continue;
    }

    try {
      const result = await probe(broker, providerAddress, status.teeSignerAddress);
      if (result !== null) {
        mkdirSync(OUT_DIR, { recursive: true });
        writeFileSync(`${OUT_DIR}/binding.json`, JSON.stringify(result, null, 2) + '\n');
        console.log(`\nwrote ${OUT_DIR}/binding.json`);
        await provider.destroy();
        return;
      }
    } catch (error) {
      console.log(`  ✗ ${(error as Error).message.slice(0, 200)}`);
    }
  }

  await provider.destroy();
  throw new Error('no provider produced a usable per-response signature');
}

async function probe(
  broker: Awaited<ReturnType<typeof createZGComputeNetworkBroker>>,
  providerAddress: string,
  teeSigner: string,
): Promise<Record<string, unknown> | null> {
  await broker.inference.acknowledgeProviderSigner(providerAddress).catch(() => undefined);

  const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress);
  console.log(`  endpoint ${endpoint}`);

  // Billing headers are single-use: the provider treats them as a settlement
  // proof, so they cannot be reused across requests.
  const headers = await broker.inference.getRequestHeaders(providerAddress, PROMPT);

  const response = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers as Record<string, string>) },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: PROMPT }] }),
  });

  const body = (await response.json()) as {
    id?: string;
    choices?: { message?: { content?: string } }[];
    error?: unknown;
  };
  if (!response.ok) {
    throw new Error(`inference returned HTTP ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
  }

  const chatID = body.id;
  const content = body.choices?.[0]?.message?.content;
  if (chatID === undefined || content === undefined) {
    throw new Error(`response carried no id/content: ${JSON.stringify(body).slice(0, 200)}`);
  }
  console.log(`  chatID   ${chatID}`);
  console.log(`  content  ${JSON.stringify(content.slice(0, 80))}`);

  // The signature the enclave produced over its own response.
  const signatureUrl = `${endpoint}/proxy/signature/${chatID}?model=${encodeURIComponent(model)}`;
  const signatureResponse = await fetch(signatureUrl);
  if (!signatureResponse.ok) {
    throw new Error(`signature endpoint returned HTTP ${signatureResponse.status}`);
  }
  const signed = (await signatureResponse.json()) as { text?: string; signature?: string };
  if (signed.text === undefined || signed.signature === undefined) {
    throw new Error(`signature endpoint returned ${JSON.stringify(signed).slice(0, 200)}`);
  }

  // Verify it here rather than trusting the endpoint. This is the check the
  // 0G SDK performs; the one it omits — comparing the signed text against the
  // response actually received — is done immediately after.
  const recovered = recoverMessageAddress(signed.text, signed.signature as Hex);
  const signerMatches = addressesEqual(recovered, teeSigner);
  console.log(`  signature recovers to ${recovered}`);
  console.log(`  matches the acknowledged TEE signer: ${signerMatches}`);

  const coversResponse = signed.text === content;
  console.log(`  signed text equals the response content: ${coversResponse}`);
  if (!coversResponse) {
    console.log(`    signed  ${JSON.stringify(signed.text.slice(0, 120))}`);
    console.log(`    content ${JSON.stringify(content.slice(0, 120))}`);
  }

  if (!signerMatches) return null;

  return {
    capturedAt: new Date().toISOString(),
    provider: providerAddress.toLowerCase(),
    teeSignerAddress: teeSigner.toLowerCase(),
    chatID,
    model,
    // The enclave's own text, verbatim. The executor compares this against the
    // step output at outputPath; re-encoding it here would break that.
    text: signed.text,
    signature: signed.signature,
    responseContent: content,
    signedTextEqualsResponse: coversResponse,
  };
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}`);
  process.exitCode = 1;
});
