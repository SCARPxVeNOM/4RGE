# TEE attestation structure on 0G Compute

**Status:** Phase 1 open item — resolved by observation. The binding gap this
uncovered is closed in code, anchored on **0G's own on-chain TEE signer
registry**. See "The gap this uncovered" below.
**Captured:** 2026-08-19, 0G Galileo Testnet (chain 16602), two independent providers.
**Raw artifacts:** `artifacts/attestation/*.raw.json`
**Reproduce:** `pnpm --filter @0gflow/attestation-probe probe`

This documents what a 0G Compute attestation actually *is*, so that the
`attestationRef` field of a receipt (§4.1) is designed against an observed
artifact instead of an assumed one.

---

## How it is retrieved

No wallet, no funds, no account required. The provider list is readable from
chain via the SDK's read-only broker, and the attestation is a plain HTTP GET.

```
GET {service.url}/v1/quote        →  200, Content-Type: text/plain; charset=utf-8
```

Note the path. The SDK also references
`/v1/proxy/attestation/report?model=…`, but that returned **501 Not
Implemented** on a host where `/v1/quote` returned 200. A probe that tries only
the documented path will wrongly conclude the provider has no attestation.
`tools/attestation-probe` tries both.

Of six providers listed on chain, two served attestations, two were DNS/TLS
unreachable, and two returned 501/404. **Availability is roughly 1 in 3** —
plan retries and provider fallback into the executor rather than assuming the
first provider answers.

## Top-level shape

JSON object, five string fields, served as `text/plain`:

| Field | Encoding | Observed size | Contents |
|---|---|---|---|
| `quote` | hex, unprefixed | **5006 bytes** (10012 chars), identical on both providers | Intel TDX quote |
| `report_data` | base64 | **64 bytes** exactly | the enclave's signing address (see below) |
| `tcb_info` | JSON string | 24 330 – 28 584 chars | measurements, image hashes, event log |
| `event_log` | JSON string | 4 927 – 6 929 chars | 28 measurement events |
| `vm_config` | JSON string | 292 – 313 chars | CPU/memory/GPU topology, `os_image_hash` |

Whole document: **43 258 – 49 773 bytes**. Comfortably fine for the trace,
far too large for chain — which is exactly why only a digest is anchored.

### `quote` — Intel TDX v4

Parsed from the header bytes:

| Offset | Field | Value |
|---|---|---|
| 0 | version | `4` |
| 2 | attestation key type | `2` (ECDSA-P256) |
| 4 | TEE type | `0x81` (TDX) |

Fixed 5006 bytes across both providers, as expected for a TDX quote with an
ECDSA-P256 signature and certification data.

### `tcb_info` — measurement registers

`mrtd`, `rtmr0`–`rtmr3` are **48 bytes** each (SHA-384). `mr_aggregated`,
`compose_hash`, `device_id` are **32 bytes** each. Also carries `os_image_hash`
and `app_compose`.

### `report_data` — the finding that matters

**Advisory only.** This field is served alongside the quote and is not
authenticated by anything 0G Flow checks. The trust anchor is the acknowledged
`teeSignerAddress` on chain; this copy is used solely to cross-check against
it. See "A hole this work exposed" below.

64 bytes, and it is **not** a hash. It is the ASCII text of an Ethereum
address, zero-padded to the full 64 bytes:

```
base64  MHg4M2RmNEI4RWJBN2MwQjNCNzQwMDE5YjhjOWE3N2ZmRjc3RDUwOGNGAAAA…
bytes   30 78 38 33 64 66 …  "0x83df4B8EbA7c0B3B740019b8c9a77ffF77D508cF"
        followed by 22 zero bytes
```

Each provider binds a different address:

| Provider (on chain) | Address in `report_data` |
|---|---|
| `0xa48f01287233509FD694a22Bf840225062E67836` | `0x83df4B8EbA7c0B3B740019b8c9a77ffF77D508cF` |
| `0x4b2a941929E39Adbea5316dDF2B9Bd8Ff3134389` | `0x2A94D671f1A5e080f75A8164087Cdd35c8442e69` |

Note these are *not* the provider's on-chain address. They are the enclave's
**TEE signer** — the key the enclave controls and signs responses with. The
contract tracks acknowledgement of it separately
(`checkProviderSignerStatus` → `teeSignerAddress`).

The key itself is the hook the whole design hangs on: an enclave controls it
and signs responses with it, so a signature by that key is a statement from
the enclave.

0G Flow learns which key that is from **0G's own contract**, not by parsing
this document. `getService(provider)` returns the same address (verified — see
below), and unlike a document served by the party being verified, chain state
cannot be rewritten by them and can be revoked.

