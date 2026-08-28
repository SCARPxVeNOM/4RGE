# @0gflow/core

The primitives every other 0G Flow package agrees on. **Zero dependencies.**

- RFC 8785 canonical JSON, with the number formatting spelled out
- `sha256`, `keccak256` and secp256k1 recovery, hand-written
- Receipt encoding and hashing, pinned against Solidity by a cross-language vector
- Chain-root folding
- Attestation binding levels — `absent` / `present` / `attested` / `bound`
- Agent output signatures
- The success rule, in one place

Hand-written rather than pulled from libraries because the verifier has to stay
a single auditable file and the same code has to run in a browser. It can
recover a public key and deliberately **cannot sign**: code that cannot sign
cannot leak a key.

`decideStepStatus` is the only function permitted to produce a step status, and
a structural test fails the build if anything else tries. No status reports
success unless a third party could confirm it from public data.

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
