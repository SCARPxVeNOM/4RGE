// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {AgentReputationV1} from "../src/AgentReputationV1.sol";

/// @title DeployReputation
/// @notice Deploys the agent bond.
///
///   ADAPTER_REGISTRY=0x… RECEIPTS=0x… \
///   forge script script/DeployReputation.s.sol:DeployReputation \
///     --rpc-url $ZG_RPC_URL --private-key $ZG_PRIVATE_KEY --broadcast
///
/// RECEIPTS must be the contract an agent's signature commits to, because the
/// equivocation digest includes it. Pointing this at the wrong one would make
/// every genuine signature fail to prove anything — a bond nobody could ever
/// slash, which is worse than no bond because it looks like protection.
contract DeployReputation is Script {
    bytes32 internal constant SALT = keccak256("0gflow.reputation.v1");

    function run() external {
        address registry = vm.envAddress("ADAPTER_REGISTRY");
        address receipts = vm.envAddress("RECEIPTS");

        require(registry.code.length > 0, "ADAPTER_REGISTRY has no code");
        require(receipts.code.length > 0, "RECEIPTS has no code");

        vm.startBroadcast();
        AgentReputationV1 reputation = new AgentReputationV1{salt: SALT}(registry, receipts);
        vm.stopBroadcast();

        console.log("AgentReputationV1 ", address(reputation));
        console.log("adapterRegistry   ", registry);
        console.log("receipts          ", receipts);
        console.log("deployedAtBlock   ", block.number);

        require(address(reputation).code.length > 0, "AgentReputationV1 has no code");
        require(address(reputation.registry()) == registry, "not wired to the registry");
        require(reputation.receipts() == receipts, "not wired to receipts");
        require(
            reputation.AGENT_OUTPUT_DOMAIN() == keccak256("0gflow-agent-output-v1"),
            "agent output domain diverged from packages/core"
        );
    }
}
