# A real run on 0G Galileo, verified

**Status:** §11 Phase 3 gate — executed.
**Date:** 2026-08-27, 0G Galileo Testnet (chain 16602).
**Verdict:** all three runs **VERIFIED**, exit 0, traces retrieved from 0G
Storage with Merkle inclusion proofs.
**Executor:** `0x3274E860FA4d3372bD120b61367a7555713417A8`
**Receipts contract:** `0x741A36fAba40ee71223539a5A062FDEDC8574e30`
**Cost:** 0.0185 A0GI for three runs — nine anchored steps, three seals and
nine trace uploads to 0G Storage.

Four runs. One success proves less than a success plus the two ways a run is
allowed to *not* succeed: §10.4 asks for a deliberately failed run that is
still sealed and verifiable, and §1.3 asks that a missing attestation is
recorded as `unattested` rather than quietly as `ok`. The fourth exercises
`requireBinding: 'bound'` against a live enclave.

`bound` is not in `all`, because it spends on paid inference. Ask for it by
name:

```
ZG_PRIVATE_KEY=… pnpm --filter @0gflow/run-flow flow -- bound
```

Reproduce:

```
pnpm --filter @0gflow/run-flow flow -- all       # execute
node packages/verify/dist/verify.mjs <runId> \
  --spec artifacts/runs/<runId>.json --trace-dir artifacts/traces
```

---

## What was anchored

Read back with raw `eth_getLogs`, independently of any code in this repo:

| Scenario | runId | Steps | Sealed at block | Outcome | Verdict |
|---|---|---|---|---|---|
| success | `0x1daea014…1608f387` | 4 | 51683572 | `0` ok | VERIFIED |
| unattested | `0x6053574e…a35d7ace4` | 2 | 51683752 | `3` unattested | VERIFIED |
| failure | `0xfd8f562f…ba292ce4` | 3 | 51683998 | `1` failed | VERIFIED |
| **bound** | `0x17f361c5…0a133fe7` | 2 | 51712841 | `0` ok | VERIFIED |

Chain roots, as sealed:

```
success      0xe30f402071f2fa6e2fb77ec6c684ee7c1d8d13fffbf1d9a4b691bcd769a8bd85
unattested   0x6fb4daee0b024bd87faffa0d57f63efbc4b5f9c9ab9ad44f94f8da4ec588a14e
failure      0xe445471a6a0aa14255a0f47a3963bf3af66200820a503ad62defd3b8bd82a2f0
```

Each equals the root `@0gflow/core` folds from the receipts as the *contract*
emitted them. If canonicalization, receipt encoding or the fold had drifted
between TypeScript and Solidity, that comparison fails.

An earlier set of runs, before 0G Storage worked, is kept in git history: same
checks, verdict INCOMPLETE, because traces were local-only.

## What verification found

All three: identity ✓, trace ✓, hashes ✓, linkage ✓, chain root ✓ against the
on-chain seal, and every trace fetched from 0G Storage with an inclusion proof.
No `--trace-dir` fallback is used.

The failure run behaves as §10.4 requires — `review` anchored status 1 and
`publish` status 2 (skipped, because its upstream did not succeed) — and is
still sealed and still verifiable *as a failure*. The unattested run anchored
status 3 with `attestation: ✗ required but absent`.

### The verifier is not rubber-stamping

The traces now live only on 0G Storage, so there is no local copy to edit —
which is the point. To demonstrate detection: download them, change one
character of one output (`1 issues` to `0 issues` in the audit step), and
re-verify with storage pointed at a dead host so the tampered copies are the
ones actually read:

```
node packages/verify/dist/verify.mjs <runId> --spec …   --indexer http://127.0.0.1:1 --trace-dir <tampered>
```

```
✗ step 0: the stored output hashes to 0x40056629… but the receipt anchors
          outputHash 0xd41e95a6…
✗ step "summarize": cannot re-derive input because upstream output "audit"
          was not confirmed
✗ step "score":     cannot re-derive input because upstream output "audit"
          was not confirmed

Linkage      ✗   1/4 inputs derive from declared upstream outputs
Chain root   ✓   0xdc908a… matches on-chain seal

FAILED — 4 checks did not pass          (exit 1)
```

Note the chain root still matches: only the trace was altered, not the
anchored receipt. The two checks are independent, and the linkage collapse
from 4/4 to 1/4 is §4.1 doing its job — one tampered output invalidates every
downstream input derived from it.

