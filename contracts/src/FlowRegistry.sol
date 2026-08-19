// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title FlowRegistry
/// @notice Publishes workflow specs and opens runs against them — spec §4.2.
///
/// flowId = keccak256(canonicalize(spec)). The spec body lives on 0G Storage;
/// only its root goes on chain, so anyone holding the spec can prove which
/// flow a run executed.
contract FlowRegistry {
    struct Flow {
        address owner;
        bytes32 specRoot;
        string name;
        uint64 publishedAt;
    }

    struct Run {
        bytes32 flowId;
        address executor;
        uint64 startedAt;
    }

    mapping(bytes32 => Flow) private _flows;
    mapping(bytes32 => Run) private _runs;

    event FlowPublished(
        bytes32 indexed flowId,
        address indexed owner,
        bytes32 specRoot,
        string name,
        uint64 publishedAt
    );

    event RunStarted(
        bytes32 indexed flowId, bytes32 indexed runId, address indexed executor, uint64 startedAt
    );

    error FlowAlreadyPublished(bytes32 flowId);
    error FlowNotPublished(bytes32 flowId);
    error RunAlreadyStarted(bytes32 runId);
    error RunNotStarted(bytes32 runId);
    error ZeroValue();

    /// @notice Publishes a flow. Permissionless: the flowId is the hash of the
    /// spec, so publishing one you did not author only records that hash.
    function publishFlow(bytes32 flowId, bytes32 specRoot, string calldata name) external {
        if (flowId == bytes32(0) || specRoot == bytes32(0)) revert ZeroValue();
        if (_flows[flowId].publishedAt != 0) revert FlowAlreadyPublished(flowId);

        _flows[flowId] =
            Flow({owner: msg.sender, specRoot: specRoot, name: name, publishedAt: uint64(block.timestamp)});

        emit FlowPublished(flowId, msg.sender, specRoot, name, uint64(block.timestamp));
    }

    /// @notice Opens a run of a published flow and names the executor
    /// permitted to anchor its receipts.
    function startRun(bytes32 flowId, bytes32 runId, address executor) external {
        if (runId == bytes32(0) || executor == address(0)) revert ZeroValue();
        if (_flows[flowId].publishedAt == 0) revert FlowNotPublished(flowId);
        if (_runs[runId].startedAt != 0) revert RunAlreadyStarted(runId);

        _runs[runId] =
            Run({flowId: flowId, executor: executor, startedAt: uint64(block.timestamp)});

        emit RunStarted(flowId, runId, executor, uint64(block.timestamp));
    }

    function flows(bytes32 flowId)
        external
        view
        returns (address owner, bytes32 specRoot, string memory name, uint64 publishedAt)
    {
        Flow storage flow = _flows[flowId];
        return (flow.owner, flow.specRoot, flow.name, flow.publishedAt);
    }

    function runs(bytes32 runId)
        external
        view
        returns (bytes32 flowId, address executor, uint64 startedAt)
    {
        Run storage run = _runs[runId];
        return (run.flowId, run.executor, run.startedAt);
    }

    /// @notice The executor permitted to anchor receipts for a run. Reverts
    /// rather than returning address(0) for an unknown run, so a caller cannot
    /// mistake "no such run" for "no restriction".
    function executorOf(bytes32 runId) external view returns (address) {
        Run storage run = _runs[runId];
        if (run.startedAt == 0) revert RunNotStarted(runId);
        return run.executor;
    }

    function flowOf(bytes32 runId) external view returns (bytes32) {
        Run storage run = _runs[runId];
        if (run.startedAt == 0) revert RunNotStarted(runId);
        return run.flowId;
    }

    function isPublished(bytes32 flowId) external view returns (bool) {
        return _flows[flowId].publishedAt != 0;
    }
}
