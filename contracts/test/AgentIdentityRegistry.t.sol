// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentIdentityRegistry} from "../src/AgentIdentityRegistry.sol";

/// This registry will hold other people's agent identities on mainnet, and
/// every receipt in the system is keyed on the ids it hands out. The tests that
/// matter are the ones about who can do what, and about ids never colliding.
contract AgentIdentityRegistryTest is Test {
    AgentIdentityRegistry private registry;

    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    function setUp() public {
        registry = new AgentIdentityRegistry();
    }

    /// The selector the publish CLI and the browser publish page both send.
    /// If this ever changes, every publish against this chain breaks.
    function test_RegisterSelectorMatchesTheGalileoRegistry() public pure {
        assertEq(bytes4(keccak256("register(string)")), bytes4(0xf2c298be));
    }

    function test_AnyoneCanRegister() public {
        vm.prank(ALICE);
        uint256 a = registry.register("data:application/json;base64,e30=");
        vm.prank(BOB);
        uint256 b = registry.register("ipfs://Qm");

        assertEq(registry.ownerOf(a), ALICE);
        assertEq(registry.ownerOf(b), BOB);
    }

    /// The whole reason this contract exists rather than 0G's Agentic ID: a
    /// stranger with no relationship to the deployer must be able to list.
    function test_RegisteringNeedsNoPermissionFromTheDeployer() public {
        address stranger = address(0xDEADBEEF);
        vm.prank(stranger);
        uint256 id = registry.register("");
        assertEq(registry.ownerOf(id), stranger);
    }

    function test_IdsStartAtOneAndNeverRepeat() public {
        vm.prank(ALICE);
        assertEq(registry.register("a"), 1, "zero must be unrepresentable");
        vm.prank(ALICE);
        assertEq(registry.register("b"), 2);
        vm.prank(BOB);
        assertEq(registry.register("c"), 3);
        assertEq(registry.totalSupply(), 3);
    }

    /// `publish` reads the id out of this log, because a non-view function
    /// cannot return one to an external caller. If the topics change shape,
    /// publishing succeeds on chain and then reports "the new agent id is
    /// unknown", which is the worst of both outcomes.
    function test_MintEmitsTransferFromZero() public {
        vm.expectEmit(true, true, true, true);
        emit Transfer(address(0), ALICE, 1);
        vm.prank(ALICE);
        registry.register("a");
    }

    function test_OwnerOfRevertsForAnUnregisteredAgent() public {
        vm.expectRevert(abi.encodeWithSelector(AgentIdentityRegistry.TokenDoesNotExist.selector, 7));
        registry.ownerOf(7);
    }

    /// Not `returns address(0)`. A falsy owner is indistinguishable from an
    /// unowned-but-present agent, and callers would treat "no such agent" as
    /// "an agent nobody controls".
    function test_OwnerOfNeverReturnsZero() public {
        vm.prank(ALICE);
        uint256 id = registry.register("a");
        assertTrue(registry.ownerOf(id) != address(0));
    }

    function test_OnlyTheOwnerCanChangeTheTokenURI() public {
        vm.prank(ALICE);
        uint256 id = registry.register("before");

        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(AgentIdentityRegistry.NotOwner.selector, id, BOB, ALICE));
        registry.setTokenURI(id, "after");

        vm.prank(ALICE);
        registry.setTokenURI(id, "after");
        assertEq(registry.tokenURI(id), "after");
    }

    function test_TransferMovesOwnershipAndBalances() public {
        vm.prank(ALICE);
        uint256 id = registry.register("a");

        vm.prank(ALICE);
        registry.transferFrom(ALICE, BOB, id);

        assertEq(registry.ownerOf(id), BOB);
        assertEq(registry.balanceOf(ALICE), 0);
        assertEq(registry.balanceOf(BOB), 1);
    }

    function test_TransferRefusesFromSomeoneWhoDoesNotOwnIt() public {
        vm.prank(ALICE);
        uint256 id = registry.register("a");

        vm.prank(BOB);
        vm.expectRevert(abi.encodeWithSelector(AgentIdentityRegistry.NotOwner.selector, id, BOB, ALICE));
        registry.transferFrom(ALICE, BOB, id);
    }

    /// Burning would make `ownerOf` revert for an agent that has historical
    /// receipts, turning a verifiable past run into an unresolvable one.
    function test_TransferToZeroIsRefusedRatherThanTreatedAsABurn() public {
        vm.prank(ALICE);
        uint256 id = registry.register("a");

        vm.prank(ALICE);
        vm.expectRevert(AgentIdentityRegistry.ZeroAddress.selector);
        registry.transferFrom(ALICE, address(0), id);
    }

    /// A transferred agent keeps its id, so every receipt naming it stays
    /// resolvable. This is why receipts key on the id and not on the owner.
    function test_IdSurvivesTransfer() public {
        vm.prank(ALICE);
        uint256 id = registry.register("a");
        vm.prank(ALICE);
        registry.transferFrom(ALICE, BOB, id);
        assertEq(id, 1);
        assertEq(registry.tokenURI(id), "a");
    }

    function test_SupportsErc721InterfaceIds() public view {
        assertTrue(registry.supportsInterface(0x01ffc9a7), "ERC-165");
        assertTrue(registry.supportsInterface(0x80ac58cd), "ERC-721");
        assertTrue(registry.supportsInterface(0x5b5e139f), "ERC-721 Metadata");
        assertFalse(registry.supportsInterface(0xffffffff));
    }

    function testFuzz_EveryRegistrationGetsADistinctOwnedId(uint8 count) public {
        vm.assume(count > 0 && count < 40);
        for (uint256 i = 0; i < count; i++) {
            address who = address(uint160(0x1000 + i));
            vm.prank(who);
            uint256 id = registry.register("x");
            assertEq(id, i + 1);
            assertEq(registry.ownerOf(id), who);
        }
        assertEq(registry.totalSupply(), count);
    }
}
