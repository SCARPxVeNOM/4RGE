// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlowRegistry} from "../src/FlowRegistry.sol";

contract FlowRegistryTest is Test {
    FlowRegistry internal registry;

    address internal author = address(0x01);
    address internal executor = address(0xE1);

    bytes32 internal constant FLOW_ID = bytes32(uint256(0x11));
    bytes32 internal constant SPEC_ROOT = bytes32(uint256(0x12));
    bytes32 internal constant RUN_ID = bytes32(uint256(0x22));

    function setUp() public {
        registry = new FlowRegistry();
    }

    function test_PublishFlowRecordsOwnerAndSpecRoot() public {
        vm.prank(author);
        registry.publishFlow(FLOW_ID, SPEC_ROOT, "audit-summarize-publish");

        (address owner, bytes32 specRoot, string memory name, uint64 publishedAt) =
            registry.flows(FLOW_ID);
        assertEq(owner, author);
        assertEq(specRoot, SPEC_ROOT);
        assertEq(name, "audit-summarize-publish");
        assertEq(publishedAt, uint64(block.timestamp));
    }

    function test_PublishFlowRevertsWhenAlreadyPublished() public {
        registry.publishFlow(FLOW_ID, SPEC_ROOT, "a");
        vm.expectRevert(
            abi.encodeWithSelector(FlowRegistry.FlowAlreadyPublished.selector, FLOW_ID)
        );
        registry.publishFlow(FLOW_ID, SPEC_ROOT, "a");
    }

    function test_PublishFlowRejectsZeroIdentifiers() public {
        vm.expectRevert(FlowRegistry.ZeroValue.selector);
        registry.publishFlow(bytes32(0), SPEC_ROOT, "a");
        vm.expectRevert(FlowRegistry.ZeroValue.selector);
        registry.publishFlow(FLOW_ID, bytes32(0), "a");
    }

    function test_StartRunRecordsTheExecutor() public {
        registry.publishFlow(FLOW_ID, SPEC_ROOT, "a");
        registry.startRun(FLOW_ID, RUN_ID, executor);

        (bytes32 flowId, address recordedExecutor, uint64 startedAt) = registry.runs(RUN_ID);
        assertEq(flowId, FLOW_ID);
        assertEq(recordedExecutor, executor);
        assertEq(startedAt, uint64(block.timestamp));
        assertEq(registry.executorOf(RUN_ID), executor);
        assertEq(registry.flowOf(RUN_ID), FLOW_ID);
    }

    function test_StartRunRevertsForUnpublishedFlow() public {
        vm.expectRevert(abi.encodeWithSelector(FlowRegistry.FlowNotPublished.selector, FLOW_ID));
        registry.startRun(FLOW_ID, RUN_ID, executor);
    }

    function test_StartRunRevertsOnDuplicateRunId() public {
        registry.publishFlow(FLOW_ID, SPEC_ROOT, "a");
        registry.startRun(FLOW_ID, RUN_ID, executor);
        vm.expectRevert(abi.encodeWithSelector(FlowRegistry.RunAlreadyStarted.selector, RUN_ID));
        registry.startRun(FLOW_ID, RUN_ID, executor);
    }

    function test_StartRunRejectsZeroExecutor() public {
        registry.publishFlow(FLOW_ID, SPEC_ROOT, "a");
        vm.expectRevert(FlowRegistry.ZeroValue.selector);
        registry.startRun(FLOW_ID, RUN_ID, address(0));
    }

    /// Returning address(0) here would let a caller read "unknown run" as "no
    /// executor restriction", which is exactly the check ExecutionReceipts
    /// relies on.
    function test_ExecutorOfRevertsForUnknownRun() public {
        vm.expectRevert(abi.encodeWithSelector(FlowRegistry.RunNotStarted.selector, RUN_ID));
        registry.executorOf(RUN_ID);
    }

    function test_FlowOfRevertsForUnknownRun() public {
        vm.expectRevert(abi.encodeWithSelector(FlowRegistry.RunNotStarted.selector, RUN_ID));
        registry.flowOf(RUN_ID);
    }

    function test_IsPublishedReflectsState() public {
        assertFalse(registry.isPublished(FLOW_ID));
        registry.publishFlow(FLOW_ID, SPEC_ROOT, "a");
        assertTrue(registry.isPublished(FLOW_ID));
    }

    /// Publishing is permissionless: flowId is the hash of the spec, so
    /// publishing one you did not author only records that hash.
    function test_AnyoneMayPublishAFlow() public {
        vm.prank(address(0xBEEF));
        registry.publishFlow(FLOW_ID, SPEC_ROOT, "a");
        (address owner,,,) = registry.flows(FLOW_ID);
        assertEq(owner, address(0xBEEF));
    }
}
