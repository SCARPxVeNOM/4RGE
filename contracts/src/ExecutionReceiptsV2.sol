// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {FlowRegistry} from "./FlowRegistry.sol";

/// @title ExecutionReceiptsV2
/// @notice v1 plus two stored fields per step — spec §4.1.
///
/// WHY THIS EXISTS
///
/// v1 stores only `status + 1` per step. `agentId` and `outputHash` live
/// exclusively in the `StepAnchored` event, and v1 says why that was fine:
/// "contracts cannot read logs." That was true while the only on-chain
/// consumer was `FlowEscrow`, which needed nothing but the status.
///
/// A marketplace escrow needs more. To pay the right agent it must know which
/// agent the receipt named, and to check that agent's signature it must know
/// what output the signature commits to. Neither is readable in v1, so there
/// is no amount of off-chain work that makes `FlowEscrowV2.releaseStep`
/// trustworthy on top of it. Hence a v2 rather than a helper.
///
/// WHAT IS DELIBERATELY UNCHANGED
///
/// The `Receipt` struct and the `StepAnchored` event are byte-identical to v1.
/// `packages/core` hashes the receipt in a form pinned by a cross-language
/// vector (`ExecutionReceipts.t.sol`), the indexer decodes the event, and the
/// verifier re-folds the chain root from both. Changing either would fork the
/// receipt hash and strand every run anchored so far. The extra fields are
/// stored, not added to the wire format — this contract costs more gas than
/// v1 and buys provable payment with it.
///
/// v1 stays deployed and every run anchored there keeps verifying (§10.2).
contract ExecutionReceiptsV2 {
    struct Receipt {
        bytes32 flowId; // keccak256 of canonical workflow spec
        bytes32 runId; // unique per execution
        uint32 stepIndex;
        uint256 agentId; // agent identity as an ERC-721 token id (see IIdentityRegistry)
        bytes32 inputHash; // sha256 of canonical JSON input
        bytes32 outputHash; // sha256 of canonical JSON output
        bytes32 traceRoot; // 0G Storage Merkle root of execution trace
        bytes32 attestationRef; // TEE attestation digest; 0x0 when absent
        uint64 startedAt;
        uint64 endedAt;
        uint8 status; // 0 ok · 1 failed · 2 skipped · 3 unattested
    }

    /// @dev What v2 keeps that v1 threw away. `statusPlusOne` preserves v1's
    /// zero-means-unanchored encoding rather than adding a separate flag: one
    /// slot cannot disagree with itself.
    struct StepState {
        uint8 statusPlusOne;
        uint256 agentId;
        bytes32 inputHash;
        bytes32 outputHash;
    }

    struct Seal {
        bytes32 chainRoot;
        uint32 stepCount;
        uint8 outcome;
        uint64 sealedAt;
    }

    uint8 internal constant STATUS_MAX = 3;

    FlowRegistry public immutable flowRegistry;

    /// runId => stepIndex => state; `statusPlusOne == 0` means not anchored.
    mapping(bytes32 => mapping(uint32 => StepState)) private _stepState;
    /// runId => number of steps anchored so far
    mapping(bytes32 => uint32) private _anchoredCount;
    mapping(bytes32 => Seal) private _seals;

    event StepAnchored(
        bytes32 indexed flowId,
        bytes32 indexed runId,
        uint32 indexed stepIndex,
        uint256 agentId,
        bytes32 inputHash,
        bytes32 outputHash,
        bytes32 traceRoot,
        bytes32 attestationRef,
        uint64 startedAt,
        uint64 endedAt,
        uint8 status
    );

    event RunSealed(bytes32 indexed runId, bytes32 chainRoot, uint32 stepCount, uint8 outcome);

    error StepAlreadyAnchored(bytes32 runId, uint32 stepIndex);
    error StepNotAnchored(bytes32 runId, uint32 stepIndex);
    error NotRunExecutor(bytes32 runId, address caller, address executor);
    error FlowMismatch(bytes32 runId, bytes32 declared, bytes32 actual);
    error UnknownStatus(uint8 status);
    error RunAlreadySealed(bytes32 runId);
    error RunNotSealed(bytes32 runId);
    error StepCountMismatch(bytes32 runId, uint32 declared, uint32 anchored);
    error InvalidTimestamps(uint64 startedAt, uint64 endedAt);

    constructor(address flowRegistry_) {
        flowRegistry = FlowRegistry(flowRegistry_);
    }

    /// @dev Anchoring is restricted to the run's declared executor. Without
    /// this, anyone could anchor step 0 of someone else's run first and
    /// permanently block it, because duplicates revert.
    modifier onlyExecutor(bytes32 runId) {
        address executor = flowRegistry.executorOf(runId);
        if (msg.sender != executor) revert NotRunExecutor(runId, msg.sender, executor);
        _;
    }

    /// @notice Records a step's receipt. Reverts on a duplicate
    /// (runId, stepIndex) so a worker resuming after a crash cannot
    /// double-anchor.
    function anchorStep(Receipt calldata r) external onlyExecutor(r.runId) {
        if (_seals[r.runId].sealedAt != 0) revert RunAlreadySealed(r.runId);
        if (_stepState[r.runId][r.stepIndex].statusPlusOne != 0) {
            revert StepAlreadyAnchored(r.runId, r.stepIndex);
        }
        if (r.status > STATUS_MAX) revert UnknownStatus(r.status);
        if (r.endedAt < r.startedAt) revert InvalidTimestamps(r.startedAt, r.endedAt);

        bytes32 actualFlow = flowRegistry.flowOf(r.runId);
        if (r.flowId != actualFlow) revert FlowMismatch(r.runId, r.flowId, actualFlow);

        _stepState[r.runId][r.stepIndex] = StepState({
            statusPlusOne: r.status + 1,
            agentId: r.agentId,
            inputHash: r.inputHash,
            outputHash: r.outputHash
        });
        unchecked {
            _anchoredCount[r.runId] += 1;
        }

        emit StepAnchored(
            r.flowId,
            r.runId,
            r.stepIndex,
            r.agentId,
            r.inputHash,
            r.outputHash,
            r.traceRoot,
            r.attestationRef,
            r.startedAt,
            r.endedAt,
            r.status
        );
    }

    /// @notice Seals a run with the chain root its receipts fold to. A run
    /// that failed is sealed too: failure is a verifiable outcome, not an
    /// absence of one (§1.3).
    function sealRun(bytes32 runId, bytes32 chainRoot, uint32 stepCount, uint8 outcome)
        external
        onlyExecutor(runId)
    {
        if (_seals[runId].sealedAt != 0) revert RunAlreadySealed(runId);
        if (outcome > STATUS_MAX) revert UnknownStatus(outcome);

        // A seal claiming more steps than were anchored would present a root
        // folded over receipts nobody can find.
        uint32 anchored = _anchoredCount[runId];
        if (stepCount != anchored) revert StepCountMismatch(runId, stepCount, anchored);

        _seals[runId] = Seal({
            chainRoot: chainRoot,
            stepCount: stepCount,
            outcome: outcome,
            sealedAt: uint64(block.timestamp)
        });

        emit RunSealed(runId, chainRoot, stepCount, outcome);
    }

    function sealOf(bytes32 runId)
        external
        view
        returns (bytes32 chainRoot, uint32 stepCount, uint8 outcome, uint64 sealedAt)
    {
        Seal storage seal = _seals[runId];
        return (seal.chainRoot, seal.stepCount, seal.outcome, seal.sealedAt);
    }

    function isSealed(bytes32 runId) external view returns (bool) {
        return _seals[runId].sealedAt != 0;
    }

    function isAnchored(bytes32 runId, uint32 stepIndex) external view returns (bool) {
        return _stepState[runId][stepIndex].statusPlusOne != 0;
    }

    /// @notice The anchored status of a step. Reverts for a step that was
    /// never anchored, so a caller cannot mistake "no receipt" for "status 0".
    /// That distinction is the whole design invariant (§1.3).
    function statusOf(bytes32 runId, uint32 stepIndex) external view returns (uint8) {
        StepState storage state = _stepState[runId][stepIndex];
        if (state.statusPlusOne == 0) revert StepNotAnchored(runId, stepIndex);
        return state.statusPlusOne - 1;
    }

    /// @notice The agent the receipt named. Reverts when unanchored, for the
    /// same reason `statusOf` does: agent 0 is a real token id, and returning
    /// it for a step that does not exist would let an escrow pay against a
    /// receipt nobody wrote.
    function agentIdOf(bytes32 runId, uint32 stepIndex) external view returns (uint256) {
        StepState storage state = _stepState[runId][stepIndex];
        if (state.statusPlusOne == 0) revert StepNotAnchored(runId, stepIndex);
        return state.agentId;
    }

    function inputHashOf(bytes32 runId, uint32 stepIndex) external view returns (bytes32) {
        StepState storage state = _stepState[runId][stepIndex];
        if (state.statusPlusOne == 0) revert StepNotAnchored(runId, stepIndex);
        return state.inputHash;
    }

    function outputHashOf(bytes32 runId, uint32 stepIndex) external view returns (bytes32) {
        StepState storage state = _stepState[runId][stepIndex];
        if (state.statusPlusOne == 0) revert StepNotAnchored(runId, stepIndex);
        return state.outputHash;
    }

    /// @notice Everything the escrow needs, in one call. Four separate reads
    /// of the same slots would cost four round trips and could in principle
    /// straddle a state change; this cannot.
    function stepOf(bytes32 runId, uint32 stepIndex)
        external
        view
        returns (uint8 status, uint256 agentId, bytes32 inputHash, bytes32 outputHash)
    {
        StepState storage state = _stepState[runId][stepIndex];
        if (state.statusPlusOne == 0) revert StepNotAnchored(runId, stepIndex);
        return (state.statusPlusOne - 1, state.agentId, state.inputHash, state.outputHash);
    }

    function anchoredCount(bytes32 runId) external view returns (uint32) {
        return _anchoredCount[runId];
    }
}
