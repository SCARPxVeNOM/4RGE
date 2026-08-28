// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentAdapterRegistryV2} from "../src/AgentAdapterRegistryV2.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";

/// Reproduces ERC-721's actual behaviour: `ownerOf` REVERTS for a nonexistent
/// token rather than returning the zero address. A mock returning address(0)
/// would let the registry pass here and fail against the live contract.
contract MockIdentityV2 is IIdentityRegistry {
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

contract AgentAdapterRegistryV2Test is Test {
    MockIdentityV2 internal identity;
    AgentAdapterRegistryV2 internal adapters;

    uint256 internal constant AGENT_A = 1;
    uint256 internal constant AGENT_B = 2;
    address internal ownerA = address(0x01);
    address internal ownerB = address(0x02);
    address internal operatorA = address(0x0A);
    address internal stranger = address(0xBAD);
    address internal payToA = address(0xF1);
    address internal signerA = address(0x51);

    function setUp() public {
        identity = new MockIdentityV2();
        adapters = new AgentAdapterRegistryV2(address(identity));
        identity.setOwner(AGENT_A, ownerA);
        identity.setOwner(AGENT_B, ownerB);
    }

    function _adapter(uint256 agentId, uint32 version)
        internal
        view
        returns (AgentAdapterRegistryV2.Adapter memory)
    {
        return AgentAdapterRegistryV2.Adapter({
            agentId: agentId,
            kind: 0,
            endpoint: "https://agent.example/invoke",
            schemaRoot: keccak256("schema"),
            version: version,
            active: true,
            payTo: payToA,
            signer: signerA,
            pricePerCall: 1 ether,
            metadataURI: "ipfs://meta"
        });
    }

    function _register(uint256 agentId, address caller, uint32 version) internal {
        vm.prank(caller);
        adapters.registerAdapter(_adapter(agentId, version));
    }

    // ---------------------------------------------------------------------
    // The marketplace fields
    // ---------------------------------------------------------------------

    function test_StoresThePaymentAndSigningFields() public {
        _register(AGENT_A, ownerA, 1);

        AgentAdapterRegistryV2.Adapter memory a = adapters.getAdapter(AGENT_A);
        assertEq(a.payTo, payToA);
        assertEq(a.signer, signerA);
        assertEq(a.pricePerCall, 1 ether);
        assertEq(a.metadataURI, "ipfs://meta");

        assertEq(adapters.signerOf(AGENT_A), signerA);
        assertEq(adapters.payToOf(AGENT_A), payToA);
        assertEq(adapters.priceOf(AGENT_A), 1 ether);
    }

    /// `FlowEscrowV2` compares `signerOf` against a recovered address, and
    /// ecrecover returns address(0) on failure. If this reverted instead of
    /// returning zero, an unlisted agent would produce a failed transaction
    /// rather than a clean refusal to pay; if it returned anything nonzero,
    /// a malformed signature could match.
    function test_SignerOfUnlistedAgentIsZeroNotARevert() public view {
        assertEq(adapters.signerOf(999), address(0));
        assertEq(adapters.payToOf(999), address(0));
    }

    /// A zero payTo would burn every payment the agent earns; a zero signer
    /// would collide with ecrecover's failure value. Both are refused at
    /// listing time rather than discovered at payment time.
    function test_RefusesZeroPayToOrSigner() public {
        AgentAdapterRegistryV2.Adapter memory a = _adapter(AGENT_A, 1);
        a.payTo = address(0);
        vm.prank(ownerA);
        vm.expectRevert(AgentAdapterRegistryV2.ZeroPayTo.selector);
        adapters.registerAdapter(a);

        a.payTo = payToA;
        a.signer = address(0);
        vm.prank(ownerA);
        vm.expectRevert(AgentAdapterRegistryV2.ZeroSigner.selector);
        adapters.registerAdapter(a);
    }

    /// The signer is a hot key in a running service; the owner is a cold key
    /// holding an NFT. Rotating one must not require touching the other.
    function test_OwnerCanRotateTheSignerWithoutMovingTheIdentity() public {
        _register(AGENT_A, ownerA, 1);

        AgentAdapterRegistryV2.Adapter memory a = _adapter(AGENT_A, 2);
        a.signer = address(0x52);
        vm.prank(ownerA);
        adapters.registerAdapter(a);

        assertEq(adapters.signerOf(AGENT_A), address(0x52));
        assertEq(identity.ownerOf(AGENT_A), ownerA);
    }

    // ---------------------------------------------------------------------
    // Who may publish
    // ---------------------------------------------------------------------

    function test_StrangerCannotList() public {
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(AgentAdapterRegistryV2.NotAuthorised.selector, AGENT_A, stranger)
        );
        adapters.registerAdapter(_adapter(AGENT_A, 1));
    }

    function test_CannotListAnAgentThatDoesNotExist() public {
        vm.prank(ownerA);
        vm.expectRevert(
            abi.encodeWithSelector(AgentAdapterRegistryV2.AgentNotRegistered.selector, uint256(777))
        );
        adapters.registerAdapter(_adapter(777, 1));
    }

    /// v1 required `ownerOf == msg.sender`, so an agent hosted by someone else
    /// could not have its endpoint updated without handing over the NFT.
    function test_OperatorMayPublishOnTheOwnersBehalf() public {
        vm.prank(ownerA);
        adapters.setOperator(AGENT_A, operatorA);
        assertEq(adapters.operatorOf(AGENT_A), operatorA);

        _register(AGENT_A, operatorA, 1);
        assertTrue(adapters.hasAdapter(AGENT_A));
    }

    /// If an operator could appoint an operator, the delegation would be
    /// irrevocable in practice: the owner revokes, the operator re-grants.
    function test_OperatorCannotAppointAnotherOperator() public {
        vm.prank(ownerA);
        adapters.setOperator(AGENT_A, operatorA);

        vm.prank(operatorA);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentAdapterRegistryV2.NotIdentityOwner.selector, AGENT_A, operatorA, ownerA
            )
        );
        adapters.setOperator(AGENT_A, stranger);
    }

    function test_OwnerCanRevokeAnOperator() public {
        vm.prank(ownerA);
        adapters.setOperator(AGENT_A, operatorA);
        vm.prank(ownerA);
        adapters.setOperator(AGENT_A, address(0));

        vm.prank(operatorA);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentAdapterRegistryV2.NotAuthorised.selector, AGENT_A, operatorA
            )
        );
        adapters.registerAdapter(_adapter(AGENT_A, 1));
    }

    /// An operator for one agent is not an operator for another.
    function test_OperatorIsScopedToOneAgent() public {
        vm.prank(ownerA);
        adapters.setOperator(AGENT_A, operatorA);

        vm.prank(operatorA);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentAdapterRegistryV2.NotAuthorised.selector, AGENT_B, operatorA
            )
        );
        adapters.registerAdapter(_adapter(AGENT_B, 1));
    }

    // ---------------------------------------------------------------------
    // Deactivation, which v1 could not express
    // ---------------------------------------------------------------------

    function test_DeactivateRemovesFromTheDirectoryAndEmits() public {
        _register(AGENT_A, ownerA, 1);
        assertEq(adapters.listActive(0, 10).length, 1);

        vm.expectEmit(true, false, false, true);
        emit AgentAdapterRegistryV2.AdapterDeactivated(AGENT_A, 1);
        vm.prank(ownerA);
        adapters.deactivate(AGENT_A);

        assertEq(adapters.listActive(0, 10).length, 0);
        // Still resolvable by id: an agent that stopped serving is not an
        // agent that never existed, and past receipts still name it.
        assertTrue(adapters.hasAdapter(AGENT_A));
        assertFalse(adapters.getAdapter(AGENT_A).active);
    }

    function test_DeactivateDoesNotRequireAVersionBump() public {
        _register(AGENT_A, ownerA, 1);
        vm.prank(ownerA);
        adapters.deactivate(AGENT_A);
        assertEq(adapters.getAdapter(AGENT_A).version, 1);
    }

    function test_StrangerCannotDeactivate() public {
        _register(AGENT_A, ownerA, 1);
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(AgentAdapterRegistryV2.NotAuthorised.selector, AGENT_A, stranger)
        );
        adapters.deactivate(AGENT_A);
    }

    function test_RegisteringInactiveAlsoEmitsDeactivated() public {
        AgentAdapterRegistryV2.Adapter memory a = _adapter(AGENT_A, 1);
        a.active = false;

        vm.expectEmit(true, false, false, true);
        emit AgentAdapterRegistryV2.AdapterDeactivated(AGENT_A, 1);
        vm.prank(ownerA);
        adapters.registerAdapter(a);
    }

    function test_ReactivationIsAVersionBump() public {
        _register(AGENT_A, ownerA, 1);
        vm.prank(ownerA);
        adapters.deactivate(AGENT_A);

        _register(AGENT_A, ownerA, 2);
        assertEq(adapters.listActive(0, 10).length, 1);
    }

    // ---------------------------------------------------------------------
    // Invariants carried over from v1
    // ---------------------------------------------------------------------

    function test_VersionsMoveForwardOnly() public {
        _register(AGENT_A, ownerA, 5);
        vm.prank(ownerA);
        vm.expectRevert(
            abi.encodeWithSelector(
                AgentAdapterRegistryV2.VersionNotIncreasing.selector, uint32(5), uint32(5)
            )
        );
        adapters.registerAdapter(_adapter(AGENT_A, 5));
    }

    function test_EmptyEndpointIsRefused() public {
        AgentAdapterRegistryV2.Adapter memory a = _adapter(AGENT_A, 1);
        a.endpoint = "";
        vm.prank(ownerA);
        vm.expectRevert(AgentAdapterRegistryV2.EmptyEndpoint.selector);
        adapters.registerAdapter(a);
    }

    /// v2 adds kind 3 (flow) so an agent can be a sub-workflow.
    function test_KindFlowIsAcceptedAndFourIsNot() public {
        AgentAdapterRegistryV2.Adapter memory a = _adapter(AGENT_A, 1);
        a.kind = 3;
        vm.prank(ownerA);
        adapters.registerAdapter(a);
        assertEq(adapters.getAdapter(AGENT_A).kind, 3);

        a = _adapter(AGENT_B, 1);
        a.kind = 4;
        vm.prank(ownerB);
        vm.expectRevert(abi.encodeWithSelector(AgentAdapterRegistryV2.UnknownKind.selector, 4));
        adapters.registerAdapter(a);
    }

    function test_GetAdapterRevertsForAnUnlistedAgent() public {
        vm.expectRevert(
            abi.encodeWithSelector(AgentAdapterRegistryV2.NoAdapter.selector, uint256(999))
        );
        adapters.getAdapter(999);
    }

    /// A right-sized array, so a caller cannot mistake trailing zero entries
    /// for real agents.
    function test_ListActivePaginatesWithoutPaddingEntries() public {
        _register(AGENT_A, ownerA, 1);
        _register(AGENT_B, ownerB, 1);

        assertEq(adapters.listActive(0, 10).length, 2);
        assertEq(adapters.listActive(0, 1).length, 1);
        assertEq(adapters.listActive(1, 10).length, 1);
        assertEq(adapters.listActive(2, 10).length, 0);
        assertEq(adapters.registeredCount(), 2);
    }
}
