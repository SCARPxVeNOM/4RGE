"""Agent output signatures, held to the TypeScript vector.

The pinned digest here is the same literal as
``packages/core/test/agent-signature.test.ts`` and
``contracts/test/FlowEscrowV2.t.sol``. Four implementations check this value —
the SDK that signs, the executor that records, the verifier that checks and the
escrow that pays — and a Python agent that computed it differently would
produce signatures that verify nowhere and find out at payment time.

This file is the only thing standing between "they agree" and "they appear to
agree".
"""

from __future__ import annotations

import pytest

from zgflow import (
    AGENT_OUTPUT_DOMAIN,
    AgentOutputClaim,
    SignatureError,
    agent_output_digest,
    agent_output_message_hash,
    keccak256,
    sign_output,
)
from zgflow.agent import InvokeRequest

# A deliberately fictional chain id, matching the TypeScript vector: the digest
# does not care which chain it names, only that it names one.
CLAIM = AgentOutputClaim(
    chain_id=31337,
    receipts="0x741a36faba40ee71223539a5a062fdedc8574e30",
    run_id="0x" + "22" * 32,
    step_index=1,
    agent_id=7,
    input_hash="0x" + "33" * 32,
    output_hash="0x" + "44" * 32,
)

PINNED = "0x0c5bf6dabc2d3db97229a669ecf3f9793f03240b790514aa9add8d1a18332a15"


class TestDomain:
    def test_is_keccak_of_the_versioned_label(self) -> None:
        assert AGENT_OUTPUT_DOMAIN == keccak256(b"0gflow-agent-output-v1")


class TestDigest:
    def test_matches_the_typescript_and_solidity_vector(self) -> None:
        assert agent_output_digest(CLAIM) == PINNED

    def test_message_hash_is_eip191_over_the_digest(self) -> None:
        digest = bytes.fromhex(agent_output_digest(CLAIM)[2:])
        expected = keccak256(b"\x19Ethereum Signed Message:\n32" + digest)
        assert agent_output_message_hash(CLAIM) == expected

    def test_accepts_either_hex_casing(self) -> None:
        upper = AgentOutputClaim(
            chain_id=CLAIM.chain_id,
            receipts=CLAIM.receipts.upper().replace("0X", "0x"),
            run_id=CLAIM.run_id.upper().replace("0X", "0x"),
            step_index=CLAIM.step_index,
            agent_id=CLAIM.agent_id,
            input_hash=CLAIM.input_hash.upper().replace("0X", "0x"),
            output_hash=CLAIM.output_hash.upper().replace("0X", "0x"),
        )
        assert agent_output_digest(upper) == PINNED


class TestEveryFieldClosesAReplay:
    """Each digest field exists to stop one thing, and a field nobody tests is
    a field someone later removes as redundant."""

    @pytest.mark.parametrize(
        "field,value",
        [
            ("chain_id", 1),
            ("receipts", "0x" + "ab" * 20),
            ("run_id", "0x" + "55" * 32),
            ("step_index", 2),
            ("agent_id", 8),
            ("input_hash", "0x" + "66" * 32),
            ("output_hash", "0x" + "77" * 32),
        ],
    )
    def test_changing_it_changes_the_digest(self, field: str, value: object) -> None:
        altered = AgentOutputClaim(
            **{**{f: getattr(CLAIM, f) for f in CLAIM.__dataclass_fields__}, field: value}
        )
        assert agent_output_digest(altered) != agent_output_digest(CLAIM)


