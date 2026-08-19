# 0G Flow

**Verifiable agent workflows on 0G.** Target network: 0G Galileo Testnet (chain 16602).

Spec: [`0g-flow-spec.md`](0g-flow-spec.md) · Phase 1 status below.

---

## What exists

Phase 1 — Foundation. Everything below is implemented, tested, and green.

| Package | Contents |
|---|---|
| `packages/core` | Canonicalization (§5.2), hashing, receipt encoding, chain root (§1.1), templates (§5.1), **linkage invariant (§4.1)**, outcome reporting (§1.3/§10.3) |
| `packages/config` | Every network-specific value (§2), and nothing else |
| `contracts` | ExecutionReceipts, FlowRegistry, AgentAdapterRegistry, FlowEscrow (§4) |
| `tools/attestation-probe` | Captures real TEE attestations from 0G Compute |
| `docs/attestation-structure.md` | The Phase 1 open item, resolved by observation |

```
pnpm install
pnpm test                 # 181 tests
pnpm typecheck
pnpm test:contracts       # 65 tests
```

**246 tests, all passing.** `packages/core` has **zero runtime dependencies**, so
the verifier CLI (§9) can bundle it into a single auditable file.

## The three things that had to be right first

**§5.2 canonicalization is frozen.** Five components hash through this module.
It is pinned by 27 unit tests, 6 property-based round-trip tests, and 15
cross-language conformance vectors in
`packages/core/vectors/canonicalization.json` that every other implementation —
including the Python SDK — must reproduce byte for byte.

> The trap worth knowing about: RFC 8785 sorts object keys by **UTF-16 code
> unit**, not code point. `U+1F600` sorts *before* `U+FFFF` because its lead
> surrogate `0xD83D` is below `0xFFFF`. Python's `sorted()` gets this backwards
> by default. There is a dedicated vector for it, and a test asserting the
> vector cannot be deleted.

**§4.1 linkage is the whole claim.** `verifyLinkage()` re-derives every step's
input from its declared upstream outputs and checks it against the anchored
`inputHash`. The test that matters is
`detects tampering even when both hashes are recomputed consistently`: an
attacker who rewrites a trace *and* both receipt hashes still fails, because
step 2's input no longer derives from step 1's output.

**§10.3 was written before the code it constrains.** Success is unreachable
without an on-chain artifact — not by convention but by construction.
`packages/core/src/outcome.ts` is the only place a success value can be built,
and the only way to build one is to supply an anchor whose hash matches the
receipt. Three source-tree scans enforce it as the executor, API, indexer and
CLI get written on top.

Solidity and TypeScript are cross-checked against each other:
`test_ReceiptHashMatchesTypeScriptCore` pins
`keccak256(abi.encode(Receipt))` to the same value both sides compute.

## Two places the implementation departs from the spec

Both are flagged rather than silently absorbed.

**1. `ExecutionReceipts` stores one byte per step.** §4.1 asks for
event-based receipts with "no per-step storage writes beyond seal records", but
§4.4's `releaseStep` requires `status == 0` — and contracts cannot read logs.
Since idempotency already forces one storage write per step, the status is
packed into that same slot at no extra gas cost, exposed as `statusOf()`.

**2. `anchorStep` is restricted to the run's declared executor.** The spec
does not mention authorisation. Without it, anyone can anchor step 0 of your
run first and permanently block it, since duplicates revert. `FlowRegistry`
records the executor at `startRun` and `ExecutionReceipts` enforces it.

## The attestation finding

`docs/attestation-structure.md` documents a real captured attestation. The
short version:

- It is an **Intel TDX v4 quote** (5006 bytes, fixed) inside a ~45 KB JSON
  envelope with `tcb_info`, `event_log` and `vm_config`.
- `report_data` is 64 bytes containing the **ASCII of an Ethereum address**,
  zero-padded — the enclave's signing key. Intel's hardware root of trust is
  attesting *"an enclave with these measurements controls this key."*
- Retrieval needs **no wallet and no funds**, but the working path is
  `/v1/quote`; the path referenced in the SDK returned 501 on the same host.
  2 of 6 listed providers responded.

**The gap this exposed:** digesting the blob proves it was not modified. It
does **not** prove the blob relates to this step's output — a genuine
attestation can be attached to an output its enclave never produced. Closing
that requires verifying the per-response signature
(`/v1/proxy/signature/{chatID}`) against the address in `report_data`. This
affects §6.3 and §9's verification procedure, and should be settled before the
executor's attestation path is written.

## Acceptance criteria (§10.4)

- [x] Canonicalization frozen with property tests
- [x] Contracts drafted and unit-tested
- [x] Real TEE attestation captured and its byte structure documented
- [x] No mock or simulated path in what is demonstrated — the attestation is
      real, the chain ID was verified live, and every hash vector is
      cross-checked against `cast`
- [ ] Contracts deployed and source-verified on Galileo *(needs a funded key)*
- [ ] 0G Storage round-trip verified *(Phase 1 remainder)*
- [ ] Multi-step run sealed on chain *(Phase 2)*

## What is needed to continue

A **funded Galileo key** (`https://faucet.0g.ai/`, ≥0.5 A0GI) to deploy
contracts and complete the 0G Storage round-trip. Everything achievable
without one is done.