---

## What this means for `attestationRef`

### Decision: digest the raw bytes, exactly as received

```
attestationRef = sha256(raw response bytes)
```

- Store the raw blob verbatim in the trace on 0G Storage.
- **Do not canonicalize it, do not re-serialise it.** The payload is served as
  `text/plain` and contains JSON-encoded strings *inside* JSON fields;
  re-serialising would change bytes without changing meaning and break the
  digest. This also sidesteps §5.2 entirely for this field — a welcome
  reduction in surface area.
- Anchor the digest in the receipt's `attestationRef`; zero when absent.

This matches §6.3 and §13's "store the raw blob and record only its digest".

### The gap this uncovered — **now closed**

A digest of the blob proves the blob was not modified after the fact. **It does
not prove the blob has anything to do with this step's output.** An operator
could attach a genuine attestation, captured from a real enclave, to an output
that enclave never produced. Nothing in §9's step 5 ("verify each
attestationRef against the raw attestation in the trace") would catch it.

Closing that requires binding the output to the attested key, in four steps:

1. Establish which key the enclave controls, from a source that cannot be
   forged by the party being verified — **0G's on-chain acknowledged TEE
   signer**, read via `getService(provider)`.
2. Require the provider to be acknowledged. A de-acknowledged signer vouches
   for nothing, which is how revocation is expressed.
3. Bind the receipt to a provider: `attestationRef` digests the provider
   address, so a stored bundle cannot be re-pointed at whichever provider
   happens to acknowledge the signing key.
4. **Fetch the per-response signature and verify it over the actual output.**
   *(Establishes this output came from that enclave.)* — implemented, and it
   is the step everything turns on.

**Only step 4 makes the attestation load-bearing for a receipt.** Steps 1–3
alone attest that some enclave exists somewhere.

### What the 0G SDK does, and why it is not enough

The SDK's own check is:

```js
// inference/broker/response.js
const ResponseSignature = await Verifier.fetchSignatureByChatID(svc.url, chatID, svc.model);
return Verifier.verifySignature(ResponseSignature.text, ResponseSignature.signature, signingAddress);
```

It verifies the signature over `ResponseSignature.text` — **the text returned
by the same endpoint that returned the signature.** It never compares that text
against the completion the client actually received.

So the SDK establishes *"the enclave signed something"*, not *"the enclave
signed what I got"*. A provider can serve one completion over `/v1/chat/...`
and a correctly-signed different `text` from `/v1/proxy/signature/{chatID}`,
and the SDK's verification passes.

0G Flow therefore performs the comparison the SDK omits. That comparison is the
entire difference between the `attested` and `bound` levels below, and it is
the reason `verifyAttestation` takes the step's output as an argument.

### The four binding levels

Implemented in `packages/core/src/attestation.ts`. Ordered weakest first; only
the last makes an attestation load-bearing.

| Level | Means | How it is reached |
|---|---|---|
| `absent` | nothing was returned | no attestation |
| `present` | a document exists and is unmodified | digest matches; **also where an unresolved or de-acknowledged signer lands** |
| `attested` | 0G vouches for a key, and that key signed some text | the registry acknowledges the provider's signer, and the response signature recovers to it |
| `bound` | **that key signed this step's output** | additionally the signed text equals the output at `outputPath` |

An acknowledged on-chain signer is a precondition for the top two: without one
there is nothing to check a signature against, and the attestation document
alone is bytes anyone could have written.

`decideStepStatus` takes `requireBinding`, defaulting to `present` — which is
what `requireAttestation` alone has always meant. A step declaring
`requireBinding: 'bound'` and reaching only `attested` is anchored **status 3
(unattested), never 0**, by the same §1.3 rule that already governed a missing
attestation. It is not the attestation the step required.

### The change to receipt semantics

`attestationRef` now digests the quote **together with** the per-response
signature:

```
attestationRef = sha256(
  "0gflow-attestation-v1\n" ‖ len‖quote ‖ len‖chatID ‖ len‖model
                            ‖ len‖text  ‖ len‖signature ‖ len‖outputPath
)
```

- Length-prefixed rather than canonical JSON. The quote is served as
  `text/plain` and carries JSON-encoded strings inside JSON fields;
  canonicalising it would NFC-normalise and re-escape bytes, changing the
  digest without changing the meaning.
- Domain-separated, so a receipt anchored under the old quote-only scheme can
  never be replayed as though it carried a binding.

`outputPath` is recorded, not assumed. The executor knows how it built the
output from the completion; a verifier working from the trace alone does not.
Without it, `bound` would rest on a convention nobody wrote down.

