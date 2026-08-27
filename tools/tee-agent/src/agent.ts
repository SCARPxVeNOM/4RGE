/**
 * An agent that fronts 0G Compute and returns a real attestation binding —
 * spec §6.3.
 *
 * The reference agents in `tools/reference-agents` are deterministic and
 * self-signed on purpose: they make the *executor* observable. This one is the
 * opposite. It calls a live enclave, pays for it, and returns the enclave's own
 * signature, so the `requireBinding: 'bound'` path runs against a real provider
 * rather than a fixture.
 *
 * It is built on `@0gflow/adapter-sdk`, which is also the point: if the SDK
 * made the §6.1 contract awkward to satisfy, it would show up here first.
 *
 * NOT DETERMINISTIC, and that is fine. A language model answers differently to
 * the same prompt, so `@0gflow/conform`'s determinism check will fail against
 * this agent — correctly. Determinism matters for re-deriving a *downstream*
 * step's input, and §9 re-derives that from the recorded trace rather than by
 * re-running the agent, so a verified run stays verified. A flow that needs a
 * reproducible output should not put an LLM in the middle of it.
 */

import { ethers } from 'ethers';
import { createZGComputeNetworkBroker } from '@0gfoundation/0g-compute-ts-sdk';
import {
  AgentError,
  require_,
  type AgentDefinition,
  type AgentResponse,
  type InvokeRequest,
} from '@0gflow/adapter-sdk';

type Broker = Awaited<ReturnType<typeof createZGComputeNetworkBroker>>;

export interface TeeAgentOptions {
  readonly rpcUrl: string;
  readonly privateKey: string;
  /** Pinned provider. Omitted means the first acknowledged chat provider. */
  readonly provider?: string;
}

/** Where the answer sits in an OpenAI-shaped completion. */
const RESPONSE_PATH = '$.choices[0].message.content';

export class TeeAgent {
  private broker: Broker | null = null;
  private providerAddress: string | null = null;
  private quote: string | null = null;

  constructor(private readonly options: TeeAgentOptions) {}

  /** ERC-721 token id of this agent's identity. */
  readonly agentId = '1';

  async ready(): Promise<{ provider: string; teeSigner: string; model: string }> {
    const wallet = new ethers.Wallet(
      this.options.privateKey.startsWith('0x')
        ? this.options.privateKey
        : `0x${this.options.privateKey}`,
      new ethers.JsonRpcProvider(this.options.rpcUrl),
    );
    this.broker = await createZGComputeNetworkBroker(wallet);

    const services = (await this.broker.inference.listService()) as {
      provider: string;
      model: string;
      verifiability?: string;
      url: string;
    }[];

    const usable = services.filter(
      (s) =>
        (this.options.provider === undefined ||
          s.provider.toLowerCase() === this.options.provider.toLowerCase()) &&
        (s.verifiability ?? '') !== '' &&
        !/image|video|audio/i.test(s.model),
    );

    for (const service of usable) {
      const status = await this.broker.inference.checkProviderSignerStatus(service.provider);
      // An unacknowledged signer vouches for nothing, so a step requiring a
      // binding could never succeed against it.
      if (!status.isAcknowledged) continue;

      await this.broker.inference.acknowledgeProviderSigner(service.provider).catch(() => undefined);
      this.providerAddress = service.provider;

      // The attestation document, fetched once: it is the same per enclave, not
      // per response, and re-fetching it per step would be a wasted round trip.
      this.quote = await fetch(`${service.url}/v1/quote`)
        .then((r) => (r.ok ? r.text() : null))
        .catch(() => null);

      return {
        provider: service.provider,
        teeSigner: status.teeSignerAddress,
        model: service.model,
      };
    }

    throw new Error('no acknowledged chat provider is available on this network');
  }

  /** The 0G provider whose acknowledged signer must have signed. */
  get provider(): string {
    if (this.providerAddress === null) throw new Error('call ready() first');
    return this.providerAddress;
  }

