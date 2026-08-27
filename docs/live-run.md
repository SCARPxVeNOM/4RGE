# A real run on 0G Galileo, verified

**Status:** §11 Phase 3 gate — executed.
**Date:** 2026-08-27, 0G Galileo Testnet (chain 16602).
**Executor:** `0x3274E860FA4d3372bD120b61367a7555713417A8`
**Receipts contract:** `0x741A36fAba40ee71223539a5A062FDEDC8574e30`
**Cost:** 0.00563 A0GI for three runs, nine anchored steps and three seals.

Three runs, because one success proves less than a success plus the two ways a
run is allowed to *not* succeed. §10.4 asks for a deliberately failed run that
is still sealed and verifiable; §1.3 asks that a missing attestation is
recorded as `unattested` rather than quietly as `ok`.

Reproduce:

```
pnpm --filter @0gflow/run-flow flow -- all       # execute
node packages/verify/dist/verify.mjs <runId> \
  --spec artifacts/runs/<runId>.json --trace-dir artifacts/traces
```

---

## What was anchored

Read back with raw `eth_getLogs`, independently of any code in this repo:

| Scenario | runId | Steps | Sealed at block | Outcome |
|---|---|---|---|---|
| success | `0xc8b00f25…f841df5c` | 4 | 51674067 | `0` ok |
| unattested | `0xf2603fbc…79f2bf36` | 2 | 51674144 | `3` unattested |
| failure | `0xf06791d2…6b188234bf` | 3 | 51674255 | `1` failed |

Chain roots, as sealed:

```
success      0xdc908a5d2203b01007de6b6ef8053f750fa80e1711f208991ffdaec45ab26c29
unattested   0x35efd4505bc5e3f51dd8f9dc46bd74f807043fd2e3b8b335ff379409877c586c
failure      0x633b2327d51f07a4ceac2bf08772d68d71fc47b3097c1d5bc80f4de957aee6f5
```

Each equals the root `@0gflow/core` folds from the receipts as the *contract*
emitted them. If canonicalization, receipt encoding or the fold had drifted
between TypeScript and Solidity, that comparison fails.

## What verification found

All three: identity ✓, trace ✓, hashes ✓, linkage ✓, chain root ✓ against the
on-chain seal.

The failure run behaves as §10.4 requires — `review` anchored status 1 and
`publish` status 2 (skipped, because its upstream did not succeed) — and the
run is still sealed and still verifiable *as a failure*. The unattested run
anchored status 3 with `attestation: ✗ required but absent`.

### Verdict: INCOMPLETE, not VERIFIED

All three exit `2`. Nothing failed; one piece of evidence could not be
obtained:

```
? not every trace was retrieved from 0G Storage with a verified inclusion
  proof, so third-party retrievability is unproven
```

This is the honest verdict and the design intends it. Traces are held locally,
so *this* machine can check them, but a stranger cannot fetch them — and §1.3
does not let "I could not obtain the evidence" collapse into success. See the
storage section below for why.

### The verifier is not rubber-stamping

Changing one character of one stored output — `1 issues` to `0 issues` in the
audit step's trace — and re-running:

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

Note the chain root still matches: only the stored trace was altered, not the
anchored receipt. The two checks are independent, and the linkage collapse
from 4/4 to 1/4 is §4.1 doing its job — one tampered output invalidates every
downstream input derived from it.

---

## Why 0G Storage did not accept the traces

`submit()` reverts with a bare `require(false)`. Diagnosed rather than assumed:

- **Not a network outage.** The flow contract
  (`0x22E03a6A89B950F1c82ec5e74F8eCa321a105296`) is not paused, its market is
  correctly cross-wired, `pricePerSector` is 30733644962, and `numSubmissions`
  stands at 148116. Storage nodes report 2 connected peers and a current
  `logSyncHeight`.
- **Not the fee.** `estimateGas` reverts identically with `value` at 0, at the
  SDK-computed fee, and at ten times it.
- **Other people are submitting successfully** — six flow-contract logs in the
  last 5000 blocks, the most recent at block 51671352.

**The cause is a contract/SDK mismatch.** A successful submission calls
selector `0xbc8c11f8`, whose calldata carries two extra leading arguments (an
address and a uint256) before the submission struct. `@0glabs/0g-ts-sdk@0.3.3`
— the latest published version — calls `0xef3e12dc`, which is
`submit((uint256,bytes,(bytes32,uint256)[]))`. That entrypoint still exists and
reverts unconditionally.

So the deployed contract has moved to a new submit entrypoint and the published
SDK has not followed. The new signature is not documented in the SDK, and
guessing it was not attempted: writing a hand-rolled submission against an
unidentified selector risks putting junk on chain, and the failure mode would
be indistinguishable from the current one.

**Consequence:** traces are written by `LocalTraceStore` and the verifier
reports third-party retrievability as unproven. Everything else in the
procedure runs against public data. The moment storage accepts a submission,
these same runs verify to `VERIFIED` with no code change — the verifier already
tries 0G Storage first and falls back.
