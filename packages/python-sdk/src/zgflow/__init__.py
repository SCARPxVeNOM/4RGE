"""0G Flow Python SDK.

Canonicalisation, hashing and receipt encoding, held byte-for-byte to the same
frozen contract as the TypeScript ``@0gflow/core``, plus the section 6.1 agent
adapter.

The contract is ``packages/core/vectors/canonicalization.json``. If this
package and core ever disagree on it, runs produced by one cannot be verified
by the other, so the vector test is not a nicety -- it is the reason this
package can be trusted at all.
"""

from .canonical import (
    CanonicalizationError,
    canonical_bytes,
    canonicalize,
    find_lossy_integers,
)
from .hashing import from_hex, hash_json, keccak256, sha256, to_hex
from .numbers import NumberError, format_number, is_lossless_integer
from .receipt import (
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
from .agent import (
    AgentDefinition,
    AgentError,
    AgentResponse,
    AttestationBinding,
    HandlerResult,
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

__version__ = "1.0.0"

from .signature import (
    AGENT_OUTPUT_DOMAIN,
    AgentOutputClaim,
    SignatureError,
    agent_output_digest,
    agent_output_message_hash,
    sign_output,
)

__all__ = [
    "__version__",
    # canonicalisation
    "canonicalize",
    "canonical_bytes",
    "find_lossy_integers",
    "CanonicalizationError",
    "format_number",
    "is_lossless_integer",
    "NumberError",
    # hashing
    "sha256",
    "keccak256",
    "hash_json",
    "to_hex",
    "from_hex",
    # receipts
    "Receipt",
    "StepStatus",
    "ZERO_BYTES32",
    "encode_receipt",
    "hash_receipt",
    "fold_chain_root",
    "chain_root_progression",
    "ReceiptError",
    "ChainRootError",
    # agents
    "AgentDefinition",
    "AgentError",
    "AgentResponse",
    "AttestationBinding",
    "HandlerResult",
    "InvokeRequest",
    "SchemaError",
    "handle_invoke",
    "route_agent_request",
    "health_body",
    "schema_body",
    "require_string",
    "require_number",
    "require_object",
    # signatures
    "AGENT_OUTPUT_DOMAIN",
    "AgentOutputClaim",
    "SignatureError",
    "agent_output_digest",
    "agent_output_message_hash",
    "sign_output",
]