---

## The `bound` run, end to end against a real enclave

`tools/tee-agent` fronts 0G Compute and is built on `@0gflow/adapter-sdk` — if
the SDK made §6.1 awkward to satisfy, it would show up there first. The step
declares `requireAttestation: true` and `requireBinding: 'bound'`, so an
attestation that merely exists is not enough.

The executor resolves the provider's acknowledged TEE signer from 0G's
InferenceServing registry (`ViemSignerRegistry`), and the verifier resolves it
again independently over the same RPC it already uses for receipts:

```
[1] summarize  id ✓  trace ✓  hashes ✓
    attestation: ✓ bound to output by 0G-acknowledged TEE signer
    — output signed by the TEE signer 0G acknowledges
      (0x83df4b8eba7c0b3b740019b8c9a77fff77d508cf)

VERIFIED — 2 steps · 1 agent          (exit 0)
```

### The guard bites

Replacing the answer in the trace with one the enclave never gave — leaving the
attestation bundle untouched — fires **two independent defences**:

```
[1] summarize  hashes ✗  attestation: ✗ TEE-signed, but not over this output

✗ step 1: the stored output hashes to 0x226ad5f7… but the receipt anchors
          outputHash 0x84cfbdb4…
✗ step 1: the attestation is signed by the attested enclave key but does not
          cover this step output, so it belongs to a different response

FAILED — 3 checks did not pass
```

The hash check and the binding check are independent: even a substitution that
somehow satisfied the first would still not be covered by the enclave's
signature. That is the whole point of binding, shown on a real run rather than
a fixture.

### One honest caveat

This agent is **not deterministic** — a language model answers differently to
the same prompt, so `@0gflow/conform`'s determinism check fails against it, and
correctly so. Determinism matters for re-deriving a *downstream* step's input,
and §9 re-derives that from the recorded trace rather than by re-running the
agent, so a verified run stays verified. A flow that needs a reproducible
output should not put an LLM in the middle of it.

---

## 0G Storage: why it failed, and the fix

`submit()` used to revert with a bare `require(false)`. Diagnosed rather than
assumed:

- **Not a network outage.** The flow contract
  (`0x22E03a6A89B950F1c82ec5e74F8eCa321a105296`) is unpaused, its market is
  cross-wired, and `numSubmissions` was already past 148000. Other people's
  submissions were landing in the same blocks.
- **Not the fee.** `estimateGas` reverted identically at `value` 0, at the
  SDK-computed fee, and at ten times it.

**It was an ABI mismatch.** Upstream refactored the submission type
(`0g-storage-contracts`, `contracts/interfaces/Submission.sol`):

```solidity
// what @0glabs/0g-ts-sdk@0.3.3 still encodes
struct Submission     { uint length; bytes tags; SubmissionNode[] nodes; }

// what the chain now expects
struct SubmissionData { uint length; bytes tags; SubmissionNode[] nodes; }
struct Submission     { SubmissionData data; address submitter; }
```

so the selector moved:

```
0xef3e12dc  submit((uint256,bytes,(bytes32,uint256)[]))            <- SDK
0xbc8c11f8  submit(((uint256,bytes,(bytes32,uint256)[]),address))  <- chain
```

The flow address is a **beacon proxy** whose own 295 bytes of runtime contain
no selectors at all, so checking its bytecode finds nothing and answers
confidently wrong. Following the beacon
(`0x7fb56db4…` → implementation `0xf99cccc4…`) shows the legacy selector is
**absent** and the current one **present**: calls to the old entrypoint fall
through and revert with no reason string, which is exactly why it looked like
a network fault.

`packages/storage/src/submit-fix.ts` corrects it. The SDK builds the
submission correctly — Merkle tree, node list, tags — and only the final
encoding is wrong, so the shim intercepts the single call that is wrong and
re-encodes it, leaving segment upload, proof generation and log processing
untouched. It resolves the proxy to decide whether the fix is needed, so it
disables itself once the SDK is republished.

One further bug surfaced only under load: the executor runs a wave's steps
concurrently, so trace uploads raced for one nonce and the second was rejected
as `replacement transaction underpriced`. `ZgStorageTraceStore` serialises
uploads — the same one-signer-one-nonce rule §7.2 states for anchoring.
