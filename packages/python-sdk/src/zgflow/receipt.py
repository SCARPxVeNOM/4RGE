"""Receipt encoding and chain root folding — spec sections 4.1 and 1.1.

The encoding must reproduce Solidity's ``abi.encode(Receipt)`` exactly. Every
field of the struct is a static type, so the result is simply the eleven
members padded to 32 bytes and concatenated -- no dynamic offset prefix, no
length words. Any field an encoder silently drops or reorders is a field the
chain root does not protect.

The fold is over ascending ``step_index``, never over completion order, so a
run with parallel branches produces the same root regardless of which branch
lands first. It is deliberately not commutative: reordering the *contents* of
two steps must change the root even though reordering their arrival must not.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import IntEnum
from typing import Iterable, Sequence

from .hashing import from_hex, keccak256

__all__ = [
    "StepStatus",
    "Receipt",
    "ZERO_BYTES32",
    "encode_receipt",
    "hash_receipt",
    "fold_chain_root",
    "chain_root_progression",
    "ChainRootError",
    "ReceiptError",
]

ZERO_BYTES32 = "0x" + "00" * 32


class StepStatus(IntEnum):
    OK = 0
    FAILED = 1
    SKIPPED = 2
    #: A step that required an attestation and did not get one (spec 1.3). It
    #: is never OK, and nothing may map it to success.
    UNATTESTED = 3


class ReceiptError(ValueError):
    """A receipt that cannot be encoded."""


class ChainRootError(ValueError):
    """A receipt set that cannot be folded."""


@dataclass(frozen=True)
class Receipt:
    """One anchored step. Field order is the ABI encoding order."""

    #: keccak256 of the canonical workflow spec.
    flow_id: str
    run_id: str
    step_index: int
    #: Agent identity as an ERC-721 token id -- NOT an address. Both agent
    #: registries on 0G Galileo identify agents by token id, and nothing
    #: constrains a token id to 20 bytes, so narrowing this to an address would
    #: collide distinct agents. See docs/agent-identity.md.
    agent_id: int
    #: sha256 of canonical JSON input.
    input_hash: str
    #: sha256 of canonical JSON output.
    output_hash: str
    #: 0G Storage Merkle root of the execution trace.
    trace_root: str
    #: TEE attestation digest; zero when absent.
    attestation_ref: str
    started_at: int
    ended_at: int
    status: StepStatus


def _encode_fixed_bytes(value: str, width: int, field: str) -> str:
    try:
        raw = from_hex(value)
    except ValueError as error:
        raise ReceiptError(f"{field}: {error}") from error
    if len(raw) != width:
        raise ReceiptError(f"{field}: expected {width} bytes, got {len(raw)}")
    # Left-pad into a 32-byte word. For bytes32 this is a no-op; for a narrower
    # type it places the bytes in the low-order end, as Solidity does.
    return raw.hex().rjust(64, "0")


def _encode_uint(value: int, bits: int, field: str) -> str:
    if isinstance(value, bool):
        raise ReceiptError(f"{field}: expected an integer, got a boolean")
    if not isinstance(value, int):
        raise ReceiptError(f"{field}: expected an integer, got {type(value).__name__}")
    if value < 0:
        raise ReceiptError(f"{field}: negative value: {value}")
    if value >= 1 << bits:
        raise ReceiptError(f"{field}: exceeds uint{bits}: {value}")
    return format(value, "x").rjust(64, "0")


def encode_receipt(receipt: Receipt) -> str:
    """Solidity ``abi.encode(receipt)``, as 0x-prefixed hex."""
    try:
        status = StepStatus(receipt.status)
    except ValueError as error:
        raise ReceiptError(f"status: unknown value {receipt.status}") from error

    words = [
        _encode_fixed_bytes(receipt.flow_id, 32, "flow_id"),
        _encode_fixed_bytes(receipt.run_id, 32, "run_id"),
        _encode_uint(receipt.step_index, 32, "step_index"),
        _encode_uint(receipt.agent_id, 256, "agent_id"),
        _encode_fixed_bytes(receipt.input_hash, 32, "input_hash"),
        _encode_fixed_bytes(receipt.output_hash, 32, "output_hash"),
        _encode_fixed_bytes(receipt.trace_root, 32, "trace_root"),
        _encode_fixed_bytes(receipt.attestation_ref, 32, "attestation_ref"),
        _encode_uint(receipt.started_at, 64, "started_at"),
        _encode_uint(receipt.ended_at, 64, "ended_at"),
        _encode_uint(int(status), 8, "status"),
    ]
    return "0x" + "".join(words)


def hash_receipt(receipt: Receipt) -> str:
    """``keccak256(abi.encode(receipt))`` -- the leaf folded into the chain root."""
    return keccak256(encode_receipt(receipt))


def _ordered(receipts: Iterable[Receipt]) -> list[Receipt]:
    items = list(receipts)
    if not items:
        raise ChainRootError("cannot fold a chain root over zero receipts")

    seen: set[int] = set()
    for receipt in items:
        if receipt.step_index in seen:
            raise ChainRootError(f"duplicate receipt for step_index {receipt.step_index}")
        seen.add(receipt.step_index)

    # A missing index would let an executor drop a step it would rather not
    # disclose and still present a well-formed root.
    for index in range(len(items)):
        if index not in seen:
            raise ChainRootError(
                f"missing receipt for step_index {index}: run has {len(items)} receipts "
                f"but indices are not contiguous from 0"
            )
    return sorted(items, key=lambda r: r.step_index)


def fold_chain_root(receipts: Sequence[Receipt]) -> str:
    """Folds a complete receipt set into the run's chain root."""
    ordered = _ordered(receipts)
    root = hash_receipt(ordered[0])
    for receipt in ordered[1:]:
        root = keccak256(from_hex(root) + from_hex(hash_receipt(receipt)))
    return root


def chain_root_progression(receipts: Sequence[Receipt]) -> list[str]:
    """The intermediate root after each step.

    The last element equals ``fold_chain_root(receipts)``. Useful for
    progressive verification, and for showing per-step state.
    """
    ordered = _ordered(receipts)
    roots = [hash_receipt(ordered[0])]
    for receipt in ordered[1:]:
        roots.append(keccak256(from_hex(roots[-1]) + from_hex(hash_receipt(receipt))))
    return roots
