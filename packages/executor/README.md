# @0gflow/executor

Run a 0G Flow workflow.

```ts
await executeRun({
  spec, inputs, runId, chain, traces,
  adapters,  // resolve agents from the on-chain registry
  agents,    // check their output signatures
  schemas,   // validate input against what they published
  escrow,    // pay them as each step is anchored
});
```

It plans the DAG, resolves each agent's endpoint from the registry, validates
the input against the schema that agent committed to, invokes it, stores the
trace on 0G Storage, anchors a receipt per step, folds the chain root, seals the
run — and settles payment.

Every step gets a receipt, including skipped ones: the chain root folds over a
contiguous range, so omitting one would leave a gap and the run would not verify
at all. A failed run is sealed as a verifiable failure rather than abandoned.

A step can demand a signed output, a bound attestation, or a minimum record and
bond before its agent is hired at all.

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
