"""The section 6.1 agent adapter.

Mostly about failure shapes rather than the happy path: an agent that returns
the right answer is easy, and an agent that reports a failure in a form the
executor misreads is the expensive kind of bug.

These mirror ``packages/adapter-sdk/test/adapter-sdk.test.ts`` deliberately.
The executor cannot tell which language an agent was written in, so a behaviour
that differs between the two SDKs is a difference with no visible cause.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from zgflow import (
    AgentDefinition,
    AgentError,
    AgentResponse,
    AttestationBinding,
    InvokeRequest,
    SchemaError,
    handle_invoke,
    health_body,
    require_number,
    require_object,
    require_string,
    route_agent_request,
    schema_body,
)

SCHEMA = {
    "input": {"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}},
    "output": {"type": "object", "required": ["text"], "properties": {"text": {"type": "string"}}},
}


def envelope(payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "runId": "0x" + "11" * 32,
        "flowId": "0x" + "22" * 32,
        "stepIndex": 0,
        "input": payload,
        "deadline": 1_800_000_000,
    }


def echo(request: InvokeRequest) -> AgentResponse:
    return AgentResponse(output={"text": require_string(request.input, "text").upper()})


AGENT = AgentDefinition(agent_id="42", schema=SCHEMA, invoke=echo, version="2.1.0")


def call(agent: AgentDefinition, body: Any) -> Any:
    return asyncio.run(handle_invoke(agent, body))


def agent_with(invoke: Any) -> AgentDefinition:
    return AgentDefinition(agent_id="42", schema=SCHEMA, invoke=invoke, version="2.1.0")


class TestInvocation:
    def test_returns_the_output_and_an_explicit_null_attestation(self) -> None:
        result = call(AGENT, envelope({"text": "hello"}))
        assert result.status == 200
        assert result.body["output"] == {"text": "HELLO"}
        # Present-and-null, not absent: the executor distinguishes "this agent
        # does not attest" from "this field went missing in transit".
        assert "attestation" in result.body
        assert result.body["attestation"] is None

    def test_passes_an_attestation_through_unmodified(self) -> None:
        raw = "BAACAIEAAAAAAAAAk5pyM/ecTKmUCg2zlX8GB//=="
        result = call(agent_with(lambda _r: AgentResponse(output={"ok": True}, attestation=raw)),
                      envelope({"text": "x"}))
        # Re-encoding would change attestationRef and break verification.
        assert result.body["attestation"] == raw

    def test_awaits_an_async_invoke(self) -> None:
        async def slow(_request: InvokeRequest) -> AgentResponse:
            await asyncio.sleep(0)
            return AgentResponse(output={"done": True})

        assert call(agent_with(slow), envelope({})).body["output"] == {"done": True}

    def test_preserves_an_output_that_is_legitimately_empty(self) -> None:
        # A deliberately returned {} is a real answer; only its *absence* is not.
        result = call(agent_with(lambda _r: AgentResponse(output={})), envelope({"text": "x"}))
        assert result.status == 200
        assert result.body["output"] == {}

    def test_the_request_carries_the_full_envelope(self) -> None:
        seen: list[InvokeRequest] = []

        def capture(request: InvokeRequest) -> AgentResponse:
            seen.append(request)
            return AgentResponse(output={})

        call(agent_with(capture), envelope({"text": "x"}))
        assert seen[0].run_id == "0x" + "11" * 32
        assert seen[0].step_index == 0
        assert seen[0].deadline == 1_800_000_000


class TestAttestationBinding:
    """Wire names must match the TypeScript SDK exactly.

    An executor cannot tell which language an agent was written in, so a
    different spelling here would silently produce an unbound step.
    """

    BINDING = AttestationBinding(
        chat_id="chat-1",
        model="qwen/qwen2.5-omni-7b",
        # A digest envelope, as 0G Compute actually signs.
        text="aa" * 32 + ":" + "bb" * 32 + ":centralized:test:" + "cc" * 32,
        signature="0x" + "ab" * 65,
        response_body='{"choices":[{"message":{"content":"Summary: ok."}}]}',
        response_path="$.choices[0].message.content",
        output_path="$.text",
    )

    def test_a_binding_without_a_provider_is_refused(self) -> None:
        # A binding nobody can attribute to a provider is unverifiable: the
        # executor would have no acknowledged signer to check it against, and
        # the step would look attested while proving nothing. Matches the
        # TypeScript SDK, which refuses the same shape.
        result = call(
            agent_with(
                lambda _r: AgentResponse(
                    output={"text": "ok"},
                    attestation="quote",
                    attestation_binding=self.BINDING,
                )
            ),
            envelope({"text": "x"}),
        )
        assert result.status == 500
        assert result.body["error"]["code"] == "bad-binding"

    def test_serialises_with_the_camelcase_wire_names(self) -> None:
        result = call(
            agent_with(
                lambda _r: AgentResponse(
                    output={"text": "Summary: ok."},
                    attestation="quote",
                    attestation_binding=self.BINDING,
                    # Required alongside a binding: without it the executor has
                    # no registry entry to check the signature against, so the
                    # binding proves nothing.
                    attestation_provider="0x" + "dd" * 20,
                )
            ),
            envelope({"text": "x"}),
        )
        assert result.body["attestationProvider"] == "0x" + "dd" * 20
        assert result.body["attestationBinding"] == {
            "chatID": "chat-1",
            "model": "qwen/qwen2.5-omni-7b",
            "text": "aa" * 32 + ":" + "bb" * 32 + ":centralized:test:" + "cc" * 32,
            "signature": "0x" + "ab" * 65,
            "responseBody": '{"choices":[{"message":{"content":"Summary: ok."}}]}',
            "responsePath": "$.choices[0].message.content",
            "outputPath": "$.text",
        }

    def test_reports_an_explicit_null_when_absent(self) -> None:
        result = call(AGENT, envelope({"text": "x"}))
        assert "attestationBinding" in result.body
        assert result.body["attestationBinding"] is None

    def test_defaults_both_paths_to_the_whole_document(self) -> None:
        binding = AttestationBinding(chat_id="c", model="m", text="t", signature="0xab")
        assert binding.output_path == "$"
        assert binding.response_path == "$"

    @pytest.mark.parametrize(
        "field",
        ["chat_id", "model", "text", "signature", "response_body", "response_path", "output_path"],
    )
    def test_rejects_a_half_filled_binding(self, field: str) -> None:
        # A binding missing a field would still be digested into
        # attestationRef, and the step would look attested while proving
        # nothing.
        values = {
            "chat_id": "c",
            "model": "m",
            "text": "t",
            "signature": "0xab",
            "response_body": "{}",
            "response_path": "$",
            "output_path": "$",
        }
        values[field] = ""
        broken = AttestationBinding(**values)

        result = call(
            agent_with(
                lambda _r: AgentResponse(
                    output={"text": "t"}, attestation="q", attestation_binding=broken
                )
            ),
            envelope({"text": "x"}),
        )
        assert result.status == 500
        assert result.body["error"]["code"] == "bad-binding"


class TestMalformedRequests:
    @pytest.mark.parametrize(
        "body",
        [None, 42, "string", [], {}, {"input": None}, {"input": []}, {"input": "text"}],
    )
    def test_a_request_with_no_input_object_is_rejected(self, body: Any) -> None:
        result = call(AGENT, body)
        assert result.status == 400
        assert result.body["error"]["code"] == "bad-request"

    def test_a_partial_envelope_is_accepted(self) -> None:
        # Omitting runId is out of spec, but the input is what gets hashed;
        # refusing to run over a missing label would help nobody.
        assert call(AGENT, {"input": {"text": "a"}}).status == 200


class TestErrorReporting:
    def test_an_absent_output_is_a_failure_not_an_empty_result(self) -> None:
        result = call(agent_with(lambda _r: AgentResponse(output=None)), envelope({"text": "x"}))
        assert result.status == 500
        assert result.body["error"]["code"] == "no-output"
        # Anchoring hash_json({}) here would commit to a claim never made.
        assert "output" not in result.body

    def test_returning_the_wrong_type_is_reported_not_coerced(self) -> None:
        result = call(agent_with(lambda _r: {"output": {"a": 1}}), envelope({"text": "x"}))
        assert result.status == 500
        assert result.body["error"]["code"] == "no-output"

    def test_the_declared_retryable_flag_and_status_are_carried_through(self) -> None:
        def flaky(_request: InvokeRequest) -> AgentResponse:
            raise AgentError("upstream timed out", "upstream", retryable=True, status=504)

        result = call(agent_with(flaky), envelope({"text": "x"}))
        assert result.status == 504
        assert result.body["error"] == {
            "code": "upstream",
            "message": "upstream timed out",
            "retryable": True,
        }

    def test_an_unqualified_error_defaults_to_non_retryable(self) -> None:
        def failing(_request: InvokeRequest) -> AgentResponse:
            raise AgentError("nope", "domain")

        # Silence is not consent to retry: repeating a deterministic failure
        # four times just burns the caller's deadline.
        assert call(agent_with(failing), envelope({"text": "x"})).body["error"]["retryable"] is False

    def test_an_unexpected_exception_becomes_a_non_retryable_internal_error(self) -> None:
        def broken(_request: InvokeRequest) -> AgentResponse:
            raise KeyError("missing")

        result = call(agent_with(broken), envelope({"text": "x"}))
        assert result.status == 500
        assert result.body["error"]["code"] == "internal"
        assert result.body["error"]["retryable"] is False

    def test_a_schema_violation_is_422_and_non_retryable(self) -> None:
        result = call(AGENT, envelope({"text": 12}))
        assert result.status == 422
        assert result.body["error"] == {
            "code": "schema",
            "message": '"text" must be a string',
            "retryable": False,
        }


class TestOutputValidity:
    def test_an_uncanonicalisable_output_is_caught_at_the_agent(self) -> None:
        # Failing here rather than at anchoring time: an output the frozen
        # canonicaliser rejects can never become a receipt, and the agent is
        # the only place that still knows what produced it.
        from datetime import datetime

        result = call(
            agent_with(lambda _r: AgentResponse(output={"at": datetime(2026, 1, 1)})),
            envelope({"text": "x"}),
        )
        assert result.status == 500
        assert result.body["error"]["code"] == "uncanonical"

    def test_a_lone_surrogate_in_the_output_is_caught(self) -> None:
        result = call(
            agent_with(lambda _r: AgentResponse(output={"text": "\ud800"})),
            envelope({"text": "x"}),
        )
        assert result.body["error"]["code"] == "uncanonical"

    def test_a_non_string_attestation_is_rejected(self) -> None:
        result = call(
            agent_with(lambda _r: AgentResponse(output={"a": 1}, attestation={"quote": "x"})),
            envelope({"text": "x"}),
        )
        assert result.body["error"]["code"] == "bad-attestation"


class TestRequireHelpers:
    def test_accepts_well_typed_fields(self) -> None:
        payload = {"s": "x", "n": 1.5, "o": {"k": 1}}
        assert require_string(payload, "s") == "x"
        assert require_number(payload, "n") == 1.5
        assert require_object(payload, "o") == {"k": 1}

    def test_rejects_a_missing_field_by_name(self) -> None:
        with pytest.raises(SchemaError, match='"absent" must be a string'):
            require_string({}, "absent")

    def test_rejects_a_non_finite_number(self) -> None:
        for value in (float("nan"), float("inf"), float("-inf")):
            with pytest.raises(SchemaError, match="finite number"):
                require_number({"n": value}, "n")

    def test_a_boolean_is_not_a_number(self) -> None:
        # bool subclasses int; without this guard True passes as 1.
        with pytest.raises(SchemaError, match="finite number"):
            require_number({"n": True}, "n")

    def test_rejects_lists_and_none_where_an_object_is_required(self) -> None:
        for value in ([], None, "text"):
            with pytest.raises(SchemaError, match='"o" must be an object'):
                require_object({"o": value}, "o")

    def test_every_schema_failure_is_422_and_non_retryable(self) -> None:
        # The same input will fail the same way.
        try:
            require_string({}, "x")
        except SchemaError as error:
            assert error.status == 422
            assert error.retryable is False
        else:
            pytest.fail("should have raised")


class TestRouting:
    def route(self, method: str, path: str, body: Any = None) -> Any:
        return asyncio.run(route_agent_request(AGENT, method, path, body))

    def test_serves_health_and_schema(self) -> None:
        assert self.route("GET", "/health").body == health_body(AGENT)
        assert health_body(AGENT) == {"ok": True, "agentId": "42", "version": "2.1.0"}
        assert self.route("GET", "/schema").body == schema_body(AGENT)

    def test_defaults_the_reported_version(self) -> None:
        bare = AgentDefinition(agent_id="1", schema=SCHEMA, invoke=echo)
        assert health_body(bare)["version"] == "1.0.0"

    def test_routes_invoke_under_a_mount_prefix_or_trailing_slash(self) -> None:
        for path in ("/invoke", "/agents/echo/invoke", "/invoke/"):
            assert self.route("POST", path, envelope({"text": "q"})).status == 200

    def test_returns_405_for_invoke_with_the_wrong_method(self) -> None:
        result = self.route("GET", "/invoke")
        assert result.status == 405
        assert result.body["error"]["code"] == "method-not-allowed"

    def test_returns_none_for_a_path_it_does_not_own(self) -> None:
        # So a host application can mount this alongside its own routes.
        assert self.route("GET", "/metrics") is None
        assert self.route("POST", "/") is None
