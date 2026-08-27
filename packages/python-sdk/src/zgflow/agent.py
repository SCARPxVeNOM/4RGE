"""Build an agent the executor can call — spec section 6.1.

The Python counterpart of ``@0gflow/adapter-sdk``, and deliberately the same
contract rather than a Pythonic reinterpretation of it: an executor cannot tell
which language an agent was written in, so a difference here would be a
difference in behaviour with no visible cause.

The three things that get quietly wrong:

- An error must say whether retrying is safe. The executor retries only on
  ``retryable: True``, so an omitted flag means "do not retry" -- and an agent
  that marks a deterministic failure retryable burns the caller's deadline four
  times over.
- A 200 must carry an ``output``. Returning ``{}`` because there was nothing to
  say anchors a hash of nothing, which is a different and false claim.
- ``attestation`` must be the provider's bytes, unmodified. The executor
  digests exactly what is returned; re-encoding it breaks attestationRef.

Transport-agnostic on purpose. An agent may sit behind Flask, FastAPI, a Lambda
or ``http.server``, and none of that should change what the executor sees.
"""

from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Any, Awaitable, Mapping, Protocol

from .canonical import CanonicalizationError, canonicalize

__all__ = [
    "AgentError",
    "AttestationBinding",
    "SchemaError",
    "InvokeRequest",
    "AgentResponse",
    "AgentDefinition",
    "HandlerResult",
    "handle_invoke",
    "route_agent_request",
    "health_body",
    "schema_body",
    "require_string",
    "require_number",
    "require_object",
]


class AgentError(Exception):
    """A failure to report to the executor in the section 6.1 envelope."""

    def __init__(
        self,
        message: str,
        code: str,
        retryable: bool = False,
        status: int = 500,
    ) -> None:
        # retryable defaults to False: repeating a call whose safety is
        # unstated is the riskier assumption, and a deterministic failure
        # repeated four times just wastes the deadline.
        super().__init__(message)
        self.message = message
        self.code = code
        self.retryable = retryable
        self.status = status

    def envelope(self) -> dict[str, Any]:
        return {
            "error": {"code": self.code, "message": self.message, "retryable": self.retryable}
        }


class SchemaError(AgentError):
    """The input does not match what the agent declared it accepts."""

    def __init__(self, message: str) -> None:
        # Never retryable: the same input will fail the same way.
        super().__init__(message, "schema", retryable=False, status=422)


@dataclass(frozen=True)
class InvokeRequest:
    run_id: str
    flow_id: str
    step_index: int
    input: dict[str, Any]
    #: Unix seconds after which the executor stops waiting.
    deadline: int


@dataclass(frozen=True)
class AttestationBinding:
    """The per-response signature tying an attestation to *this* output.

    An attestation without one proves an enclave exists somewhere; it says
    nothing about the answer being returned. An agent fronting 0G Compute gets
    this from ``GET {url}/v1/proxy/signature/{chatID}?model={model}``.

    Do not copy the 0G SDK's own check. ``Verifier.verifySignature`` compares
    the signature against the ``text`` that same endpoint returned, never
    against the completion the caller received -- so it passes even when a
    provider serves one response and signs another. The executor performs the
    comparison the SDK omits, using ``output_path``.
    """

    chat_id: str
    model: str
    #: The text the enclave signed, verbatim.
    text: str
    #: The 65-byte signature, 0x hex, exactly as returned.
    signature: str
    #: Which part of ``output`` the signed text is: "$" for the whole output,
    #: or a path such as "$.text". State it rather than leaving it to
    #: convention -- if it does not resolve to the signed text, the executor
    #: records the step unattested, which is correct for an attestation that
    #: does not describe the answer.
    output_path: str = "$"


@dataclass(frozen=True)
class AgentResponse:
    output: Any
    #: The raw attestation exactly as produced, or None. Never re-encode it:
    #: the executor hashes these bytes into attestationRef, and a verifier
    #: compares against what the provider actually sent.
    attestation: str | None = None
    #: The signature binding ``attestation`` to ``output``. Without it the
    #: strongest level a step can reach is "present".
    attestation_binding: AttestationBinding | None = None


class _Invoker(Protocol):
    def __call__(self, request: InvokeRequest) -> AgentResponse | Awaitable[AgentResponse]: ...


@dataclass
class AgentDefinition:
    #: ERC-721 token id of this agent's identity, as a decimal string.
    agent_id: str
    schema: Mapping[str, Any]
    invoke: _Invoker
    version: str = "1.0.0"


@dataclass(frozen=True)
class HandlerResult:
    status: int
    body: dict[str, Any]


