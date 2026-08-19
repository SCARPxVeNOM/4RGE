// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentAdapterRegistry} from "../src/AgentAdapterRegistry.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

/// Stands in for the agent registries deployed on Galileo, both of which are
/// ERC-721. Critically it reproduces ERC-721's actual behaviour: ownerOf
/// REVERTS for a nonexistent token rather than returning the zero address.
/// A mock that returned address(0) instead would let the adapter registry pass
/// its tests and then fail against the live contract.
contract MockIdentityRegistry is IIdentityRegistry {
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

contract AgentAdapterRegistryTest is Test {
    MockIdentityRegistry internal identity;
    AgentAdapterRegistry internal adapters;

    uint256 internal constant AGENT_A = 1;
    uint256 internal constant AGENT_B = 2;
    address internal ownerA = address(0x01);
    address internal ownerB = address(0x02);
    address internal stranger = address(0xBAD);

    function setUp() public {
        identity = new MockIdentityRegistry();
        adapters = new AgentAdapterRegistry(address(identity));
        identity.setOwner(AGENT_A, ownerA);
        identity.setOwner(AGENT_B, ownerB);
    }

    function _adapter(uint256 agentId, uint8 kind, uint32 version, bool active)
        internal
        pure
        returns (AgentAdapterRegistry.Adapter memory)
    {
        return AgentAdapterRegistry.Adapter({
            agentId: agentId,
            kind: kind,
            endpoint: "https://agent.example.test/invoke",
            schemaRoot: keccak256("schema"),
            version: version,
            active: active
        });
    }

    function test_RegisterAdapterStoresIt() public {
        vm.prank(ownerA);
        adapters.registerAdapter(_adapter(AGENT_A, 0, 1, true));

        AgentAdapterRegistry.Adapter memory stored = adapters.getAdapter(AGENT_A);
        assertEq(stored.agentId, AGENT_A);
        assertEq(stored.kind, 0);
        assertEq(stored.endpoint, "https://agent.example.test/invoke");
        assertEq(stored.version, 1);
        assertTrue(stored.active);
    }

    /// §10.1: registration rejected for non-owners of the agent identity.
    function test_RegisterAdapterRevertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentAdapterRegistry.NotIdentityOwner.selector, AGENT_A, stranger, ownerA
            )
        );
        adapters.registerAdapter(_adapter(AGENT_A, 0, 1, true));
    }

    function test_RegisterAdapterRevertsForAnotherAgentsOwner() public {
        vm.prank(ownerB);
        vm.expectRevert();
        adapters.registerAdapter(_adapter(AGENT_A, 0, 1, true));
    }

    /// The registry must surface a nonexistent agent as AgentNotRegistered
    /// rather than letting ERC-721's revert bubble up unrecognisably.
    function test_RegisterAdapterRevertsForUnmintedTokenId() public {
        uint256 unknown = 999;
        vm.prank(ownerA);
        vm.expectRevert(
            abi.encodeWithSelector(AgentAdapterRegistry.AgentNotRegistered.selector, unknown)
        );
        adapters.registerAdapter(_adapter(unknown, 0, 1, true));
    }

    function test_RegisterAdapterAcceptsAllThreeKinds() public {
        for (uint8 kind = 0; kind <= 2; kind++) {
            MockIdentityRegistry freshIdentity = new MockIdentityRegistry();
            AgentAdapterRegistry fresh = new AgentAdapterRegistry(address(freshIdentity));
            freshIdentity.setOwner(AGENT_A, ownerA);
            vm.prank(ownerA);
            fresh.registerAdapter(_adapter(AGENT_A, kind, 1, true));
            assertEq(fresh.getAdapter(AGENT_A).kind, kind);
        }
    }

    function test_RegisterAdapterRevertsOnUnknownKind() public {
        vm.prank(ownerA);
        vm.expectRevert(abi.encodeWithSelector(AgentAdapterRegistry.UnknownKind.selector, uint8(3)));
        adapters.registerAdapter(_adapter(AGENT_A, 3, 1, true));
    }

    function test_RegisterAdapterRevertsOnEmptyEndpoint() public {
        AgentAdapterRegistry.Adapter memory a = _adapter(AGENT_A, 0, 1, true);
        a.endpoint = "";
        vm.prank(ownerA);
        vm.expectRevert(AgentAdapterRegistry.EmptyEndpoint.selector);
        adapters.registerAdapter(a);
    }

    /// A token id far above the 160-bit address range must work: this is the
    /// case that a previous `address agentId` design would have truncated.
    function test_RegisterAdapterAcceptsLargeTokenIds() public {
        uint256 big = type(uint256).max - 3;
        identity.setOwner(big, ownerA);
        vm.prank(ownerA);
        adapters.registerAdapter(_adapter(big, 0, 1, true));
        assertEq(adapters.getAdapter(big).agentId, big);
    }

    function test_UpdateRequiresAnIncreasingVersion() public {
        vm.startPrank(ownerA);
        adapters.registerAdapter(_adapter(AGENT_A, 0, 2, true));

        vm.expectRevert();
        adapters.registerAdapter(_adapter(AGENT_A, 0, 2, true));
        vm.expectRevert();
        adapters.registerAdapter(_adapter(AGENT_A, 0, 1, true));

        adapters.registerAdapter(_adapter(AGENT_A, 0, 3, true));
        vm.stopPrank();
        assertEq(adapters.getAdapter(AGENT_A).version, 3);
    }

    function test_UpdateDoesNotDuplicateTheRegistryEntry() public {
        vm.startPrank(ownerA);
        adapters.registerAdapter(_adapter(AGENT_A, 0, 1, true));
        adapters.registerAdapter(_adapter(AGENT_A, 0, 2, true));
        vm.stopPrank();
        assertEq(adapters.registeredCount(), 1);
    }

    function test_GetAdapterRevertsWhenAbsent() public {
        vm.expectRevert(abi.encodeWithSelector(AgentAdapterRegistry.NoAdapter.selector, AGENT_A));
        adapters.getAdapter(AGENT_A);
    }

    function test_ListActiveExcludesInactiveAdapters() public {
        vm.prank(ownerA);
        adapters.registerAdapter(_adapter(AGENT_A, 0, 1, true));
        vm.prank(ownerB);
        adapters.registerAdapter(_adapter(AGENT_B, 1, 1, false));

        AgentAdapterRegistry.Adapter[] memory active = adapters.listActive(0, 10);
        assertEq(active.length, 1);
        assertEq(active[0].agentId, AGENT_A);
    }

    function test_ListActiveIsRightSizedRatherThanZeroPadded() public view {
        // A caller must not have to distinguish a real entry from a zero one.
        AgentAdapterRegistry.Adapter[] memory none = adapters.listActive(0, 10);
        assertEq(none.length, 0);
    }

    function test_ListActivePaginates() public {
        vm.prank(ownerA);
        adapters.registerAdapter(_adapter(AGENT_A, 0, 1, true));
        vm.prank(ownerB);
        adapters.registerAdapter(_adapter(AGENT_B, 0, 1, true));

        assertEq(adapters.listActive(0, 1).length, 1);
        assertEq(adapters.listActive(0, 1)[0].agentId, AGENT_A);
        assertEq(adapters.listActive(1, 1).length, 1);
        assertEq(adapters.listActive(1, 1)[0].agentId, AGENT_B);
        assertEq(adapters.listActive(2, 1).length, 0);
    }

    function test_DeactivationRemovesFromListActive() public {
        vm.startPrank(ownerA);
        adapters.registerAdapter(_adapter(AGENT_A, 0, 1, true));
        assertEq(adapters.listActive(0, 10).length, 1);
        adapters.registerAdapter(_adapter(AGENT_A, 0, 2, false));
        vm.stopPrank();
        assertEq(adapters.listActive(0, 10).length, 0);
    }
}
