// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @title AgentAdapterRegistryV2
/// @notice The marketplace listing — spec §4.3, extended past v1.0's scope.
///
/// v1 answers "how do I call this agent". A market also has to answer "who
/// gets paid", "whose signature counts as this agent's", "what does it cost"
/// and "what is it called". Those four are what v2 adds, and each one is load
/// bearing somewhere else:
///
///   payTo         `FlowEscrowV2` sends here, so the executor cannot redirect
///                 payment by naming a different address at release time
///   signer        the key whose signature over `agentOutputDigest` proves
///                 this agent produced a step's output
///   pricePerCall  what the executor allocates from the run's budget
///   metadataURI   a name and description, so the directory shows something
///                 other than a token id
///
/// `signer` is separate from the identity owner on purpose. The owner is a
/// cold key that holds an NFT; the signer is a hot key inside a running
/// service. Requiring the owner's key to sign every output would put it on
/// whatever machine serves traffic, which is exactly where it should not be.
/// The owner can rotate the signer at any time without touching the identity.
///
/// Registration stays permissionless and gated only on identity ownership:
/// anyone who controls an agent identity may list it, nobody may list on
/// behalf of an identity they do not control. There is no admin, no allowlist
/// and no curation — a registry that can refuse a listing is not a market.
contract AgentAdapterRegistryV2 {
    uint8 internal constant KIND_MAX = 3; // 0 http · 1 contract · 2 0g-compute · 3 flow

    struct Adapter {
        uint256 agentId;
        uint8 kind;
        string endpoint;
        bytes32 schemaRoot; // 0G Storage root of input/output JSON Schema
        uint32 version;
        bool active;
        address payTo; // where FlowEscrowV2 sends payment
        address signer; // key that signs this agent's outputs
        uint256 pricePerCall; // native wei; 0 means free or negotiated off-chain
        string metadataURI; // name, description, tags
    }

    IIdentityRegistry public immutable identityRegistry;

    mapping(uint256 => Adapter) private _adapters;
    uint256[] private _registered;
    mapping(uint256 => bool) private _known;
    /// agentId => address allowed to publish alongside the identity owner.
    mapping(uint256 => address) private _operator;

    event AdapterRegistered(
        uint256 indexed agentId,
        address indexed owner,
        uint8 kind,
        string endpoint,
        bytes32 schemaRoot,
        uint32 version,
        bool active,
        address payTo,
        address signer,
        uint256 pricePerCall,
        string metadataURI
    );

    /// @dev v1 has no such event, so an indexer there can only infer that an
    /// agent went away by noticing a later registration that says `active:
    /// false` — and never learns about one that simply stopped.
    event AdapterDeactivated(uint256 indexed agentId, uint32 version);

    event OperatorSet(uint256 indexed agentId, address indexed operator);

    error NotIdentityOwner(uint256 agentId, address caller, address owner);
    error NotAuthorised(uint256 agentId, address caller);
    error AgentNotRegistered(uint256 agentId);
    error UnknownKind(uint8 kind);
    error EmptyEndpoint();
    error ZeroPayTo();
    error ZeroSigner();
    error VersionNotIncreasing(uint32 submitted, uint32 current);
    error NoAdapter(uint256 agentId);

    constructor(address identityRegistry_) {
        identityRegistry = IIdentityRegistry(identityRegistry_);
    }

    /// @dev ERC-721 `ownerOf` reverts for a nonexistent token, so existence
    /// and ownership are the same call. Catching the revert lets us report
    /// "no such agent" distinctly from "not your agent".
    function _ownerOf(uint256 agentId) private view returns (address owner) {
        try identityRegistry.ownerOf(agentId) returns (address resolved) {
            owner = resolved;
        } catch {
            revert AgentNotRegistered(agentId);
        }
        if (owner == address(0)) revert AgentNotRegistered(agentId);
    }

    /// @notice Registers or updates the adapter for an agent identity.
    ///
    /// The owner or the operator may call. v1 allowed only the owner, which
    /// meant an agent hosted by someone else could not have its endpoint
    /// updated without handing over the identity NFT.
    function registerAdapter(Adapter calldata a) external {
        address owner = _ownerOf(a.agentId);
        if (msg.sender != owner && msg.sender != _operator[a.agentId]) {
            revert NotAuthorised(a.agentId, msg.sender);
        }

        if (a.kind > KIND_MAX) revert UnknownKind(a.kind);
        if (bytes(a.endpoint).length == 0) revert EmptyEndpoint();

        // A zero payTo would burn every payment this agent earns, silently.
        if (a.payTo == address(0)) revert ZeroPayTo();
        // A zero signer would make every signature check fail closed against
        // ecrecover's own failure value, which is the same address. Better to
        // refuse the listing than to publish an agent that can never be paid.
        if (a.signer == address(0)) revert ZeroSigner();

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
            a.agentId,
            owner,
            a.kind,
            a.endpoint,
            a.schemaRoot,
            a.version,
            a.active,
            a.payTo,
            a.signer,
            a.pricePerCall,
            a.metadataURI
        );

        if (!a.active) emit AdapterDeactivated(a.agentId, a.version);
    }

    /// @notice Takes an agent out of the directory without bumping its
    /// version or resubmitting its whole record — the common case when a
    /// service goes down and its operator wants it to stop being hired.
    function deactivate(uint256 agentId) external {
        if (!_known[agentId]) revert NoAdapter(agentId);
        address owner = _ownerOf(agentId);
        if (msg.sender != owner && msg.sender != _operator[agentId]) {
            revert NotAuthorised(agentId, msg.sender);
        }

        _adapters[agentId].active = false;
        emit AdapterDeactivated(agentId, _adapters[agentId].version);
    }

    /// @notice Delegates publishing to an operator. Owner only — an operator
    /// cannot appoint its own successor, or the delegation would be
    /// irrevocable in practice.
    function setOperator(uint256 agentId, address operator) external {
        address owner = _ownerOf(agentId);
        if (msg.sender != owner) revert NotIdentityOwner(agentId, msg.sender, owner);
        _operator[agentId] = operator;
        emit OperatorSet(agentId, operator);
    }

    function operatorOf(uint256 agentId) external view returns (address) {
        return _operator[agentId];
    }

    function getAdapter(uint256 agentId) external view returns (Adapter memory) {
        if (!_known[agentId]) revert NoAdapter(agentId);
        return _adapters[agentId];
    }

    /// @notice The key whose signature counts as this agent's.
    ///
    /// Returns the zero address for an unlisted agent rather than reverting:
    /// `FlowEscrowV2` compares this against a recovered signer, and an agent
    /// that never listed simply has no valid signature. Reverting would turn
    /// "this agent is not in the registry" into a failed transaction rather
    /// than a clean refusal to pay.
    function signerOf(uint256 agentId) external view returns (address) {
        return _adapters[agentId].signer;
    }

    function payToOf(uint256 agentId) external view returns (address) {
        return _adapters[agentId].payTo;
    }

    function priceOf(uint256 agentId) external view returns (uint256) {
        return _adapters[agentId].pricePerCall;
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
