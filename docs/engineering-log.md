# Engineering log

The record of how this was built, moved out of the README when that became a
document for people who want to *use* the project rather than read its history.

Kept because most of it is not narrative: these are findings that changed the
design, and several are the reason the code looks the way it does. Nothing here
is a status report — for what is deployed and how to run it, see the
[README](../README.md).

Stale sections were dropped rather than carried forward. In particular, one
claiming 0G Storage was rejecting writes is gone: it was true when written and
is not now. Traces and agent schemas are written to 0G Storage on both Galileo
and Aristotle, and the verified mainnet run in the README depends on it.

---

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

## The verifier

```
npx @0gflow/verify <runId>
```

Zero runtime dependencies, one bundled file of ~1,400 readable lines importing
nothing but `node:crypto`, `node:fs`, `node:https`, `node:os` and `node:path`.
JSON-RPC and ABI decoding are hand-rolled: §9 makes auditability the point, and
a tool with a large transitive dependency tree is not auditable. A test asserts
the published package declares no dependencies and the bundle contains no bare
imports, so this cannot rot.

**Three verdicts, because two would force it to lie.** §1.3 says nothing
reports success unless a third party can confirm it, so "I could not get the
evidence" must not collapse into either pass or fail:

| Verdict | Exit | Meaning |
|---|---|---|
| `VERIFIED` | 0 | every check ran and passed against retrievable public data |
| `FAILED` | 1 | a check ran and did not pass |
| `INCOMPLETE` | 2 | evidence was missing, so a check could not run |

Failure outranks incompleteness, so a broken run cannot hide behind missing
data. Against the live run, with 0G Storage down, it correctly refuses to say
VERIFIED even though every check it *could* run passed:

```
  [0] audit        0x4109ce…   id ✓   trace ✓   hashes ✓   attestation: not required
  [1] summarize    0x706edb…   id ✓   trace ✓   hashes ✓   attestation: not required

  Linkage      ✓   2/2 inputs derive from declared upstream outputs
  Chain root   ✓   0x52f5f4… matches on-chain seal
  Outcome      ✓   success

  Not checked:
    ? not every trace was retrieved from 0G Storage with a verified inclusion
      proof, so third-party retrievability is unproven

  INCOMPLETE — nothing failed, but the evidence to finish verifying was not available
```

### `--tamper`

Mutates a copy of a stored trace and shows the detection cascade:

```
  before  {"report":"no critical findings; 3 informational","severity":"info"}
  after   {"report":"…","severity":"info","tamperedBy":"0gflow-verify --tamper"}

  [0] audit        hashes ✗
  Linkage      ✗   0/2 inputs derive from declared upstream outputs

    ✗ step 0: the stored output hashes to 0x02d28b… but the receipt anchors 0x6cf9cf…
    ✗ step "summarize": cannot re-derive input because upstream output "audit"
      was not confirmed

  TAMPER DETECTED
```

Note the second failure. Changing one step's output does not merely break that
step's hash — it breaks the *next* step's linkage, because step 1's input can
no longer be derived from an output nobody confirmed. That cascade is §4.1
working.

### Two bugs that only showed up against the real chain

Both were the same species — a verifier claiming to have checked something it
had not — and both were found by running it against Galileo rather than
fixtures:

1. **The 0G Storage indexer answers a missing file with HTTP 200** and a body
   of `{"code":101,"message":"File not found"}`. Keying off the status code
   handed that envelope to the verifier as though it were a trace, which then
   reported a *failed* hash check for a file that simply was not there.
   "Absent" and "wrong" are different answers.
2. **The report printed "flow spec not supplied"** whenever linkage was
   skipped, including when the real reason was unavailable traces — stating a
   confident wrong reason for not checking something.

## Phase 3: real runs, end to end

`pnpm --filter @0gflow/run-flow flow -- all` executes three flows against the
deployed contracts, invoking the reference agents over real HTTP. Each is then
verified independently by the CLI, which reads only chain logs and traces.

| Scenario | Shape | Sealed outcome | Verifier |
|---|---|---|---|
| `success` | 4 steps, parallel branch | `0` ok | linkage ✓ 4/4, chain root ✓ |
| `unattested` | step requires attestation, agent gives none | `3` unattested | linkage ✓ 2/2, step flagged `✗ required but absent` |
| `failure` | middle step fails, next is skipped | `1` failed | linkage ✓ 3/3, chain root ✓ |

