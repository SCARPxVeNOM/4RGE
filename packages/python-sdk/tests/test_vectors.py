"""The cross-language contract for spec section 5.2.

``packages/core/vectors/canonicalization.json`` is frozen. The TypeScript core
asserts it reproduces those vectors; this asserts the same of Python. Together
they are the only evidence that a run executed by one implementation can be
verified by the other.

If this fails, do not regenerate the vectors. Either core changed behaviour --
a consensus break -- or this port is wrong. Editing the file to make the test
pass destroys the only thing it was protecting.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from zgflow import canonicalize, hash_json, keccak256

VECTOR_FILE = (
    Path(__file__).resolve().parents[2] / "core" / "vectors" / "canonicalization.json"
)

VECTORS = json.loads(VECTOR_FILE.read_text(encoding="utf-8"))["vectors"]
IDS = [v["name"] for v in VECTORS]


def test_the_vector_file_was_found_and_is_populated() -> None:
    # A path that silently resolves to nothing would turn every test below into
    # a no-op that reports success.
    assert VECTOR_FILE.exists(), f"vector file not found at {VECTOR_FILE}"
    assert len(VECTORS) >= 15


@pytest.mark.parametrize("vector", VECTORS, ids=IDS)
def test_canonical_form_matches(vector: dict) -> None:
    assert canonicalize(vector["value"]) == vector["canonical"]


@pytest.mark.parametrize("vector", VECTORS, ids=IDS)
def test_sha256_matches(vector: dict) -> None:
    assert hash_json(vector["value"]) == vector["sha256"]


@pytest.mark.parametrize("vector", VECTORS, ids=IDS)
def test_keccak256_matches(vector: dict) -> None:
    assert keccak256(vector["canonical"].encode("utf-8")) == vector["keccak256"]


def test_the_non_bmp_ordering_trap_is_covered() -> None:
    """The single most likely cross-language divergence.

    Python's ``sorted()`` orders by code point, which puts U+FFFF (65535)
    before U+1F600 (128512). RFC 8785 orders by UTF-16 code unit, which puts
    U+1F600 first because its lead surrogate 0xD83D is below 0xFFFF. A port
    using the default sort produces a hash no verifier will reproduce, and
    nothing in the output hints at why.
    """
    vector = next((v for v in VECTORS if v["name"] == "key-ordering-non-bmp"), None)
    assert vector is not None, "the non-BMP key ordering vector must not be removed"

    canonical = canonicalize(vector["value"])
    assert canonical.index("\U0001F600") < canonical.index("￿")

    # And the naive implementation really would disagree, so the test above is
    # testing something.
    naive = sorted(vector["value"])
    assert naive[0] == "￿", "if this changes, Python's sort semantics did"
