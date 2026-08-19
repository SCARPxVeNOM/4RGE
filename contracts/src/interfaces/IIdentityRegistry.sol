// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IIdentityRegistry
/// @notice The slice of ERC-8004 identity that 0G Flow depends on.
///
/// OPEN ITEM — PROVISIONAL SHAPE.
///
/// §2 states the ERC-8004 registries are pre-deployed on Galileo and that
/// their addresses must be resolved before deploying replacements. This
/// interface is the minimum 0G Flow needs, declared narrowly and deliberately:
/// it is the only surface that has to change once the live registry's ABI is
/// confirmed. Nothing else in the contracts references ERC-8004 directly.
///
/// Confirm against the deployed registry before Phase 2, in the same way the
/// TEE attestation structure is being confirmed before attestationRef is
/// finalised. Designing the rest of the system against a guessed ABI is the
/// expensive way to discover it was wrong.
interface IIdentityRegistry {
    /// @notice The account that controls an agent identity.
    /// @dev Expected to revert or return address(0) for an unregistered agent.
    function ownerOf(address agentId) external view returns (address);

    /// @notice Whether an agent identity is registered and active.
    function isRegistered(address agentId) external view returns (bool);
}
