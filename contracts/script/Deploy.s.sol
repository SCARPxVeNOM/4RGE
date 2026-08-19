// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ExecutionReceipts} from "../src/ExecutionReceipts.sol";
import {FlowRegistry} from "../src/FlowRegistry.sol";
import {AgentAdapterRegistry} from "../src/AgentAdapterRegistry.sol";
import {FlowEscrow} from "../src/FlowEscrow.sol";

/// @title Deploy
/// @notice Deploys the 0G Flow contracts via CREATE2 with a fixed salt, so the
/// same addresses are reproducible on Aristotle at migration time (§12).
///
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url $ZG_RPC_URL --private-key $ZG_PRIVATE_KEY --broadcast
///
/// IDENTITY_REGISTRY must be an ERC-721 agent registry. On Galileo that is
/// either the ERC-8004 registry or 0G's Agentic ID; both are keyed by uint256
/// token id, so either works unchanged.
contract Deploy is Script {
    bytes32 internal constant SALT = keccak256("0gflow.v1");

    function run() external {
        address identityRegistry = vm.envAddress("IDENTITY_REGISTRY");

        vm.startBroadcast();

        FlowRegistry flowRegistry = new FlowRegistry{salt: SALT}();
        ExecutionReceipts receipts = new ExecutionReceipts{salt: SALT}(address(flowRegistry));
        AgentAdapterRegistry adapters = new AgentAdapterRegistry{salt: SALT}(identityRegistry);
        FlowEscrow escrow = new FlowEscrow{salt: SALT}(address(receipts));

        vm.stopBroadcast();

        console.log("FlowRegistry         ", address(flowRegistry));
        console.log("ExecutionReceipts    ", address(receipts));
        console.log("AgentAdapterRegistry ", address(adapters));
        console.log("FlowEscrow           ", address(escrow));
        console.log("identityRegistry     ", identityRegistry);
        console.log("deployedAtBlock      ", block.number);

        // Fail loudly rather than reporting addresses nothing was deployed to.
        require(address(flowRegistry).code.length > 0, "FlowRegistry has no code");
        require(address(receipts).code.length > 0, "ExecutionReceipts has no code");
        require(address(adapters).code.length > 0, "AgentAdapterRegistry has no code");
        require(address(escrow).code.length > 0, "FlowEscrow has no code");
        require(receipts.flowRegistry() == flowRegistry, "receipts not wired to registry");
        require(escrow.receipts() == receipts, "escrow not wired to receipts");
        require(address(adapters.identityRegistry()) == identityRegistry, "adapters not wired");
    }
}
