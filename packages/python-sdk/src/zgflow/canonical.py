"""RFC 8785 JSON Canonicalization Scheme — spec section 5.2.

This is a port, not a second design. The TypeScript ``@0gflow/core`` is the
reference; this file must agree with it byte for byte on every input, and
``packages/core/vectors/canonicalization.json`` is the contract both are held
to. Divergence between any two consumers produces runs that execute correctly
and then fail verification, with a symptom that points nowhere near the cause.

The traps a Python port walks into, in the order they bite:

1.  **Key ordering.** RFC 8785 section 3.2.3 sorts by UTF-16 code unit.
    Python's ``sorted()`` sorts by code point. These agree on the entire BMP
    and disagree above it: U+1F600 must sort BEFORE U+FFFF, because its lead
    surrogate 0xD83D is below 0xFFFF. Any workflow carrying an emoji key hashes
    differently in the two languages. See ``_utf16_key``.

2.  **Numbers.** See ``numbers.py``; the divergences are neither obvious nor
    rare.

3.  **bool is an int.** ``isinstance(True, int)`` is True in Python, so a
    naive type dispatch serialises ``True`` as ``1``.

4.  **Lone surrogates.** Python strings can hold them and ``str.encode`` raises
    a UnicodeEncodeError deep inside the call, so they are rejected up front
    with a message that says what is actually wrong.
"""

from __future__ import annotations

import unicodedata
from typing import Any

from .numbers import NumberError, format_number, is_lossless_integer

__all__ = [
    "canonicalize",
    "canonical_bytes",
    "find_lossy_integers",
    "CanonicalizationError",
]


class CanonicalizationError(ValueError):
    """A value that has no canonical form."""


# RFC 8785 section 3.2.2.2: these seven get short escapes, every other C0
# control gets \u00xx in lowercase hex, and everything else is literal --
# including the solidus and all non-ASCII.
_SHORT_ESCAPES = {
    0x08: "\\b",
    0x09: "\\t",
    0x0A: "\\n",
    0x0C: "\\f",
    0x0D: "\\r",
    0x22: '\\"',
    0x5C: "\\\\",
}


def _utf16_key(key: str) -> bytes:
    """Sort key placing a string in UTF-16 code unit order.

    Comparing UTF-16 big-endian bytes is exactly comparing code units, because
    big-endian byte order and code unit order coincide. This is the one line
    that decides whether a Python implementation can verify a run produced by
    the TypeScript one.
    """
    return key.encode("utf-16-be", errors="surrogatepass")


def _check_encodable(value: str, what: str) -> None:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as error:
        # A lone surrogate has no UTF-8 encoding, so it cannot be hashed and
        # must never reach a receipt.
        raise CanonicalizationError(
            f"{what} contains an unpaired surrogate and cannot be encoded as UTF-8: {value!r}"
        ) from error


def _serialise_string(value: str) -> str:
    _check_encodable(value, "string")
    out = ['"']
    for character in value:
        code = ord(character)
        escape = _SHORT_ESCAPES.get(code)
        if escape is not None:
            out.append(escape)
        elif code < 0x20:
            out.append(f"\\u{code:04x}")
        else:
            out.append(character)
    out.append('"')
    return "".join(out)


def _normalise(value: str) -> str:
    """RFC 8785 requires UTF-8 NFC, for keys and values alike."""
    return unicodedata.normalize("NFC", value)


def _serialise(value: Any, seen: set[int], path: str) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        # Before the int check, not after: bool subclasses int.
        return "true" if value else "false"
    if isinstance(value, str):
        return _serialise_string(_normalise(value))
    if isinstance(value, (int, float)):
        try:
            return format_number(value)
        except NumberError as error:
            raise CanonicalizationError(f"at {path}: {error}") from error

    if isinstance(value, (list, tuple)):
        if id(value) in seen:
            raise CanonicalizationError(f"at {path}: the value contains a cycle")
        seen.add(id(value))
        try:
            items = [
                _serialise(item, seen, f"{path}[{index}]") for index, item in enumerate(value)
            ]
        finally:
            seen.discard(id(value))
        return "[" + ",".join(items) + "]"

    if isinstance(value, dict):
        if id(value) in seen:
            raise CanonicalizationError(f"at {path}: the value contains a cycle")
        seen.add(id(value))
        try:
            return _serialise_object(value, seen, path)
        finally:
            seen.discard(id(value))

    # Anything else -- a datetime, a Decimal, a dataclass, a set -- has no
    # single obvious JSON form. Choosing one here would make the hash depend on
    # a convention the other four implementations never agreed to.
    raise CanonicalizationError(
        f"at {path}: {type(value).__name__} has no canonical JSON form; "
        f"convert it to a JSON primitive before hashing"
    )


def _serialise_object(value: dict[Any, Any], seen: set[int], path: str) -> str:
    normalised: dict[str, Any] = {}
    for key, item in value.items():
        if not isinstance(key, str):
            # Python allows int and tuple keys; JSON does not. Coercing them
            # would let two different objects canonicalise identically.
            raise CanonicalizationError(
                f"at {path}: object key {key!r} is {type(key).__name__}, not a string"
            )
        _check_encodable(key, "object key")
        normal = _normalise(key)
        if normal in normalised:
            # Two keys that differ only by Unicode composition become one key
            # after NFC. Silently dropping one would make the hash depend on
            # dict insertion order.
            raise CanonicalizationError(
                f"at {path}: keys {key!r} and another collide as {normal!r} after NFC normalisation"
            )
        normalised[normal] = item

    parts = [
        f"{_serialise_string(key)}:{_serialise(normalised[key], seen, f'{path}.{key}')}"
        for key in sorted(normalised, key=_utf16_key)
    ]
    return "{" + ",".join(parts) + "}"


def canonicalize(value: Any) -> str:
    """Returns the RFC 8785 canonical form of a JSON value."""
    return _serialise(value, set(), "$")


def canonical_bytes(value: Any) -> bytes:
    """The canonical form as UTF-8 bytes -- the preimage every hash is taken over."""
    return canonicalize(value).encode("utf-8")


def find_lossy_integers(value: Any, path: str = "$") -> list[str]:
    """Paths to ints that lose precision when hashed. Advisory, not a guard.

    Canonicalisation converts every number to an IEEE754 double, because that
    is what a JSON number is and because a verifier must be able to reproduce
    any hash a JavaScript executor produced. Python is the only one of the five
    implementations with an unbounded integer type, so it is the only one that
    can *notice* the loss -- which makes it worth reporting even though it is
    not worth refusing.

    Call this when building a step input, not when verifying one: by
    verification time the receipt already exists and the rounding is a fact.
    A large identifier should be carried as a string.
    """
    found: list[str] = []
    if isinstance(value, bool):
        return found
    if isinstance(value, int):
        if not is_lossless_integer(value):
            found.append(path)
    elif isinstance(value, dict):
        for key, item in value.items():
            found.extend(find_lossy_integers(item, f"{path}.{key}"))
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            found.extend(find_lossy_integers(item, f"{path}[{index}]"))
    return found
