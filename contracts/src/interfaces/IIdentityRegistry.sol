// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IIdentityRegistry
/// @notice The slice of agent identity that 0G Flow depends on.
///
/// RESOLVED AGAINST LIVE CONTRACTS (not assumed). Two registries are deployed
/// on 0G Galileo and both are ERC-721:
///
///   ERC-8004 Trustless Agent  0x7177a6867296406881E20d6647232314736Dd09A
///                             name "ERC-8004 Trustless Agent", symbol AGENT
///   0G Agentic ID (ERC-7857)  0x2700F6A3e505402C9daB154C5c6ab9cAEC98EF1F
///                             name "Agentic ID", symbol AID
///
/// Both identify an agent by uint256 token id and expose ownerOf(). This
/// interface is therefore just the ERC-721 slice we need, which means
/// AgentAdapterRegistry can point at either registry unchanged.
///
/// ERC-721 requires ownerOf() to revert for a nonexistent token, so
/// "is this agent registered" is "does ownerOf not revert" — there is no
/// separate existence method to call.
interface IIdentityRegistry {
    /// @notice The account that controls an agent identity.
    /// @dev Reverts if the token does not exist, per ERC-721.
    function ownerOf(uint256 agentId) external view returns (address);
}
