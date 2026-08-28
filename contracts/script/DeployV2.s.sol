// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ExecutionReceiptsV2} from "../src/ExecutionReceiptsV2.sol";
import {FlowRegistry} from "../src/FlowRegistry.sol";
import {AgentAdapterRegistryV2} from "../src/AgentAdapterRegistryV2.sol";
import {FlowEscrowV2} from "../src/FlowEscrowV2.sol";

/// @title DeployV2
/// @notice Deploys the marketplace contracts alongside v1 — v1 stays live and
/// every run anchored there keeps verifying (§10.2).
///
///   FLOW_REGISTRY=0x… IDENTITY_REGISTRY=0x… \
///   forge script script/DeployV2.s.sol:DeployV2 \
///     --rpc-url $ZG_RPC_URL --private-key $ZG_PRIVATE_KEY --broadcast
///
/// `FlowRegistry` is deliberately *reused*, not redeployed. It maps runId to
/// flowId and executor, and nothing about a marketplace changes that. Sharing
/// it means a run id is unique across both receipt contracts, so a v1 run and
/// a v2 run can never collide — and published flows stay published.
///
/// Set FLOW_REGISTRY to the existing deployment. It is read rather than
/// defaulted because a wrong flow registry would not fail loudly: v2 would
/// simply find no run and refuse every anchor, which looks like a permissions
/// problem rather than a wiring one.
contract DeployV2 is Script {
    /// A different salt from v1, so CREATE2 yields fresh addresses rather than
    /// colliding with the existing deployment.
    bytes32 internal constant SALT = keccak256("0gflow.v2");

    function run() external {
        address flowRegistry = vm.envAddress("FLOW_REGISTRY");
        address identityRegistry = vm.envAddress("IDENTITY_REGISTRY");

        require(flowRegistry.code.length > 0, "FLOW_REGISTRY has no code");
        require(identityRegistry.code.length > 0, "IDENTITY_REGISTRY has no code");

        vm.startBroadcast();

        ExecutionReceiptsV2 receipts = new ExecutionReceiptsV2{salt: SALT}(flowRegistry);
        AgentAdapterRegistryV2 adapters = new AgentAdapterRegistryV2{salt: SALT}(identityRegistry);
        FlowEscrowV2 escrow = new FlowEscrowV2{salt: SALT}(address(receipts), address(adapters));

        vm.stopBroadcast();

        console.log("ExecutionReceiptsV2    ", address(receipts));
        console.log("AgentAdapterRegistryV2 ", address(adapters));
        console.log("FlowEscrowV2           ", address(escrow));
        console.log("FlowRegistry (reused)  ", flowRegistry);
        console.log("identityRegistry       ", identityRegistry);
        console.log("deployedAtBlock        ", block.number);

        // Fail loudly rather than reporting addresses nothing was deployed to.
        require(address(receipts).code.length > 0, "ExecutionReceiptsV2 has no code");
        require(address(adapters).code.length > 0, "AgentAdapterRegistryV2 has no code");
        require(address(escrow).code.length > 0, "FlowEscrowV2 has no code");
        require(address(receipts.flowRegistry()) == flowRegistry, "receipts not wired");
        require(address(escrow.receipts()) == address(receipts), "escrow not wired to receipts");
        require(address(escrow.registry()) == address(adapters), "escrow not wired to registry");
        require(address(adapters.identityRegistry()) == identityRegistry, "adapters not wired");

        // The digest the escrow will enforce must be the one agents sign. A
        // mismatch here would deploy a contract that silently refuses every
        // payment, so it is checked before the addresses are trusted.
        require(
            escrow.AGENT_OUTPUT_DOMAIN() == keccak256("0gflow-agent-output-v1"),
            "agent output domain diverged from packages/core"
        );
    }
}
