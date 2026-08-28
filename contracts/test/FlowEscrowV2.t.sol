// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ExecutionReceiptsV2} from "../src/ExecutionReceiptsV2.sol";
import {AgentAdapterRegistryV2} from "../src/AgentAdapterRegistryV2.sol";
import {FlowEscrowV2} from "../src/FlowEscrowV2.sol";
import {FlowRegistry} from "../src/FlowRegistry.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

contract MockIdentityEscrow is IIdentityRegistry {
    error ERC721NonexistentToken(uint256 tokenId);

    mapping(uint256 => address) private _owners;

    function setOwner(uint256 agentId, address owner) external {
        _owners[agentId] = owner;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        address owner = _owners[agentId];
        if (owner == address(0)) revert ERC721NonexistentToken(agentId);
        return owner;
    }
}

/// A payee that refuses payment, to prove a failed transfer reverts the whole
/// release rather than marking the step paid and losing the money.
contract RejectingPayee {
    receive() external payable {
        revert("no thanks");
    }
}

contract FlowEscrowV2Test is Test {
    FlowRegistry internal flows;
    ExecutionReceiptsV2 internal receipts;
    AgentAdapterRegistryV2 internal registry;
    MockIdentityEscrow internal identity;
    FlowEscrowV2 internal escrow;

    address internal executor = address(0xE1);
    address internal funder = address(0xF1);
    address internal stranger = address(0xBAD);

    uint256 internal constant AGENT_A = 1;
    uint256 internal constant AGENT_B = 2;

    // The agent's hot signing key, and a key belonging to nobody in the market.
    uint256 internal agentAKey = 0xA11CE;
    uint256 internal impostorKey = 0xBADBEEF;
    address internal agentASigner;
    address internal agentAPayTo = address(0x9001);
    address internal ownerA = address(0x01);

    bytes32 internal constant FLOW_ID = bytes32(uint256(0x11));
    bytes32 internal constant RUN_ID = bytes32(uint256(0x22));

    uint64 internal deadline;

    function setUp() public {
        agentASigner = vm.addr(agentAKey);

        flows = new FlowRegistry();
        receipts = new ExecutionReceiptsV2(address(flows));
        identity = new MockIdentityEscrow();
        registry = new AgentAdapterRegistryV2(address(identity));
        escrow = new FlowEscrowV2(address(receipts), address(registry));

        identity.setOwner(AGENT_A, ownerA);
        identity.setOwner(AGENT_B, address(0x02));

        vm.prank(ownerA);
        registry.registerAdapter(
            AgentAdapterRegistryV2.Adapter({
                agentId: AGENT_A,
                kind: 0,
                endpoint: "https://a.example/invoke",
                schemaRoot: keccak256("schema"),
                version: 1,
                active: true,
                payTo: agentAPayTo,
                signer: agentASigner,
                pricePerCall: 1 ether,
                metadataURI: ""
            })
        );

        flows.publishFlow(FLOW_ID, bytes32(uint256(0x12)), "paid-flow");
        vm.prank(executor);
        flows.startRun(FLOW_ID, RUN_ID, executor);

        vm.deal(funder, 100 ether);
        deadline = uint64(block.timestamp + 1 days);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _fund(uint256 amount) internal {
        vm.prank(funder);
        escrow.fundRun{value: amount}(RUN_ID, deadline);
    }

    function _anchor(uint32 stepIndex, uint8 status, uint256 agentId) internal {
        vm.prank(executor);
        receipts.anchorStep(
            ExecutionReceiptsV2.Receipt({
                flowId: FLOW_ID,
                runId: RUN_ID,
                stepIndex: stepIndex,
                agentId: agentId,
                inputHash: keccak256(abi.encode("in", stepIndex)),
                outputHash: keccak256(abi.encode("out", stepIndex)),
                traceRoot: keccak256("trace"),
                attestationRef: bytes32(0),
                startedAt: 1_755_600_000,
                endedAt: 1_755_600_100,
                status: status
            })
        );
    }

    function _allocate(uint32 stepIndex, uint256 amount) internal {
        vm.prank(executor);
        escrow.allocate(RUN_ID, stepIndex, amount);
    }

    /// Signs exactly what the contract will recompute, with whichever key.
    function _sign(uint256 key, uint32 stepIndex, uint256 agentId)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = escrow.agentOutputDigest(
            RUN_ID,
            stepIndex,
            agentId,
            keccak256(abi.encode("in", stepIndex)),
            keccak256(abi.encode("out", stepIndex))
        );
        bytes32 message = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, message);
        return abi.encodePacked(r, s, v);
    }

    function _setUpPaidStep(uint32 stepIndex) internal returns (bytes memory) {
        _fund(5 ether);
        _anchor(stepIndex, 0, AGENT_A);
        _allocate(stepIndex, 1 ether);
        return _sign(agentAKey, stepIndex, AGENT_A);
    }

    // ---------------------------------------------------------------------
    // The digest, which four implementations must agree on
    // ---------------------------------------------------------------------

    /// Pinned against `packages/core/test/agent-signature.test.ts`. If this
    /// diverges, agents sign something the escrow will not accept and payment
    /// stops with nothing in the output pointing at the cause — the §5.2
    /// failure mode moved to payment.
    ///
    /// The chain id and receipts address are forced to the values the
    /// TypeScript vector uses, because the digest binds both.
    function test_DigestMatchesTypeScriptCore() public {
        vm.chainId(31337);

        // The vector pins a specific receipts address, and the digest commits
        // to it, so the escrow under test must be pointed at that address.
        address pinnedReceipts = 0x741A36fAba40ee71223539a5A062FDEDC8574e30;
        FlowEscrowV2 pinned = new FlowEscrowV2(pinnedReceipts, address(registry));

        assertEq(
            pinned.AGENT_OUTPUT_DOMAIN(),
            keccak256("0gflow-agent-output-v1"),
            "domain separator diverged"
        );

        bytes32 digest = pinned.agentOutputDigest(
            bytes32(0x2222222222222222222222222222222222222222222222222222222222222222),
            1,
            7,
            bytes32(0x3333333333333333333333333333333333333333333333333333333333333333),
            bytes32(0x4444444444444444444444444444444444444444444444444444444444444444)
        );

        assertEq(
            digest,
            0x0c5bf6dabc2d3db97229a669ecf3f9793f03240b790514aa9add8d1a18332a15,
            "agent output digest diverged from packages/core"
        );
    }

    // ---------------------------------------------------------------------
    // The property that makes an open marketplace safe to fund
    // ---------------------------------------------------------------------

    function test_PaysTheAgentsRegisteredAddressAgainstItsOwnSignature() public {
        bytes memory sig = _setUpPaidStep(0);

        vm.expectEmit(true, true, true, true);
        emit FlowEscrowV2.StepReleased(RUN_ID, 0, AGENT_A, agentAPayTo, 1 ether);
        escrow.releaseStep(RUN_ID, 0, sig);

        assertEq(agentAPayTo.balance, 1 ether);
        assertTrue(escrow.isReleased(RUN_ID, 0));
        assertEq(escrow.balanceOf(RUN_ID), 4 ether);
        assertEq(escrow.allocatedOf(RUN_ID), 0);
    }

    /// The heart of it. The executor writes `agentId` into the receipt and
    /// could write anyone's — but it cannot produce that agent's signature,
    /// so it cannot cause payment to a party the agent did not authorise.
    function test_ExecutorCannotMisdirectPaymentByNamingAnotherAgent() public {
        _fund(5 ether);
        // The executor anchors a step claiming AGENT_A did the work.
        _anchor(0, 0, AGENT_A);
        _allocate(0, 1 ether);

        // But it does not hold AGENT_A's key, so its signature is worthless.
        bytes memory forged = _sign(impostorKey, 0, AGENT_A);

        vm.expectRevert(
            abi.encodeWithSelector(
                FlowEscrowV2.BadSignature.selector, AGENT_A, vm.addr(impostorKey), agentASigner
            )
        );
        escrow.releaseStep(RUN_ID, 0, forged);
        assertEq(agentAPayTo.balance, 0);
    }

    /// Release is permissionless because the signature is the authorisation:
    /// the agent can collect for itself, or anyone can settle on its behalf,
    /// and neither can send the money anywhere else.
    function test_AnyoneMaySubmitTheSignatureAndTheMoneyStillGoesToTheAgent() public {
        bytes memory sig = _setUpPaidStep(0);

        vm.prank(stranger);
        escrow.releaseStep(RUN_ID, 0, sig);

        assertEq(agentAPayTo.balance, 1 ether);
        assertEq(stranger.balance, 0);
    }

    /// A signature naming a different agent recovers correctly but against the
    /// wrong registry entry — and agent B is unlisted, so it has no signer.
    function test_SignatureForAnotherAgentDoesNotRelease() public {
        _fund(5 ether);
        _anchor(0, 0, AGENT_B);
        _allocate(0, 1 ether);

        bytes memory sig = _sign(agentAKey, 0, AGENT_B);

        vm.expectRevert(
            abi.encodeWithSelector(FlowEscrowV2.AgentNotListed.selector, AGENT_B)
        );
        escrow.releaseStep(RUN_ID, 0, sig);
    }

    /// The domain separator's whole job. An agent legitimately signed step 0;
    /// that signature must not pay out step 1.
    function test_SignatureCannotBeLiftedOntoAnotherStep() public {
        _fund(5 ether);
        _anchor(0, 0, AGENT_A);
        _anchor(1, 0, AGENT_A);
        _allocate(1, 1 ether);

        bytes memory sigForStepZero = _sign(agentAKey, 0, AGENT_A);

        // Matched on the selector, not a bare expectRevert: the recovered
        // address is arbitrary, but it must fail *as a bad signature* and not
        // because of some unrelated guard, or the test proves nothing.
        vm.expectPartialRevert(FlowEscrowV2.BadSignature.selector);
        escrow.releaseStep(RUN_ID, 1, sigForStepZero);
        assertEq(agentAPayTo.balance, 0);
    }

    function test_MalformedSignatureIsRejected() public {
        _fund(5 ether);
        _anchor(0, 0, AGENT_A);
        _allocate(0, 1 ether);

        vm.expectRevert(abi.encodeWithSelector(FlowEscrowV2.MalformedSignature.selector, 4));
        escrow.releaseStep(RUN_ID, 0, hex"deadbeef");
    }

    /// Every ECDSA signature has a second encoding with s' = N - s. Accepting
    /// both would let one signed output appear as two distinct signatures.
    function test_HighSMalleableSignatureIsRejected() public {
        bytes memory sig = _setUpPaidStep(0);

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        uint256 N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory malleable = abi.encodePacked(r, bytes32(N - uint256(s)), v == 27 ? 28 : 27);

        vm.expectRevert(
            abi.encodeWithSelector(
                FlowEscrowV2.BadSignature.selector, AGENT_A, address(0), agentASigner
            )
        );
        escrow.releaseStep(RUN_ID, 0, malleable);
    }

    // ---------------------------------------------------------------------
    // No payment without a verified receipt (§4.4)
    // ---------------------------------------------------------------------

    function test_FailedStepIsNotPaid() public {
        _fund(5 ether);
        _anchor(0, 1, AGENT_A);
        _allocate(0, 1 ether);

        // Signed before arming the expectation: `_sign` itself makes an
        // external view call, which vm.expectRevert would otherwise arm on.
        bytes memory sig = _sign(agentAKey, 0, AGENT_A);
        vm.expectRevert(
            abi.encodeWithSelector(FlowEscrowV2.StepNotSuccessful.selector, RUN_ID, uint32(0), 1)
        );
        escrow.releaseStep(RUN_ID, 0, sig);
    }

    /// The point of status 3. A step that ran but could not be proven is not a
    /// success, and does not get paid.
    function test_UnattestedStepIsNotPaid() public {
        _fund(5 ether);
        _anchor(0, 3, AGENT_A);
        _allocate(0, 1 ether);

        bytes memory sig = _sign(agentAKey, 0, AGENT_A);
        vm.expectRevert(
            abi.encodeWithSelector(FlowEscrowV2.StepNotSuccessful.selector, RUN_ID, uint32(0), 3)
        );
        escrow.releaseStep(RUN_ID, 0, sig);
    }

    function test_UnanchoredStepIsNotPaid() public {
        _fund(5 ether);
        _allocate(0, 1 ether);

        bytes memory sig = _sign(agentAKey, 0, AGENT_A);
        vm.expectRevert(
            abi.encodeWithSelector(
                ExecutionReceiptsV2.StepNotAnchored.selector, RUN_ID, uint32(0)
            )
        );
        escrow.releaseStep(RUN_ID, 0, sig);
    }

    function test_DoubleReleaseReverts() public {
        bytes memory sig = _setUpPaidStep(0);
        escrow.releaseStep(RUN_ID, 0, sig);

        vm.expectRevert(
            abi.encodeWithSelector(
                FlowEscrowV2.StepAlreadyReleased.selector, RUN_ID, uint32(0)
            )
        );
        escrow.releaseStep(RUN_ID, 0, sig);
        assertEq(agentAPayTo.balance, 1 ether);
    }

    function test_StepWithNoAllocationCannotBeReleased() public {
        _fund(5 ether);
        _anchor(0, 0, AGENT_A);

        bytes memory sig = _sign(agentAKey, 0, AGENT_A);
        vm.expectRevert(
            abi.encodeWithSelector(FlowEscrowV2.NoAllocation.selector, RUN_ID, uint32(0))
        );
        escrow.releaseStep(RUN_ID, 0, sig);
    }

    /// A rejecting payee must not leave the step marked paid with the money
    /// gone from the balance.
    function test_FailedTransferRevertsTheWholeRelease() public {
        RejectingPayee rejector = new RejectingPayee();
        vm.prank(ownerA);
        registry.registerAdapter(
            AgentAdapterRegistryV2.Adapter({
                agentId: AGENT_A,
                kind: 0,
                endpoint: "https://a.example/invoke",
                schemaRoot: keccak256("schema"),
                version: 2,
                active: true,
                payTo: address(rejector),
                signer: agentASigner,
                pricePerCall: 1 ether,
                metadataURI: ""
            })
        );

        bytes memory sig = _setUpPaidStep(0);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlowEscrowV2.TransferFailed.selector, address(rejector), 1 ether
            )
        );
        escrow.releaseStep(RUN_ID, 0, sig);

        assertFalse(escrow.isReleased(RUN_ID, 0));
        assertEq(escrow.balanceOf(RUN_ID), 5 ether);
    }

    // ---------------------------------------------------------------------
    // Allocation
    // ---------------------------------------------------------------------

    function test_OnlyTheExecutorMayAllocate() public {
        _fund(5 ether);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlowEscrowV2.NotRunExecutor.selector, RUN_ID, stranger, executor
            )
        );
        escrow.allocate(RUN_ID, 0, 1 ether);
    }

    function test_CannotAllocateBeyondTheBudget() public {
        _fund(1 ether);
        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlowEscrowV2.InsufficientBalance.selector, RUN_ID, 2 ether, 1 ether
            )
        );
        escrow.allocate(RUN_ID, 0, 2 ether);
    }

    function test_AllocationsAccumulateAcrossSteps() public {
        _fund(3 ether);
        _allocate(0, 1 ether);
        _allocate(1, 2 ether);
        assertEq(escrow.allocatedOf(RUN_ID), 3 ether);

        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlowEscrowV2.InsufficientBalance.selector, RUN_ID, 1 ether, 0
            )
        );
        escrow.allocate(RUN_ID, 2, 1 ether);
    }

    /// Re-allocating an unreleased step replaces the figure rather than adding
    /// to it, so a retry at a different price does not silently double the
    /// commitment.
    function test_ReallocatingAStepReplacesRatherThanAdds() public {
        _fund(3 ether);
        _allocate(0, 1 ether);
        _allocate(0, 2 ether);
        assertEq(escrow.allocatedOf(RUN_ID), 2 ether);
        assertEq(escrow.allocationOf(RUN_ID, 0), 2 ether);
    }

    function test_CannotReallocateAReleasedStep() public {
        bytes memory sig = _setUpPaidStep(0);
        escrow.releaseStep(RUN_ID, 0, sig);

        vm.prank(executor);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlowEscrowV2.StepAlreadyReleased.selector, RUN_ID, uint32(0)
            )
        );
        escrow.allocate(RUN_ID, 0, 1 ether);
    }

    function test_TopUpExtendsTheBudgetMidRun() public {
        _fund(1 ether);
        vm.prank(funder);
        escrow.topUp{value: 2 ether}(RUN_ID);
        assertEq(escrow.balanceOf(RUN_ID), 3 ether);
        _allocate(0, 3 ether);
    }

    function test_FundingTwiceReverts() public {
        _fund(1 ether);
        vm.prank(funder);
        vm.expectRevert(abi.encodeWithSelector(FlowEscrowV2.RunAlreadyFunded.selector, RUN_ID));
        escrow.fundRun{value: 1 ether}(RUN_ID, deadline);
    }

    /// Without a deadline there is no path out of an abandoned run.
    function test_DeadlineMustBeInTheFuture() public {
        vm.prank(funder);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlowEscrowV2.DeadlineInPast.selector,
                uint64(block.timestamp),
                uint64(block.timestamp)
            )
        );
        escrow.fundRun{value: 1 ether}(RUN_ID, uint64(block.timestamp));
    }

    // ---------------------------------------------------------------------
    // The v1 locking bug, asserted the other way (this is the regression)
    // ---------------------------------------------------------------------

    /// v1 reverts `RunSucceeded` here, permanently trapping the remainder of
    /// any run that succeeded without spending its whole budget.
    /// `FlowEscrow.t.sol` asserts that as intended behaviour. It was not.
    function test_RefundsTheRemainderOfASuccessfulRun() public {
        bytes memory sig = _setUpPaidStep(0);
        escrow.releaseStep(RUN_ID, 0, sig);

        vm.prank(executor);
        receipts.sealRun(RUN_ID, keccak256("root"), 1, 0); // outcome ok

        uint256 before = funder.balance;
        escrow.refundUnspent(RUN_ID);

        assertEq(funder.balance - before, 4 ether, "the unspent budget must come back");
        assertEq(escrow.balanceOf(RUN_ID), 0);
    }

    function test_RefundsAfterAFailedRunToo() public {
        _fund(5 ether);
        _anchor(0, 1, AGENT_A);
        vm.prank(executor);
        receipts.sealRun(RUN_ID, keccak256("root"), 1, 1);

        uint256 before = funder.balance;
        escrow.refundUnspent(RUN_ID);
        assertEq(funder.balance - before, 5 ether);
    }

    /// A funder must not be able to seal and sweep before agents whose steps
    /// succeeded have collected.
    function test_RefundUnspentLeavesLiveAllocationsAlone() public {
        _fund(5 ether);
        _anchor(0, 0, AGENT_A);
        _allocate(0, 1 ether);

        vm.prank(executor);
        receipts.sealRun(RUN_ID, keccak256("root"), 1, 0);

        escrow.refundUnspent(RUN_ID);
        assertEq(escrow.balanceOf(RUN_ID), 1 ether, "the agent's allocation must survive");

        // And the agent can still collect it after the refund.
        escrow.releaseStep(RUN_ID, 0, _sign(agentAKey, 0, AGENT_A));
        assertEq(agentAPayTo.balance, 1 ether);
    }

    function test_CannotRefundBeforeTheRunIsSealed() public {
        _fund(5 ether);
        vm.expectRevert(abi.encodeWithSelector(FlowEscrowV2.RunNotSealed.selector, RUN_ID));
        escrow.refundUnspent(RUN_ID);
    }

    /// v1's other trap: a run the executor never seals holds the money forever.
    function test_AbandonedRunIsRecoverableAfterTheDeadline() public {
        _fund(5 ether);
        _anchor(0, 0, AGENT_A);
        _allocate(0, 1 ether);
        // The executor then disappears — no seal, ever.

        vm.warp(deadline + 1);
        uint256 before = funder.balance;
        vm.prank(funder);
        escrow.refundExpired(RUN_ID);

        assertEq(funder.balance - before, 5 ether, "everything must come back");
        assertEq(escrow.balanceOf(RUN_ID), 0);
    }

    function test_CannotRecoverBeforeTheDeadline() public {
        _fund(5 ether);
        vm.prank(funder);
        vm.expectRevert(
            abi.encodeWithSelector(
                FlowEscrowV2.DeadlineNotReached.selector, deadline, uint64(block.timestamp)
            )
        );
        escrow.refundExpired(RUN_ID);
    }

    /// Only the funder, so nobody else can end a run still legitimately in
    /// progress at the boundary.
    function test_OnlyTheFunderMayRecoverAnExpiredRun() public {
        _fund(5 ether);
        vm.warp(deadline + 1);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(FlowEscrowV2.NotRunFunder.selector, RUN_ID, stranger, funder)
        );
        escrow.refundExpired(RUN_ID);
    }

    function test_ExpiryClosesTheRunToFurtherActivity() public {
        _fund(5 ether);
        _anchor(0, 0, AGENT_A);
        _allocate(0, 1 ether);

        bytes memory sig = _sign(agentAKey, 0, AGENT_A);

        vm.warp(deadline + 1);
        vm.prank(funder);
        escrow.refundExpired(RUN_ID);

        vm.expectRevert(abi.encodeWithSelector(FlowEscrowV2.RunClosed.selector, RUN_ID));
        escrow.releaseStep(RUN_ID, 0, sig);

        vm.prank(executor);
        vm.expectRevert(abi.encodeWithSelector(FlowEscrowV2.RunClosed.selector, RUN_ID));
        escrow.allocate(RUN_ID, 1, 1 ether);
    }

    /// No path may pay out more than was escrowed, whatever order the calls
    /// arrive in.
    function testFuzz_NeverPaysOutMoreThanWasFunded(uint96 budget, uint96 allocation) public {
        budget = uint96(bound(budget, 1, 50 ether));
        allocation = uint96(bound(allocation, 1, budget));

        vm.prank(funder);
        escrow.fundRun{value: budget}(RUN_ID, deadline);
        _anchor(0, 0, AGENT_A);
        _allocate(0, allocation);

        escrow.releaseStep(RUN_ID, 0, _sign(agentAKey, 0, AGENT_A));

        assertEq(agentAPayTo.balance, allocation);
        assertEq(escrow.balanceOf(RUN_ID), budget - allocation);
        assertEq(address(escrow).balance, budget - allocation);
    }
}
