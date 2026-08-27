"""Hashing primitives.

The keccak256 tests matter more than they look. ``hashlib.sha3_256`` is a
different function with different padding that produces equally well-formed
32-byte digests, so a wrong implementation here fails nowhere except at
verification time, against the chain, with no local symptom at all.
"""

from __future__ import annotations

import hashlib

import pytest

from zgflow import from_hex, hash_json, keccak256, sha256, to_hex


class TestKeccak256:
    def test_the_empty_input_vector(self) -> None:
        # The single most widely published Keccak-256 test vector.
        assert keccak256(b"") == "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470"

    def test_known_vectors(self) -> None:
        assert keccak256(b"abc") == (
            "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45"
        )
        # The Ethereum function selector preimage for transfer(address,uint256)
        # begins 0xa9059cbb, which is independently checkable against any
        # deployed ERC-20.
        assert keccak256(b"transfer(address,uint256)").startswith("0xa9059cbb")

    def test_it_is_not_sha3_256(self) -> None:
        # The whole reason this implementation exists. SHA3-256 pads with 0x06
        # where original Keccak pads with 0x01.
        assert keccak256(b"") != to_hex(hashlib.sha3_256(b"").digest())

    @pytest.mark.parametrize(
        ("length", "expected"),
        [
            (135, "0x34367dc248bbd832f4e3e69dfaac2f92638bd0bbd18f2912ba4ef454919cf446"),
            (136, "0xa6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e"),
            (137, "0xd869f639c7046b4929fc92a4d988a8b22c55fbadb802c0c66ebcd484f1915f39"),
            (272, "0xcf7fcd4f705ee749930d19ca84561a9bf62516bd90a471545fa2f49fdc7e63c8"),
        ],
    )
    def test_it_agrees_with_core_across_the_rate_boundary(
        self, length: int, expected: str
    ) -> None:
        # The sponge absorbs 136 bytes at a time, and the padding logic differs
        # at exactly the rate and one byte either side. A single-block
        # implementation passes every short vector and fails only on a real
        # receipt. These digests were taken from the TypeScript core, so this
        # is a cross-implementation check, not a restatement of this one.
        assert keccak256(b"a" * length) == expected

    def test_it_accepts_hex_as_well_as_bytes(self) -> None:
        assert keccak256("0x616263") == keccak256(b"abc")

    def test_a_one_bit_change_changes_the_digest(self) -> None:
        assert keccak256(b"a") != keccak256(b"b")


class TestSha256:
    def test_matches_hashlib(self) -> None:
        for message in (b"", b"abc", b"x" * 1000):
            assert sha256(message) == to_hex(hashlib.sha256(message).digest())

    def test_the_empty_vector(self) -> None:
        assert sha256(b"") == (
            "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        )


class TestHashJson:
    def test_hashes_the_canonical_form_not_the_input_spelling(self) -> None:
        # Two objects differing only in key order have one canonical form and
        # must therefore have one hash.
        assert hash_json({"a": 1, "b": 2}) == hash_json({"b": 2, "a": 1})

    def test_distinguishes_an_empty_object_from_an_empty_array(self) -> None:
        # These mean different things, so they must not collide -- the
        # zero-as-absence rule elsewhere depends on it.
        assert hash_json({}) != hash_json([])

    def test_distinguishes_a_number_from_its_string(self) -> None:
        assert hash_json({"n": 1}) != hash_json({"n": "1"})

    def test_is_sha256_of_the_canonical_bytes(self) -> None:
        from zgflow import canonical_bytes

        value = {"b": [1, 2], "a": "x"}
        assert hash_json(value) == sha256(canonical_bytes(value))


class TestHex:
    def test_round_trips(self) -> None:
        for data in (b"", b"\x00", bytes(range(256))):
            assert from_hex(to_hex(data)) == data

    def test_output_is_lowercase_and_prefixed(self) -> None:
        # The contracts and core both emit this form; a mixed-case comparison
        # elsewhere would fail on otherwise identical values.
        assert to_hex(b"\xab\xcd") == "0xabcd"

    def test_accepts_upper_and_unprefixed_input(self) -> None:
        assert from_hex("0XABCD") == from_hex("abcd") == b"\xab\xcd"

    def test_rejects_malformed_hex(self) -> None:
        with pytest.raises(ValueError, match="odd length"):
            from_hex("0xabc")
        with pytest.raises(ValueError, match="not a hex string"):
            from_hex("0xzz")
