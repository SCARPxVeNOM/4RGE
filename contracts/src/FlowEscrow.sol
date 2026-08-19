// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ExecutionReceipts} from "./ExecutionReceipts.sol";

/// @title FlowEscrow
/// @notice Payment held against verifiable execution — spec §4.4.
///
/// Funds release only against an anchored receipt with status ok. This is
/// where a receipt performs economic work rather than serving as a log: an
/// unattested step (status 3) is not a success, and so it does not get paid.
contract FlowEscrow {
    uint8 internal constant STATUS_OK = 0;
    uint8 internal constant OUTCOME_OK = 0;

    struct Funding {
        address funder;
        uint256 unreleased;
        bool refunded;
        bool exists;
    }

    ExecutionReceipts public immutable receipts;

    mapping(bytes32 => Funding) private _funding;
    /// runId => stepIndex => payee
    mapping(bytes32 => mapping(uint32 => address)) private _payee;
    /// runId => stepIndex => amount
    mapping(bytes32 => mapping(uint32 => uint256)) private _amount;
    /// runId => stepIndex => released
    mapping(bytes32 => mapping(uint32 => bool)) private _released;

    event RunFunded(bytes32 indexed runId, address indexed funder, uint256 total, uint256 stepCount);
    event StepReleased(
        bytes32 indexed runId, uint32 indexed stepIndex, address indexed payee, uint256 amount
    );
    event RunRefunded(bytes32 indexed runId, address indexed funder, uint256 amount);

    error RunAlreadyFunded(bytes32 runId);
    error RunNotFunded(bytes32 runId);
    error LengthMismatch(uint256 payees, uint256 amounts);
    error ValueMismatch(uint256 sent, uint256 expected);
    error NoPayeeForStep(bytes32 runId, uint32 stepIndex);
    error StepNotSuccessful(bytes32 runId, uint32 stepIndex, uint8 status);
    error StepAlreadyReleased(bytes32 runId, uint32 stepIndex);
    error RunNotSealed(bytes32 runId);
    error RunSucceeded(bytes32 runId);
    error AlreadyRefunded(bytes32 runId);
    error TransferFailed(address to, uint256 amount);

    constructor(address receipts_) {
        receipts = ExecutionReceipts(receipts_);
    }

    /// @notice Escrows payment for a run, one payee and amount per stepIndex.
    function fundRun(bytes32 runId, address[] calldata payees, uint256[] calldata amounts)
        external
        payable
    {
        if (_funding[runId].exists) revert RunAlreadyFunded(runId);
        if (payees.length != amounts.length) revert LengthMismatch(payees.length, amounts.length);

        uint256 total;
        for (uint256 i = 0; i < payees.length; i++) {
            total += amounts[i];
            _payee[runId][uint32(i)] = payees[i];
            _amount[runId][uint32(i)] = amounts[i];
        }
        if (msg.value != total) revert ValueMismatch(msg.value, total);

        _funding[runId] =
            Funding({funder: msg.sender, unreleased: total, refunded: false, exists: true});

        emit RunFunded(runId, msg.sender, total, payees.length);
    }

    /// @notice Pays the step's payee, if and only if the step has an anchored
    /// receipt with status ok. Permissionless: the receipt decides, not the
    /// caller.
    function releaseStep(bytes32 runId, uint32 stepIndex) external {
        Funding storage funding = _funding[runId];
        if (!funding.exists) revert RunNotFunded(runId);
        if (funding.refunded) revert AlreadyRefunded(runId);
        if (_released[runId][stepIndex]) revert StepAlreadyReleased(runId, stepIndex);

        address payee = _payee[runId][stepIndex];
        if (payee == address(0)) revert NoPayeeForStep(runId, stepIndex);

        // Reverts if the step was never anchored, so an absent receipt can
        // never be mistaken for a successful one.
        uint8 status = receipts.statusOf(runId, stepIndex);
        if (status != STATUS_OK) revert StepNotSuccessful(runId, stepIndex, status);

        uint256 amount = _amount[runId][stepIndex];

        // Effects before interaction.
        _released[runId][stepIndex] = true;
        funding.unreleased -= amount;

        emit StepReleased(runId, stepIndex, payee, amount);

        (bool sent,) = payee.call{value: amount}("");
        if (!sent) revert TransferFailed(payee, amount);
    }

    /// @notice Returns everything not released, once the run is sealed with a
    /// non-ok outcome.
    function refundUnspent(bytes32 runId) external {
        Funding storage funding = _funding[runId];
        if (!funding.exists) revert RunNotFunded(runId);
        if (funding.refunded) revert AlreadyRefunded(runId);

        (, , uint8 outcome, uint64 sealedAt) = receipts.sealOf(runId);
        if (sealedAt == 0) revert RunNotSealed(runId);
        if (outcome == OUTCOME_OK) revert RunSucceeded(runId);

        uint256 amount = funding.unreleased;

        funding.refunded = true;
        funding.unreleased = 0;

        emit RunRefunded(runId, funding.funder, amount);

        (bool sent,) = funding.funder.call{value: amount}("");
        if (!sent) revert TransferFailed(funding.funder, amount);
    }

    function unreleasedOf(bytes32 runId) external view returns (uint256) {
        return _funding[runId].unreleased;
    }

    function payeeOf(bytes32 runId, uint32 stepIndex) external view returns (address) {
        return _payee[runId][stepIndex];
    }

    function amountOf(bytes32 runId, uint32 stepIndex) external view returns (uint256) {
        return _amount[runId][stepIndex];
    }

    function isReleased(bytes32 runId, uint32 stepIndex) external view returns (bool) {
        return _released[runId][stepIndex];
    }
}
