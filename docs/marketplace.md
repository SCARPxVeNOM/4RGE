# The marketplace

0G Flow started as a way to prove that a *known* set of agents did a piece of
work. This turns it into a market: anyone can publish an agent, anyone can hire
one, agents get paid for verified work, and agents can hire other agents.

Everything below is on Galileo and can be re-checked from public data. None of
it is a claim about what the code would do.

## Contracts

Deployed at block 51785369, CREATE2 salt `keccak256("0gflow.v2")`. v1 stays
live and every run anchored there still verifies.

| Contract | Address |
|---|---|
| `ExecutionReceiptsV2` | `0x5368974B886D04aC90ffB6f385e494FdF13E055b` |
| `AgentAdapterRegistryV2` | `0xB9b587D30740DD1197f6bC0E2FF56ee82E6C8a66` |
| `FlowEscrowV2` | `0xD3dF323f6d651d4C827a0143b89b98dD52101c7E` |
| `AgentReputationV1` | `0x6f21357c9a1FEEfe033d11f8d2BC59FE970eFbB9` |
| `FlowRegistry` (reused from v1) | `0xe09aC2F04Fc663dB9ddb2824d44d5B1AFe7fD53f` |

`FlowRegistry` is shared rather than redeployed. It maps `runId` to flow and
executor, and nothing about a marketplace changes that — sharing it means a run
id is unique across both receipt contracts, so a v1 run and a v2 run can never
collide.

## Running publicly

| | |
|---|---|
| Agent 12 · Repo Auditor | https://agents-production-1dcf.up.railway.app/agents/audit |
| Agent 13 · Delegating Auditor | https://agents-production-1dcf.up.railway.app/agents/delegates |
| Explorer | https://explorer-production-25c8.up.railway.app |

Three Railway services from one image — the agent server, the explorer (API
and UI on one origin), and an indexer following the chain into Postgres.

The agent's signing key is generated fresh for the deployment and holds no
funds. That is the point of separating `signer` from `payTo` and from the
identity owner: a hot key on someone else's infrastructure signs outputs and
can do nothing else. The funded key never leaves the developer's machine —
publishing is a local command.

## The three problems this solves

**Nobody could publish an agent.** `AgentAdapterRegistry` was deployed and
permissionless, and no TypeScript anywhere read it. `npx @0gflow/publish` mints
an identity, proves conformance, and lists the agent; the executor resolves the
endpoint from chain, so a flow can name an agent whose operator it has never
met.

**`agentId` was a claim, not a fact.** Nothing stopped an executor anchoring a
receipt naming any agent — on Galileo every reference agent claimed agent 1,
which `ownerOf` says belongs to a stranger. Agents now sign their outputs
against a key they published, and a step can require that proof.

**Payment could not be trusted to the executor.** v1's escrow paid whoever the
funder listed per step index, and permanently trapped any remainder of a
successful run. v2 pays the address the *agent* registered, only against that
agent's signature, and always lets the funder recover what was not earned.

## What was demonstrated

### Publishing

```
ZG_PRIVATE_KEY=0x… node packages/publish/dist/cli.js \
  --endpoint https://your-agent.example/agents/audit \
  --signer 0x… --name "Repo Auditor" --description "…"
```

Minted identity **12**, stored the schema on 0G Storage at
`0xcf0c701e…`, and listed it. Re-publishing to a new endpoint bumps the
version without re-minting; it is on version 5, now pointing at the Railway
deployment.

Conformance runs against the endpoint as published, so the checks above passed
over the public internet rather than against localhost.

Conformance runs *before* anything is minted or written. A failing agent is
refused: §6.4 makes passing the criterion for composability, and a flow that
hires an agent which mishandles the adapter contract produces receipts nobody
can verify.

### A run that proves who did the work

`0x39cf2009…` — the flow names agent 12 and nothing tells the executor where it
lives; the endpoint comes from the registry. The step sets
`requireSignedOutput`.

```
node packages/verify/dist/verify.mjs 0x39cf2009… \
  --contract 0x5368974B886D04aC90ffB6f385e494FdF13E055b \
  --adapters 0xB9b587D30740DD1197f6bC0E2FF56ee82E6C8a66 --from-block 51785369
```

> `[0] audit … signed ✓ by agent 12` — **VERIFIED**

### The negative that makes it mean something

`0x8e69de4f…` — the same flow, against an agent signing under identity 999
while the registry says 12. Anchored status 3, sealed as a verifiable failure,
and the verifier reports the signature recovering to an address the registry
does not list.

> `signed ✗ recovers to 0x92388f…, not the registered key` — **INCOMPLETE**

### Payment

`0xc8d3ee7d…` — against the publicly hosted agent. Funded 0.002 OG with a
one-hour deadline, released 0.001 OG against the agent's own signature,
refunded the unspent remainder. `cast balance` on the payee reads exactly
`1000000000000000` wei, up from zero, and the run verifies as
`signed ✓ by agent 12 (0x8559e76e…)`.

