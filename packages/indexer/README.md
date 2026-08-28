# @0gflow/indexer

Index 0G Flow receipts, seals, agent listings and bonds into Postgres, with
backfill and reorg handling.

```sh
DATABASE_URL=postgres://… npx @0gflow/indexer --v2   # or: 0gflow-indexer
```

Every write is idempotent and carries the block it came from, so a reorg can
undo it: an indexer that cannot forget serves receipts that no longer exist on
chain.

It also probes listed agents so a directory can tell a live one from an
abandoned one — stored as an observation with a timestamp, because unlike
everything else here that is not something a reader can verify.

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
