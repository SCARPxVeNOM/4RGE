# 0G Flow — Technical Specification v1.0

**Verifiable agent workflows on 0G.**
Target network: 0G Galileo Testnet. Mainnet migration path defined in §12.

---

## 1. Overview

0G Flow executes multi-step agent workflows and produces a cryptographic record that any third party can verify from public data without trusting the operator.

A workflow is a JSON document declaring steps. Each step names an agent by its on-chain identity and consumes outputs from prior steps. The runtime resolves each agent, invokes it, stores the full execution trace on 0G Storage, and anchors a receipt on 0G Chain. Receipts are linked: each step's input hash is provably the upstream step's output hash. A completed run folds into a single root sealed on-chain.

### 1.1 The primitive

Existing systems attest individual agent executions. 0G Flow binds executions to each other, making a multi-step run a single cryptographic object. Modifying any intermediate output invalidates the run root.

```
chainRoot[0] = keccak256(abi.encode(receipt[0]))
chainRoot[n] = keccak256(chainRoot[n-1] ‖ keccak256(abi.encode(receipt[n])))
```

Receipts are folded in ascending `stepIndex` order, so the root is deterministic regardless of completion order under parallel execution.

### 1.2 Why 0G specifically

| Requirement | 0G service | Substitutable? |
|---|---|---|
| Prove which model produced an output, inside an enclave | 0G Compute (TEE attestation) | No |
| Store execution traces retrievably with inclusion proofs | 0G Storage (Merkle root) | Partially — IPFS lacks proofs |
| Anchor commitments and agent identity | 0G Chain (EVM) | Yes |

The attestation is what makes a receipt meaningful. Without it the system notarizes an API response.

### 1.3 Design invariant

**No status reports success unless a third party can independently confirm it from public data.**

A step whose attestation is required but absent is recorded `unattested`, never `ok`. A step whose trace failed to upload is recorded with the failure. Runs that fail are sealed and verifiable as failures. This is enforced by test, not convention (§10.3).

---

## 2. Network configuration

| Parameter | Value |
|---|---|
| Chain | 0G Galileo Testnet |
| Chain ID | 16602 |
| RPC | `https://evmrpc-testnet.0g.ai` |
| Explorer | `https://chainscan-galileo.0g.ai` |
| Faucet | `https://faucet.0g.ai/` |
| Native token | A0GI |
| ERC-8004 registries | Pre-deployed on Galileo — resolve addresses before deploying replacements |

**Measured costs on Galileo:** ERC-8004 agent registration 482,000–505,000 gas. A three-agent workflow run with two payments costs approximately 0.007 A0GI per participating wallet, almost entirely registration gas. Fund each executor signer with ≥0.5 A0GI.

All network values live in `packages/config` and are referenced nowhere else in the codebase.

---

## 3. Architecture

```
      Studio (authoring + run viewer)      Explorer (public, read-only)
                    │                              │
                    └──────────┬───────────────────┘
                               │ REST / WebSocket
                  ┌────────────▼─────────────┐   ┌──────────────┐
                  │    Orchestrator API      │   │   Indexer    │
                  │  validate → plan → queue │   │ events → DB  │
                  └────────────┬─────────────┘   └──────▲───────┘
                               │ Postgres queue         │
                  ┌────────────▼─────────────┐          │
                  │   Executor workers × N   │          │
                  │ resolve → invoke → hash  │          │
                  │  → store → anchor        │          │
                  └──┬──────────┬─────────┬──┘          │
                     │          │         │             │
          ┌──────────▼──┐ ┌─────▼────┐ ┌──▼─────────┐   │
          │  ERC-8004   │ │0G Compute│ │ 0G Storage │   │
          │  registries │ │  (TEE)   │ │  (traces)  │   │
          └──────────┬──┘ └─────┬────┘ └──┬─────────┘   │
                     │          │         │             │
             ┌───────▼──────────▼─────────▼─────────────┴──┐
             │              0G Chain (Galileo)              │
             │  FlowRegistry · ExecutionReceipts ·          │
             │  AgentAdapterRegistry · FlowEscrow           │
             └──────────────────────────────────────────────┘
```

