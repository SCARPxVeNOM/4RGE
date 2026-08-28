/**
 * Executor semantics — spec §7.
 *
 * For each step, in order:
 *   1. Build input: resolve templates, canonicalize, compute inputHash.
 *   2. Invoke, enforcing timeoutMs and retrying only on retryable errors.
 *   3. Build output: canonicalize, compute outputHash.
 *   4. Store the trace; record traceRoot.
 *   5. Anchor. If an attestation was required and absent, status is
 *      unattested (3) — never ok.
 *   6. On terminal failure, anchor status failed (1) and halt or continue
 *      per failFast.
 *   7. After the final step, fold the chain root and seal.
 *
 * Two invariants shape the whole file:
 *
 * - Status is never assigned by hand. Every status comes from
 *   decideStepStatus, which is the only place the attestation and identity
 *   rules live (§1.3, §10.3). A structural test fails the build if that is
 *   bypassed.
 * - Every step gets a receipt, including skipped ones. The chain root folds
 *   over a contiguous 0..n-1 range, so omitting a step would leave a gap and
 *   the run would not verify at all.
 */

import {
  attestationRefFor,
  decideStepStatus,
  foldChainRoot,
  hashJson,
  resolveTemplates,
  statusSucceeded,
  StepStatus,
  verifyAgentSignature,
  verifyAttestation,
  ZERO_BYTES32,
  type AcknowledgedSigner,
  type AttestationBundle,
  type AttestationVerification,
  type ExecutionTrace,
  type Hex,
  type JsonValue,
  type Receipt,
  type ResponseSignature,
} from '@0gflow/core';
import { AdapterError, invokeHttpAdapter, type AttemptRecord } from './adapter.js';
import { planFlow, PlanError, type FlowSpec, type PlannedStep } from './plan.js';
import type { AdapterResolver } from './adapters.js';

export interface AnchorReceipt {
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly logIndex: number;
}

export interface ChainWriter {
  readonly executorAddress: Hex;
  /**
   * The chain and contract this writer anchors to.
   *
   * Needed because an agent's signature commits to both — otherwise one
   * signature would be valid against every deployment on every chain. The
   * writer already knows them; asking the caller to repeat them would be a
   * second source of truth for a value that must match exactly.
   */
  readonly chainId: number;
  readonly receiptsAddress: Hex;
  isFlowPublished(flowId: Hex): Promise<boolean>;
  publishFlow(flowId: Hex, specRoot: Hex, name: string): Promise<void>;
  startRun(flowId: Hex, runId: Hex, executor: Hex): Promise<void>;
  anchorStep(receipt: Receipt): Promise<AnchorReceipt>;
  sealRun(
    runId: Hex,
    chainRoot: Hex,
    stepCount: number,
    outcome: number,
  ): Promise<{ txHash: Hex; blockNumber: bigint }>;
}

/**
 * Reads 0G's InferenceServing registry.
 *
 * The trust anchor for attestation: without the acknowledged TEE signer there
 * is nothing to check a response signature against, so a step can reach no
 * more than `present`. Optional, because a flow of ordinary HTTP agents needs
 * no registry at all.
 */
export interface SignerRegistry {
  acknowledgedSigner(provider: Hex): Promise<AcknowledgedSigner | null>;
}

/**
 * Reads the signing key an agent published for itself in the adapter
 * registry.
 *
 * The trust anchor for identity, as `SignerRegistry` is for attestation, and
 * read live for the same reason: an agent that rotates a compromised key
 * should stop being credited for work signed with the old one.
 *
 * Optional. A flow that does not ask any step for a signed output never needs
 * it, and a run of trusted in-house agents may reasonably not.
 */
export interface AgentRegistry {
  /** Null when the agent published no key, which cannot verify to true. */
  agentSigner(agentId: bigint): Promise<Hex | null>;
}

export interface TraceStore {
  readonly describe: string;
  put(trace: JsonValue): Promise<{ traceRoot: Hex }>;
}

