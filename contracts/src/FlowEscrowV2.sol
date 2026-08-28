// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ExecutionReceiptsV2} from "./ExecutionReceiptsV2.sol";
import {AgentAdapterRegistryV2} from "./AgentAdapterRegistryV2.sol";

/// @title FlowEscrowV2
/// @notice Payment held against verifiable execution — spec §4.4, rebuilt for
/// a market.
///
/// WHAT CHANGED AND WHY
///
/// 1. **The payee table is gone.** v1 required the funder to name every payee
///    and amount up front, which presumes the funder already knows which
///    agents will run. In a market they do not: the executor resolves agents
///    from the registry, and a hiring agent may pick a subcontractor at run
///    time. v2 escrows one pool and the executor allocates from it.
///
/// 2. **Release requires the agent's signature.** v1 paid whoever the funder
///    listed for that step index. v2 pays the address the *agent itself*
///    registered, and only against a signature by the key that agent
///    published. The executor writes `agentId` into the receipt and could
///    write anyone's — but it cannot produce that agent's signature, so it
///    cannot misdirect the money. This is the property that makes an open
///    marketplace safe to fund: you are not trusting the executor.
///
/// 3. **Funds can no longer be locked forever.** v1's `refundUnspent` reverts
///    with `RunSucceeded` when the outcome is ok, so a run that succeeded with
///    any unreleased remainder trapped it permanently, and a run that was
///    never sealed trapped everything. `FlowEscrow.t.sol` asserted that as
///    intended behaviour. It was not. v2 refunds on any sealed outcome, and
///    adds a deadline for the never-sealed case.
///
/// The digest below must stay byte-identical to `agentOutputDigest` in
/// `packages/core/src/agent-signature.ts`, which pins it as a test vector. If
/// one changes without the other, agents sign something this contract will not
/// accept and payment stops with no indication why.
contract FlowEscrowV2 {
    uint8 internal constant STATUS_OK = 0;

    /// keccak256("0gflow-agent-output-v1")
    bytes32 public constant AGENT_OUTPUT_DOMAIN =
        0x15c09898cb7db4f292f4362b60ea464352690737ff2225b4063ae967f0dccd75;

    struct Funding {
        address funder;
        uint256 balance; // held and not yet paid out
        uint256 allocated; // sum of live per-step allocations
        uint64 deadline; // after this, the funder can always recover
        bool closed;
        bool exists;
    }

    ExecutionReceiptsV2 public immutable receipts;
    AgentAdapterRegistryV2 public immutable registry;

    mapping(bytes32 => Funding) private _funding;
    /// runId => stepIndex => amount earmarked for whoever proves that step
    mapping(bytes32 => mapping(uint32 => uint256)) private _allocation;
    mapping(bytes32 => mapping(uint32 => bool)) private _released;

    event RunFunded(bytes32 indexed runId, address indexed funder, uint256 amount, uint64 deadline);
    event RunToppedUp(bytes32 indexed runId, address indexed funder, uint256 amount);
    event StepAllocated(bytes32 indexed runId, uint32 indexed stepIndex, uint256 amount);
    event StepReleased(
        bytes32 indexed runId,
        uint32 indexed stepIndex,
        uint256 indexed agentId,
        address payTo,
        uint256 amount
    );
    event RunRefunded(bytes32 indexed runId, address indexed funder, uint256 amount);

    error RunAlreadyFunded(bytes32 runId);
    error RunNotFunded(bytes32 runId);
    error RunClosed(bytes32 runId);
    error DeadlineInPast(uint64 deadline, uint64 nowTs);
    error NotRunFunder(bytes32 runId, address caller, address funder);
    error NotRunExecutor(bytes32 runId, address caller, address executor);
    error NoAllocation(bytes32 runId, uint32 stepIndex);
    error InsufficientBalance(bytes32 runId, uint256 requested, uint256 available);
    error StepNotSuccessful(bytes32 runId, uint32 stepIndex, uint8 status);
    error StepAlreadyReleased(bytes32 runId, uint32 stepIndex);
    error AgentNotListed(uint256 agentId);
    error BadSignature(uint256 agentId, address recovered, address expected);
    error MalformedSignature(uint256 length);
    error DeadlineNotReached(uint64 deadline, uint64 nowTs);
    error RunNotSealed(bytes32 runId);
    error NothingToRefund(bytes32 runId);
    error TransferFailed(address to, uint256 amount);

    constructor(address receipts_, address registry_) {
        receipts = ExecutionReceiptsV2(receipts_);
        registry = AgentAdapterRegistryV2(registry_);
    }

    /// @notice Escrows a budget for a run, recoverable after `deadline`.
    ///
    /// The deadline is mandatory. Without one, a run the executor abandons
    /// before sealing holds the funder's money with no path to recovery —
    /// which is v1's actual behaviour and the bug this fixes.
    function fundRun(bytes32 runId, uint64 deadline) external payable {
        if (_funding[runId].exists) revert RunAlreadyFunded(runId);
        if (deadline <= block.timestamp) revert DeadlineInPast(deadline, uint64(block.timestamp));

        _funding[runId] = Funding({
            funder: msg.sender,
            balance: msg.value,
            allocated: 0,
            deadline: deadline,
            closed: false,
            exists: true
        });

        emit RunFunded(runId, msg.sender, msg.value, deadline);
    }

    /// @notice Adds to an existing budget — a flow that hires more agents than
    /// expected would otherwise stall mid-run with no way to continue.
    function topUp(bytes32 runId) external payable {
        Funding storage f = _funding[runId];
        if (!f.exists) revert RunNotFunded(runId);
        if (f.closed) revert RunClosed(runId);
        f.balance += msg.value;
        emit RunToppedUp(runId, msg.sender, msg.value);
    }

    /// @dev Allocation is the executor's job because only it knows, at run
    /// time, which agent ran which step and what the registry said it costs.
    modifier onlyExecutor(bytes32 runId) {
        address executor = receipts.flowRegistry().executorOf(runId);
        if (msg.sender != executor) revert NotRunExecutor(runId, msg.sender, executor);
        _;
    }

    /// @notice Earmarks part of the budget for a step.
    ///
    /// Re-allocating an unreleased step overwrites the previous figure rather
    /// than adding to it, so a retry at a different price does not silently
    /// double the commitment.
    function allocate(bytes32 runId, uint32 stepIndex, uint256 amount)
        external
        onlyExecutor(runId)
    {
        Funding storage f = _funding[runId];
        if (!f.exists) revert RunNotFunded(runId);
        if (f.closed) revert RunClosed(runId);
        if (_released[runId][stepIndex]) revert StepAlreadyReleased(runId, stepIndex);

        uint256 previous = _allocation[runId][stepIndex];
        uint256 committed = f.allocated - previous;
        if (committed + amount > f.balance) {
            revert InsufficientBalance(runId, amount, f.balance - committed);
        }

        f.allocated = committed + amount;
        _allocation[runId][stepIndex] = amount;

        emit StepAllocated(runId, stepIndex, amount);
    }

    /// @notice Pays a step's agent, against its own signature over its own
    /// output.
    ///
    /// Permissionless: anyone may submit the signature, because the signature
    /// is the authorisation. The agent can collect its own payment, the
    /// executor can settle on its behalf, and neither can pay the wrong party.
    ///
    /// Four things must hold, and each rules out a distinct way of being
    /// robbed:
    ///   · the step is anchored with status ok — no payment for work that did
    ///     not verify, which is the whole §4.4 idea
    ///   · the agent is listed — an unlisted agent has signer 0, and ecrecover
    ///     returns 0 on failure, so this check is what stops a malformed
    ///     signature from matching a nonexistent agent
    ///   · the signature recovers to that agent's registered signer
    ///   · the digest names *this* run, step, agent, input and output
    function releaseStep(bytes32 runId, uint32 stepIndex, bytes calldata agentSig) external {
        Funding storage f = _funding[runId];
        if (!f.exists) revert RunNotFunded(runId);
        if (f.closed) revert RunClosed(runId);
        if (_released[runId][stepIndex]) revert StepAlreadyReleased(runId, stepIndex);

        uint256 amount = _allocation[runId][stepIndex];
        if (amount == 0) revert NoAllocation(runId, stepIndex);

        (uint256 agentId, address payTo) = _checkClaim(runId, stepIndex, agentSig);

        // Effects before interaction.
        _released[runId][stepIndex] = true;
        _allocation[runId][stepIndex] = 0;
        f.allocated -= amount;
        f.balance -= amount;

        emit StepReleased(runId, stepIndex, agentId, payTo, amount);

        (bool sent,) = payTo.call{value: amount}("");
        if (!sent) revert TransferFailed(payTo, amount);
    }

    /// @dev The four checks that authorise a payment, in their own frame.
    ///
    /// Extracted from `releaseStep` because inlining it overflows the EVM's
    /// 16-slot stack. That is a compiler constraint, not a design one, but the
    /// split is honest: this function answers "may this agent be paid for this
    /// step", and `releaseStep` answers "move the money".
    function _checkClaim(bytes32 runId, uint32 stepIndex, bytes calldata agentSig)
        private
        view
        returns (uint256 agentId, address payTo)
    {
        bytes32 inputHash;
        bytes32 outputHash;
        {
            // Reverts if never anchored, so an absent receipt can never be
            // mistaken for a successful one.
            uint8 status;
            (status, agentId, inputHash, outputHash) = receipts.stepOf(runId, stepIndex);
            if (status != STATUS_OK) revert StepNotSuccessful(runId, stepIndex, status);
        }

        address expected = registry.signerOf(agentId);
        if (expected == address(0)) revert AgentNotListed(agentId);

        address recovered = _recover(
            _toEthSignedMessageHash(
                agentOutputDigest(runId, stepIndex, agentId, inputHash, outputHash)
            ),
            agentSig
        );
        if (recovered != expected) revert BadSignature(agentId, recovered, expected);

        payTo = registry.payToOf(agentId);
    }

    /// @notice The digest an agent signs to claim a step's output.
    ///
    /// Public so an agent can ask the chain what to sign rather than
    /// reimplementing this and discovering the mismatch at payment time.
    function agentOutputDigest(
        bytes32 runId,
        uint32 stepIndex,
        uint256 agentId,
        bytes32 inputHash,
        bytes32 outputHash
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                AGENT_OUTPUT_DOMAIN,
                block.chainid,
                address(receipts),
                runId,
                uint256(stepIndex),
                agentId,
                inputHash,
                outputHash
            )
        );
    }

    /// @notice Returns the unallocated remainder once the run is sealed —
    /// whatever the outcome.
    ///
    /// v1 reverted here when the outcome was ok, on the reasoning that a
    /// successful run's money belongs to the agents. But an agent that never
    /// claims, or a step priced below its allocation, leaves a remainder that
    /// belongs to nobody and could never be recovered. Sealed means finished;
    /// finished means the funder gets back what was not earned.
    function refundUnspent(bytes32 runId) external {
        Funding storage f = _funding[runId];
        if (!f.exists) revert RunNotFunded(runId);
        if (f.closed) revert RunClosed(runId);

        (,,, uint64 sealedAt) = receipts.sealOf(runId);
        if (sealedAt == 0) revert RunNotSealed(runId);

        // Still owed to agents whose steps succeeded but who have not yet
        // collected. Refunding it would let a funder seal and sweep before the
        // agents it already owes have submitted their signatures.
        uint256 amount = f.balance - f.allocated;
        if (amount == 0) revert NothingToRefund(runId);

        f.balance -= amount;

        emit RunRefunded(runId, f.funder, amount);

        (bool sent,) = f.funder.call{value: amount}("");
        if (!sent) revert TransferFailed(f.funder, amount);
    }

    /// @notice After the deadline, the funder recovers everything and the run
    /// is closed.
    ///
    /// This is the escape hatch for a run that was never sealed — an executor
    /// that crashed, went away, or simply chose not to finish. Unlike
    /// `refundUnspent` it ignores allocations: past the deadline, an agent
    /// that has not collected has had its window and the funder should not be
    /// hostage to it. Funder-only, so nobody else can end a run that is still
    /// legitimately in progress at the boundary.
    function refundExpired(bytes32 runId) external {
        Funding storage f = _funding[runId];
        if (!f.exists) revert RunNotFunded(runId);
        if (f.closed) revert RunClosed(runId);
        if (msg.sender != f.funder) revert NotRunFunder(runId, msg.sender, f.funder);
        if (block.timestamp < f.deadline) {
            revert DeadlineNotReached(f.deadline, uint64(block.timestamp));
        }

        uint256 amount = f.balance;

        f.closed = true;
        f.balance = 0;
        f.allocated = 0;

        emit RunRefunded(runId, f.funder, amount);

        if (amount > 0) {
            (bool sent,) = f.funder.call{value: amount}("");
            if (!sent) revert TransferFailed(f.funder, amount);
        }
    }

    function _toEthSignedMessageHash(bytes32 digest) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
    }

    /// @dev ecrecover, with the malleable high-s form rejected. Every ECDSA
    /// signature has a second valid encoding with s' = N - s; accepting both
    /// would let one signed output be presented as two distinct signatures.
    /// Mirrors `parseSignature` in `packages/core/src/secp256k1.ts`.
    function _recover(bytes32 hash, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) revert MalformedSignature(signature.length);

        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (v < 27) v += 27;

        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }

        return ecrecover(hash, v, r, s);
    }

    function balanceOf(bytes32 runId) external view returns (uint256) {
        return _funding[runId].balance;
    }

    function allocatedOf(bytes32 runId) external view returns (uint256) {
        return _funding[runId].allocated;
    }

    function allocationOf(bytes32 runId, uint32 stepIndex) external view returns (uint256) {
        return _allocation[runId][stepIndex];
    }

    function isReleased(bytes32 runId, uint32 stepIndex) external view returns (bool) {
        return _released[runId][stepIndex];
    }

    function fundingOf(bytes32 runId)
        external
        view
        returns (address funder, uint256 balance, uint256 allocated, uint64 deadline, bool closed)
    {
        Funding storage f = _funding[runId];
        return (f.funder, f.balance, f.allocated, f.deadline, f.closed);
    }
}
