"""Canonicalisation behaviour beyond the frozen vectors.

The vectors pin what the canonical form *is*. These pin what the module
refuses, which matters just as much: a value quietly coerced into some JSON
form is a value the hash no longer describes.
"""

from __future__ import annotations

import unicodedata
from datetime import datetime
from decimal import Decimal

import pytest

from zgflow import CanonicalizationError, canonical_bytes, canonicalize

CONTROLS = chr(0x00) + chr(0x0F) + chr(0x1F)
# Spelled with chr(92) so the expected text contains no escape sequence of
# its own: the point is that canonicalize EMITS a backslash-u escape, and a
# literal one here would be interpreted by Python before the comparison.
BS = chr(92)
EXPECTED_CONTROLS = '"' + BS + "u0000" + BS + "u000f" + BS + "u001f" + '"'


class TestOrdering:
    def test_sorts_by_utf16_code_unit_not_code_point(self) -> None:
        # The one line that decides whether this package can verify a run the
        # TypeScript executor produced.
        assert canonicalize({"￿": 1, "\U0001F600": 2}) == '{"\U0001F600":2,"￿":1}'

    def test_ascii_ordering_is_empty_digit_upper_lower(self) -> None:
        value = {"a": 1, "A": 2, "0": 3, "": 4}
        assert canonicalize(value) == '{"":4,"0":3,"A":2,"a":1}'

    def test_a_prefix_orders_before_its_extension(self) -> None:
        assert canonicalize({"ab": 1, "a": 2}) == '{"a":2,"ab":1}'

    def test_ordering_is_independent_of_insertion_order(self) -> None:
        forward = canonicalize({"a": 1, "b": 2, "c": 3})
        backward = canonicalize({"c": 3, "b": 2, "a": 1})
        assert forward == backward

    def test_ordering_recurses(self) -> None:
        assert canonicalize({"z": {"b": 1, "a": 2}}) == '{"z":{"a":2,"b":1}}'


class TestStrings:
    def test_short_escapes(self) -> None:
        assert canonicalize("\b\t\n\f\r\"\\") == r'"\b\t\n\f\r\"\\"'

    def test_remaining_c0_controls_use_lowercase_hex(self) -> None:
        # Lowercase is not cosmetic: an uppercase \\u000F is a different
        # preimage and therefore a different hash.
        assert canonicalize(CONTROLS) == EXPECTED_CONTROLS

    def test_solidus_and_non_ascii_stay_literal(self) -> None:
        # Escaping "/" is legal JSON and not canonical JSON.
        assert canonicalize("a/b") == '"a/b"'
        assert canonicalize("héllo 世界") == '"héllo 世界"'

    def test_del_is_not_escaped(self) -> None:
        # 0x7F is not a C0 control; only characters below 0x20 are escaped.
        assert canonicalize(chr(0x7F)) == '"' + chr(0x7F) + '"'

    def test_nfc_normalises_values_and_keys(self) -> None:
        decomposed = "é"
        assert unicodedata.normalize("NFC", decomposed) == "é"
        assert canonicalize({decomposed: decomposed}) == '{"é":"é"}'

    def test_a_lone_surrogate_is_rejected_with_a_useful_message(self) -> None:
        with pytest.raises(CanonicalizationError, match="unpaired surrogate"):
            canonicalize("\ud800")
        with pytest.raises(CanonicalizationError, match="unpaired surrogate"):
            canonicalize({"\udfff": 1})

    def test_a_valid_surrogate_pair_is_fine(self) -> None:
        assert canonicalize("\U0001F600") == '"\U0001F600"'