export interface StepResult {
  readonly stepId: string;
  readonly stepIndex: number;
  readonly status: StepStatus;
  readonly traceRoot: Hex;
  readonly inputHash: Hex;
  readonly outputHash: Hex;
  readonly attestationRef: Hex;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly anchor: AnchorReceipt;
  readonly error: string | null;
  readonly attempts: AttemptRecord[];
  /**
   * The agent's signature over this step's output, when it produced one.
   *
   * Surfaced because `FlowEscrowV2.releaseStep` needs it: the signature is
   * the authorisation to pay, and without it here the caller would have to
   * fetch the trace back out of storage to collect its own payment evidence.
   */
  readonly outputSignature: Hex | null;
}

export interface RunResult {
  readonly runId: Hex;
  readonly flowId: Hex;
  readonly chainRoot: Hex;
  readonly steps: StepResult[];
  readonly receipts: Receipt[];
  readonly sealed: boolean;
  /** True only when every step succeeded. Not the same as "it ran". */
  readonly succeeded: boolean;
  readonly outcome: number;
}

export interface ExecuteOptions {
  readonly spec: FlowSpec;
  readonly inputs: JsonValue;
  readonly runId: Hex;
  readonly chain: ChainWriter;
  readonly traces: TraceStore;
  /**
   * Where to call each agent, supplied by the caller.
   *
   * Optional now that `adapters` can answer the same question from chain.
   * Kept because tests and offline development need a flow to run without a
   * registry, and because an operator running their own agents should not
   * have to publish them to call them. When both are given the callback wins:
   * an explicit local override is the more specific instruction.
   */
  readonly endpointFor?: (step: PlannedStep) => string;
  /**
   * The adapter registry — spec §7 step 1. This is what lets a flow name an
   * agent it does not operate, which is the whole point of a marketplace.
   */
  readonly adapters?: AdapterResolver;
  /** 0G's InferenceServing registry. Omitted means attestations cap at `present`. */
  readonly signers?: SignerRegistry;
  /**
   * The adapter registry, for checking agent output signatures. Omitted means
   * no step can prove its agent's identity, so any step asking for
   * `requireSignedOutput` records Unattested.
   */
  readonly agents?: AgentRegistry;
  /** Halt remaining waves after a step fails. Defaults to true (§5 policy). */
  readonly failFast?: boolean;
  readonly defaultTimeoutMs?: number;
  readonly now?: () => number;
}

interface StepOutcomeInternal {
  readonly step: PlannedStep;
  readonly receipt: Receipt;
  readonly result: StepResult;
  readonly output: JsonValue | null;
}

const nowSeconds = (ms: number): bigint => BigInt(Math.floor(ms / 1000));
const ZERO_ADDRESS = `0x${'00'.repeat(20)}` as Hex;

