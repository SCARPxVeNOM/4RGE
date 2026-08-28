// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExecutionReceiptsV2} from "../src/ExecutionReceiptsV2.sol";
import {ExecutionReceipts} from "../src/ExecutionReceipts.sol";
import {FlowRegistry} from "../src/FlowRegistry.sol";

/// v2 adds stored fields. These tests exist to prove it added *only* that —
/// the wire format, the hash and every v1 refusal must survive unchanged, or
/// runs anchored on v1 stop verifying.
contract ExecutionReceiptsV2Test is Test {
    FlowRegistry internal registry;
    ExecutionReceiptsV2 internal receipts;

    address internal executor = address(0xE1);
    address internal stranger = address(0xBAD);

    bytes32 internal constant FLOW_ID = bytes32(uint256(0x11));
    bytes32 internal constant RUN_ID = bytes32(uint256(0x22));

    function setUp() public {
        registry = new FlowRegistry();
        receipts = new ExecutionReceiptsV2(address(registry));

        registry.publishFlow(FLOW_ID, bytes32(uint256(0x12)), "v2-flow");
        vm.prank(executor);
        registry.startRun(FLOW_ID, RUN_ID, executor);
    }

    function _receipt(uint32 stepIndex, uint8 status)
        internal
        pure
        returns (ExecutionReceiptsV2.Receipt memory)
    {
        return ExecutionReceiptsV2.Receipt({
            flowId: FLOW_ID,
            runId: RUN_ID,
            stepIndex: stepIndex,
            agentId: 42,
            inputHash: keccak256("in"),
            outputHash: keccak256("out"),
            traceRoot: keccak256("trace"),
            attestationRef: bytes32(0),
            startedAt: 1_755_600_000,
            endedAt: 1_755_600_100,
            status: status
        });
    }

    function _anchor(uint32 stepIndex, uint8 status) internal {
        vm.prank(executor);
        receipts.anchorStep(_receipt(stepIndex, status));
    }

    // ---------------------------------------------------------------------
    // The compatibility that makes v2 safe to deploy alongside v1
    // ---------------------------------------------------------------------

    /// The same pinned vector as `ExecutionReceipts.t.sol` and
    /// `packages/core/test/receipt.test.ts`. If v2's struct drifted by so much
    /// as a field order, every chain root computed against it would diverge
    /// from the verifier's, and runs would fail verification for reasons
    /// pointing nowhere near the cause (§5.2).
    function test_ReceiptHashIsIdenticalToV1AndTypeScript() public pure {
        ExecutionReceiptsV2.Receipt memory r = ExecutionReceiptsV2.Receipt({
            flowId: 0x1111111111111111111111111111111111111111111111111111111111111111,
            runId: 0x2222222222222222222222222222222222222222222222222222222222222222,
            stepIndex: 7,
            agentId: 1,
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
            0x8a5999198c4052570e862e464f36fe4af19f8f7211909027c89f72cee501a26d,
            "v2 receipt hash diverged from v1 and the TypeScript core"
        );
    }

    /// A stronger form of the same claim: the two structs are the same bytes
    /// for arbitrary field values, not just for the pinned one.
    function testFuzz_ReceiptEncodingMatchesV1(
        bytes32 flowId,
        bytes32 runId,
        uint32 stepIndex,
        uint256 agentId,
        bytes32 inputHash,
        bytes32 outputHash,
        uint64 startedAt
    ) public pure {
        ExecutionReceiptsV2.Receipt memory v2 = ExecutionReceiptsV2.Receipt({
            flowId: flowId,
            runId: runId,
            stepIndex: stepIndex,
            agentId: agentId,
            inputHash: inputHash,
            outputHash: outputHash,
            traceRoot: bytes32(0),
            attestationRef: bytes32(0),
            startedAt: startedAt,
            endedAt: startedAt,
            status: 0
        });
        ExecutionReceipts.Receipt memory v1 = ExecutionReceipts.Receipt({
            flowId: flowId,
            runId: runId,
            stepIndex: stepIndex,
            agentId: agentId,
            inputHash: inputHash,
            outputHash: outputHash,
            traceRoot: bytes32(0),
            attestationRef: bytes32(0),
            startedAt: startedAt,
            endedAt: startedAt,
            status: 0
        });
        assertEq(keccak256(abi.encode(v2)), keccak256(abi.encode(v1)));
    }

    // ---------------------------------------------------------------------
    // What v2 exists for
    // ---------------------------------------------------------------------

    function test_StoresAgentIdAndHashesForOnChainReaders() public {
        _anchor(0, 0);

        assertEq(receipts.agentIdOf(RUN_ID, 0), 42);
        assertEq(receipts.inputHashOf(RUN_ID, 0), keccak256("in"));
        assertEq(receipts.outputHashOf(RUN_ID, 0), keccak256("out"));

        (uint8 status, uint256 agentId, bytes32 inputHash, bytes32 outputHash) =
            receipts.stepOf(RUN_ID, 0);
        assertEq(status, 0);
        assertEq(agentId, 42);
        assertEq(inputHash, keccak256("in"));
        assertEq(outputHash, keccak256("out"));
    }

    /// Agent 0 is a real ERC-721 token id. If an unanchored step returned it
    /// instead of reverting, an escrow could pay against a receipt nobody
    /// wrote — the §1.3 distinction, applied to the new accessors.
    function test_AccessorsRevertWhenUnanchored() public {
        bytes4 err = ExecutionReceiptsV2.StepNotAnchored.selector;

        vm.expectRevert(abi.encodeWithSelector(err, RUN_ID, uint32(0)));
        receipts.agentIdOf(RUN_ID, 0);
        vm.expectRevert(abi.encodeWithSelector(err, RUN_ID, uint32(0)));
        receipts.inputHashOf(RUN_ID, 0);
        vm.expectRevert(abi.encodeWithSelector(err, RUN_ID, uint32(0)));
        receipts.outputHashOf(RUN_ID, 0);
        vm.expectRevert(abi.encodeWithSelector(err, RUN_ID, uint32(0)));
        receipts.stepOf(RUN_ID, 0);
        vm.expectRevert(abi.encodeWithSelector(err, RUN_ID, uint32(0)));
        receipts.statusOf(RUN_ID, 0);
    }

    /// Status 0 is "ok". A step anchored with status 0 must still read as
    /// anchored — the encoding is status+1 precisely so these do not collide.
    function test_StatusZeroIsDistinguishableFromUnanchored() public {
        assertFalse(receipts.isAnchored(RUN_ID, 0));
        _anchor(0, 0);
        assertTrue(receipts.isAnchored(RUN_ID, 0));
        assertEq(receipts.statusOf(RUN_ID, 0), 0);
    }

    function test_StoresAgentZeroWithoutLosingAnchoredness() public {
        ExecutionReceiptsV2.Receipt memory r = _receipt(0, 0);
        r.agentId = 0;
        vm.prank(executor);
        receipts.anchorStep(r);

        assertTrue(receipts.isAnchored(RUN_ID, 0));
        assertEq(receipts.agentIdOf(RUN_ID, 0), 0);
    }

    // ---------------------------------------------------------------------
    // Every v1 refusal, still refused
    // ---------------------------------------------------------------------

    function test_OnlyExecutorMayAnchor() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                ExecutionReceiptsV2.NotRunExecutor.selector, RUN_ID, stranger, executor
            )
        );
        receipts.anchorStep(_receipt(0, 0));
    }

    function test_DuplicateStepReverts() public {
        _anchor(0, 0);
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                ExecutionReceiptsV2.StepAlreadyAnchored.selector, RUN_ID, uint32(0)
            )
        );
        receipts.anchorStep(_receipt(0, 0));
    }

    function test_UnknownStatusReverts() public {
        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(ExecutionReceiptsV2.UnknownStatus.selector, 4));
        receipts.anchorStep(_receipt(0, 4));
    }

    function test_FlowMismatchReverts() public {
        ExecutionReceiptsV2.Receipt memory r = _receipt(0, 0);
        r.flowId = bytes32(uint256(0x99));
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                ExecutionReceiptsV2.FlowMismatch.selector, RUN_ID, bytes32(uint256(0x99)), FLOW_ID
            )
        );
        receipts.anchorStep(r);
    }

    function test_InvertedTimestampsRevert() public {
        ExecutionReceiptsV2.Receipt memory r = _receipt(0, 0);
        r.endedAt = r.startedAt - 1;
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                ExecutionReceiptsV2.InvalidTimestamps.selector, r.startedAt, r.endedAt
            )
        );
        receipts.anchorStep(r);
    }

    function test_SealingFixesTheRunAndBlocksLateAnchors() public {
        _anchor(0, 0);
        _anchor(1, 1);

        vm.prank(executor);
        receipts.sealRun(RUN_ID, keccak256("root"), 2, 1);

        assertTrue(receipts.isSealed(RUN_ID));
        (bytes32 root, uint32 count, uint8 outcome, uint64 at) = receipts.sealOf(RUN_ID);
        assertEq(root, keccak256("root"));
        assertEq(count, 2);
        assertEq(outcome, 1);
        assertGt(at, 0);

        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(ExecutionReceiptsV2.RunAlreadySealed.selector, RUN_ID)
        );
        receipts.anchorStep(_receipt(2, 0));
    }

    function test_SealMustMatchAnchoredCount() public {
        _anchor(0, 0);
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                ExecutionReceiptsV2.StepCountMismatch.selector, RUN_ID, uint32(5), uint32(1)
            )
        );
        receipts.sealRun(RUN_ID, keccak256("root"), 5, 0);
    }

    function test_SealingTwiceReverts() public {
        vm.prank(executor);
        receipts.sealRun(RUN_ID, keccak256("root"), 0, 0);
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(ExecutionReceiptsV2.RunAlreadySealed.selector, RUN_ID)
        );
        receipts.sealRun(RUN_ID, keccak256("root"), 0, 0);
    }

    function test_EventIsEmittedWithEveryReceiptField() public {
        vm.expectEmit(true, true, true, true);
        emit ExecutionReceiptsV2.StepAnchored(
            FLOW_ID,
            RUN_ID,
            0,
            42,
            keccak256("in"),
            keccak256("out"),
            keccak256("trace"),
            bytes32(0),
            1_755_600_000,
            1_755_600_100,
            0
        );
        _anchor(0, 0);
    }
}
