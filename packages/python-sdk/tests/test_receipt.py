"""Receipt encoding and chain root folding.

Every expected hash here was produced by the TypeScript ``@0gflow/core``, which
is itself checked against Solidity's ``abi.encode`` by the Foundry suite. So
this is a three-way agreement -- Python, TypeScript, Solidity -- and a value
restated from this implementation would prove none of it.
"""

from __future__ import annotations

import pytest

from zgflow import (
    ZERO_BYTES32,
    ChainRootError,
    Receipt,
    ReceiptError,
    StepStatus,
    chain_root_progression,
    encode_receipt,
    fold_chain_root,
    hash_receipt,
)

BASE = Receipt(
    flow_id="0x" + "11" * 32,
    run_id="0x" + "22" * 32,
    step_index=0,
    agent_id=42,
    input_hash="0x" + "33" * 32,
    output_hash="0x" + "44" * 32,
    trace_root="0x" + "55" * 32,
    attestation_ref=ZERO_BYTES32,
    started_at=1755600000,
    ended_at=1755600100,
    status=StepStatus.OK,
)

# A large agent_id, because identity is an ERC-721 token id and nothing
# constrains one to 20 bytes. An implementation that assumed an address would
# encode this wrongly.
SECOND = Receipt(**{**BASE.__dict__, "step_index": 1, "agent_id": 1 << 200,
                    "status": StepStatus.UNATTESTED})
THIRD = Receipt(**{**BASE.__dict__, "step_index": 2, "status": StepStatus.FAILED,
                   "output_hash": ZERO_BYTES32})

HASH_0 = "0xd0bcd2743906ece982787c44431c3b44d5a2d9ce5c338768b00dc8561eea6d8f"
HASH_1 = "0xdd9d2120cfc673e686e84d24572f77dbcd876c6049e46a81d166ba665f51cafb"
HASH_2 = "0xfc83e234dcf05e1d11b59da30d247b9c0a1001ff33bc56576a4b9878f1d67059"
FOLD_2 = "0xce77918e1bd7265f6d396623c38b46dd071dd5aa09bb82a6a9390214ee90636e"
FOLD_3 = "0xa0e421e5be059706cae13c56931b732a5a2a786a09b67249746f7608f4f0c75d"


class TestEncoding:
    def test_is_eleven_static_words(self) -> None:
        # Every field is a static type, so there is no offset prefix and no
        # length word: 11 * 32 bytes exactly. A dynamic encoder would produce
        # something longer that still looked plausible.
        encoded = encode_receipt(BASE)
        assert len(encoded) == 2 + 11 * 64

    def test_matches_the_typescript_core(self) -> None:
        assert hash_receipt(BASE) == HASH_0

    def test_a_large_agent_id_encodes_as_uint256(self) -> None:
        assert hash_receipt(SECOND) == HASH_1

    def test_the_maximum_agent_id_is_accepted(self) -> None:
        # The full uint256 range is valid, so the boundary must not be rejected.
        encoded = encode_receipt(Receipt(**{**BASE.__dict__, "agent_id": 2**256 - 1}))
        # Word 4 of 11 (zero-based index 3) is agentId.
        assert encoded[2:][3 * 64 : 4 * 64] == "f" * 64

    def test_every_field_is_covered_by_the_hash(self) -> None:
        # A field the encoder silently drops is a field the chain root does not
        # protect, so each one must move the hash on its own.
        changes = {
            "flow_id": "0x" + "aa" * 32,
            "run_id": "0x" + "bb" * 32,
            "step_index": 7,
            "agent_id": 43,
            "input_hash": "0x" + "cc" * 32,
            "output_hash": "0x" + "dd" * 32,
            "trace_root": "0x" + "ee" * 32,
            "attestation_ref": "0x" + "ff" * 32,
            "started_at": 1755600001,
            "ended_at": 1755600101,
            "status": StepStatus.FAILED,
        }
        assert set(changes) == set(BASE.__dict__), "a field was added without a test"

        seen = {hash_receipt(BASE)}
        for field, value in changes.items():
            digest = hash_receipt(Receipt(**{**BASE.__dict__, field: value}))
            assert digest not in seen, f"changing {field} did not change the hash"
            seen.add(digest)