export async function executeRun(options: ExecuteOptions): Promise<RunResult> {
  const {
    spec,
    inputs,
    runId,
    chain,
    traces,
    endpointFor,
    adapters,
    signers,
    agents,
    failFast = true,
    defaultTimeoutMs = 30_000,
    now = Date.now,
  } = options;

  // §5.1: validation happens before anything is published, invoked or
  // anchored. A rejected plan costs nothing; a bad receipt is permanent.
  const plan = planFlow(spec);

  if (endpointFor === undefined && adapters === undefined) {
    // Refused up front, before anything is published or anchored (§5.1). A
    // run that discovers this at the first step would already have written a
    // flow and a run to chain for a plan that was never executable.
    throw new PlanError(
      'no way to reach any agent: supply endpointFor, or adapters to resolve them from the registry',
    );
  }

  if (!(await chain.isFlowPublished(plan.flowId))) {
    await chain.publishFlow(plan.flowId, hashJson(spec as unknown as JsonValue), plan.name);
  }
  await chain.startRun(plan.flowId, runId, chain.executorAddress);

  const outputs = new Map<string, JsonValue>();
  const statusById = new Map<string, StepStatus>();
  const completed: StepOutcomeInternal[] = [];
  let halted = false;

  for (const wave of plan.waves) {
    const settled = await Promise.all(
      wave.map((step) =>
        runStep({
          step,
          halted,
          inputs,
          outputs,
          statusById,
          runId,
          flowId: plan.flowId,
          traces,
          ...(endpointFor === undefined ? {} : { endpointFor }),
          ...(adapters === undefined ? {} : { adapters }),
          defaultTimeoutMs,
          now,
          chainId: chain.chainId,
          receiptsAddress: chain.receiptsAddress,
          ...(signers === undefined ? {} : { signers }),
          ...(agents === undefined ? {} : { agents }),
        }),
      ),
    );

    // Anchor sequentially: one signer per worker means one nonce sequence
    // (§7.2), and anchoring concurrently on a single signer invites gaps.
    for (const outcome of settled) {
      const anchor = await chain.anchorStep(outcome.receipt);
      completed.push({ ...outcome, result: { ...outcome.result, anchor } });

      statusById.set(outcome.step.id, outcome.receipt.status);
      if (outcome.output !== null) outputs.set(outcome.step.id, outcome.output);
    }

    if (failFast && settled.some((o) => !statusSucceeded(o.receipt.status))) halted = true;
  }

  const receipts = completed
    .map((c) => c.receipt)
    .sort((a, b) => a.stepIndex - b.stepIndex);
  const chainRoot = foldChainRoot(receipts);

  const succeeded = receipts.every((r) => statusSucceeded(r.status));
  // The run's outcome is the first non-ok status, so a failure and a missing
  // attestation are distinguishable on chain rather than both being "not ok".
  const outcome = succeeded
    ? StepStatus.Ok
    : (receipts.find((r) => !statusSucceeded(r.status))?.status ?? StepStatus.Failed);

  await chain.sealRun(runId, chainRoot, receipts.length, outcome);

  return {
    runId,
    flowId: plan.flowId,
    chainRoot,
    steps: completed.map((c) => c.result).sort((a, b) => a.stepIndex - b.stepIndex),
    receipts,
    sealed: true,
    succeeded,
    outcome,
  };
}

interface RunStepArgs {
  step: PlannedStep;
  halted: boolean;
  inputs: JsonValue;
  outputs: Map<string, JsonValue>;
  statusById: Map<string, StepStatus>;
  runId: Hex;
  flowId: Hex;
  traces: TraceStore;
  endpointFor?: (step: PlannedStep) => string;
  adapters?: AdapterResolver;
  defaultTimeoutMs: number;
  now: () => number;
  chainId: number;
  receiptsAddress: Hex;
  signers?: SignerRegistry;
  agents?: AgentRegistry;
}