**Invariant:** orchestration is off-chain; commitments are on-chain. The chain never determines what executes next. It records what executed and whether it can be proven.

### 3.1 Stack

| Component | Technology |
|---|---|
| Contracts | Solidity 0.8.24, Foundry, CREATE2 deployment |
| Backend | Node 20, TypeScript (strict), Fastify |
| Queue | Postgres 16 (`FOR UPDATE SKIP LOCKED`) |
| Chain client | viem with `nonceManager` |
| Storage | `@0glabs/0g-ts-sdk`, called directly |
| Compute | `@0gfoundation/0g-compute-ts-sdk`, called directly |
| Indexer | viem `watchContractEvent` + backfill, Postgres |
| Frontend | React 19, Vite, wagmi v2, React Flow, Tailwind |
| Python SDK | Python 3.10+, web3.py, pydantic |
| Verifier CLI | Node standard library only, zero dependencies |

The verifier's zero-dependency constraint is deliberate: a verification tool with a large transitive dependency tree is not independently auditable.

---

## 4. Contracts

### 4.1 ExecutionReceipts

The core primitive. Event-based; no per-step storage writes beyond seal records.

```solidity
struct Receipt {
    bytes32 flowId;          // keccak256 of canonical workflow spec
    bytes32 runId;           // unique per execution
    uint32  stepIndex;
    address agentId;         // ERC-8004 identity
    bytes32 inputHash;       // sha256 of canonical JSON input
    bytes32 outputHash;      // sha256 of canonical JSON output
    bytes32 traceRoot;       // 0G Storage Merkle root of execution trace
    bytes32 attestationRef;  // TEE attestation digest; 0x0 when absent
    uint64  startedAt;
    uint64  endedAt;
    uint8   status;          // 0 ok · 1 failed · 2 skipped · 3 unattested
}

event StepAnchored(
    bytes32 indexed flowId,
    bytes32 indexed runId,
    uint32  indexed stepIndex,
    address agentId,
    bytes32 inputHash,
    bytes32 outputHash,
    bytes32 traceRoot,
    bytes32 attestationRef,
    uint64  startedAt,
    uint64  endedAt,
    uint8   status
);

event RunSealed(bytes32 indexed runId, bytes32 chainRoot, uint32 stepCount, uint8 outcome);

function anchorStep(Receipt calldata r) external;
function sealRun(bytes32 runId, bytes32 chainRoot, uint32 stepCount, uint8 outcome) external;
function sealOf(bytes32 runId) external view
    returns (bytes32 chainRoot, uint32 stepCount, uint8 outcome, uint64 sealedAt);
```

**Idempotency.** `anchorStep` reverts on a duplicate `(runId, stepIndex)`. A worker resuming after a crash must not double-anchor.

**Linkage invariant.** For any step consuming output from step *k*, the executor asserts that `inputHash` is derivable from step *k*'s `outputHash` under the declared template. The verifier re-derives this independently. This invariant is what makes a run a chain rather than a list.

### 4.2 FlowRegistry

```solidity
function publishFlow(bytes32 flowId, bytes32 specRoot, string calldata name) external;
function startRun(bytes32 flowId, bytes32 runId, address executor) external;
function flows(bytes32 flowId) external view
    returns (address owner, bytes32 specRoot, string memory name, uint64 publishedAt);
```

`flowId = keccak256(canonicalize(spec))`. The spec body is stored on 0G Storage; only its root goes on-chain.

### 4.3 AgentAdapterRegistry

ERC-8004 establishes agent identity. This registry establishes invocation.

```solidity
struct Adapter {
    address agentId;
    uint8   kind;        // 0 http · 1 contract · 2 0g-compute
    string  endpoint;
    bytes32 schemaRoot;  // 0G Storage root of input/output JSON Schema
    uint32  version;
    bool    active;
}

function registerAdapter(Adapter calldata a) external;  // caller must own the ERC-8004 identity
function getAdapter(address agentId) external view returns (Adapter memory);
function listActive(uint256 offset, uint256 limit) external view returns (Adapter[] memory);
```

