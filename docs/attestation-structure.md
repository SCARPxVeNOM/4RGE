# TEE attestation structure on 0G Compute

**Status:** Phase 1 open item — resolved by observation. The binding gap this
uncovered is now closed in code; see "The gap this uncovered" below. One piece
remains open: Intel certificate chain verification.
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

Because `report_data` is covered by the TDX quote's signature, Intel's
hardware root of trust is attesting: *"an enclave running these measurements
controls this Ethereum key."* That is the hook the whole design hangs on.

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

1. Verify the TDX quote signature against Intel's certificate chain.
   *(Establishes the enclave is genuine.)* — **not implemented**, see below.
2. Extract the address from `report_data`.
   *(Establishes which key the enclave controls.)* — implemented,
   `signerFromReportData`.
3. Check that address against the on-chain acknowledged TEE signer for the
   provider. *(Establishes it is the expected enclave.)* — implemented as an
   optional input, `verifyAttestation({ acknowledgedSigner })`.
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
| `present` | a document exists and is unmodified | digest matches, nothing else established |
| `attested` | a key named in the quote signed some text | `report_data` parses, signature recovers to that key |
| `bound` | **that key signed this step's output** | additionally the signed text equals the output at `outputPath` |

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

### What is still not proven

The TDX quote's own signature is **not** checked against Intel's PCS roots, so:

> `bound` means *the key named in this quote signed this output*.
> It does not mean *Intel vouches for the enclave holding that key*.

`quoteSignatureVerified` is reported as `false` rather than omitted, and no
code path prints an unqualified TEE tick. The verifier previously printed
`attestation: TEE ✓` on a mere digest match; it now prints the level, and even
`bound` reads `bound to output (Intel chain unchecked)`.

---

## Degradation path

§13 anticipates the format being unparseable and calls for degrading to
"present and unmodified" with explicit labelling. Concretely, the executor
should record which level it achieved:

| Level | Meaning | Receipt status |
|---|---|---|
| `bound` | steps 1–4 all pass | `ok` |
| `attested` | quote verified, signer acknowledged, no response signature | `ok` only if the flow did not require binding |
| `present` | blob captured, quote not verified | `unattested` when `requireAttestation` |
| `absent` | nothing returned | `unattested` when `requireAttestation` |

Per §1.3 the middle rows must never be silently promoted to `ok`. The status
decision belongs in `decideStepStatus`, which is already the only place a
success status can be produced (`packages/core/src/outcome.ts`).

---

## Degradation path in practice

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

1. **Intel certificate chain verification.** Not implemented. The verifier CLI
   is zero-dependency (§9) and full TDX quote verification needs Intel's PCS
   roots. Vendoring them is the remaining work; until then the output says the
   chain was not checked rather than implying it was. This is the one
   outstanding piece of the four-step plan.
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