def _parse_request(body: Any) -> InvokeRequest | None:
    if not isinstance(body, dict):
        return None
    payload = body.get("input")
    if not isinstance(payload, dict):
        return None
    return InvokeRequest(
        run_id=str(body.get("runId", "")),
        flow_id=str(body.get("flowId", "")),
        step_index=int(body.get("stepIndex", 0) or 0),
        input=payload,
        deadline=int(body.get("deadline", 0) or 0),
    )


async def handle_invoke(agent: AgentDefinition, body: Any) -> HandlerResult:
    """Runs one invocation and returns the exact status and body to send."""
    request = _parse_request(body)
    if request is None:
        error = AgentError('request must carry an "input" object', "bad-request", False, 400)
        return HandlerResult(400, error.envelope())

    try:
        result = agent.invoke(request)
        if inspect.isawaitable(result):
            result = await result

        if not isinstance(result, AgentResponse):
            raise AgentError(
                "agent did not return an AgentResponse", "no-output", False, 500
            )
        if result.output is None:
            # An agent that returns nothing has misbehaved; saying so beats
            # anchoring a hash of {} as though it were the answer.
            raise AgentError(
                'agent returned no "output"; an absent output is not an empty one',
                "no-output",
                False,
                500,
            )

        try:
            # Fail here rather than at anchoring time. An output the frozen
            # canonicaliser rejects can never become a receipt, and the agent
            # is the only place that still knows what produced it.
            canonicalize(result.output)
        except CanonicalizationError as error:
            raise AgentError(
                f"output has no canonical JSON form: {error}", "uncanonical", False, 500
            ) from error

        if result.attestation is not None and not isinstance(result.attestation, str):
            raise AgentError(
                "attestation must be a string or None", "bad-attestation", False, 500
            )

        binding = result.attestation_binding
        if binding is not None:
            # A half-filled binding is worse than none: the executor would
            # digest fields a verifier cannot check, and the step would look
            # attested while proving nothing.
            for field_name in ("chat_id", "model", "text", "signature", "output_path"):
                value = getattr(binding, field_name, None)
                if not isinstance(value, str) or value == "":
                    raise AgentError(
                        f"attestation_binding.{field_name} must be a non-empty string",
                        "bad-binding",
                        False,
                        500,
                    )

        return HandlerResult(
            200,
            {
                "output": result.output,
                "attestation": result.attestation,
                # Wire names match the TypeScript SDK: an executor cannot tell
                # which language an agent was written in, and a different
                # spelling here would silently produce an unbound step.
                "attestationBinding": None
                if binding is None
                else {
                    "chatID": binding.chat_id,
                    "model": binding.model,
                    "text": binding.text,
                    "signature": binding.signature,
                    "outputPath": binding.output_path,
                },
            },
        )

    except AgentError as error:
        return HandlerResult(error.status, error.envelope())
    except Exception as error:  # noqa: BLE001 - deliberately broad
        # An unexpected throw is not known to be safe to repeat.
        return HandlerResult(500, AgentError(str(error), "internal", False, 500).envelope())


def health_body(agent: AgentDefinition) -> dict[str, Any]:
    return {"ok": True, "agentId": agent.agent_id, "version": agent.version}


def schema_body(agent: AgentDefinition) -> dict[str, Any]:
    return {"input": agent.schema.get("input"), "output": agent.schema.get("output")}


async def route_agent_request(
    agent: AgentDefinition,
    method: str,
    path: str,
    body: Any = None,
) -> HandlerResult | None:
    """Routes the three section 6.1 paths.

    Returns None when the path is not ours, so a host application can mount
    this alongside its own routes.
    """
    tail = path.rstrip("/").rsplit("/", 1)[-1]

    if tail == "health" and method == "GET":
        return HandlerResult(200, health_body(agent))
    if tail == "schema" and method == "GET":
        return HandlerResult(200, schema_body(agent))
    if tail == "invoke":
        if method != "POST":
            error = AgentError("use POST", "method-not-allowed", False, 405)
            return HandlerResult(405, error.envelope())
        return await handle_invoke(agent, body)
    return None


# --- schema helpers --------------------------------------------------------
# One line per field, and always non-retryable.


def require_string(payload: Mapping[str, Any], name: str) -> str:
    value = payload.get(name)
    if not isinstance(value, str):
        raise SchemaError(f'"{name}" must be a string')
    return value


def require_number(payload: Mapping[str, Any], name: str) -> float:
    value = payload.get(name)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SchemaError(f'"{name}" must be a finite number')
    if value != value or value in (float("inf"), float("-inf")):
        # A non-finite number has no JSON form and could never be hashed.
        raise SchemaError(f'"{name}" must be a finite number')
    return value


def require_object(payload: Mapping[str, Any], name: str) -> dict[str, Any]:
    value = payload.get(name)
    if not isinstance(value, dict):
        raise SchemaError(f'"{name}" must be an object')
    return value