Registration is permissionless, gated only on ERC-8004 ownership.

### 4.4 FlowEscrow

```solidity
function fundRun(bytes32 runId, address[] calldata payees, uint256[] calldata amounts)
    external payable;
function releaseStep(bytes32 runId, uint32 stepIndex) external;  // requires anchored receipt, status == 0
function refundUnspent(bytes32 runId) external;                  // after seal with failure outcome
```

Funds release only against an anchored successful receipt. This is where the receipt performs economic work rather than serving as a log.

---

## 5. Workflow specification format

```json
{
  "version": "0gflow/1",
  "name": "audit-summarize-publish",
  "inputs": {
    "repoUrl": { "type": "string" }
  },
  "steps": [
    {
      "id": "audit",
      "agent": "0x…",
      "input": { "repo": "{{ inputs.repoUrl }}" },
      "timeoutMs": 120000,
      "retries": { "max": 2, "backoffMs": 3000 }
    },
    {
      "id": "summarize",
      "agent": "0x…",
      "kind": "0g-compute",
      "model": "gpt-oss-120b",
      "requireAttestation": true,
      "needs": ["audit"],
      "input": { "text": "{{ steps.audit.output.report }}" }
    },
    {
      "id": "score",
      "agent": "0x…",
      "needs": ["audit"],
      "input": { "report": "{{ steps.audit.output.report }}" }
    },
    {
      "id": "publish",
      "agent": "0x…",
      "needs": ["summarize", "score"],
      "input": {
        "body":  "{{ steps.summarize.output.text }}",
        "grade": "{{ steps.score.output.value }}"
      }
    }
  ],
  "outputs": { "url": "{{ steps.publish.output.url }}" },
  "policy": { "minReputation": 0, "failFast": true }
}
```

`needs` defines the dependency graph. `summarize` and `score` execute in parallel; `publish` waits for both.

### 5.1 Template resolution

Templates resolve only against `inputs.*` and `steps.<id>.output.*`, evaluated over a parsed object graph. No expression evaluation, no external template engine, no dynamic code paths. Unresolvable references fail validation before execution begins.

### 5.2 Canonicalization

All hashing uses RFC 8785 JSON Canonicalization Scheme: lexicographically sorted keys, no insignificant whitespace, normalized number representation, UTF-8 NFC.

A single implementation in `packages/core` is shared by the executor, verifier, indexer, and both SDKs. Divergence between any two consumers produces valid runs that fail verification. This module is frozen early and covered by property-based round-trip tests.

---

## 6. Adapter conformance

An agent is 0G Flow-compatible when it implements one of three adapter kinds.

### 6.1 HTTP

```
POST /invoke
  Request:
    { "runId": "0x…", "flowId": "0x…", "stepIndex": 2,
      "input": { … }, "deadline": 1755600000 }
  Response 200:
    { "output": { … }, "attestation": "0x…" | null,
      "meta": { "durationMs": 1234 } }
  Response 4xx/5xx:
    { "error": { "code": "…", "message": "…", "retryable": true } }

GET /schema  → { "input": <JSON Schema>, "output": <JSON Schema> }
GET /health  → { "ok": true, "agentId": "0x…", "version": "1.0.0" }
```

### 6.2 Contract

An ABI method registered via `schemaRoot`. Arguments are mapped from canonical input by name.

### 6.3 0G Compute

Handled natively. The executor calls the compute broker, retrieves the TEE attestation, stores the raw attestation in the trace, and records its digest as `attestationRef`.

### 6.4 Conformance suite

`npx @0gflow/conform <endpoint>` validates schema exposure, health, golden-input invocation, timeout behaviour, and error shape. Passing is the criterion for composability.

---

## 7. Executor semantics

For each step, in order:

1. **Resolve identity.** Query the ERC-8004 IdentityRegistry: is `agentId` registered and active? Then query AgentAdapterRegistry for endpoint, schema root, and version.
2. **Apply policy.** If `policy.minReputation > 0`, read the ReputationRegistry. Below threshold → anchor `status = 2` with the reason and continue per `failFast`.
3. **Build input.** Resolve templates, canonicalize, compute `inputHash`, validate against the adapter's input schema.
4. **Invoke.** Enforce `timeoutMs`. Retry only on `retryable: true`, with exponential backoff and jitter.
5. **Build output.** Validate against the output schema, canonicalize, compute `outputHash`.
6. **Store trace.** Assemble request, response, headers, timings, retry history, raw attestation, and errors. Upload to 0G Storage; record `traceRoot`.
7. **Anchor.** Call `anchorStep`. If `requireAttestation` is set and none was returned, `status = 3` (unattested) — never `0`.
8. **Terminal failure.** Anchor `status = 1` with the error trace, then halt or continue per `failFast`.
9. **Seal.** After the final step, fold the chain root and call `sealRun`.

### 7.1 Concurrency

```sql
UPDATE jobs
SET status = 'claimed', claimed_by = $1, claimed_at = now()
WHERE id = (
  SELECT id FROM jobs
  WHERE status = 'pending' AND deps_met
  ORDER BY created_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

### 7.2 Transaction safety

One signer per worker, each wrapped in viem's `nonceManager`. Signers are never shared across workers. Anchoring transactions are submitted with an explicit gas ceiling and retried on nonce-gap errors only after re-reading pending state.

### 7.3 Storage latency

Trace upload is asynchronous. The receipt is anchored once the storage root is confirmed, never before. Uploads never block step execution.

---

## 8. Indexer and Explorer

### 8.1 Indexer

Subscribes to `StepAnchored`, `RunSealed`, `FlowPublished`, and adapter registration events. Backfills from the deployment block. Handles reorgs by tracking finality depth and re-processing affected ranges.

### 8.2 Explorer

Public, read-only, no wallet connection required.

| Route | Contents |
|---|---|
| `/` | Recent runs across the network |
| `/run/:runId` | Step timeline, per-step verification badges, trace downloads, chain-root status |
| `/agent/:agentId` | Run participation, success rate, attestation rate, ERC-8004 identity and reputation |
| `/flow/:flowId` | Spec, versions, run history |

Each run page displays a copyable verification command and performs client-side verification where feasible.

---

## 9. Verifier CLI

Zero dependencies, single file, distributed as `npx @0gflow/verify <runId>`.

```
$ npx @0gflow/verify 0x7f3a…

  Run    0x7f3a…   flow "audit-summarize-publish"
  Chain  0G Galileo (16602)   ·   executor 0x1b4e…

  [1] audit       0x9a1c…   id ✓   trace ✓   hashes ✓   attestation: not required
  [2] summarize   0x44b2…   id ✓   trace ✓   hashes ✓   attestation: TEE ✓ gpt-oss-120b
  [3] score       0x0e7d…   id ✓   trace ✓   hashes ✓   attestation: not required
  [4] publish     0x33af…   id ✓   trace ✓   hashes ✓   attestation: not required

  Linkage      ✓   4/4 inputs derive from declared upstream outputs
  Chain root   ✓   0xd41f… matches on-chain seal
  Outcome      ✓   success

  VERIFIED — 4 steps · 2 agents not authored by the flow owner
