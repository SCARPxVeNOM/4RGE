// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentIdentityRegistry} from "../src/AgentIdentityRegistry.sol";
import {AgentAdapterRegistryV2} from "../src/AgentAdapterRegistryV2.sol";
import {AgentReputationV1} from "../src/AgentReputationV1.sol";
import {ExecutionReceiptsV2} from "../src/ExecutionReceiptsV2.sol";
import {FlowEscrowV2} from "../src/FlowEscrowV2.sol";
import {FlowRegistry} from "../src/FlowRegistry.sol";

/// @title DeployMainnet
/// @notice The whole system, on a chain where nothing of ours exists yet.
///
///   forge script script/DeployMainnet.s.sol:DeployMainnet \
///     --rpc-url https://evmrpc.0g.ai --private-key $ZG_PRIVATE_KEY --broadcast
///
/// Differs from DeployV2 in two ways, both forced by the target chain.
///
/// It deploys its own identity registry. On Galileo an ERC-8004 registry
/// already exists at 0x7177a686… and this project's agents live in it. On
/// Aristotle there is no code at that address, and 0G's Agentic ID cannot
/// stand in: its mint is onlyOwner, so no stranger could list an agent. See
/// AgentIdentityRegistry for the full argument.
///
/// It deploys FlowRegistry rather than reusing one, for the same reason:
/// there is nothing here to reuse.
///
/// Everything is wired and then read back before any address is reported.
/// A deploy script that prints addresses it has not checked is how a chain
/// ends up with six contracts that cannot talk to each other.
contract DeployMainnet is Script {
    /// A distinct salt per chain generation. Sharing v2's salt would make the
    /// mainnet addresses collide with Galileo's in anyone's notes, and two
    /// deployments that look alike but are not is worse than two that differ.
    bytes32 internal constant SALT = keccak256("0gflow.mainnet.v1");

    function run() external {
        vm.startBroadcast();

        AgentIdentityRegistry identity = new AgentIdentityRegistry{salt: SALT}();
        FlowRegistry flowRegistry = new FlowRegistry{salt: SALT}();
        ExecutionReceiptsV2 receipts = new ExecutionReceiptsV2{salt: SALT}(address(flowRegistry));
        AgentAdapterRegistryV2 adapters = new AgentAdapterRegistryV2{salt: SALT}(address(identity));
        FlowEscrowV2 escrow = new FlowEscrowV2{salt: SALT}(address(receipts), address(adapters));
        AgentReputationV1 reputation = new AgentReputationV1{salt: SALT}(address(adapters), address(receipts));

        vm.stopBroadcast();

        // --- code exists ----------------------------------------------------
        require(address(identity).code.length > 0, "AgentIdentityRegistry has no code");
        require(address(flowRegistry).code.length > 0, "FlowRegistry has no code");
        require(address(receipts).code.length > 0, "ExecutionReceiptsV2 has no code");
        require(address(adapters).code.length > 0, "AgentAdapterRegistryV2 has no code");
        require(address(escrow).code.length > 0, "FlowEscrowV2 has no code");
        require(address(reputation).code.length > 0, "AgentReputationV1 has no code");

        // --- wiring ---------------------------------------------------------
        require(address(receipts.flowRegistry()) == address(flowRegistry), "receipts not wired");
        require(address(adapters.identityRegistry()) == address(identity), "adapters not wired");
        require(address(escrow.receipts()) == address(receipts), "escrow not wired to receipts");
        require(address(escrow.registry()) == address(adapters), "escrow not wired to registry");

        // --- the digest agents sign must be the one the escrow enforces -----
        //
        // A mismatch deploys a system that accepts work and then silently
        // refuses every payment for it.
        require(
            escrow.AGENT_OUTPUT_DOMAIN() == keccak256("0gflow-agent-output-v1"),
            "agent output domain diverged from packages/core"
        );

        // --- the identity registry answers the way publish expects ----------
        require(identity.totalSupply() == 0, "identity registry should start empty");

        console.log("network                ", block.chainid);
        console.log("identityRegistry       ", address(identity));
        console.log("flowRegistry           ", address(flowRegistry));
        console.log("executionReceiptsV2    ", address(receipts));
        console.log("agentAdapterRegistryV2 ", address(adapters));
        console.log("flowEscrowV2           ", address(escrow));
        console.log("agentReputation        ", address(reputation));
        console.log("deployedAtBlock        ", block.number);
    }
}
