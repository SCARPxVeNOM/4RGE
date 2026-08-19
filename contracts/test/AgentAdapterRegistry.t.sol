// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentAdapterRegistry} from "../src/AgentAdapterRegistry.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

/// Stands in for the pre-deployed ERC-8004 IdentityRegistry on Galileo, whose
/// exact ABI is still to be confirmed (§2). Only the two methods 0G Flow
/// depends on are modelled.
contract MockIdentityRegistry is IIdentityRegistry {
    mapping(address => address) private _owners;

    function setOwner(address agentId, address owner) external {
        _owners[agentId] = owner;
    }

    function ownerOf(address agentId) external view returns (address) {
        return _owners[agentId];
    }

    function isRegistered(address agentId) external view returns (bool) {
        return _owners[agentId] != address(0);
    }
}

contract AgentAdapterRegistryTest is Test {
    MockIdentityRegistry internal identity;
    AgentAdapterRegistry internal adapters;

    address internal agentA = address(0xA1);
    address internal agentB = address(0xA2);
    address internal ownerA = address(0x01);
    address internal ownerB = address(0x02);
    address internal stranger = address(0xBAD);

    function setUp() public {
        identity = new MockIdentityRegistry();
        adapters = new AgentAdapterRegistry(address(identity));
        identity.setOwner(agentA, ownerA);
        identity.setOwner(agentB, ownerB);
    }

    function _adapter(address agentId, uint8 kind, uint32 version, bool active)
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
        adapters.registerAdapter(_adapter(agentA, 0, 1, true));

        AgentAdapterRegistry.Adapter memory stored = adapters.getAdapter(agentA);
        assertEq(stored.agentId, agentA);
        assertEq(stored.kind, 0);
        assertEq(stored.endpoint, "https://agent.example.test/invoke");
        assertEq(stored.version, 1);
        assertTrue(stored.active);
    }

    /// §10.1: registration rejected for non-owners of the ERC-8004 identity.
    function test_RegisterAdapterRevertsForNonOwner() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentAdapterRegistry.NotIdentityOwner.selector, agentA, stranger, ownerA
            )
        );
        adapters.registerAdapter(_adapter(agentA, 0, 1, true));
    }

    function test_RegisterAdapterRevertsForAnotherAgentsOwner() public {
        vm.prank(ownerB);
        vm.expectRevert();
        adapters.registerAdapter(_adapter(agentA, 0, 1, true));
    }

    function test_RegisterAdapterRevertsForUnregisteredIdentity() public {
        address unknown = address(0xDEAD);
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
            freshIdentity.setOwner(agentA, ownerA);
            vm.prank(ownerA);
            fresh.registerAdapter(_adapter(agentA, kind, 1, true));
            assertEq(fresh.getAdapter(agentA).kind, kind);
        }
    }

    function test_RegisterAdapterRevertsOnUnknownKind() public {
        vm.prank(ownerA);
        vm.expectRevert(abi.encodeWithSelector(AgentAdapterRegistry.UnknownKind.selector, uint8(3)));
        adapters.registerAdapter(_adapter(agentA, 3, 1, true));
    }

    function test_RegisterAdapterRevertsOnEmptyEndpoint() public {
        AgentAdapterRegistry.Adapter memory a = _adapter(agentA, 0, 1, true);
        a.endpoint = "";
        vm.prank(ownerA);
        vm.expectRevert(AgentAdapterRegistry.EmptyEndpoint.selector);
        adapters.registerAdapter(a);
    }

    function test_UpdateRequiresAnIncreasingVersion() public {
        vm.startPrank(ownerA);
        adapters.registerAdapter(_adapter(agentA, 0, 2, true));

        vm.expectRevert();
        adapters.registerAdapter(_adapter(agentA, 0, 2, true));
        vm.expectRevert();
        adapters.registerAdapter(_adapter(agentA, 0, 1, true));

        adapters.registerAdapter(_adapter(agentA, 0, 3, true));
        vm.stopPrank();
        assertEq(adapters.getAdapter(agentA).version, 3);
    }

    function test_UpdateDoesNotDuplicateTheRegistryEntry() public {
        vm.startPrank(ownerA);
        adapters.registerAdapter(_adapter(agentA, 0, 1, true));
        adapters.registerAdapter(_adapter(agentA, 0, 2, true));
        vm.stopPrank();
        assertEq(adapters.registeredCount(), 1);
    }

    function test_GetAdapterRevertsWhenAbsent() public {
        vm.expectRevert(abi.encodeWithSelector(AgentAdapterRegistry.NoAdapter.selector, agentA));
        adapters.getAdapter(agentA);
    }

    function test_ListActiveExcludesInactiveAdapters() public {
        vm.prank(ownerA);
        adapters.registerAdapter(_adapter(agentA, 0, 1, true));
        vm.prank(ownerB);
        adapters.registerAdapter(_adapter(agentB, 1, 1, false));

        AgentAdapterRegistry.Adapter[] memory active = adapters.listActive(0, 10);
        assertEq(active.length, 1);
        assertEq(active[0].agentId, agentA);
    }

    function test_ListActiveIsRightSizedRatherThanZeroPadded() public {
        // A caller must not have to distinguish a real entry from a zero one.
        AgentAdapterRegistry.Adapter[] memory none = adapters.listActive(0, 10);
        assertEq(none.length, 0);
    }

    function test_ListActivePaginates() public {
        vm.prank(ownerA);
        adapters.registerAdapter(_adapter(agentA, 0, 1, true));
        vm.prank(ownerB);
        adapters.registerAdapter(_adapter(agentB, 0, 1, true));

        assertEq(adapters.listActive(0, 1).length, 1);
        assertEq(adapters.listActive(0, 1)[0].agentId, agentA);
        assertEq(adapters.listActive(1, 1).length, 1);
        assertEq(adapters.listActive(1, 1)[0].agentId, agentB);
        assertEq(adapters.listActive(2, 1).length, 0);
    }

    function test_DeactivationRemovesFromListActive() public {
        vm.startPrank(ownerA);
        adapters.registerAdapter(_adapter(agentA, 0, 1, true));
        assertEq(adapters.listActive(0, 10).length, 1);
        adapters.registerAdapter(_adapter(agentA, 0, 2, false));
        vm.stopPrank();
        assertEq(adapters.listActive(0, 10).length, 0);
    }
}
