// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExecutionReceipts} from "../src/ExecutionReceipts.sol";
import {FlowRegistry} from "../src/FlowRegistry.sol";
import {ChainRoot} from "../src/lib/ChainRoot.sol";

contract ExecutionReceiptsTest is Test {
    FlowRegistry internal registry;
    ExecutionReceipts internal receipts;

    address internal executor = address(0xE1);
    address internal stranger = address(0xBAD);
    address internal agent = address(0xAA);

    bytes32 internal constant FLOW_ID = bytes32(uint256(0x11));
    bytes32 internal constant SPEC_ROOT = bytes32(uint256(0x12));
    bytes32 internal constant RUN_ID = bytes32(uint256(0x22));

    event StepAnchored(
        bytes32 indexed flowId,
        bytes32 indexed runId,
        uint32 indexed stepIndex,
        address agentId,
        bytes32 inputHash,
        bytes32 outputHash,
        bytes32 traceRoot,
        bytes32 attestationRef,
        uint64 startedAt,
        uint64 endedAt,
        uint8 status
    );

    event RunSealed(bytes32 indexed runId, bytes32 chainRoot, uint32 stepCount, uint8 outcome);

    function setUp() public {
        registry = new FlowRegistry();
        receipts = new ExecutionReceipts(address(registry));

        registry.publishFlow(FLOW_ID, SPEC_ROOT, "audit-summarize-publish");
        vm.prank(executor);
        registry.startRun(FLOW_ID, RUN_ID, executor);
    }

    function _receipt(uint32 stepIndex, uint8 status)
        internal
        view
        returns (ExecutionReceipts.Receipt memory)
    {
        return ExecutionReceipts.Receipt({
            flowId: FLOW_ID,
            runId: RUN_ID,
            stepIndex: stepIndex,
            agentId: agent,
            inputHash: keccak256(abi.encodePacked("input", stepIndex)),
            outputHash: keccak256(abi.encodePacked("output", stepIndex)),
            traceRoot: keccak256(abi.encodePacked("trace", stepIndex)),
            attestationRef: bytes32(0),
            startedAt: 1_755_600_000,
            endedAt: 1_755_600_100,
            status: status
        });
    }

    // ---------------------------------------------------------------------
    // Cross-language encoding (§5.2)
    // ---------------------------------------------------------------------

    // The single most important assertion in the contract suite: if Solidity
    // and the TypeScript core disagree on this encoding, every chain root
    // diverges and every run fails verification for reasons that point nowhere
    // near the cause. The expected value is pinned in
    // packages/core/test/receipt.test.ts.
    function test_ReceiptHashMatchesTypeScriptCore() public pure {
        ExecutionReceipts.Receipt memory r = ExecutionReceipts.Receipt({
            flowId: 0x1111111111111111111111111111111111111111111111111111111111111111,
            runId: 0x2222222222222222222222222222222222222222222222222222222222222222,
            stepIndex: 7,
            agentId: 0x00000000000000000000000000000000000000AA,
            inputHash: 0x3333333333333333333333333333333333333333333333333333333333333333,
            outputHash: 0x4444444444444444444444444444444444444444444444444444444444444444,
            traceRoot: 0x5555555555555555555555555555555555555555555555555555555555555555,
            attestationRef: bytes32(0),
            startedAt: 1_755_600_000,
            endedAt: 1_755_600_123,
            status: 3
        });

        assertEq(abi.encode(r).length, 11 * 32, "receipt must encode as 11 static words");
        assertEq(
            keccak256(abi.encode(r)),
            0x71574db4cd51506383f8a17050b5e5e63df758c656363598e85f74e4ce831de0,
            "receipt hash diverged from @0gflow/core"
        );
    }

    // ---------------------------------------------------------------------
    // Anchoring
    // ---------------------------------------------------------------------

    function test_AnchorStepEmitsEveryReceiptField() public {
        ExecutionReceipts.Receipt memory r = _receipt(0, 0);

        vm.expectEmit(true, true, true, true);
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

        vm.prank(executor);
        receipts.anchorStep(r);
    }

    function test_AnchorStepRevertsOnDuplicateStepIndex() public {
        vm.startPrank(executor);
        receipts.anchorStep(_receipt(0, 0));
        vm.expectRevert(
            abi.encodeWithSelector(ExecutionReceipts.StepAlreadyAnchored.selector, RUN_ID, uint32(0))
        );
        receipts.anchorStep(_receipt(0, 0));
        vm.stopPrank();
    }

    /// A worker resuming after a crash must not double-anchor, even if the
    /// receipt it re-submits differs from the one already on chain.
    function test_AnchorStepRevertsOnDuplicateEvenWithDifferentContents() public {
        vm.startPrank(executor);
        receipts.anchorStep(_receipt(0, 0));
        vm.expectRevert();
        receipts.anchorStep(_receipt(0, 1));
        vm.stopPrank();
    }

    function test_AnchorStepAllowsDistinctStepIndices() public {
        vm.startPrank(executor);
        receipts.anchorStep(_receipt(0, 0));
        receipts.anchorStep(_receipt(1, 0));
        receipts.anchorStep(_receipt(2, 0));
        vm.stopPrank();
        assertEq(receipts.anchoredCount(RUN_ID), 3);
    }

    /// Without this, anyone could anchor step 0 of someone else's run first and
    /// permanently block it, because duplicates revert.
    function test_AnchorStepRevertsForNonExecutor() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                ExecutionReceipts.NotRunExecutor.selector, RUN_ID, stranger, executor
            )
        );
        receipts.anchorStep(_receipt(0, 0));
    }

    function test_AnchorStepRevertsForUnknownRun() public {
        ExecutionReceipts.Receipt memory r = _receipt(0, 0);
        r.runId = bytes32(uint256(0xDEAD));
        vm.prank(executor);
        vm.expectRevert();
        receipts.anchorStep(r);
    }

    function test_AnchorStepRevertsWhenFlowIdDoesNotMatchTheRun() public {
        ExecutionReceipts.Receipt memory r = _receipt(0, 0);
        r.flowId = bytes32(uint256(0x99));
        vm.prank(executor);
        vm.expectRevert();
        receipts.anchorStep(r);
    }

    function test_AnchorStepRevertsOnUnknownStatus() public {
        vm.prank(executor);
        vm.expectRevert();
        receipts.anchorStep(_receipt(0, 4));
    }

    function test_AnchorStepAcceptsEveryDefinedStatus() public {
        vm.startPrank(executor);
        for (uint8 status = 0; status <= 3; status++) {
            receipts.anchorStep(_receipt(status, status));
        }
        vm.stopPrank();
        assertEq(receipts.anchoredCount(RUN_ID), 4);
    }

    // ---------------------------------------------------------------------
    // Sealing
    // ---------------------------------------------------------------------

    function test_SealRunRecordsTheSeal() public {
        bytes32 root = keccak256("chain-root");
        vm.startPrank(executor);
        receipts.anchorStep(_receipt(0, 0));
        vm.expectEmit(true, false, false, true);
        emit RunSealed(RUN_ID, root, 1, 0);
        receipts.sealRun(RUN_ID, root, 1, 0);
        vm.stopPrank();

        (bytes32 chainRoot, uint32 stepCount, uint8 outcome, uint64 sealedAt) =
            receipts.sealOf(RUN_ID);
        assertEq(chainRoot, root);
        assertEq(stepCount, 1);
        assertEq(outcome, 0);
        assertEq(sealedAt, uint64(block.timestamp));
    }

    function test_SealRunRevertsWhenAlreadySealed() public {
        vm.startPrank(executor);
        receipts.anchorStep(_receipt(0, 0));
        receipts.sealRun(RUN_ID, bytes32(uint256(1)), 1, 0);
        vm.expectRevert();
        receipts.sealRun(RUN_ID, bytes32(uint256(2)), 1, 0);
        vm.stopPrank();
    }

    function test_SealRunRevertsForNonExecutor() public {
        vm.prank(executor);
        receipts.anchorStep(_receipt(0, 0));
        vm.prank(stranger);
        vm.expectRevert();
        receipts.sealRun(RUN_ID, bytes32(uint256(1)), 1, 0);
    }

    /// A seal claiming more steps than were anchored would let an executor
    /// present a root folded over receipts nobody can find.
    function test_SealRunRevertsWhenStepCountDisagreesWithAnchors() public {
        vm.startPrank(executor);
        receipts.anchorStep(_receipt(0, 0));
        vm.expectRevert();
        receipts.sealRun(RUN_ID, bytes32(uint256(1)), 2, 0);
        vm.stopPrank();
    }

    function test_AnchorStepRevertsAfterSeal() public {
        vm.startPrank(executor);
        receipts.anchorStep(_receipt(0, 0));
        receipts.sealRun(RUN_ID, bytes32(uint256(1)), 1, 0);
        vm.expectRevert();
        receipts.anchorStep(_receipt(1, 0));
        vm.stopPrank();
    }

    function test_SealOfIsZeroForUnsealedRun() public view {
        (bytes32 chainRoot,, , uint64 sealedAt) = receipts.sealOf(RUN_ID);
        assertEq(chainRoot, bytes32(0));
        assertEq(sealedAt, 0);
    }

    function test_IsSealedReflectsState() public {
        assertFalse(receipts.isSealed(RUN_ID));
        vm.startPrank(executor);
        receipts.anchorStep(_receipt(0, 0));
        receipts.sealRun(RUN_ID, bytes32(uint256(1)), 1, 0);
        vm.stopPrank();
        assertTrue(receipts.isSealed(RUN_ID));
    }

    // ---------------------------------------------------------------------
    // Chain root (§1.1, §10.1)
    // ---------------------------------------------------------------------

    /// Receipts fold in ascending stepIndex order, so the root does not depend
    /// on which branch of a parallel run completed first.
    function test_ChainRootIsIndependentOfAnchoringOrder() public {
        ExecutionReceipts.Receipt memory s0 = _receipt(0, 0);
        ExecutionReceipts.Receipt memory s1 = _receipt(1, 0);
        ExecutionReceipts.Receipt memory s2 = _receipt(2, 0);

        bytes32[] memory leaves = new bytes32[](3);
        leaves[0] = keccak256(abi.encode(s0));
        leaves[1] = keccak256(abi.encode(s1));
        leaves[2] = keccak256(abi.encode(s2));
        bytes32 expected = ChainRoot.fold(leaves);

        // Anchor out of order, as a parallel branch would.
        vm.startPrank(executor);
        receipts.anchorStep(s2);
        receipts.anchorStep(s0);
        receipts.anchorStep(s1);
        receipts.sealRun(RUN_ID, expected, 3, 0);
        vm.stopPrank();

        (bytes32 chainRoot,,,) = receipts.sealOf(RUN_ID);
        assertEq(chainRoot, expected);
    }

    function test_ChainRootFoldMatchesTheSpecFormula() public pure {
        bytes32 a = keccak256("a");
        bytes32 b = keccak256("b");
        bytes32[] memory leaves = new bytes32[](2);
        leaves[0] = a;
        leaves[1] = b;
        assertEq(ChainRoot.fold(leaves), keccak256(abi.encodePacked(a, b)));
    }

    function test_ChainRootFoldIsNotCommutative() public pure {
        bytes32[] memory ab = new bytes32[](2);
        ab[0] = keccak256("a");
        ab[1] = keccak256("b");
        bytes32[] memory ba = new bytes32[](2);
        ba[0] = keccak256("b");
        ba[1] = keccak256("a");
        assertTrue(ChainRoot.fold(ab) != ChainRoot.fold(ba));
    }

    /// §10.1 tamper detection: mutating any receipt field moves the root.
    function testFuzz_ChainRootChangesWhenAnyReceiptFieldChanges(
        bytes32 newOutputHash,
        uint64 newEndedAt
    ) public view {
        ExecutionReceipts.Receipt memory s0 = _receipt(0, 0);
        bytes32[] memory original = new bytes32[](1);
        original[0] = keccak256(abi.encode(s0));

        vm.assume(newOutputHash != s0.outputHash);
        s0.outputHash = newOutputHash;
        bytes32[] memory tamperedOutput = new bytes32[](1);
        tamperedOutput[0] = keccak256(abi.encode(s0));
        assertTrue(ChainRoot.fold(original) != ChainRoot.fold(tamperedOutput));

        s0 = _receipt(0, 0);
        vm.assume(newEndedAt != s0.endedAt);
        s0.endedAt = newEndedAt;
        bytes32[] memory tamperedTime = new bytes32[](1);
        tamperedTime[0] = keccak256(abi.encode(s0));
        assertTrue(ChainRoot.fold(original) != ChainRoot.fold(tamperedTime));
    }

    function test_ChainRootRevertsOnEmptyLeafSet() public {
        bytes32[] memory none = new bytes32[](0);
        vm.expectRevert();
        this.foldExternal(none);
    }

    function foldExternal(bytes32[] calldata leaves) external pure returns (bytes32) {
        return ChainRoot.fold(leaves);
    }
}
