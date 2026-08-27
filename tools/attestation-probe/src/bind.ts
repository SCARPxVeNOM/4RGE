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

/**
 * Deposited into the ledger when it is empty. One prompt costs far less.
 *
 * The SDK refuses anything under 3 A0GI, with a comment claiming that mirrors
 * `MIN_ACCOUNT_BALANCE` in the LedgerManager contract. It does not: that
 * constant reads 0.1 A0GI on Galileo (`MIN_ACCOUNT_BALANCE()` →
 * 100000000000000000). The SDK's floor is a stale client-side guard, so the
 * ledger is created by calling the contract directly rather than by depositing
 * thirty times what the chain asks for.
 */
const LEDGER_TOP_UP_A0GI = 0.5;

/**
 * What the ledger must hold before inference will run.
 *
 * Two separate floors, both observed rather than documented. Acknowledging a
 * provider opens a per-provider sub-account and the contract rejects it below
 * 1 A0GI (`InsufficientAvailableBalance(5e17, 1e18)`). The provider then
 * refuses the request unless the *locked* balance exceeds a 1 A0GI reserve
 * plus unsettled fees, so an exactly-1 ledger still fails with
 * "required minimum is 1.000065". Two gives room for both.
 */
const WORKING_BALANCE = 2_000_000_000_000_000_000n;

/** Below this a top-up is float noise, not a real shortfall. */
const DUST = 1_000_000_000_000_000n;

/** Galileo LedgerManager. */
const LEDGER_CONTRACT = '0xE70830508dAc0A97e6c087c75f402f9Be669E406';
const LEDGER_ABI = ['function addLedger(string additionalInfo) payable'];

const PROMPT =
  process.env['ZG_PROMPT'] ?? 'Reply with exactly: 0G Flow attestation binding probe.';

