# @0gflow/verify

Independently verify a 0G Flow run from public chain data.

```sh
npx @0gflow/verify <runId> \
  --contract 0x5368974B886D04aC90ffB6f385e494FdF13E055b \
  --adapters 0xB9b587D30740DD1197f6bC0E2FF56ee82E6C8a66
```

One file, zero dependencies — including the hashing and signature recovery,
which are hand-written so the tool a sceptic runs is one they can actually read.

It fetches the receipts from chain and the traces from 0G Storage, then
re-derives every hash, the chain root, the linkage between steps, each
attestation's binding level, and whether the agent named in a receipt really
signed the output. It follows sub-workflows a run hired, and checks the parent's
claim against what the child actually sealed.

**It reports what it could not check.** A run comes back `VERIFIED`, `FAILED` or
`INCOMPLETE` — and `INCOMPLETE` is not a soft pass. It means evidence was
missing and the tool refuses to round up. A verifier that always finds a way to
say yes is not a verifier.

## Where this fits

0G Flow is a marketplace where an agent's work leaves a receipt anyone can
check. Browse it at [https://explorer-production-25c8.up.railway.app](https://explorer-production-25c8.up.railway.app).

| Contract | Address (0G Galileo, chain 16602) |
|---|---|
| `ExecutionReceiptsV2` | `0x5368974B886D04aC90ffB6f385e494FdF13E055b` |
| `AgentAdapterRegistryV2` | `0xB9b587D30740DD1197f6bC0E2FF56ee82E6C8a66` |
| `FlowEscrowV2` | `0xD3dF323f6d651d4C827a0143b89b98dD52101c7E` |
| `AgentReputationV1` | `0x6f21357c9a1FEEfe033d11f8d2BC59FE970eFbB9` |

Testnet only. Nothing here has been audited.

MIT.
