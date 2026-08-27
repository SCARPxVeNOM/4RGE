"""ECMAScript number serialisation.

Every expected value here was taken from Node's ``String(n)``, not from
reasoning about the spec. The three cases marked as traps are the ones where
Python's own ``repr`` disagrees, and they are the reason this module exists
rather than a call to ``repr``.
"""

from __future__ import annotations

import pytest

from zgflow import (
    NumberError,
    canonicalize,
    find_lossy_integers,
    format_number,
    is_lossless_integer,
)


class TestTheThreeTraps:
    def test_large_integers_are_written_out_in_full(self) -> None:
        # repr gives '1e+20'. JavaScript writes integers in full below 1e21,
        # so a workflow carrying a large id would hash differently in the two
        # languages with nothing in the output to suggest why.
        assert format_number(1e20) == "100000000000000000000"
        assert repr(1e20) == "1e+20"

    def test_exponents_carry_no_leading_zero(self) -> None:
        # repr gives '1e-07'.
        assert format_number(1e-7) == "1e-7"
        assert repr(1e-7) == "1e-07"

    def test_negative_zero_is_written_as_zero(self) -> None:
        # repr gives '-0.0'. RFC 8785 and ECMAScript both say "0".
        assert format_number(-0.0) == "0"
        assert format_number(0.0) == "0"
        assert format_number(0) == "0"


class TestAgainstNode:
    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            (333333333.3333333, "333333333.3333333"),
            (1e30, "1e+30"),
            (4.5, "4.5"),
            (0.002, "0.002"),
            (1e-27, "1e-27"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (1e-7, "1e-7"),
            (0.000001, "0.000001"),
            (1, "1"),
            (-1.5, "-1.5"),
            (5e-324, "5e-324"),
            (1.7976931348623157e308, "1.7976931348623157e+308"),
            (9007199254740992, "9007199254740992"),
            (-0.0, "0"),
            (0, "0"),
        ],
    )
    def test_matches_javascript_string_conversion(self, value: float, expected: str) -> None:
        assert format_number(value) == expected


class TestBoundaries:
    def test_the_positional_to_exponential_boundary_at_1e21(self) -> None:
        # The exact point where JavaScript switches notation.
        assert format_number(1e20) == "100000000000000000000"
        assert format_number(1e21) == "1e+21"

    def test_the_small_boundary_at_1e_minus_7(self) -> None:
        assert format_number(1e-6) == "0.000001"
        assert format_number(1e-7) == "1e-7"

    def test_trailing_zeros_are_not_emitted(self) -> None:
        assert format_number(100.0) == "100"
        assert format_number(1.10) == "1.1"

    def test_integers_and_their_float_forms_agree(self) -> None:
        # 1 and 1.0 must hash identically: JSON has one number type, and a
        # workflow that computed a whole number as a float must not produce a
        # different receipt from one that computed it as an int.
        for value in (0, 1, 42, -7, 10**15):
            assert format_number(value) == format_number(float(value))


class TestRejections:
    def test_nan_and_infinity_have_no_json_form(self) -> None:
        # JSON.stringify emits null for these, which would silently turn a
        # broken computation into a well-formed receipt.
        for value in (float("nan"), float("inf"), float("-inf")):
            with pytest.raises(NumberError, match="no JSON representation"):
                format_number(value)

    def test_a_boolean_is_not_a_number(self) -> None:
        # bool subclasses int; without this guard True would serialise as 1.
        with pytest.raises(NumberError, match="boolean"):
            format_number(True)

    def test_an_int_beyond_the_double_range_is_rejected(self) -> None:
        # JavaScript would hold Infinity here and rejects it, so rejecting
        # keeps the two implementations in agreement.
        with pytest.raises(NumberError, match="beyond the IEEE754 double range"):
            format_number(10**400)

    def test_exactness_is_not_a_magnitude_test(self) -> None:
        # 10**20 is far above 2**53 and still exact, because its factors of two
        # absorb the precision. A naive "abs(n) <= 2**53" guard rejects it, and
        # would have rejected a value that appears in the frozen vectors.
        assert format_number(10**20) == "100000000000000000000"
        assert format_number(2**53) == "9007199254740992"

    def test_an_exact_integer_may_still_print_with_fewer_digits(self) -> None:
        # 2**60 is exactly representable, and JavaScript still prints
        # 1152921504606847000 for it: a JSON number carries the *shortest*
        # decimal that round-trips, not the value's full decimal spelling.
        #
        # This looks like a precision bug and is not one. What matters is that
        # both languages do it identically, so a Python agent and a JavaScript
        # agent passing 2**60 produce the same hash. Verified against Node's
        # String(2**60).
        assert format_number(2**60) == "1152921504606847000"
        assert int(float(2**60)) == 2**60  # still exact, despite the printing


class TestLossyIntegers:
    """Python is the only one of the five implementations with unbounded ints.

    That makes it the only one that can notice precision loss -- and it must
    still not refuse, because a receipt anchored by the TypeScript executor
    holds the rounded double, and a verifier that would not reproduce that hash
    could not verify the run at all.
    """

    def test_a_lossy_integer_is_hashed_the_way_javascript_would(self) -> None:
        # Verified against Node: String(1840870599108701000).
        assert format_number(1840870599108701000) == "1840870599108701000"
        assert format_number(2**53 + 1) == "9007199254740992"

    def test_an_int_and_the_double_it_becomes_agree(self) -> None:
        # The property that makes cross-language verification work: however the
        # value was spelled, both sides hash the same double.
        value = 1840870599108701000
        assert format_number(value) == format_number(float(value))

    def test_the_loss_is_reportable_even_though_it_is_not_refused(self) -> None:
        assert is_lossless_integer(10**20) is True
        assert is_lossless_integer(2**53) is True
        assert is_lossless_integer(2**53 + 1) is False
        assert is_lossless_integer(10**400) is False

    def test_find_lossy_integers_names_the_paths(self) -> None:
        value = {"safe": 10**20, "id": 2**53 + 1, "nested": [1, {"big": 2**53 + 3}]}
        assert sorted(find_lossy_integers(value)) == ["$.id", "$.nested[1].big"]

    def test_find_lossy_integers_is_quiet_on_ordinary_data(self) -> None:
        assert find_lossy_integers({"a": 1, "b": [1.5, True, None, "x"]}) == []

    def test_a_boolean_is_not_reported_as_a_lossy_integer(self) -> None:
        # bool subclasses int, so a naive walk reports True.
        assert find_lossy_integers({"flag": True}) == []


class TestThroughCanonicalize:
    def test_rejections_surface_as_canonicalisation_errors_with_a_path(self) -> None:
        from zgflow import CanonicalizationError

        with pytest.raises(CanonicalizationError, match=r"\$\.a"):
            canonicalize({"a": float("nan")})

    def test_numbers_inside_structures_use_the_same_formatting(self) -> None:
        assert canonicalize({"n": 1e20}) == '{"n":100000000000000000000}'
        assert canonicalize([1e-7, -0.0]) == "[1e-7,0]"