```

**Verification procedure:**

1. Read `StepAnchored` and `RunSealed` logs for `runId`.
2. Fetch each `traceRoot` from 0G Storage; verify the Merkle inclusion proof.
3. Recompute `inputHash` and `outputHash` from the trace contents.
4. Re-derive each step's input from its declared upstream outputs; assert the linkage invariant.
5. Verify each `attestationRef` against the raw attestation in the trace.
6. Fold the chain root; compare against the on-chain seal.
7. Resolve every `agentId` against the ERC-8004 IdentityRegistry.

Exit code is non-zero on any failure. A `--tamper` mode mutates a stored trace and demonstrates detection.

---

## 10. Testing and acceptance

### 10.1 Contract tests (Foundry)

- Receipt anchoring, duplicate rejection, seal correctness
- Chain-root determinism under out-of-order parallel anchoring
- Tamper detection: mutated receipt fields produce a mismatched root
- Escrow release gated on `status == 0`; refund path after failure seal
- Adapter registration rejected for non-owners of the ERC-8004 identity

### 10.2 Core tests

Property-based round-trip tests on canonicalization across generated JSON structures, including nested objects, unicode, floats, and key ordering. Executor and verifier must produce byte-identical output for every generated input.

### 10.3 Invariant test

An automated test asserts that no success status is reachable without a corresponding on-chain artifact. Any code path printing or returning success without an anchored receipt fails the build.

### 10.4 Acceptance criteria

- [ ] Contracts deployed and source-verified on Galileo; addresses in README
- [ ] Multi-step run including a parallel branch, sealed on-chain
- [ ] A run composing at least one externally authored agent
- [ ] A deliberately failed run, sealed and verifiable as a failure
- [ ] `npx @0gflow/verify` succeeds from a clean machine with no configuration
- [ ] `--tamper` demonstrates detection
- [ ] 0G Chain, Storage, Compute, and ERC-8004 all load-bearing
- [ ] `@0gflow/sdk` and `@0gflow/adapter-sdk` published to npm; `0gflow` to PyPI
- [ ] Explorer publicly accessible without a wallet
- [ ] No mock or simulated path reachable in the demonstrated flow

---

## 11. Delivery phases

**Phase 1 — Foundation.** Monorepo, network config, canonicalization module frozen with property tests, contracts drafted and unit-tested, 0G Storage round-trip verified, one real TEE attestation captured and its structure documented.

**Phase 2 — Execution.** Contracts deployed to Galileo. Executor completes a two-step linear run and anchors receipts. ERC-8004 resolution live. Reference agents responding to `/invoke`.

**Phase 3 — Verification.** DAG planner with parallel branches. Verifier CLI passes against a live four-step run. Failure and unattested paths produce correct statuses. *This is the completion gate — everything after is surface area.*

**Phase 4 — Distribution.** Adapter SDK, conformance suite, Python SDK, indexer ingesting full history.

**Phase 5 — Presentation.** Explorer, Studio, documentation, external agent integrations, demonstration recording.

Reduction order under time pressure: Studio authoring canvas (retain the run viewer) → Python SDK → escrow → additional external integrations. The mainnet-equivalent deployment, the verifier, the chain root, and the failure demonstration are not reducible.

---

## 12. Mainnet migration

Contracts deploy via CREATE2 with a fixed salt, producing identical addresses across Galileo and Aristotle. Migration requires only:

1. Confirming Aristotle chain ID, RPC endpoint, and Storage indexer URL.
2. Determining whether ERC-8004 registries are already deployed at their canonical addresses on Aristotle; deploying the reference registries if not.
3. Updating `packages/config`.
4. Re-registering reference agents and re-running the acceptance suite.

No application code changes. Everything network-specific is confined to a single package by design.

---

## 13. Risk register

| Risk | Mitigation |
|---|---|
| Canonicalization divergence between executor and verifier | Single shared module, frozen in Phase 1, property-tested across all consumers |
| TEE attestation format undocumented | Capture a real attestation in Phase 1 before designing against it; store the raw blob and record only its digest on-chain; degrade to "present and unmodified" with explicit labelling if unparseable |
| Nonce collisions dropping anchor transactions | One signer per worker with `nonceManager`; never share keys |
| No externally authored agent exposes a callable endpoint | Publish the conformance suite and adapter SDK; ship four reference agents covering all three adapter kinds; compose those if no external integration lands |
| 0G Storage latency on upload | Asynchronous upload, anchor on confirmation, never block execution |
| Parallel development across a large team | Strict package boundaries, one owner per package, contract interfaces frozen at the end of Phase 1 |
| Scope expansion | Workflow marketplace, cross-chain execution, and token mechanics are explicitly out of scope for v1.0 |