async function runStep(args: RunStepArgs): Promise<StepOutcomeInternal> {
  const { step, halted, inputs, outputs, statusById, runId, flowId, traces, endpointFor, adapters, defaultTimeoutMs, now, signers, agents, chainId, receiptsAddress } = args;
  const startedAtMs = now();

  // A step whose upstream did not succeed has no data to run on. Skipping is
  // the honest record; running it on absent data would produce a receipt that
  // asserts something false.
  const blockedBy = step.dependsOn.filter((id) => {
    const status = statusById.get(id);
    return status !== undefined && !statusSucceeded(status);
  });
  const skipReason =
    blockedBy.length > 0
      ? `upstream step${blockedBy.length > 1 ? 's' : ''} ${blockedBy.map((b) => `"${b}"`).join(', ')} did not succeed`
      : halted
        ? 'an earlier step failed and the flow declares failFast'
        : undefined;

  if (skipReason !== undefined) {
    return buildSkipped(step, runId, flowId, traces, skipReason, startedAtMs, now);
  }

  // 1a. Resolve where this agent lives — §7 step 1.
  //
  // Before the input, because a step naming an agent nobody has listed cannot
  // run at all, and finding that out after building the input would just be
  // work thrown away.
  let endpoint: string;
  try {
    endpoint = await resolveEndpoint(step, endpointFor, adapters);
  } catch (error) {
    return buildFailed(step, runId, flowId, traces, null, (error as Error).message, [], startedAtMs, now);
  }

  // 1. Build the input.
  let resolvedInput: JsonValue;
  try {
    resolvedInput = resolveTemplates(step.input, {
      inputs,
      steps: Object.fromEntries([...outputs].map(([id, output]) => [id, { output }])),
    });
  } catch (error) {
    return buildFailed(step, runId, flowId, traces, null, (error as Error).message, [], startedAtMs, now);
  }
  const inputHash = hashJson(resolvedInput);

  // 2. Invoke.
  const timeoutMs = step.timeoutMs ?? defaultTimeoutMs;
  let output: JsonValue;
  let attestation: string | null;
  let attestationBinding: ResponseSignature | null;
  let attestationProvider: Hex | null;
  let outputSignature: Hex | null;
  let attempts: AttemptRecord[];
  try {
    const invocation = await invokeHttpAdapter(
      endpoint,
      {
        runId,
        flowId,
        stepIndex: step.stepIndex,
        input: resolvedInput,
        deadline: Math.floor((now() + timeoutMs) / 1000),
        // Always sent, not only when a signature is required: an agent that
        // signs unconditionally is the well-behaved case, and withholding
        // these would make it unable to.
        chainId,
        receipts: receiptsAddress,
      },
      {
        timeoutMs,
        ...(step.retries === undefined ? {} : { retries: step.retries }),
      },
    );
    output = invocation.output;
    attestation = invocation.attestation;
    attestationBinding = invocation.attestationBinding;
    attestationProvider = invocation.attestationProvider;
    outputSignature = invocation.outputSignature;
    attempts = invocation.attempts;
  } catch (error) {
    const adapterError = error instanceof AdapterError ? error : null;
    return buildFailed(
      step,
      runId,
      flowId,
      traces,
      resolvedInput,
      (error as Error).message,
      adapterError?.attempts ?? [],
      startedAtMs,
      now,
    );
  }

  const outputHash = hashJson(output);

  // 5. Attestation. The digest covers the quote *and* the per-response
  //    signature, because a digest of the quote alone proves the document was
  //    not modified and says nothing about whether it describes this output.
  //    The bundle fields go in verbatim; see attestationRefFor for why the
  //    preimage is length-prefixed rather than canonical JSON.
  const bundle: AttestationBundle | null =
    attestation === null
      ? null
      : {
          quote: attestation,
          // Zero when the agent named no provider: the digest still commits to
          // a value, and a verifier will find no acknowledged signer for it.
          provider: attestationProvider ?? ZERO_ADDRESS,
          response: attestationBinding,
        };

  const attestationRef = bundle === null ? ZERO_BYTES32 : attestationRefFor(bundle);

  // The trust anchor: what 0G's registry says about this provider's TEE
  // signer. Read live, so a de-acknowledged signer stops attesting.
  let acknowledgedSigner: AcknowledgedSigner | null = null;
  if (bundle !== null && signers !== undefined && attestationProvider !== null) {
    try {
      acknowledgedSigner = await signers.acknowledgedSigner(attestationProvider);
    } catch {
      // An unreachable registry is not an attestation failure; it just means
      // nothing can be established, which the level already expresses.
      acknowledgedSigner = null;
    }
  }

  // What the attestation actually establishes, decided here so the trace and
  // the status agree and a verifier re-derives the same answer from chain.
  const binding = verifyAttestation({ bundle, output, acknowledgedSigner });

  // Who produced it. Checked against the key the agent published for itself,
  // read live so a rotated key stops vouching for the old one. A verifier
  // repeats this from chain, which is why the signature goes into the trace.
  let outputSignatureValid = false;
  let agentSigner: Hex | null = null;
  if (outputSignature !== null && agents !== undefined) {
    try {
      agentSigner = await agents.agentSigner(BigInt(step.agent));
    } catch {
      // An unreachable registry establishes nothing, which is what
      // `outputSignatureValid: false` already says. It is not a failure of the
      // step unless the step demanded the proof.
      agentSigner = null;
    }
    outputSignatureValid = verifyAgentSignature(
      {
        chainId,
        receipts: receiptsAddress,
        runId,
        stepIndex: step.stepIndex,
        agentId: BigInt(step.agent),
        inputHash,
        outputHash,
      },
      outputSignature,
      agentSigner,
    );
  }

  const endedAtMs = now();
  const trace = buildTrace(step, runId, resolvedInput, output, bundle, binding, attempts, null, startedAtMs, endedAtMs, {
    signature: outputSignature,
    registeredSigner: agentSigner,
    valid: outputSignatureValid,
  });
  const { traceRoot } = await traces.put(trace as unknown as JsonValue);

  const status = decideStepStatus({
    requireAttestation: step.requireAttestation === true,
    attestationPresent: attestation !== null,
    bindingLevel: binding.level,
    ...(step.requireBinding === undefined ? {} : { requireBinding: step.requireBinding }),
    requireSignedOutput: step.requireSignedOutput === true,
    outputSignatureValid,
  });

  const receipt: Receipt = {
    flowId,
    runId,
    stepIndex: step.stepIndex,
    agentId: BigInt(step.agent),
    inputHash,
    outputHash,
    traceRoot,
    attestationRef,
    startedAt: nowSeconds(startedAtMs),
    endedAt: nowSeconds(endedAtMs),
    status,
  };

  return {
    step,
    receipt,
    output: statusSucceeded(status) ? output : null,
    result: {
      stepId: step.id,
      stepIndex: step.stepIndex,
      status,
      traceRoot,
      inputHash,
      outputHash,
      attestationRef,
      startedAt: startedAtMs,
      endedAt: endedAtMs,
      anchor: { txHash: ZERO_BYTES32, blockNumber: 0n, logIndex: 0 },
      error: null,
      attempts,
      outputSignature,
    },
  };
}