/** Lets a second capture be written alongside the first, for comparison. */
const OUT_NAME = process.env['ZG_BINDING_NAME'] ?? 'binding';

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
    const minimum = await new ethers.Contract(
      LEDGER_CONTRACT,
      ['function MIN_ACCOUNT_BALANCE() view returns (uint256)'],
      provider,
    ).MIN_ACCOUNT_BALANCE();
    const deposit = ethers.parseEther(String(LEDGER_TOP_UP_A0GI));
    if (deposit < minimum) {
      throw new Error(
        `the contract requires at least ${ethers.formatEther(minimum)} to open a ledger`,
      );
    }

    console.log(`         empty; opening with ${LEDGER_TOP_UP_A0GI} (contract minimum ${ethers.formatEther(minimum)}) …`);
    const ledgerContract = new ethers.Contract(LEDGER_CONTRACT, LEDGER_ABI, wallet);
    const tx = await ledgerContract.addLedger!('', { value: deposit });
    await tx.wait();
    console.log(`         tx ${tx.hash}`);

    const ledger = await broker.ledger.getLedger();
    balance = BigInt(ledger.totalBalance ?? 0n);
    console.log(`         now ${ethers.formatEther(balance)}`);
  }

  // Acknowledging a provider opens a sub-account funded from the ledger, and
  // that needs 1 A0GI of its own. Topping up is unguarded once the ledger
  // exists, so the SDK's own method is fine here.
  if (WORKING_BALANCE - balance > DUST) {
    const shortfall = Number(ethers.formatEther(WORKING_BALANCE - balance));
    console.log(`         topping up ${shortfall} for the provider sub-account …`);
    await broker.ledger.depositFund(shortfall);
    const ledger = await broker.ledger.getLedger();
    balance = BigInt(ledger.totalBalance ?? 0n);
    console.log(`         now ${ethers.formatEther(balance)}`);
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
        writeFileSync(`${OUT_DIR}/${OUT_NAME}.json`, JSON.stringify(result, null, 2) + '\n');
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

  // The provider checks the *locked* balance in its own sub-account, not the
  // ledger total. Acknowledging locks exactly 1 A0GI, and the provider then
  // demands strictly more than that ("required minimum is 1.000065"), so a
  // freshly acknowledged account is always a hair short. Push the remaining
  // ledger balance across rather than depositing more: the funds are already
  // there, just on the wrong side of the sub-account boundary.
  const ledger = (await broker.ledger.getLedger()) as unknown as {
    totalBalance?: bigint;
    availableBalance?: bigint;
  };
  const available = BigInt(ledger.availableBalance ?? 0n);
  console.log(
    `  ledger total ${ethers.formatEther(BigInt(ledger.totalBalance ?? 0n))}, available ${ethers.formatEther(available)}`,
  );
  if (available > 0n) {
    // Leave a little behind so the transfer itself cannot be short.
    const move = (available * 9n) / 10n;
    if (move > 0n) {
      console.log(`  transferring ${ethers.formatEther(move)} into the provider sub-account …`);
      await broker.ledger
        .transferFund(providerAddress, 'inference', move)
        .catch((error: unknown) => {
          console.log(`  (transfer skipped: ${(error as Error).message.slice(0, 90)})`);
        });
    }
  }

  const { endpoint, model } = await broker.inference.getServiceMetadata(providerAddress);
  console.log(`  endpoint ${endpoint}`);

  // Billing headers are single-use: the provider treats them as a settlement
  // proof, so they cannot be reused across requests.
  const headers = await broker.inference.getRequestHeaders(providerAddress, PROMPT);

  const requestBody = JSON.stringify({ model, messages: [{ role: 'user', content: PROMPT }] });
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers as Record<string, string>) },
    body: requestBody,
  });

  // Kept verbatim: whether the signed digests can be recomputed by a verifier
  // depends on the exact bytes, so a re-serialised copy would prove nothing.
  const responseText = await response.text();
  const body = JSON.parse(responseText) as {
    id?: string;
    choices?: { message?: { content?: string } }[];
    error?: unknown;
  };
  if (!response.ok) {
    throw new Error(`inference returned HTTP ${response.status}: ${JSON.stringify(body).slice(0, 200)}`);
  }

  // The signature is keyed by the ZG-Res-Key response header, not by the
  // completion id. They differ, and using the completion id gets
  // "chat_id_not_found" from the signature endpoint — the SDK notes this in a
  // comment and its own example server never exercises it.
  const chatID = response.headers.get('ZG-Res-Key') ?? body.id;
  const content = body.choices?.[0]?.message?.content;
  console.log(`  ZG-Res-Key ${response.headers.get('ZG-Res-Key') ?? '(absent)'}`);
  console.log(`  completion.id ${body.id ?? '(absent)'}`);
  if (chatID === undefined || content === undefined) {
    throw new Error(`response carried no id/content: ${JSON.stringify(body).slice(0, 200)}`);
  }
  console.log(`  chatID   ${chatID}`);
  console.log(`  content  ${JSON.stringify(content.slice(0, 80))}`);

  // The signature the enclave produced over its own response.
  //
  // `getServiceMetadata` already returns the endpoint with `/v1/proxy` on it,
  // so the path here is just `/signature/{chatID}`. The SDK's own helper takes
  // the bare service URL and appends `/v1/proxy/signature/...`; appending its
  // path to this endpoint doubles the segment and the provider answers 400.
  const signatureUrl = `${endpoint}/signature/${chatID}?model=${encodeURIComponent(model)}`;
  // The enclave signs after it has finished streaming, so a request issued the
  // instant the completion returns can arrive before the signature exists.
  let signatureResponse: Response | null = null;
  let lastBody = '';
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await fetch(signatureUrl);
    if (r.ok) {
      signatureResponse = r;
      break;
    }
    lastBody = (await r.text()).slice(0, 300);
    console.log(`  signature attempt ${attempt}/5 -> HTTP ${r.status} ${lastBody}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (signatureResponse === null) {
    throw new Error(`signature endpoint never succeeded; last body: ${lastBody}`);
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
    rawRequestBody: requestBody,
    rawResponseBody: responseText,
  };
}

main().catch((error: unknown) => {
  console.error(`\n✗ ${(error as Error).message}`);
  process.exitCode = 1;
});
