/**
 * @0gflow/core — the frozen primitives of 0G Flow.
 *
 * Every component that hashes anything must import it from here: the
 * executor, the verifier, the indexer, and both SDKs. Five implementations of
 * canonicalization is five chances for two of them to disagree, and a
 * disagreement shows up as a run that executed successfully and then failed
 * verification, with a symptom nowhere near the cause.
 *
 * This package has zero runtime dependencies so that the verifier CLI (§9) can
 * bundle it into a single auditable file.
 */

export {
  canonicalize,
  canonicalBytes,
  CanonicalizationError,
  type JsonValue,
} from './canonicalize.js';

export { keccak256, sha256, hashJson, bytesToHex, hexToBytes, type Hex } from './hash.js';

export {
  encodeReceipt,
  hashReceipt,
  StepStatus,
  ZERO_BYTES32,
  type Receipt,
} from './receipt.js';

export { foldChainRoot, chainRootProgression, ChainRootError } from './chain-root.js';

export {
  resolveTemplates,
  referencedSteps,
  TemplateError,
  type TemplateContext,
  type StepContext,
} from './template.js';

export {
  verifyLinkage,
  type LinkedStep,
  type StepEvidence,
  type StepLinkage,
  type LinkageReport,
  type LinkageQuery,
} from './linkage.js';

export {
  parseTrace,
  TraceError,
  type ExecutionTrace,
  type TraceRetry,
} from './trace.js';

export {
  recoverAddress,
  recoverMessageAddress,
  recoverPublicKey,
  publicKeyToAddress,
  hashPersonalMessage,
  parseSignature,
  toChecksumAddress,
  addressesEqual,
  Secp256k1Error,
  type Signature,
} from './secp256k1.js';

export {
  verifyAttestation,
  attestationRefFor,
  legacyAttestationRef,
  claimedSigner,
  signerFromReportData,
  addressFromReportDataBytes,
  resolveOutputPath,
  signedTextCommitsTo,
  meetsBinding,
  describeBinding,
  AttestationError,
  type BindingLevel,
  type AttestationBundle,
  type AttestationVerification,
  type ResponseSignature,
  type AcknowledgedSigner,
  type VerifyAttestationInput,
} from './attestation.js';

export {
  decideStepStatus,
  statusSucceeded,
  reportStepOutcome,
  reportRunOutcome,
  isSuccess,
  isRunSuccess,
  OutcomeError,
  type AnchoredArtifact,
  type SealArtifact,
  type StepOutcome,
  type RunOutcome,
  type RunReport,
  type StatusDecision,
} from './outcome.js';

export {
  agentOutputDigest,
  agentOutputMessageHash,
  recoverAgentSigner,
  verifyAgentSignature,
  AGENT_OUTPUT_DOMAIN,
  AgentSignatureError,
  type AgentOutputClaim,
} from './agent-signature.js';
export {
  validateAgainstSchema,
  describeSchemaProblems,
  type SchemaCheck,
  type SchemaProblem,
} from './schema.js';
export {
  computeAgentRecord,
  evaluateReputation,
  successRate,
  EMPTY_RECORD,
  type AgentRecord,
  type ReputationRequirement,
  type ReputationVerdict,
} from './reputation.js';
