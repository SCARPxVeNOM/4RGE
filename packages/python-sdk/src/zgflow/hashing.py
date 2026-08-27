"""Hashing primitives — spec sections 4.1 and 5.2.

Two different hash functions are load-bearing and must not be confused:

    sha256     payload hashes (inputHash, outputHash), over canonical JSON
    keccak256  chain-level hashes (flowId, receipt hashes, chain root)

sha256 comes from ``hashlib``. keccak256 cannot: ``hashlib.sha3_256`` is
FIPS-202 SHA3-256, a *different* function that pads with 0x06 where original
Keccak pads with 0x01. It produces well-formed 32-byte digests that never match
anything on chain, and because both are "sha3" in casual speech, the mistake
survives review easily. That is the entire reason this file contains a Keccak
implementation.
"""

from __future__ import annotations

import hashlib

from .canonical import canonical_bytes

__all__ = ["keccak256", "sha256", "hash_json", "to_hex", "from_hex"]

_MASK64 = (1 << 64) - 1

_ROUND_CONSTANTS = (
    0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
    0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
    0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
    0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
    0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
    0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
)

# Rho rotation offsets, flattened as index = x + 5*y.
_ROTATIONS = (
    0, 1, 62, 28, 27,
    36, 44, 6, 55, 20,
    3, 10, 43, 25, 39,
    41, 45, 15, 21, 8,
    18, 2, 61, 56, 14,
)

_RATE_BYTES = 136  # (1600 - 2*256) / 8, for keccak256


def _rotl64(value: int, amount: int) -> int:
    return ((value << amount) | (value >> (64 - amount))) & _MASK64


def _keccak_f1600(state: list[int]) -> None:
    for round_constant in _ROUND_CONSTANTS:
        # theta
        c = [state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20]
             for x in range(5)]
        for x in range(5):
            d = c[(x + 4) % 5] ^ _rotl64(c[(x + 1) % 5], 1)
            for y in range(5):
                state[x + 5 * y] ^= d

        # rho + pi
        b = [0] * 25
        for x in range(5):
            for y in range(5):
                b[y + 5 * ((2 * x + 3 * y) % 5)] = _rotl64(state[x + 5 * y], _ROTATIONS[x + 5 * y])

        # chi
        for x in range(5):
            for y in range(5):
                state[x + 5 * y] = b[x + 5 * y] ^ (~b[((x + 1) % 5) + 5 * y] & _MASK64) & b[
                    ((x + 2) % 5) + 5 * y
                ]

        # iota
        state[0] ^= round_constant


def keccak256(data: bytes | str) -> str:
    """Original Keccak-256 with 0x01 domain padding.

    Do not "modernise" the padding byte to 0x06. That turns this into SHA3-256
    and breaks every comparison against the chain.
    """
    message = from_hex(data) if isinstance(data, str) else bytes(data)

    padded = bytearray(message)
    padded.append(0x01)
    while len(padded) % _RATE_BYTES != 0:
        padded.append(0x00)
    padded[-1] |= 0x80

    state = [0] * 25
    for offset in range(0, len(padded), _RATE_BYTES):
        for lane in range(_RATE_BYTES // 8):
            start = offset + lane * 8
            state[lane] ^= int.from_bytes(padded[start:start + 8], "little")
        _keccak_f1600(state)

    digest = b"".join(state[lane].to_bytes(8, "little") for lane in range(4))
    return to_hex(digest)


def sha256(data: bytes | str) -> str:
    message = from_hex(data) if isinstance(data, str) else bytes(data)
    return to_hex(hashlib.sha256(message).digest())


def hash_json(value: object) -> str:
    """inputHash / outputHash: sha256 over the RFC 8785 canonical form.

    Always hash through this rather than over a JSON string produced elsewhere,
    so the preimage is the canonical bytes and not whatever ``json.dumps``
    happened to emit.
    """
    return sha256(canonical_bytes(value))


def to_hex(data: bytes) -> str:
    """0x-prefixed lowercase hex, matching what the contracts and core emit."""
    return "0x" + data.hex()


def from_hex(value: str) -> bytes:
    body = value[2:] if value[:2] in ("0x", "0X") else value
    if len(body) % 2 != 0:
        raise ValueError(f"hex string has odd length: {value}")
    try:
        return bytes.fromhex(body)
    except ValueError as error:
        raise ValueError(f"not a hex string: {value}") from error
