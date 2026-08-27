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
 *   decideStepStatus, which is the only place the attestation rule lives
 *   (§1.3, §10.3). A structural test fails the build if that is bypassed.
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
import { planFlow, type FlowSpec, type PlannedStep } from './plan.js';

export interface AnchorReceipt {
  readonly txHash: Hex;
  readonly blockNumber: bigint;
  readonly logIndex: number;
}

export interface ChainWriter {
  readonly executorAddress: Hex;
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
  readonly endpointFor: (step: PlannedStep) => string;
  /** 0G's InferenceServing registry. Omitted means attestations cap at `present`. */
  readonly signers?: SignerRegistry;
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
    signers,
    failFast = true,
    defaultTimeoutMs = 30_000,
    now = Date.now,
  } = options;

  // §5.1: validation happens before anything is published, invoked or
  // anchored. A rejected plan costs nothing; a bad receipt is permanent.
  const plan = planFlow(spec);

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
          endpointFor,
          defaultTimeoutMs,
          now,
          ...(signers === undefined ? {} : { signers }),
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
  endpointFor: (step: PlannedStep) => string;
  defaultTimeoutMs: number;
  now: () => number;
  signers?: SignerRegistry;
}

async function runStep(args: RunStepArgs): Promise<StepOutcomeInternal> {
  const { step, halted, inputs, outputs, statusById, runId, flowId, traces, endpointFor, defaultTimeoutMs, now, signers } = args;
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
  let attempts: AttemptRecord[];
  try {
    const invocation = await invokeHttpAdapter(
      endpointFor(step),
      {
        runId,
        flowId,
        stepIndex: step.stepIndex,
        input: resolvedInput,
        deadline: Math.floor((now() + timeoutMs) / 1000),
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

  const endedAtMs = now();
  const trace = buildTrace(step, runId, resolvedInput, output, bundle, binding, attempts, null, startedAtMs, endedAtMs);
  const { traceRoot } = await traces.put(trace as unknown as JsonValue);

  const status = decideStepStatus({
    requireAttestation: step.requireAttestation === true,
    attestationPresent: attestation !== null,
    bindingLevel: binding.level,
    ...(step.requireBinding === undefined ? {} : { requireBinding: step.requireBinding }),
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
    error,
  };
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
    },
  };
}
