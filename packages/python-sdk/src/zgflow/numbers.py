"""ECMAScript number serialisation — spec section 5.2.

RFC 8785 defers number formatting to ECMAScript's ``Number::toString``. That
sounds like an implementation detail and is not: it is the part of
canonicalisation a Python port is most likely to get subtly wrong, because
Python's ``repr`` is *also* a shortest round-trip representation and therefore
looks correct until it isn't.

The three divergences, all of which produce a valid-looking hash that no
verifier will ever reproduce:

    value      ECMAScript                 Python repr
    1e20       100000000000000000000      1e+20
    1e-7       1e-7                       1e-07
    -0.0       0                          -0.0

The first is the dangerous one. Integers up to 1e21 are written out in full by
JavaScript, and a workflow passing a large integer id would hash differently in
the two languages with nothing in the output to suggest why.

This module implements ECMA-262 section 6.1.6.1.20 directly, using Python's
shortest-repr only as the source of digits.
"""

from __future__ import annotations

import math
from decimal import Decimal

__all__ = ["format_number", "is_lossless_integer", "NumberError"]

class NumberError(ValueError):
    """A number that has no canonical JSON form."""


def is_lossless_integer(value: int) -> bool:
    """Whether an int survives the round-trip through an IEEE754 double.

    Not a magnitude test. 10**20 is far above 2**53 and is still exact, because
    its factors of two absorb the precision; 2**53 + 1 is barely above and is
    not.

    Canonicalisation does **not** reject the lossy ones -- see ``format_number``
    for why -- so this is exposed for producers who want to check their own
    values before hashing them. ``zgflow.canonical.find_lossy_integers`` walks a
    whole structure with it.
    """
    try:
        return int(float(value)) == value
    except OverflowError:
        return False


def _digits_and_exponent(value: float) -> tuple[str, int]:
    """Returns ``(s, n)`` where the value equals ``0.s * 10**n``.

    ``s`` carries no trailing zeros, matching the ECMA-262 requirement that the
    chosen digit string not be divisible by 10.
    """
    # repr() gives the shortest string that round-trips, which is exactly the
    # digit set ECMA-262 asks for. Decimal is used only to take it apart
    # without float arithmetic reintroducing error.
    decimal = Decimal(repr(value))
    _sign, digits, exponent = decimal.as_tuple()
    assert isinstance(exponent, int)  # never 'n'/'N'/'F' here: value is finite

    s = "".join(str(d) for d in digits)

    stripped = s.rstrip("0")
    if stripped == "":
        # The value is zero; ECMA-262 handles that before reaching here.
        return "0", 1
    exponent += len(s) - len(stripped)
    s = stripped

    return s, exponent + len(s)


def format_number(value: float | int) -> str:
    """Formats a number exactly as ``JSON.stringify`` would."""
    if isinstance(value, bool):
        # bool is a subclass of int in Python, so this must be caught before
        # any numeric handling. A bare True here would serialise as "1".
        raise NumberError("a boolean is not a number")

    if isinstance(value, int):
        # A JSON number *is* an IEEE754 double under RFC 8785, so a Python int
        # is converted rather than rejected -- even when the conversion loses
        # precision.
        #
        # Rejecting the lossy ones was the first thing tried here, and it was
        # wrong. JavaScript has no integer type: a receipt anchored by the
        # TypeScript executor carrying 1840870599108701000 holds the *double*,
        # and a Python verifier that refused to hash it could not verify that
        # run at all. Refusing to reproduce a hash is a worse failure than
        # reproducing one whose rounding is inherent to JSON, and it is the
        # exact failure mode section 5.2 exists to prevent. The cross-language
        # property test in packages/core caught this.
        #
        # Producers who want to know before it matters can call
        # is_lossless_integer or find_lossy_integers.
        try:
            value = float(value)
        except OverflowError as error:
            # Beyond the double range. JavaScript would hold Infinity here, and
            # rejects it, so rejecting keeps the two in agreement.
            raise NumberError(
                f"integer {value} is beyond the IEEE754 double range and has no "
                f"JSON representation"
            ) from error

    if math.isnan(value) or math.isinf(value):
        # RFC 8785 has no representation for these, and JSON.stringify emits
        # null — which would silently turn a broken computation into a
        # well-formed receipt.
        raise NumberError(f"{value} has no JSON representation")

    if value == 0:
        # Covers -0.0, which ECMAScript writes as "0". Python's repr does not.
        return "0"

    sign = "-" if value < 0 else ""
    s, n = _digits_and_exponent(abs(value))
    k = len(s)

    # ECMA-262 section 6.1.6.1.20, steps 6 through 10.
    if k <= n <= 21:
        return sign + s + "0" * (n - k)
    if 0 < n <= 21:
        return sign + s[:n] + "." + s[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + s
    # Exponential form. Note the exponent carries no leading zero: ECMAScript
    # writes 1e-7, Python's repr writes 1e-07.
    exponent = n - 1
    exponent_sign = "+" if exponent >= 0 else "-"
    mantissa = s if k == 1 else s[0] + "." + s[1:]
    return f"{sign}{mantissa}e{exponent_sign}{abs(exponent)}"
