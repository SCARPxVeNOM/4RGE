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
| `tools/live-run` | Executes a real multi-step run against the deployed contracts |
| `tools/storage-roundtrip` | 0G Storage upload/download with Merkle proof (blocked, see below) |
| `docs/attestation-structure.md` | The Phase 1 open item, resolved by observation |

```
pnpm install
pnpm test                 # 185 tests
pnpm typecheck
pnpm test:contracts       # 66 tests
```

**251 tests, all passing.** `packages/core` has **zero runtime dependencies**, so
the verifier CLI (§9) can bundle it into a single auditable file.

## Deployed on 0G Galileo (chain 16602)

Deployed via CREATE2 with salt `keccak256("0gflow.v1")` at block 50316677, so
the same addresses are reproducible on Aristotle (§12). Each was confirmed to
hold code and to be correctly wired before being recorded in `packages/config`.

| Contract | Address |
|---|---|
| FlowRegistry | [`0xe09aC2F04Fc663dB9ddb2824d44d5B1AFe7fD53f`](https://chainscan-galileo.0g.ai/address/0xe09aC2F04Fc663dB9ddb2824d44d5B1AFe7fD53f) |
| ExecutionReceipts | [`0x741A36fAba40ee71223539a5A062FDEDC8574e30`](https://chainscan-galileo.0g.ai/address/0x741A36fAba40ee71223539a5A062FDEDC8574e30) |
| AgentAdapterRegistry | [`0x239E66ca972bdA91542BA78c12B3003EFED8389e`](https://chainscan-galileo.0g.ai/address/0x239E66ca972bdA91542BA78c12B3003EFED8389e) |
| FlowEscrow | [`0xC40aC67bF4d63D8CdFeCBb80cE1C357c90291C39`](https://chainscan-galileo.0g.ai/address/0xC40aC67bF4d63D8CdFeCBb80cE1C357c90291C39) |

Pre-existing registries resolved by on-chain probe (§2), not assumed:

| Registry | Address |
|---|---|
| ERC-8004 Trustless Agent | `0x7177a6867296406881E20d6647232314736Dd09A` |
| 0G Agentic ID (ERC-7857) | `0x2700F6A3e505402C9daB154C5c6ab9cAEC98EF1F` |

### A real run, anchored and sealed

`pnpm --filter @0gflow/live-run live` executed a two-step linked run on chain:

```
runId       0x530f48096fd42536e4b9726c3d3a0a3126ff10270c7c77127071bd4fc831be52
chain root  0x0fa7e8ef4f15125b5f72648fd59051df1b4f9f50c28dbd1b51c846524fce07c1

  publishFlow    block 50317338
  startRun       block 50317353
  anchorStep(1)  block 50317376   <- anchored out of order, deliberately
  anchorStep(0)  block 50317392
  sealRun        block 50317415

  chain root computed off chain == chain root read from the seal
  receipts recovered from StepAnchored logs re-fold to the sealed root
  linkage verified 2/2 from the chain-recovered receipts
  run outcome: success
```

Steps were anchored **out of order** on purpose: §1.1 claims the root is
independent of completion order, and this exercises that against a real chain.
The root the TypeScript core folded matched the root Solidity sealed, which is
the cross-language agreement §5.2 exists to guarantee — proven on a live
network rather than against a fixture.

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

## Three places the implementation departs from the spec

All flagged rather than silently absorbed.

**1. `Receipt.agentId` is a `uint256`, not an `address`.** §4.1 types it as an
address, but both agent registries deployed on Galileo are ERC-721 and identify
agents by token id. Narrowing a token id to 20 bytes would let two distinct
agents collide into one identity, and there is no stable address to use — an
ERC-721 agent's owner is transferable. Changed during Phase 1 because §13
freezes contract interfaces at the end of it. Full reasoning and the on-chain
evidence: [`docs/agent-identity.md`](docs/agent-identity.md).

**2. `ExecutionReceipts` stores one byte per step.** §4.1 asks for event-based
receipts with "no per-step storage writes beyond seal records", but §4.4's
`releaseStep` requires `status == 0` — and contracts cannot read logs. Since
idempotency already forces one storage write per step, the status is packed
into that same slot at no extra gas cost, exposed as `statusOf()`.

**3. `anchorStep` is restricted to the run's declared executor.** The spec does
not mention authorisation. Without it, anyone can anchor step 0 of your run
first and permanently block it, since duplicates revert. `FlowRegistry` records
the executor at `startRun` and `ExecutionReceipts` enforces it.

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

## 0G Storage is currently rejecting writes

The round-trip tool (`tools/storage-roundtrip`) is written and correct up to
the upload call, but cannot complete on Galileo right now. This is upstream,
not ours:

- Every `submit()` to the Flow contract
  (`0x22E03a6A89B950F1c82ec5e74F8eCa321a105296`, a beacon proxy) reverts with a
  bare `require(false)` and no revert data.
- It fails identically for a clean 256-byte single-chunk upload, so it is not
  our padding, length semantics or submission structure.
- The fee is correct: 3 sectors × `pricePerSector` 30733644962, sent as value.
  A 10× fee reverts the same way.
- Flow and market are mutually wired (`market.flow()` and `flow.market()`
  agree), and the contract is not paused.
- **Zero `Submit` events in the last 200,000 blocks.**
- The standard indexer returns 503; the turbo indexer is reachable but its Flow
  rejects everything. Both independent networks are unavailable.

Consequence: `traceRoot` in the live run above commits to the canonical trace
bytes we hold rather than to a retrievable 0G Storage root. The commitment is
real; retrievability is pending. Re-run the tool when Galileo storage accepts
writes.

## Acceptance criteria (§10.4)

- [x] Canonicalization frozen with property tests
- [x] Contracts drafted and unit-tested
- [x] Real TEE attestation captured and its byte structure documented
- [x] Contracts deployed on Galileo; addresses in this README
- [x] Multi-step run with linked steps, anchored out of order and sealed on chain
- [x] ERC-8004 identity resolved on chain and load-bearing
- [x] No mock or simulated path in what is demonstrated
- [ ] Contracts source-verified on the explorer
- [ ] 0G Storage round-trip *(blocked upstream, see above)*
- [ ] A deliberately failed run, sealed and verifiable as a failure
- [ ] Verifier CLI (`npx @0gflow/verify`)

## Next

Phase 2 is unblocked: contracts are live, the core is frozen, and the
anchor/seal/verify path is proven end to end. The natural next pieces are the
verifier CLI (§9) — everything it needs already exists in `packages/core` — and
the executor's adapter invocation path.