All three cost 0.0075 A0GI in total.

The `success` run is §11's completion gate — "verifier CLI passes against a
live four-step run":

```
  [0] audit        id ✓   trace ✓   hashes ✓   attestation: not required
  [1] summarize    id ✓   trace ✓   hashes ✓   attestation: TEE ✓
  [2] score        id ✓   trace ✓   hashes ✓   attestation: not required
  [3] publish      id ✓   trace ✓   hashes ✓   attestation: not required

  Linkage      ✓   4/4 inputs derive from declared upstream outputs
  Chain root   ✓   0x784439… matches on-chain seal
```

### What the failure run exposed

It initially made the verifier report **FAILED** — which is wrong. §1.3 says
failed runs are *verifiable as failures*; a failed run that fails verification
is indistinguishable from a tampered one, and the entire point is that those
are different.

The cause was a semantic gap. A failed or skipped step anchors
`outputHash = 0x00…`, which is a claim of **absence** — the step committed to
nothing. The verifier was comparing that against `hashJson({})` from the trace
and calling the mismatch tampering. Both `verifyLinkage` and the verifier now
treat a zero hash as "no commitment" and skip the comparison — but only where
the status explains it:

> **An ok step may never commit to nothing.** Otherwise a step could pass every
> hash check by claiming it produced nothing at all.

`--tamper` still detects mutation, so the exemption did not become a hiding
place. Nothing had exercised the failure path end to end until §11 forced it,
which is the argument for building the failure demonstration rather than
assuming it.

## Indexer and explorer

```
docker run -d --name 0gflow-pg -e POSTGRES_PASSWORD=0gflow   -e POSTGRES_USER=0gflow -e POSTGRES_DB=0gflow -p 55432:5432 postgres:16-alpine

export DATABASE_URL=postgres://0gflow:0gflow@localhost:55432/0gflow
pnpm --filter @0gflow/indexer index --once      # backfill from the deployment block
pnpm --filter @0gflow/explorer-api serve        # :8711
pnpm --filter @0gflow/explorer dev              # :5173
```

The indexer backfills from the deployment block and follows the head. All five
live runs index correctly and re-indexing is idempotent.

**Reorgs (§8.1).** Rows record the block they came from, so they can be undone.
Each pass re-checks the unfinalised tail against the chain's current block
hashes; the first mismatch means everything above it describes a chain that no
longer exists, so those rows are dropped and the range is rescanned. Blocks
below the finality depth are never re-checked — re-verifying the whole chain
every pass would make the indexer O(chain). That tradeoff has its own test
asserting a deep reorg is *not* detected, so the limit is documented rather
than discovered.

**Two stores, one suite.** `MemoryStore` makes the ingestion logic testable
without infrastructure; `PostgresStore` is what runs. Both are held to the same
conformance suite, so a divergence is a failing test rather than a
production-only surprise. The Postgres case skips when no database is
reachable and says so out loud, because a green suite that quietly skipped the
production store is worse than a red one.

### The explorer does not ask to be trusted

§8.2 requires client-side verification, and it means it. The API serves the raw
receipt fields rather than a verdict, and the browser folds the chain root
itself using the same frozen `@0gflow/core` the executor and verifier use:

> **Chain root verified in your browser.** The receipts served by this API fold
> to `0x784439c4a85ff5…0ca4`, which is the root sealed on chain. Recomputed
> here with the same `@0gflow/core` the executor and verifier use — this page
> did not take the API's word for it.

If the API were lying, or merely wrong, the fold would not match and the page
says so. It is also explicit about its limits: it cannot fetch traces, so it
never claims a run is *verified* — only that the chain root holds — and it
prints the `npx @0gflow/verify` command for the rest.

### Making core browser-safe

Building the explorer surfaced a real constraint. `@0gflow/core` used
`node:crypto` for sha256, so it could not bundle for a browser at all:

```
"createHash" is not exported by "__vite-browser-external"
```

§5.2 makes core the single implementation shared by five components and §8.2
adds a sixth that runs in a browser, so sha256 is now hand-written in pure
TypeScript alongside keccak256. A test asserts core imports nothing from
`node:`, uses no `require()`, and touches no Node globals — the guard that
keeps it true. The published conformance vectors pinned correctness through
the swap.

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