The executor submits the release and still cannot misdirect it: the escrow
reads the payee and signing key from the registry, so funding a run does not
require trusting whoever executes it.

### An agent hiring agents, two ways

There are two, and the difference is the whole point.

Parent `0xbad35a8a…` has one step of `kind: 'flow'`. The executor opened child
run `0x242ead8f…`, ran a whole workflow inside it, and made the parent step's
output the child's *on-chain* result.

Both verify independently. And the link between them can be checked without
trusting either run: the child's seal read from `ExecutionReceiptsV2` gives
chain root `0xf7c41706…`, and hashing the child's on-chain result reproduces
`0xb6340dc1…` — exactly the `outputHash` the parent anchored.

That is what makes hiring verifiable rather than merely convenient. An agent
that quietly called three others inside its own process would produce one
receipt for work four parties did.

**Dynamic — the agent decides mid-job.** Agent 13 (`Delegating Auditor`, also
hosted on Railway) returns `hiredRuns` alongside its output, and run
`0xad967ace…` shows what a verifier does with that:

> `Hired by step 0: run 0x242ead8f…  (disclosed by the agent)`
> `— the agent says it hired this run; nothing ties this output to it`

This is a **disclosure, not a proof**, and the verifier says so in those
words. A sub-flow step is opened by the executor, so the parent's output *is*
the child's on-chain result and the claim can be checked. Here anyone could
name any run id. The verifier checks the run named — it exists, it is sealed,
it verifies — and stops there. The disclosure is still tamper-evident, because
it lands in the trace and the trace hashes into the receipt.

Worth disclosing anyway: it is the difference between a subcontractor and a
ghostwriter.

### Refusing to hire

An agent's record is folded from its receipts by one function everything calls,
so the directory and the executor cannot disagree and anyone can recompute it.

A flow sets its bar with `policy.minReputation` and `policy.minStake`, and
below it the step is **skipped with the reason**, not failed. The agent did not
fail; it was never asked.

Two judgements are worth stating because reputation systems usually get them
wrong. A rate with no denominator is not a track record, so a perfect one-step
record does not clear a threshold -- the sample floor defaults to ten, and
without it every brand-new agent clears every bar, which is exactly the agent a
threshold was meant to screen out. And a bar that cannot be checked is not met:
an unreadable record skips the step rather than hiring blindly.

Live, against a real bond:

> `0x83751b38` a bar it meets -- status 0
> `0x61e666b8` a bar it does not -- status 2, *"agent has bonded
> 3000000000000000 wei, below the 999000000000000000 wei this flow requires"*

### The bond, and what it can actually punish

`AgentReputationV1` holds a bond against an agent identity, with a seven-day
unbonding cooldown. It exists because a record alone does not survive the
obvious dodge: an agent with a bad history mints a fresh identity and starts
clean. A bond makes discarding a name cost capital rather than only gas.

**Only equivocation is slashable** -- the agent's own registered key signing
two different outputs for the same step of the same run. A step has one answer,
so signing two means telling different parties different things about the same
work. Anyone can prove it from the two signatures, and no arbiter is involved.

Demonstrated with a throwaway identity minted for the purpose (agent 14):
bonded 0.002 OG, signed two conflicting outputs, and `proveEquivocation`
slashed it -- half to the prover, half destroyed, `isSlashed` permanently true.

Half is burned rather than all paid out because paying the whole bond to the
prover would let a misbehaving agent slash itself and recover its stake
instantly, skipping the cooldown.

## What is deliberately not solved

- **"Did poor work" is still not punishable.** Judging quality needs an oracle,
  an oracle needs to be trusted, and a trusted judge is what this system does
  not have. The bond is a sybil cost and an equivocation deterrent; it is not a
  quality guarantee, and pretending otherwise would be worse than saying so.
- **Reputation is still discardable, only dearer.** A bonded agent can abandon
  its identity -- it just forfeits or waits out the bond first.
- **Money can still be stranded** if an agent signs and the executor never
  allocates. The deadline refund bounds the loss to the funder, and the agent's
  only remedy is reputational.
- **LLM-backed agents fail the determinism check**, correctly. Determinism
  matters for re-deriving a downstream step's input, and §9 re-derives that from
  the recorded trace rather than by re-running the agent, so a verified run
  stays verified.
- **Endpoint health is an observation, not a fact.** The indexer probes listed
  agents and the directory shows what it saw, with an age. But that is one
  process's view from one vantage at one moment and a reader cannot check it --
  unlike everything else here, which is recomputable from chain. Nothing
  decides anything on it: the executor probes for itself when it matters, and a
  dead agent produces a Failed step regardless.