class TestMalformedClaimsAreRejected:
    """Refused rather than hashed: a digest over a mangled claim would be a
    perfectly well-formed signature over the wrong thing."""

    def test_a_wrong_length_hash(self) -> None:
        with pytest.raises(SignatureError, match="expected 32 bytes"):
            agent_output_digest(
                AgentOutputClaim(
                    **{**{f: getattr(CLAIM, f) for f in CLAIM.__dataclass_fields__},
                       "run_id": "0x1234"}
                )
            )

    def test_a_wrong_length_address(self) -> None:
        with pytest.raises(SignatureError, match="expected 20 bytes"):
            agent_output_digest(
                AgentOutputClaim(
                    **{**{f: getattr(CLAIM, f) for f in CLAIM.__dataclass_fields__},
                       "receipts": "0x" + "ab" * 32}
                )
            )

    def test_a_non_hex_field(self) -> None:
        with pytest.raises(SignatureError, match="not hex"):
            agent_output_digest(
                AgentOutputClaim(
                    **{**{f: getattr(CLAIM, f) for f in CLAIM.__dataclass_fields__},
                       "run_id": "0x" + "zz" * 32}
                )
            )

    def test_an_agent_id_beyond_uint256(self) -> None:
        with pytest.raises(SignatureError, match="uint256"):
            agent_output_digest(
                AgentOutputClaim(
                    **{**{f: getattr(CLAIM, f) for f in CLAIM.__dataclass_fields__},
                       "agent_id": 1 << 256}
                )
            )

    def test_a_negative_step_index(self) -> None:
        with pytest.raises(SignatureError, match="negative"):
            agent_output_digest(
                AgentOutputClaim(
                    **{**{f: getattr(CLAIM, f) for f in CLAIM.__dataclass_fields__},
                       "step_index": -1}
                )
            )

    def test_the_full_uint256_agent_id_range_is_accepted(self) -> None:
        # Token ids are uint256; narrowing anywhere would collide distinct
        # agents.
        digest = agent_output_digest(
            AgentOutputClaim(
                **{**{f: getattr(CLAIM, f) for f in CLAIM.__dataclass_fields__},
                   "agent_id": (1 << 256) - 1}
            )
        )
        assert len(digest) == 66


class TestSignOutput:
    def _request(self, **over: object) -> InvokeRequest:
        base = {
            "run_id": "0x" + "22" * 32,
            "flow_id": "0x" + "11" * 32,
            "step_index": 1,
            "input": {"repo": "x"},
            "deadline": 0,
            "chain_id": 31337,
            "receipts": "0x741a36faba40ee71223539a5a062fdedc8574e30",
        }
        base.update(over)
        return InvokeRequest(**base)  # type: ignore[arg-type]

    def test_hands_the_digest_to_the_signer_and_returns_both(self) -> None:
        seen: list[str] = []

        def sign(digest: str) -> str:
            seen.append(digest)
            return "0x" + "11" * 65

        signature, digest = sign_output(self._request(), "7", {"text": "done"}, sign)

        # The digest, not the already-prefixed message hash: eth_account and
        # viem both apply EIP-191 themselves, and passing the prefixed value
        # would prefix it twice.
        assert seen == [digest]
        assert digest != agent_output_message_hash(CLAIM)
        assert signature == "0x" + "11" * 65

    def test_hashes_the_request_input_and_the_given_output(self) -> None:
        captured: list[str] = []
        sign_output(
            self._request(),
            "7",
            {"text": "done"},
            lambda d: captured.append(d) or "0x" + "11" * 65,  # type: ignore[func-returns-value]
        )
        from zgflow import hash_json

        expected = agent_output_digest(
            AgentOutputClaim(
                chain_id=31337,
                receipts="0x741a36faba40ee71223539a5a062fdedc8574e30",
                run_id="0x" + "22" * 32,
                step_index=1,
                agent_id=7,
                input_hash=hash_json({"repo": "x"}),
                output_hash=hash_json({"text": "done"}),
            )
        )
        assert captured == [expected]

    @pytest.mark.parametrize("missing", ["chain_id", "receipts"])
    def test_refuses_when_the_executor_named_no_anchoring(self, missing: str) -> None:
        # A signature not bound to a chain and contract would be valid against
        # every deployment — worse than none.
        with pytest.raises(SignatureError, match="chain_id and receipts"):
            sign_output(self._request(**{missing: None}), "7", {}, lambda d: d)
