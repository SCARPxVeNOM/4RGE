# zgflow

The 0G Flow Python SDK: RFC 8785 canonicalisation, receipt hashing, and the
§6.1 agent adapter contract. No runtime dependencies.

```python
from zgflow import hash_json, canonicalize

canonicalize({"b": 2, "a": 1})   # '{"a":1,"b":2}'
hash_json({"b": 2, "a": 1})      # '0x...'  same value the executor anchors
```

## Why this package is a port, not a design

§5.2 says one canonicalisation implementation is shared by five components. If
any two disagree, you get runs that execute correctly and then fail
verification, with a symptom that points nowhere near the cause. The TypeScript
`@0gflow/core` is the reference; this package is held to the same frozen
vectors in `packages/core/vectors/canonicalization.json`.

Two test suites enforce that, and both must pass:

- `pytest` here checks this package against the vectors.
- `packages/core/test/cross-language-python.test.ts` runs **both**
  implementations over 500 randomly generated JSON values and asserts they
  produce identical bytes and identical digests — and reject identically. It
  runs under `pnpm test`, so a divergence is caught without anyone remembering
  to run pytest. It skips with a printed note if Python is not on PATH.

The random test is there because fifteen vectors are fifteen values: they pin
the cases someone thought of. It has already earned its place once — see
"Large integers" below.

## The four traps a Python port walks into

**Key ordering.** RFC 8785 sorts property names by UTF-16 code unit. Python's
`sorted()` sorts by code point. These agree across the entire BMP and disagree
above it: `U+1F600` must sort *before* `U+FFFF`, because its lead surrogate
`0xD83D` is below `0xFFFF`. Any workflow carrying an emoji key hashes
differently under a naive port. `canonical._utf16_key` is the one line that
decides whether this package can verify a run the TypeScript executor produced.

**Numbers.** RFC 8785 defers to ECMAScript's `Number::toString`. Python's
`repr` is *also* shortest-round-trip, which is why this looks fine until it
isn't:

| value  | ECMAScript              | Python `repr` |
|--------|-------------------------|---------------|
| `1e20` | `100000000000000000000` | `1e+20`       |
| `1e-7` | `1e-7`                  | `1e-07`       |
| `-0.0` | `0`                     | `-0.0`        |

`numbers.py` implements ECMA-262 §6.1.6.1.20 directly.

**`bool` is an `int`.** `isinstance(True, int)` is `True`, so a naive type
dispatch serialises `True` as `1`.

**Lone surrogates.** Python strings can hold them; `str.encode` then raises
from deep inside the call. They are rejected up front instead.

## Large integers

Python is the only one of the five implementations with an unbounded integer
type. A JSON number is an IEEE754 double, so `canonicalize` converts ints to
doubles — **including when that loses precision**.

Rejecting the lossy ones was tried first and was wrong. JavaScript has no
integer type: a receipt anchored by the TypeScript executor carrying
`1840870599108701000` holds the double, and a Python verifier that refused to
hash it could not verify that run at all. Refusing to reproduce a hash is a
worse failure than reproducing one whose rounding is inherent to JSON.

Producers who want to know before it matters can ask:

```python
from zgflow import find_lossy_integers

find_lossy_integers({"id": 2**53 + 1})   # ['$.id']  -> carry it as a string
```

Call it when *building* a step input. By verification time the receipt exists
and the rounding is a fact.

## Building an agent

The same contract as `@0gflow/adapter-sdk`, deliberately — an executor cannot
tell which language an agent was written in, so a behaviour that differed
between the two SDKs would be a difference with no visible cause.

```python
from zgflow import AgentDefinition, AgentResponse, require_string, route_agent_request

def summarize(request):
    text = require_string(request.input, "text")
    return AgentResponse(output={"text": f"Summary: {text}."}, attestation=None)

agent = AgentDefinition(
    agent_id="1",                      # ERC-721 token id, as a decimal string
    schema={"input": {...}, "output": {...}},
    invoke=summarize,
)

# Behind any framework: returns (status, body) or None if the path isn't ours.
result = await route_agent_request(agent, "POST", "/invoke", body)
```

Three things the SDK makes hard to get wrong:

- **An error must say whether retrying is safe.** `retryable` defaults to
  `False`, because repeating a call whose safety is unstated is the riskier
  assumption, and a deterministic failure retried four times just burns the
  caller's deadline.
- **A 200 must carry an `output`.** Returning `{}` because there was nothing to
  say anchors a hash of nothing, which is a different and false claim. An
  absent output is reported as an error; a deliberately empty one is passed
  through.
- **`attestation` is passed through unmodified.** The executor digests exactly
  what is returned, and a verifier compares against what the provider sent.
  Re-encoding it breaks `attestationRef`.

Outputs are canonicalised before the response is built, so an output the frozen
canonicaliser would reject fails at the agent — where something still knows
what produced it — rather than at anchoring time.

Validate your agent with the conformance suite:

```
npx @0gflow/conform http://localhost:8000/agents/summarize
```

## Receipts

```python
from zgflow import Receipt, StepStatus, fold_chain_root, hash_receipt
```

`encode_receipt` reproduces Solidity's `abi.encode(Receipt)`: eleven static
32-byte words, no offset prefix. `fold_chain_root` folds over ascending
`step_index`, never completion order, so a run with parallel branches produces
one root regardless of which branch lands first.

`agent_id` is a `uint256` ERC-721 token id, **not** an address. Both agent
registries on 0G Galileo identify agents by token id, and nothing constrains
one to 20 bytes.

The expected hashes in `tests/test_receipt.py` came from the TypeScript core,
which the Foundry suite checks against Solidity — so they are a three-way
agreement, not a restatement of this implementation.

## Development

```
pip install -e ".[dev]"
pytest
```