class TestEncodingRejections:
    @pytest.mark.parametrize(
        ("field", "value", "match"),
        [
            ("flow_id", "0x1234", "expected 32 bytes"),
            ("run_id", "0xnothex" + "0" * 58, "not a hex string"),
            ("run_id", "0x" + "1" * 63, "odd length"),
            ("input_hash", "0x" + "11" * 31, "expected 32 bytes"),
            ("step_index", -1, "negative"),
            ("step_index", 2**32, "exceeds uint32"),
            ("agent_id", 2**256, "exceeds uint256"),
            ("agent_id", -5, "negative"),
            ("started_at", 2**64, "exceeds uint64"),
            ("status", 9, "unknown value"),
        ],
    )
    def test_out_of_range_fields_are_rejected(self, field: str, value: object, match: str) -> None:
        with pytest.raises(ReceiptError, match=match):
            encode_receipt(Receipt(**{**BASE.__dict__, field: value}))

    def test_a_boolean_is_not_an_index(self) -> None:
        # bool subclasses int, so True would otherwise encode as step 1.
        with pytest.raises(ReceiptError, match="boolean"):
            encode_receipt(Receipt(**{**BASE.__dict__, "step_index": True}))

    def test_the_error_names_the_field(self) -> None:
        with pytest.raises(ReceiptError, match="trace_root"):
            encode_receipt(Receipt(**{**BASE.__dict__, "trace_root": "0xff"}))


class TestChainRoot:
    def test_a_single_receipt_folds_to_its_own_hash(self) -> None:
        assert fold_chain_root([BASE]) == HASH_0

    def test_matches_the_typescript_core(self) -> None:
        assert fold_chain_root([BASE, SECOND]) == FOLD_2
        assert fold_chain_root([BASE, SECOND, THIRD]) == FOLD_3

    def test_the_fold_is_over_step_index_not_arrival_order(self) -> None:
        # A run with parallel branches must produce one root regardless of
        # which branch lands first.
        assert fold_chain_root([THIRD, BASE, SECOND]) == FOLD_3
        assert fold_chain_root([SECOND, THIRD, BASE]) == FOLD_3

    def test_the_fold_is_not_commutative_in_content(self) -> None:
        # Reordering arrival must not change the root; reordering the step
        # *contents* must.
        swapped_a = Receipt(**{**BASE.__dict__, "step_index": 1})
        swapped_b = Receipt(**{**SECOND.__dict__, "step_index": 0})
        assert fold_chain_root([swapped_a, swapped_b]) != FOLD_2

    def test_the_progression_ends_at_the_fold(self) -> None:
        progression = chain_root_progression([BASE, SECOND, THIRD])
        assert progression == [HASH_0, FOLD_2, FOLD_3]
        assert progression[-1] == fold_chain_root([BASE, SECOND, THIRD])

    def test_a_zero_output_hash_still_folds(self) -> None:
        # A failed step commits outputHash = 0 as a claim of absence. It is a
        # real receipt and must be inside the root, not skipped.
        assert hash_receipt(THIRD) == HASH_2
        assert HASH_2 != hash_receipt(BASE)


class TestChainRootRejections:
    def test_an_empty_set_cannot_be_folded(self) -> None:
        with pytest.raises(ChainRootError, match="zero receipts"):
            fold_chain_root([])

    def test_a_missing_index_is_rejected(self) -> None:
        # Otherwise an executor could drop a step it would rather not disclose
        # and still present a well-formed root.
        with pytest.raises(ChainRootError, match="missing receipt for step_index 1"):
            fold_chain_root([BASE, THIRD])

    def test_a_duplicate_index_is_rejected(self) -> None:
        with pytest.raises(ChainRootError, match="duplicate receipt for step_index 0"):
            fold_chain_root([BASE, Receipt(**BASE.__dict__)])

    def test_a_set_not_starting_at_zero_is_rejected(self) -> None:
        with pytest.raises(ChainRootError, match="missing receipt for step_index 0"):
            fold_chain_root([SECOND, THIRD])


class TestStepStatus:
    def test_the_numbering_is_the_on_chain_numbering(self) -> None:
        # These values are written into receipts and read by the contracts;
        # renumbering them would silently reinterpret every anchored step.
        assert (StepStatus.OK, StepStatus.FAILED, StepStatus.SKIPPED, StepStatus.UNATTESTED) == (
            0,
            1,
            2,
            3,
        )

    def test_unattested_is_distinct_from_ok(self) -> None:
        # Spec 1.3: a step that required an attestation and did not get one is
        # never OK. Nothing may map it to success.
        assert StepStatus.UNATTESTED != StepStatus.OK