  definition(): AgentDefinition {
    return {
      agentId: this.agentId,
      version: '1.0.0',
      schema: {
        input: {
          type: 'object',
          required: ['text'],
          properties: { text: { type: 'string' } },
        },
        output: {
          type: 'object',
          required: ['text'],
          properties: { text: { type: 'string' } },
        },
      },
      invoke: (request) => this.invoke(request),
    };
  }

  private async invoke(request: InvokeRequest): Promise<AgentResponse> {
    if (this.broker === null || this.providerAddress === null) {
      throw new AgentError('agent is not initialised', 'unavailable', true, 503);
    }
    const text = require_.string(request.input, 'text');
    const prompt = `Summarise in one short sentence: ${text}`;

    const { endpoint, model } = await this.broker.inference.getServiceMetadata(
      this.providerAddress,
    );
    // Billing headers are single-use: the provider treats them as a settlement
    // proof, so a retry needs fresh ones.
    const headers = await this.broker.inference.getRequestHeaders(this.providerAddress, prompt);

    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(headers as Record<string, string>) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }] }),
    });

    // Verbatim. The enclave's signature commits to a digest of these exact
    // bytes, so parsing and re-serialising would break the binding.
    const responseBody = await response.text();
    if (!response.ok) {
      throw new AgentError(
        `0G Compute returned HTTP ${response.status}: ${responseBody.slice(0, 160)}`,
        'upstream',
        // A billing or capacity refusal may clear; the executor decides whether
        // it has deadline left to find out.
        response.status >= 500 || response.status === 429,
        502,
      );
    }

    const parsed = JSON.parse(responseBody) as {
      choices?: { message?: { content?: string } }[];
    };
    const answer = parsed.choices?.[0]?.message?.content;
    if (typeof answer !== 'string') {
      throw new AgentError('0G Compute returned no completion', 'upstream', false, 502);
    }

    // Keyed by the ZG-Res-Key header, not the completion id: they differ by a
    // `chatcmpl-` prefix and the id gets `chat_id_not_found`.
    const chatID = response.headers.get('ZG-Res-Key');
    if (chatID === null) {
      throw new AgentError(
        'the provider returned no ZG-Res-Key, so this response cannot be bound',
        'unverifiable',
        false,
        502,
      );
    }

    const signature = await this.fetchSignature(endpoint, chatID, model);

    return {
      output: { text: answer },
      attestation: this.quote,
      // Without this the executor has no registry entry to check the
      // signature against, and the step caps at `present`.
      attestationProvider: this.providerAddress,
      attestationBinding: {
        chatID,
        model,
        text: signature.text,
        signature: signature.signature,
        responseBody,
        responsePath: RESPONSE_PATH,
        // The completion is wrapped in { text }, so that is where it sits.
        outputPath: '$.text',
      },
    };
  }

  /**
   * The enclave signs after it has finished, so a request issued the instant
   * the completion returns can arrive before the signature exists.
   */
  private async fetchSignature(
    endpoint: string,
    chatID: string,
    model: string,
  ): Promise<{ text: string; signature: string }> {
    // `endpoint` already ends in /v1/proxy; appending the SDK helper's own path
    // would double the segment and return 400.
    const url = `${endpoint}/signature/${chatID}?model=${encodeURIComponent(model)}`;

    let last = '';
    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await fetch(url);
      if (response.ok) {
        const body = (await response.json()) as { text?: string; signature?: string };
        if (typeof body.text === 'string' && typeof body.signature === 'string') {
          return { text: body.text, signature: body.signature };
        }
        last = JSON.stringify(body).slice(0, 160);
        break;
      }
      last = (await response.text()).slice(0, 160);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }

    // Returning the answer without a binding would be the quiet promotion §1.3
    // forbids: the step would look attested while proving nothing.
    throw new AgentError(
      `could not obtain the response signature: ${last}`,
      'unverifiable',
      false,
      502,
    );
  }
}
