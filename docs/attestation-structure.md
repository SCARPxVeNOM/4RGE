# TEE attestation structure on 0G Compute

**Status:** Phase 1 open item — resolved by observation.
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

### The gap this uncovered

A digest of the blob proves the blob was not modified after the fact. **It does
not prove the blob has anything to do with this step's output.** An operator
could attach a genuine attestation, captured from a real enclave, to an output
that enclave never produced. Nothing in §9's step 5 ("verify each
attestationRef against the raw attestation in the trace") would catch it.

Closing that requires binding the output to the attested key, in four steps:

1. Verify the TDX quote signature against Intel's certificate chain.
   *(Establishes the enclave is genuine.)*
2. Extract the address from `report_data`.
   *(Establishes which key the enclave controls.)*
3. Check that address against the on-chain acknowledged TEE signer for the
   provider. *(Establishes it is the expected enclave.)*
4. **Fetch the per-response signature and verify it over the actual output.**
   `GET {url}/v1/proxy/signature/{chatID}?model={model}` returns
   `{ text, signature }`; the SDK verifies it with
   `Verifier.verifySignature(message, signature, expectedAddress)`.
   *(Establishes this output came from that enclave.)*

**Only step 4 makes the attestation load-bearing for a receipt.** Steps 1–3
alone attest that some enclave exists somewhere.

### Recommended change to the receipt semantics

The executor should capture the per-response signature and `chatID` alongside
the raw quote, storing both in the trace, and `attestationRef` should digest
that combined envelope rather than the quote alone. Otherwise `attestationRef`
certifies provenance of a document rather than provenance of an output, and
§1.2's claim — "prove which model produced an output" — is not met.

This is a spec change to §6.3 and to the §9 verification procedure, and it
should land before the executor's attestation path is written, for the same
reason §10.3 was written early.

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

## Open questions for Phase 2

1. **Intel certificate chain verification offline.** The verifier CLI is
   zero-dependency (§9). Full TDX quote verification needs Intel's PCS roots.
   Either vendor the root certificates into the verifier or accept that quote
   *signature* verification is delegated, and say so in the output rather than
   printing an unqualified `TEE ✓`.
2. **`chatID` provenance.** Confirm the executor can obtain `chatID` reliably
   from an inference call, since step 4 depends on it.
3. **Provider availability.** 2 of 6 responded. Decide whether
   `requireAttestation: true` should fail the step or retry across providers.
4. **Quote freshness.** `/v1/quote` appears to serve a per-enclave quote, not a
   per-request one. If it is cached, `report_data` binds the key but not the
   moment — which is fine, because freshness comes from step 4's per-response
   signature, not from the quote.