class TestKeys:
    def test_keys_colliding_after_nfc_are_rejected(self) -> None:
        # Both normalise to U+00E9. Dropping one silently would make the hash
        # depend on dict insertion order.
        with pytest.raises(CanonicalizationError, match="collide"):
            canonicalize({"é": 1, "é": 2})

    def test_non_string_keys_are_rejected(self) -> None:
        # Python allows these; JSON does not, and coercing them would let two
        # different objects canonicalise identically.
        for key in (1, None, (1, 2), 1.5):
            with pytest.raises(CanonicalizationError, match="not a string"):
                canonicalize({key: "v"})

    def test_a_boolean_key_is_rejected_rather_than_becoming_true(self) -> None:
        with pytest.raises(CanonicalizationError, match="not a string"):
            canonicalize({True: 1})

    def test_dunder_proto_is_an_ordinary_data_key(self) -> None:
        # Harmless in Python, load-bearing in the vectors because it is not
        # harmless in JavaScript. Both must agree it is just a key.
        assert canonicalize({"__proto__": {"x": 1}}) == '{"__proto__":{"x":1}}'


class TestTypes:
    def test_booleans_are_not_integers(self) -> None:
        # isinstance(True, int) is True in Python. A naive dispatch writes 1.
        assert canonicalize(True) == "true"
        assert canonicalize(False) == "false"
        assert canonicalize([True, 1]) == "[true,1]"

    def test_none_is_null(self) -> None:
        assert canonicalize(None) == "null"
        assert canonicalize({"a": None}) == '{"a":null}'

    def test_tuples_serialise_as_arrays(self) -> None:
        # Safe: a tuple has the same ordered semantics a JSON array does.
        assert canonicalize((1, 2)) == canonicalize([1, 2])

    @pytest.mark.parametrize(
        "value",
        [datetime(2026, 1, 1), Decimal("1.5"), {1, 2}, b"bytes", object()],
        ids=["datetime", "Decimal", "set", "bytes", "object"],
    )
    def test_types_with_no_obvious_json_form_are_rejected(self, value: object) -> None:
        # Choosing a convention here would make the hash depend on something
        # the other four implementations never agreed to.
        with pytest.raises(CanonicalizationError, match="no canonical JSON form"):
            canonicalize(value)

    def test_a_rejection_names_the_path(self) -> None:
        with pytest.raises(CanonicalizationError, match=r"\$\.a\[1\]\.b"):
            canonicalize({"a": [0, {"b": Decimal("1")}]})


class TestStructure:
    def test_empty_containers_differ(self) -> None:
        assert canonicalize({}) == "{}"
        assert canonicalize([]) == "[]"

    def test_no_insignificant_whitespace(self) -> None:
        assert canonicalize({"a": [1, 2], "b": {"c": 3}}) == '{"a":[1,2],"b":{"c":3}}'

    def test_a_cycle_is_reported_not_recursed(self) -> None:
        cyclic: dict = {"a": 1}
        cyclic["self"] = cyclic
        with pytest.raises(CanonicalizationError, match="cycle"):
            canonicalize(cyclic)

        loop: list = []
        loop.append(loop)
        with pytest.raises(CanonicalizationError, match="cycle"):
            canonicalize(loop)

    def test_repeating_a_value_is_not_a_cycle(self) -> None:
        # A shared subtree appearing twice is ordinary; only a value containing
        # itself is a cycle. Tracking by id without unwinding would reject this.
        shared = {"x": 1}
        assert canonicalize({"a": shared, "b": shared}) == '{"a":{"x":1},"b":{"x":1}}'

    def test_deep_nesting_survives(self) -> None:
        value: object = "leaf"
        for _ in range(200):
            value = {"n": value}
        assert canonicalize(value).count('"n"') == 200


class TestBytes:
    def test_canonical_bytes_is_utf8_of_the_canonical_form(self) -> None:
        value = {"k": "héllo"}
        assert canonical_bytes(value) == canonicalize(value).encode("utf-8")

    def test_non_ascii_is_not_escaped_in_the_byte_form(self) -> None:
        # json.dumps defaults to ensure_ascii=True, which would produce a
        # different preimage and therefore a different hash.
        assert "\\u" not in canonical_bytes({"k": "é"}).decode("utf-8")
