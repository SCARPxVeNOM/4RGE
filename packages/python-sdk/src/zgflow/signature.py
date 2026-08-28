"""Agent output signatures — proving which agent produced a step's output.

This is the Python half of ``packages/core/src/agent-signature.ts``. The two
must agree byte for byte, because four implementations check this digest: the
SDK that signs, the executor that records, the verifier that checks, and
``FlowEscrowV2`` that pays. ``tests/test_signature.py`` pins the same vector
the TypeScript test pins, which is the only thing standing between "they
agree" and "they appear to agree".

WHY THE DIGEST HAS THESE FIELDS

Each one closes a replay:

  DOMAIN      a signature for something else in this system is not one of
              these, and vice versa
  chain_id    a testnet signature cannot be replayed on mainnet
  receipts    nor against a different receipts contract on the same chain
  run_id      nor lifted into another run
  step_index  nor moved to another step of the same run
  agent_id    nor re-attributed to a different agent
  input_hash  nor presented as the answer to a different question
  output_hash and it commits to the output itself, which is the point

WHAT THIS MODULE DOES NOT DO

Sign. ``sign_output`` takes a callable and hands it the digest, exactly as the
TypeScript SDK does. That keeps the promise in ``pyproject.toml`` — no runtime
dependencies — and means the SDK never handles a private key. Use ``eth_account``
or whatever the agent already has:

    from eth_account import Account
    from eth_account.messages import encode_defunct

    def sign(digest: str) -> str:
        return Account.sign_message(
            encode_defunct(hexstr=digest), private_key=key
        ).signature.hex()

Note ``encode_defunct``: the callable receives the 32-byte **digest**, and the
signer applies the EIP-191 prefix. Handing over the already-prefixed message
hash would prefix it twice and produce a signature that verifies nowhere.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

from .hashing import from_hex, hash_json, keccak256

#: keccak256('0gflow-agent-output-v1'), fixed at the first deployment.
AGENT_OUTPUT_DOMAIN = keccak256(b"0gflow-agent-output-v1")


class SignatureError(ValueError):
    """A claim that cannot be encoded, so must not be hashed."""


@dataclass(frozen=True)
class AgentOutputClaim:
    """What an agent asserts by signing."""

    #: EVM chain the receipt is anchored on.
    chain_id: int
    #: The ExecutionReceipts contract the receipt is anchored in.
    receipts: str
    run_id: str
    step_index: int
    #: ERC-721 token id of the agent claiming the work.
    agent_id: int
    #: sha256 of the canonical input — the receipt's inputHash.
    input_hash: str
    #: sha256 of the canonical output — the receipt's outputHash.
    output_hash: str


def _word(value: int, field: str) -> str:
    if value < 0:
        raise SignatureError(f"{field}: negative value {value}")
    if value >= 1 << 256:
        raise SignatureError(f"{field}: exceeds uint256")
    return f"{value:064x}"


def _fixed(value: str, width: int, field: str) -> str:
    body = value[2:] if value[:2].lower() == "0x" else value
    body = body.lower()
    try:
        int(body or "0", 16)
    except ValueError as exc:
        raise SignatureError(f"{field}: not hex: {value}") from exc
    if len(body) != width * 2:
        raise SignatureError(f"{field}: expected {width} bytes, got {len(body) // 2}")
    # Left-padded into a 32-byte word, which is how Solidity's abi.encode lays
    # out an address as well as a bytes32.
    return body.rjust(64, "0")


def agent_output_digest(claim: AgentOutputClaim) -> str:
    """The digest an agent signs.

    Matches Solidity's ``keccak256(abi.encode(DOMAIN, chainid, receipts,
    runId, stepIndex, agentId, inputHash, outputHash))``. Every member is
    static, so ``abi.encode`` is just the eight words concatenated — no offset
    prefix, no length words.
    """
    encoded = (
        _fixed(AGENT_OUTPUT_DOMAIN, 32, "domain")
        + _word(claim.chain_id, "chain_id")
        + _fixed(claim.receipts, 20, "receipts")
        + _fixed(claim.run_id, 32, "run_id")
        + _word(claim.step_index, "step_index")
        + _word(claim.agent_id, "agent_id")
        + _fixed(claim.input_hash, 32, "input_hash")
        + _fixed(claim.output_hash, 32, "output_hash")
    )
    return keccak256(from_hex(encoded))


def agent_output_message_hash(claim: AgentOutputClaim) -> str:
    """The EIP-191 message hash actually signed.

    ``"\\x19Ethereum Signed Message:\\n32" || digest``, byte-identical to
    Solidity's ``toEthSignedMessageHash`` and to viem's ``hashMessage({raw})``.
    Provided for checking, not for signing: a signer applies this prefix
    itself, so pass ``agent_output_digest`` to the callable instead.
    """
    digest = from_hex(agent_output_digest(claim))
    return keccak256(b"\x19Ethereum Signed Message:\n32" + digest)


def sign_output(
    request: Any,
    agent_id: str,
    output: Any,
    sign: Callable[[str], str],
) -> tuple[str, str]:
    """Signs an output so the escrow will pay for it.

    ``request`` is the :class:`~zgflow.agent.InvokeRequest` the executor sent;
    it must carry ``chain_id`` and ``receipts``. Returns ``(signature,
    digest)``.

    The hashes are computed here rather than taken from the caller because they
    must match what the executor anchors and what ``FlowEscrowV2`` recomputes.
    An agent that hashed its own output slightly differently would produce a
    signature that verifies nowhere, and would find out at payment time.
    """
    chain_id = getattr(request, "chain_id", None)
    receipts = getattr(request, "receipts", None)
    if chain_id is None or receipts is None:
        # Signing against an unspecified chain would produce a signature valid
        # everywhere, which is the replay this digest exists to prevent.
        raise SignatureError(
            "the executor did not supply chain_id and receipts, "
            "so this output cannot be bound to an anchoring"
        )

    claim = AgentOutputClaim(
        chain_id=int(chain_id),
        receipts=str(receipts),
        run_id=str(request.run_id),
        step_index=int(request.step_index),
        agent_id=int(agent_id),
        input_hash=hash_json(request.input),
        output_hash=hash_json(output),
    )

    digest = agent_output_digest(claim)
    return sign(digest), digest
