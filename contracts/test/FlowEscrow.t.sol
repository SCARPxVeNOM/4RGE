// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExecutionReceipts} from "../src/ExecutionReceipts.sol";
import {FlowRegistry} from "../src/FlowRegistry.sol";
import {FlowEscrow} from "../src/FlowEscrow.sol";

contract FlowEscrowTest is Test {
    FlowRegistry internal registry;
    ExecutionReceipts internal receipts;
    FlowEscrow internal escrow;

    address internal executor = address(0xE1);
    address internal funder = address(0xF1);
    address internal agentA = address(0xA1);
    address internal agentB = address(0xA2);

    bytes32 internal constant FLOW_ID = bytes32(uint256(0x11));
    bytes32 internal constant RUN_ID = bytes32(uint256(0x22));

    function setUp() public {
        registry = new FlowRegistry();
        receipts = new ExecutionReceipts(address(registry));
        escrow = new FlowEscrow(address(receipts));

        registry.publishFlow(FLOW_ID, bytes32(uint256(0x12)), "paid-flow");
        vm.prank(executor);
        registry.startRun(FLOW_ID, RUN_ID, executor);

        vm.deal(funder, 10 ether);
    }

    function _fund() internal {
        address[] memory payees = new address[](2);
        payees[0] = agentA;
        payees[1] = agentB;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1 ether;
        amounts[1] = 2 ether;

        vm.prank(funder);
        escrow.fundRun{value: 3 ether}(RUN_ID, payees, amounts);
    }

    function _anchor(uint32 stepIndex, uint8 status) internal {
        vm.prank(executor);
        receipts.anchorStep(
            ExecutionReceipts.Receipt({
                flowId: FLOW_ID,
                runId: RUN_ID,
                stepIndex: stepIndex,
                agentId: agentA,
                inputHash: keccak256("in"),
                outputHash: keccak256("out"),
                traceRoot: keccak256("trace"),
                attestationRef: bytes32(0),
                startedAt: 1_755_600_000,
                endedAt: 1_755_600_100,
                status: status
            })
        );
    }

    function _seal(uint8 outcome, uint32 stepCount) internal {
        vm.prank(executor);
        receipts.sealRun(RUN_ID, keccak256("root"), stepCount, outcome);
    }

    // ---------------------------------------------------------------------
    // Funding
    // ---------------------------------------------------------------------

    function test_FundRunHoldsTheFullAmount() public {
        _fund();
        assertEq(address(escrow).balance, 3 ether);
        assertEq(escrow.unreleasedOf(RUN_ID), 3 ether);
    }

    function test_FundRunRevertsWhenValueDoesNotMatchTheSum() public {
        address[] memory payees = new address[](1);
        payees[0] = agentA;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1 ether;

        vm.prank(funder);
        vm.expectRevert();
        escrow.fundRun{value: 2 ether}(RUN_ID, payees, amounts);
    }

    function test_FundRunRevertsOnMismatchedArrayLengths() public {
        address[] memory payees = new address[](2);
        uint256[] memory amounts = new uint256[](1);
        vm.prank(funder);
        vm.expectRevert();
        escrow.fundRun{value: 0}(RUN_ID, payees, amounts);
    }

    function test_FundRunRevertsWhenAlreadyFunded() public {
        _fund();
        address[] memory payees = new address[](1);
        payees[0] = agentA;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = 1 ether;
        vm.prank(funder);
        vm.expectRevert();
        escrow.fundRun{value: 1 ether}(RUN_ID, payees, amounts);
    }

    // ---------------------------------------------------------------------
    // Release — the receipt performing economic work (§4.4)
    // ---------------------------------------------------------------------

    function test_ReleaseStepPaysThePayeeForAnOkReceipt() public {
        _fund();
        _anchor(0, 0);

        uint256 before = agentA.balance;
        escrow.releaseStep(RUN_ID, 0);
        assertEq(agentA.balance - before, 1 ether);
        assertEq(escrow.unreleasedOf(RUN_ID), 2 ether);
    }

    function test_ReleaseStepRevertsWithoutAnAnchoredReceipt() public {
        _fund();
        vm.expectRevert();
        escrow.releaseStep(RUN_ID, 0);
    }

    /// The economic core of the design invariant: money only moves against a
    /// receipt a third party can verify.
    function test_ReleaseStepRevertsForEveryNonOkStatus() public {
        _fund();
        for (uint8 status = 1; status <= 3; status++) {
            uint32 stepIndex = uint32(status);
            _anchor(stepIndex, status);
            vm.expectRevert();
            escrow.releaseStep(RUN_ID, stepIndex);
        }
    }

    function test_ReleaseStepRevertsForAnUnattestedReceipt() public {
        _fund();
        _anchor(0, 3); // unattested
        vm.expectRevert(
            abi.encodeWithSelector(FlowEscrow.StepNotSuccessful.selector, RUN_ID, uint32(0), uint8(3))
        );
        escrow.releaseStep(RUN_ID, 0);
    }

    function test_ReleaseStepIsIdempotentlyGuarded() public {
        _fund();
        _anchor(0, 0);
        escrow.releaseStep(RUN_ID, 0);
        vm.expectRevert();
        escrow.releaseStep(RUN_ID, 0);
    }

    function test_ReleaseStepRevertsForAStepWithNoPayee() public {
        _fund();
        _anchor(5, 0);
        vm.expectRevert();
        escrow.releaseStep(RUN_ID, 5);
    }

    function test_ReleaseStepIsPermissionless() public {
        // Anyone may trigger a release; the receipt decides, not the caller.
        _fund();
        _anchor(0, 0);
        vm.prank(address(0xBEEF));
        escrow.releaseStep(RUN_ID, 0);
        assertEq(agentA.balance, 1 ether);
    }

    // ---------------------------------------------------------------------
    // Refund
    // ---------------------------------------------------------------------

    function test_RefundUnspentReturnsTheBalanceAfterAFailureSeal() public {
        _fund();
        _anchor(0, 1); // failed
        _seal(1, 1);

        uint256 before = funder.balance;
        escrow.refundUnspent(RUN_ID);
        assertEq(funder.balance - before, 3 ether);
        assertEq(escrow.unreleasedOf(RUN_ID), 0);
    }

    function test_RefundUnspentReturnsOnlyWhatWasNotReleased() public {
        _fund();
        _anchor(0, 0);
        _anchor(1, 1);
        escrow.releaseStep(RUN_ID, 0);
        _seal(1, 2);

        uint256 before = funder.balance;
        escrow.refundUnspent(RUN_ID);
        assertEq(funder.balance - before, 2 ether);
    }

    function test_RefundUnspentRevertsBeforeTheRunIsSealed() public {
        _fund();
        _anchor(0, 1);
        vm.expectRevert();
        escrow.refundUnspent(RUN_ID);
    }

    function test_RefundUnspentRevertsWhenTheRunSucceeded() public {
        _fund();
        _anchor(0, 0);
        _seal(0, 1);
        vm.expectRevert();
        escrow.refundUnspent(RUN_ID);
    }

    function test_RefundUnspentCannotBeCalledTwice() public {
        _fund();
        _anchor(0, 1);
        _seal(1, 1);
        escrow.refundUnspent(RUN_ID);
        vm.expectRevert();
        escrow.refundUnspent(RUN_ID);
    }

    function test_ReleaseStepRevertsAfterRefund() public {
        // Funds that went back to the funder must not be payable again.
        _fund();
        _anchor(0, 0);
        _anchor(1, 1);
        _seal(1, 2);
        escrow.refundUnspent(RUN_ID);
        vm.expectRevert();
        escrow.releaseStep(RUN_ID, 0);
    }

    function testFuzz_ReleasesNeverExceedTheFundedAmount(uint8 statusA, uint8 statusB) public {
        statusA = uint8(bound(statusA, 0, 3));
        statusB = uint8(bound(statusB, 0, 3));
        _fund();
        _anchor(0, statusA);
        _anchor(1, statusB);

        if (statusA == 0) escrow.releaseStep(RUN_ID, 0);
        if (statusB == 0) escrow.releaseStep(RUN_ID, 1);

        assertLe(agentA.balance + agentB.balance, 3 ether);
        assertEq(address(escrow).balance, escrow.unreleasedOf(RUN_ID));
    }
}