function buildTrace(
  step: PlannedStep,
  runId: Hex,
  input: JsonValue,
  output: JsonValue,
  bundle: AttestationBundle | null,
  binding: AttestationVerification | null,
  attempts: readonly AttemptRecord[],
  error: string | null,
  startedAtMs: number,
  endedAtMs: number,
  identity: OutputIdentity | null = null,
): ExecutionTrace {
  return {
    version: '0gflow/1',
    runId,
    stepIndex: step.stepIndex,
    stepId: step.id,
    agent: step.agent,
    input,
    output,
    timings: { startedAt: startedAtMs, endedAt: endedAtMs, durationMs: endedAtMs - startedAtMs },
    retries: attempts.map((a) => ({ attempt: a.attempt, error: a.error ?? '', delayMs: a.durationMs })),
    // Kept for readers of older traces. attestationBundle is the field a
    // verifier re-derives attestationRef from.
    attestation: bundle?.quote ?? null,
    attestationBundle: bundle,
    // Recorded as the executor's finding, not as evidence. A verifier
    // recomputes the level itself and does not read this to decide anything —
    // trusting it would let the executor grade its own homework.
    attestationBinding:
      binding === null
        ? null
        : {
            level: binding.level,
            acknowledgedSigner: binding.acknowledgedSigner,
            recoveredAddress: binding.recoveredAddress,
            signerResolved: binding.signerResolved,
            notes: binding.notes,
          },
    // The signature itself is evidence — a verifier recovers the address from
    // it and compares against the registry. `valid` beside it is the
    // executor's finding, recorded for the same reason and with the same
    // standing as the attestation level: readable, not authoritative.
    outputIdentity: identity,
    error,
  };
}

/** What the trace records about who produced a step's output. */
export interface OutputIdentity {
  readonly signature: Hex | null;
  readonly registeredSigner: Hex | null;
  readonly valid: boolean;
}

/**
 * Where to POST this step's invocation.
 *
 * The caller's callback wins over the registry: an explicit local override is
 * the more specific instruction, and it is what makes tests and offline
 * development possible without publishing anything.
 *
 * Every failure here is thrown and turned into a Failed receipt by the
 * caller, never into a silent skip. A flow that names an unlisted agent
 * should say so in its receipts.
 */