**Old receipts still verify.** `legacyAttestationRef` reproduces the previous
digest exactly — sha256 over the base64-*decoded* attestation, matching what
was actually anchored — and such receipts are reported as `present`, never
promoted.

### The trust anchor is 0G, not a vendor PKI

0G's InferenceServing contract (`0xa79F4c83…` on Galileo) records, per
provider, the TEE signer it has acknowledged:

```solidity
struct Service { …; address teeSignerAddress; bool teeSignerAcknowledged; }
function getService(address provider) view returns (Service);
```

**Verified live on Galileo.** For both captured providers, the acknowledged
`teeSignerAddress` is byte-identical to the address inside that provider's
quote `report_data`:

| Provider | On-chain `teeSignerAddress` | Quote `report_data` | Acknowledged |
|---|---|---|---|
| `0xa48f0128…` | `0x83df4B8E…` | `0x83df4B8E…` | yes |
| `0x4b2a9419…` | `0x2A94D671…` | `0x2A94D671…` | yes |

So anchoring on 0G does not change **which key** is trusted — it is the same
key. It changes **who vouches for it**, from a vendor certificate chain to the
chain this system already reads. Three things follow:

- **No foreign root is vendored** and no external PKI has to be kept current.
- **Revocation works.** Chain state is live, so a de-acknowledged signer stops
  verifying on the next read. A pinned certificate chain cannot express that
  without a network fetch the offline verifier was built to avoid.
- **One evidence source.** §9's verifier resolves the signer over the same RPC
  it already uses for receipts, hand-decoded — no ABI dependency, consistent
  with the zero-dependency rule.

The verifier reads word 10 and 11 of the `getService` return (the two static
members of a dynamic tuple), a layout confirmed against a live response.

### What this rests on, stated plainly

That 0G acknowledges a signer only for an enclave it actually attested.

`bound` therefore means: *0G's registry vouches for this key, and this key
signed this output.* It is not an independent hardware proof, and nothing in
the code or the CLI claims otherwise. The attestation document is still stored
in the trace verbatim, so anyone who wants a hardware-level check can perform
one out of band against the bytes the provider actually sent.

### A hole this work exposed

An earlier iteration read the signer address from the attestation envelope's
JSON `report_data` field. That field is **not authenticated** — it is served
alongside the quote as a convenience. An attacker could keep a genuine
attestation and rewrite that one field to name a key they control.

The signer now comes from chain only. `claimedSigner()` still parses the
envelope's copy, but purely as an advisory cross-check: a disagreement is
reported as a note, and the acknowledged key is what counts.

## Degradation path

§13 anticipates the format being unparseable and calls for degrading to
"present and unmodified" with explicit labelling. That is what the levels do,
and `decideStepStatus` is where the mapping lives — the only place a success
status can be produced (`packages/core/src/outcome.ts`).

`decideStepStatus` maps the level to a status. Nothing may promote a weaker
level than the flow asked for:

| Achieved | `requireBinding` unset / `present` | `requireBinding: 'bound'` |
|---|---|---|
| `bound` | ok | ok |
| `attested` | ok | **unattested (3)** |
| `present` | ok | **unattested (3)** |
| `absent` | unattested (3) | unattested (3) |

A verifier goes further: a step anchored **ok** whose attestation reaches only
`attested` is a verification *failure*, not a note. A genuine quote with a
genuine signature over a different response is the substitution this exists to
catch, and it must not pass.

---

## Still open

1. **Measurement policy.** `getService` says *which key* 0G vouches for, not
   *which software* the enclave was running. Whether a given `mrtd`/`rtmr` set
   is the image you expected is a policy question; the attestation document in
   the trace carries the measurements for anyone who wants to judge them.
2. **`chatID` provenance.** The binding requires it. An agent fronting 0G
   Compute must return it in `attestationBinding`; the adapter SDKs expose the
   field and reject a partially-filled binding, but no reference agent yet
   produces a real one, because that needs a live inference call against a
   provider that serves both endpoints.
3. **Provider availability.** 2 of 6 responded. Decide whether
   `requireAttestation: true` should fail the step or retry across providers.
4. **Quote freshness.** `/v1/quote` appears to serve a per-enclave quote, not a
   per-request one. If it is cached, `report_data` binds the key but not the
   moment — which is fine, because freshness now comes from the per-response
   signature, not from the quote.
5. **Replay within a run.** A signature over a given text remains valid
   forever, so an agent could return the same signed completion for two
   identical inputs. That is correct behaviour — identical inputs *should*
   produce identical outputs, per the determinism the conformance suite
   requires — but a flow needing per-invocation freshness would have to carry
   `runId`/`stepIndex` into the signed text, which 0G Compute does not
   currently do.
