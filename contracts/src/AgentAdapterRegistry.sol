// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @title AgentAdapterRegistry
/// @notice ERC-8004 establishes agent identity; this registry establishes
/// invocation — spec §4.3.
///
/// Registration is permissionless, gated only on registry ownership. Anyone
/// who controls an agent identity may publish how to call it; nobody may
/// publish on behalf of an identity they do not control.
contract AgentAdapterRegistry {
    uint8 internal constant KIND_MAX = 2; // 0 http · 1 contract · 2 0g-compute

    struct Adapter {
        uint256 agentId;
        uint8 kind;
        string endpoint;
        bytes32 schemaRoot; // 0G Storage root of input/output JSON Schema
        uint32 version;
        bool active;
    }

    IIdentityRegistry public immutable identityRegistry;

    mapping(uint256 => Adapter) private _adapters;
    uint256[] private _registered;
    mapping(uint256 => bool) private _known;

    event AdapterRegistered(
        uint256 indexed agentId,
        address indexed owner,
        uint8 kind,
        string endpoint,
        bytes32 schemaRoot,
        uint32 version,
        bool active
    );

    error NotIdentityOwner(uint256 agentId, address caller, address owner);
    error AgentNotRegistered(uint256 agentId);
    error UnknownKind(uint8 kind);
    error EmptyEndpoint();
    error VersionNotIncreasing(uint32 submitted, uint32 current);
    error NoAdapter(uint256 agentId);

    constructor(address identityRegistry_) {
        identityRegistry = IIdentityRegistry(identityRegistry_);
    }

    /// @notice Registers or updates the adapter for an agent identity.
    function registerAdapter(Adapter calldata a) external {
        // ERC-721 ownerOf reverts for a nonexistent token, so existence and
        // ownership are the same call. Catching the revert lets us report
        // "no such agent" distinctly from "not your agent".
        address owner;
        try identityRegistry.ownerOf(a.agentId) returns (address resolved) {
            owner = resolved;
        } catch {
            revert AgentNotRegistered(a.agentId);
        }
        if (owner == address(0)) revert AgentNotRegistered(a.agentId);
        if (owner != msg.sender) revert NotIdentityOwner(a.agentId, msg.sender, owner);

        if (a.kind > KIND_MAX) revert UnknownKind(a.kind);
        if (bytes(a.endpoint).length == 0) revert EmptyEndpoint();

        // Versions move forward only, so a cached adapter can be invalidated
        // by comparison rather than by refetching.
        uint32 current = _adapters[a.agentId].version;
        if (_known[a.agentId] && a.version <= current) {
            revert VersionNotIncreasing(a.version, current);
        }

        _adapters[a.agentId] = a;
        if (!_known[a.agentId]) {
            _known[a.agentId] = true;
            _registered.push(a.agentId);
        }

        emit AdapterRegistered(
            a.agentId, msg.sender, a.kind, a.endpoint, a.schemaRoot, a.version, a.active
        );
    }

    function getAdapter(uint256 agentId) external view returns (Adapter memory) {
        if (!_known[agentId]) revert NoAdapter(agentId);
        return _adapters[agentId];
    }

    function hasAdapter(uint256 agentId) external view returns (bool) {
        return _known[agentId];
    }

    function registeredCount() external view returns (uint256) {
        return _registered.length;
    }

    /// @notice Paginated view of active adapters. Returns a right-sized array
    /// so a caller cannot mistake trailing zero entries for real ones.
    function listActive(uint256 offset, uint256 limit) external view returns (Adapter[] memory) {
        Adapter[] memory page = new Adapter[](limit);
        uint256 found;
        uint256 skipped;

        for (uint256 i = 0; i < _registered.length && found < limit; i++) {
            Adapter storage adapter = _adapters[_registered[i]];
            if (!adapter.active) continue;
            if (skipped < offset) {
                skipped++;
                continue;
            }
            page[found++] = adapter;
        }

        assembly {
            mstore(page, found)
        }
        return page;
    }
}