async function resolveEndpoint(
  step: PlannedStep,
  endpointFor: ((step: PlannedStep) => string) | undefined,
  adapters: AdapterResolver | undefined,
): Promise<string> {
  if (endpointFor !== undefined) return endpointFor(step);
  if (adapters === undefined) {
    throw new Error(`no endpoint for agent ${step.agent} and no adapter registry configured`);
  }

  const adapter = await adapters.resolve(BigInt(step.agent));
  if (adapter === null) {
    throw new Error(
      `agent ${step.agent} is not listed in the adapter registry, so there is nowhere to call it`,
    );
  }
  if (!adapter.active) {
    // Its operator took it out of the directory. Calling it anyway would
    // ignore the one signal they have for saying "do not hire me right now".
    throw new Error(`agent ${step.agent} is listed but not active, so it declines to be hired`);
  }
  if (adapter.endpoint.length === 0) {
    throw new Error(`agent ${step.agent} is listed with an empty endpoint`);
  }
  return adapter.endpoint;
}

async function buildFailed(
  step: PlannedStep,
  runId: Hex,
  flowId: Hex,
  traces: TraceStore,
  input: JsonValue | null,
  error: string,
  attempts: readonly AttemptRecord[],
  startedAtMs: number,
  now: () => number,
): Promise<StepOutcomeInternal> {
  const endedAtMs = now();
  // The failure gets a trace too: §1.3 requires a failed step to be recorded
  // with its error, not merely absent.
  const trace = buildTrace(step, runId, input ?? {}, {}, null, null, attempts, error, startedAtMs, endedAtMs);
  const { traceRoot } = await traces.put(trace as unknown as JsonValue);

  const status = decideStepStatus({ requireAttestation: false, attestationPresent: false, error });

  return {
    step,
    output: null,
    receipt: {
      flowId,
      runId,
      stepIndex: step.stepIndex,
      agentId: BigInt(step.agent),
      inputHash: input === null ? ZERO_BYTES32 : hashJson(input),
      outputHash: ZERO_BYTES32,
      traceRoot,
      attestationRef: ZERO_BYTES32,
      startedAt: nowSeconds(startedAtMs),
      endedAt: nowSeconds(endedAtMs),
      status,
    },
    result: {
      stepId: step.id,
      stepIndex: step.stepIndex,
      status,
      traceRoot,
      inputHash: input === null ? ZERO_BYTES32 : hashJson(input),
      outputHash: ZERO_BYTES32,
      attestationRef: ZERO_BYTES32,
      startedAt: startedAtMs,
      endedAt: endedAtMs,
      anchor: { txHash: ZERO_BYTES32, blockNumber: 0n, logIndex: 0 },
      error,
      attempts: [...attempts],
      // A step that failed produced no output to sign, so there is nothing
      // payable here. null says that, rather than leaving it ambiguous.
      outputSignature: null,
    },
  };
}

async function buildSkipped(
  step: PlannedStep,
  runId: Hex,
  flowId: Hex,
  traces: TraceStore,
  reason: string,
  startedAtMs: number,
  now: () => number,
): Promise<StepOutcomeInternal> {
  const endedAtMs = now();
  const trace = buildTrace(step, runId, {}, {}, null, null, [], reason, startedAtMs, endedAtMs);
  const { traceRoot } = await traces.put(trace as unknown as JsonValue);

  const status = decideStepStatus({
    requireAttestation: false,
    attestationPresent: false,
    skipped: reason,
  });

  const receipt: Receipt = {
    flowId,
    runId,
    stepIndex: step.stepIndex,
    agentId: BigInt(step.agent),
    // Nothing was consumed and nothing produced, so there is nothing to
    // commit to. Zero here is a claim of absence, not a hash of empty data.
    inputHash: ZERO_BYTES32,
    outputHash: ZERO_BYTES32,
    traceRoot,
    attestationRef: ZERO_BYTES32,
    startedAt: nowSeconds(startedAtMs),
    endedAt: nowSeconds(endedAtMs),
    status,
  };

  return {
    step,
    receipt,
    output: null,
    result: {
      stepId: step.id,
      stepIndex: step.stepIndex,
      status,
      traceRoot,
      inputHash: ZERO_BYTES32,
      outputHash: ZERO_BYTES32,
      attestationRef: ZERO_BYTES32,
      startedAt: startedAtMs,
      endedAt: endedAtMs,
      anchor: { txHash: ZERO_BYTES32, blockNumber: 0n, logIndex: 0 },
      error: reason,
      attempts: [],
      outputSignature: null,
    },
  };
}
