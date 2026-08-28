// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentReputationV1} from "../src/AgentReputationV1.sol";
import {AgentAdapterRegistryV2} from "../src/AgentAdapterRegistryV2.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

contract MockIdentityRep is IIdentityRegistry {
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

/// Refuses payment, to prove a failed transfer reverts rather than losing the
/// bond.
contract RejectingOwner {
    receive() external payable {
        revert("no thanks");
    }
}

contract AgentReputationV1Test is Test {
    MockIdentityRep internal identity;
    AgentAdapterRegistryV2 internal registry;
    AgentReputationV1 internal reputation;

    uint256 internal constant AGENT = 1;
    uint256 internal constant UNLISTED = 2;

    address internal owner = address(0x01);
    address internal operator = address(0x0A);
    address internal backer = address(0xB1);
    address internal prover = address(0xC1);
    address internal stranger = address(0xBAD);

    uint256 internal agentKey = 0xA11CE;
    uint256 internal otherKey = 0xBADBEEF;
    address internal agentSigner;

    address internal constant RECEIPTS = address(0xBEEF);
    bytes32 internal constant RUN_ID = bytes32(uint256(0x22));

    /// This contract is the prover in the tests that do not prank, so it has
    /// to be able to take its half of a slashed bond.
    receive() external payable {}

    function setUp() public {
        agentSigner = vm.addr(agentKey);

        identity = new MockIdentityRep();
        registry = new AgentAdapterRegistryV2(address(identity));
        reputation = new AgentReputationV1(address(registry), RECEIPTS);

        identity.setOwner(AGENT, owner);
        identity.setOwner(UNLISTED, owner);

        vm.prank(owner);
        registry.registerAdapter(
            AgentAdapterRegistryV2.Adapter({
                agentId: AGENT,
                kind: 0,
                endpoint: "https://a.example",
                schemaRoot: bytes32(0),
                version: 1,
                active: true,
                payTo: address(0x9001),
                signer: agentSigner,
                pricePerCall: 0,
                metadataURI: ""
            })
        );

        vm.deal(owner, 100 ether);
        vm.deal(backer, 100 ether);
    }

    function _claim(uint256 key, bytes32 outputHash) internal view returns (AgentReputationV1.SignedClaim memory) {
        bytes32 inputHash = keccak256("in");
        bytes32 digest = reputation.agentOutputDigest(RUN_ID, 0, AGENT, inputHash, outputHash);
        bytes32 message = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, message);
        return AgentReputationV1.SignedClaim({
            inputHash: inputHash,
            outputHash: outputHash,
            signature: abi.encodePacked(r, s, v)
        });
    }

    function _stake(uint256 amount) internal {
        vm.prank(owner);
        reputation.stake{value: amount}(AGENT);
    }

    // ---------------------------------------------------------------------
    // Bonding
    // ---------------------------------------------------------------------

    function test_StakeIsRecordedAndReadable() public {
        _stake(5 ether);
        assertEq(reputation.stakeOf(AGENT), 5 ether);
        assertFalse(reputation.isSlashed(AGENT));
    }

    /// There is no way to hurt an agent by staking for it, and requiring
    /// ownership would stop a backer vouching for an agent they did not mint.
    function test_AnyoneMayTopUpAnAgentsBond() public {
        _stake(1 ether);
        vm.prank(backer);
        reputation.stake{value: 2 ether}(AGENT);
        assertEq(reputation.stakeOf(AGENT), 3 ether);
    }

    /// Funds bonded to an identity nobody minted would be unreclaimable by
    /// anyone.
    function test_CannotBondToAnIdentityThatDoesNotExist() public {
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(AgentReputationV1.AgentNotRegistered.selector, uint256(999))
        );
        reputation.stake{value: 1 ether}(999);
    }

    function test_ZeroStakeIsRefused() public {
        vm.prank(owner);
        vm.expectRevert(AgentReputationV1.ZeroStake.selector);
        reputation.stake{value: 0}(AGENT);
    }

    /// An agent with no bond reads as zero, not as a revert: a caller
    /// comparing against a threshold needs no special case.
    function test_AnAgentThatNeverStakedReadsZero() public view {
        assertEq(reputation.stakeOf(777), 0);
    }

    // ---------------------------------------------------------------------
    // Unbonding
    // ---------------------------------------------------------------------

    /// Without a cooldown the bond is theatre: an agent could stake, take a
    /// job, and withdraw before anyone could react.
    function test_WithdrawalWaitsOutTheCooldown() public {
        _stake(5 ether);

        vm.prank(owner);
        reputation.requestUnstake(AGENT);
        uint64 unlockAt = reputation.unlockAtOf(AGENT);
        assertEq(unlockAt, uint64(block.timestamp) + reputation.UNBONDING_PERIOD());

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentReputationV1.StillBonded.selector, AGENT, unlockAt, uint64(block.timestamp)
            )
        );
        reputation.withdraw(AGENT);

        vm.warp(unlockAt);
        uint256 before = owner.balance;
        vm.prank(owner);
        reputation.withdraw(AGENT);

        assertEq(owner.balance - before, 5 ether);
        assertEq(reputation.stakeOf(AGENT), 0);
    }

    function test_CannotWithdrawWithoutRequesting() public {
        _stake(1 ether);
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(AgentReputationV1.WithdrawalNotRequested.selector, AGENT)
        );
        reputation.withdraw(AGENT);
    }

    /// Otherwise an agent could request unbonding, keep the bond visible while
    /// it counts down, and take jobs on the strength of a number it was in the
    /// middle of removing.
    function test_StakingCancelsAPendingWithdrawal() public {
        _stake(1 ether);
        vm.prank(owner);
        reputation.requestUnstake(AGENT);
        assertGt(reputation.unlockAtOf(AGENT), 0);

        vm.prank(backer);
        reputation.stake{value: 1 wei}(AGENT);
        assertEq(reputation.unlockAtOf(AGENT), 0);
    }

    function test_OnlyOwnerOrOperatorMayUnbond() public {
        _stake(1 ether);

        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(AgentReputationV1.NotAuthorised.selector, AGENT, stranger)
        );
        reputation.requestUnstake(AGENT);

        vm.prank(owner);
        registry.setOperator(AGENT, operator);
        vm.prank(operator);
        reputation.requestUnstake(AGENT);
        assertGt(reputation.unlockAtOf(AGENT), 0);
    }

    /// The bond belongs to whoever holds the identity. `payTo` is where
    /// earnings go and may be an operator's address.
    function test_WithdrawalGoesToTheIdentityOwnerNotTheCaller() public {
        _stake(2 ether);
        vm.prank(owner);
        registry.setOperator(AGENT, operator);

        vm.prank(owner);
        reputation.requestUnstake(AGENT);
        vm.warp(block.timestamp + reputation.UNBONDING_PERIOD());

        uint256 ownerBefore = owner.balance;
        vm.prank(operator);
        reputation.withdraw(AGENT);

        assertEq(owner.balance - ownerBefore, 2 ether);
        assertEq(operator.balance, 0);
    }

    function test_AFailedTransferRevertsRatherThanLosingTheBond() public {
        RejectingOwner rejecting = new RejectingOwner();
        identity.setOwner(AGENT, address(rejecting));

        vm.prank(backer);
        reputation.stake{value: 1 ether}(AGENT);

        vm.prank(address(rejecting));
        reputation.requestUnstake(AGENT);
        vm.warp(block.timestamp + reputation.UNBONDING_PERIOD());

        vm.prank(address(rejecting));
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentReputationV1.TransferFailed.selector, address(rejecting), 1 ether
            )
        );
        reputation.withdraw(AGENT);
        assertEq(reputation.stakeOf(AGENT), 1 ether);
    }

    // ---------------------------------------------------------------------
    // Equivocation — the only slashable offence
    // ---------------------------------------------------------------------

    /// A step has one answer. Signing two means telling different parties
    /// different things about the same work, and no honest agent does it.
    function test_TwoSignaturesOverDifferentOutputsSlashTheBond() public {
        _stake(4 ether);

        // Built before the prank: _claim makes an external view call, which
        // would otherwise consume it and leave this contract as msg.sender.
        AgentReputationV1.SignedClaim memory a = _claim(agentKey, keccak256("answer A"));
        AgentReputationV1.SignedClaim memory b = _claim(agentKey, keccak256("answer B"));

        uint256 proverBefore = prover.balance;
        vm.prank(prover);
        reputation.proveEquivocation(AGENT, RUN_ID, 0, a, b);

        assertEq(reputation.stakeOf(AGENT), 0);
        assertTrue(reputation.isSlashed(AGENT));
        // Half rewarded, half destroyed.
        assertEq(prover.balance - proverBefore, 2 ether);
        assertEq(address(reputation).balance, 2 ether);
    }

    /// Paying the whole bond to the prover would let a misbehaving agent slash
    /// itself and recover its stake instantly, skipping the cooldown. Burning
    /// half makes self-reporting cost half the bond.
    function test_SelfReportingStillCostsHalfTheBond() public {
        _stake(4 ether);

        AgentReputationV1.SignedClaim memory a = _claim(agentKey, keccak256("A"));
        AgentReputationV1.SignedClaim memory b = _claim(agentKey, keccak256("B"));

        uint256 before = owner.balance;
        vm.prank(owner);
        reputation.proveEquivocation(AGENT, RUN_ID, 0, a, b);
        assertEq(owner.balance - before, 2 ether);
    }

    /// One signature submitted twice proves nothing.
    function test_TheSameClaimTwiceIsNotEquivocation() public {
        _stake(1 ether);
        AgentReputationV1.SignedClaim memory claim = _claim(agentKey, keccak256("same"));

        vm.expectRevert(
            abi.encodeWithSelector(AgentReputationV1.NotEquivocation.selector, AGENT, RUN_ID, uint32(0))
        );
        reputation.proveEquivocation(AGENT, RUN_ID, 0, claim, claim);
        assertEq(reputation.stakeOf(AGENT), 1 ether);
    }

    /// Nobody can frame an agent without its key.
    function test_SignaturesByAnotherKeyDoNotSlash() public {
        _stake(1 ether);
        // Built before arming the expectation: _claim makes an external view
        // call, which vm.expectRevert would otherwise arm on.
        AgentReputationV1.SignedClaim memory a = _claim(otherKey, keccak256("A"));
        AgentReputationV1.SignedClaim memory b = _claim(otherKey, keccak256("B"));

        vm.expectPartialRevert(AgentReputationV1.NotTheAgentsKey.selector);
        reputation.proveEquivocation(AGENT, RUN_ID, 0, a, b);
        assertEq(reputation.stakeOf(AGENT), 1 ether);
    }

    function test_OneGenuineAndOneForgedSignatureDoNotSlash() public {
        _stake(1 ether);
        AgentReputationV1.SignedClaim memory a = _claim(agentKey, keccak256("A"));
        AgentReputationV1.SignedClaim memory b = _claim(otherKey, keccak256("B"));

        vm.expectPartialRevert(AgentReputationV1.NotTheAgentsKey.selector);
        reputation.proveEquivocation(AGENT, RUN_ID, 0, a, b);
        assertEq(reputation.stakeOf(AGENT), 1 ether);
    }

    function test_AnAgentWithNoBondHasNothingToSlash() public {
        AgentReputationV1.SignedClaim memory a = _claim(agentKey, keccak256("A"));
        AgentReputationV1.SignedClaim memory b = _claim(agentKey, keccak256("B"));

        vm.expectRevert(abi.encodeWithSelector(AgentReputationV1.NothingStaked.selector, AGENT));
        reputation.proveEquivocation(AGENT, RUN_ID, 0, a, b);
    }

    /// A slashed identity cannot be rehabilitated by staking again — that is
    /// the point of it being permanent.
    function test_ASlashedAgentCannotStakeAgain() public {
        _stake(2 ether);
        reputation.proveEquivocation(
            AGENT, RUN_ID, 0, _claim(agentKey, keccak256("A")), _claim(agentKey, keccak256("B"))
        );

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(AgentReputationV1.AlreadySlashed.selector, AGENT));
        reputation.stake{value: 1 ether}(AGENT);
        assertTrue(reputation.isSlashed(AGENT));
    }

    function test_CannotSlashTwice() public {
        _stake(2 ether);
        reputation.proveEquivocation(
            AGENT, RUN_ID, 0, _claim(agentKey, keccak256("A")), _claim(agentKey, keccak256("B"))
        );
        AgentReputationV1.SignedClaim memory again = _claim(agentKey, keccak256("A"));
        AgentReputationV1.SignedClaim memory alsoAgain = _claim(agentKey, keccak256("B"));

        vm.expectRevert(abi.encodeWithSelector(AgentReputationV1.AlreadySlashed.selector, AGENT));
        reputation.proveEquivocation(AGENT, RUN_ID, 0, again, alsoAgain);
    }

    /// A rotated key is a legitimate act. Old signatures no longer recover to
    /// the registered signer, so they neither slash nor can be used to frame.
    function test_RotatingTheKeyMakesOldSignaturesUnusable() public {
        _stake(1 ether);
        AgentReputationV1.SignedClaim memory a = _claim(agentKey, keccak256("A"));
        AgentReputationV1.SignedClaim memory b = _claim(agentKey, keccak256("B"));

        vm.prank(owner);
        registry.registerAdapter(
            AgentAdapterRegistryV2.Adapter({
                agentId: AGENT,
                kind: 0,
                endpoint: "https://a.example",
                schemaRoot: bytes32(0),
                version: 2,
                active: true,
                payTo: address(0x9001),
                signer: vm.addr(otherKey),
                pricePerCall: 0,
                metadataURI: ""
            })
        );

        vm.expectPartialRevert(AgentReputationV1.NotTheAgentsKey.selector);
        reputation.proveEquivocation(AGENT, RUN_ID, 0, a, b);
    }

    function test_AnUnlistedAgentHasNoKeyToCheckAgainst() public {
        vm.prank(owner);
        reputation.stake{value: 1 ether}(UNLISTED);

        AgentReputationV1.SignedClaim memory a = _claim(agentKey, keccak256("A"));
        AgentReputationV1.SignedClaim memory b = _claim(agentKey, keccak256("B"));

        vm.expectRevert(abi.encodeWithSelector(AgentReputationV1.AgentNotListed.selector, UNLISTED));
        reputation.proveEquivocation(UNLISTED, RUN_ID, 0, a, b);
    }

    function test_AMalformedSignatureIsRefused() public {
        _stake(1 ether);
        AgentReputationV1.SignedClaim memory bad = AgentReputationV1.SignedClaim({
            inputHash: keccak256("in"),
            outputHash: keccak256("B"),
            signature: hex"deadbeef"
        });
        AgentReputationV1.SignedClaim memory good = _claim(agentKey, keccak256("A"));

        vm.expectRevert(abi.encodeWithSelector(AgentReputationV1.MalformedSignature.selector, 4));
        reputation.proveEquivocation(AGENT, RUN_ID, 0, good, bad);
    }

    /// Signing different inputs for the same step is equivocation too: the
    /// agent claimed the same step consumed two different things.
    function test_DifferentInputsForTheSameStepAlsoSlash() public {
        _stake(2 ether);

        bytes32 output = keccak256("same output");
        AgentReputationV1.SignedClaim memory a = _claim(agentKey, output);

        bytes32 otherInput = keccak256("a different input");
        bytes32 digest = reputation.agentOutputDigest(RUN_ID, 0, AGENT, otherInput, output);
        bytes32 message = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, message);
        AgentReputationV1.SignedClaim memory b = AgentReputationV1.SignedClaim({
            inputHash: otherInput,
            outputHash: output,
            signature: abi.encodePacked(r, s, v)
        });

        reputation.proveEquivocation(AGENT, RUN_ID, 0, a, b);
        assertTrue(reputation.isSlashed(AGENT));
    }

    // ---------------------------------------------------------------------
    // The digest, which must match everything else
    // ---------------------------------------------------------------------

    /// Pinned against packages/core, FlowEscrowV2 and the Python SDK. If this
    /// diverges, an agent's real signature would not prove equivocation and a
    /// bond would be unslashable for the wrong reason.
    function test_DigestMatchesTheRestOfTheSystem() public {
        vm.chainId(31337);
        AgentReputationV1 pinned = new AgentReputationV1(
            address(registry), 0x741A36fAba40ee71223539a5A062FDEDC8574e30
        );

        assertEq(pinned.AGENT_OUTPUT_DOMAIN(), keccak256("0gflow-agent-output-v1"));
        assertEq(
            pinned.agentOutputDigest(
                bytes32(0x2222222222222222222222222222222222222222222222222222222222222222),
                1,
                7,
                bytes32(0x3333333333333333333333333333333333333333333333333333333333333333),
                bytes32(0x4444444444444444444444444444444444444444444444444444444444444444)
            ),
            0x0c5bf6dabc2d3db97229a669ecf3f9793f03240b790514aa9add8d1a18332a15
        );
    }
}
