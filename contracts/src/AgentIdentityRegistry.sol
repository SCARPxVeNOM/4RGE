// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title AgentIdentityRegistry
/// @notice A permissionless ERC-8004-shaped agent identity registry.
///
/// WHY THIS EXISTS
///
/// On Galileo this contract is not needed: an ERC-8004 registry is already
/// deployed at 0x7177a6867296406881E20d6647232314736Dd09A and agents 12-15 of
/// this project were minted into it. On Aristotle mainnet there is no code at
/// that address, and 0G's own Agentic ID (ERC-7857) is not a substitute for
/// this particular job:
///
///   ERC-7857's mint is `onlyOwner`. That is correct for what it is for --
///   tokenising an agent's *intelligence* with encrypted metadata, where the
///   issuer vouches for what is inside. It is fatal for a marketplace whose
///   entire premise is that a stranger can list an agent without asking
///   anyone's permission. A directory you must be admitted to is a directory,
///   not a market.
///
/// So the two standards are not competing here, and this is not a rejection of
/// Agentic ID. 0G's own documentation puts it exactly right: ERC-7857 governs
/// "encrypted ownership and secure transfer of an agent's intelligence", while
/// ERC-8004 is "the identity and reputation layer" for public discovery. This
/// project is the second thing. An agent whose model is tokenised as an
/// Agentic ID can still be listed here -- the two identities coexist, and
/// AgentAdapterRegistryV2 accepts either because both are keyed by uint256.
///
/// WHAT THIS DELIBERATELY IS NOT
///
/// Not a full ERC-721. There is no approval machinery, no safeTransferFrom, no
/// operator model. `AgentAdapterRegistryV2` needs exactly one function --
/// `ownerOf` -- and every additional entry point is additional surface on a
/// contract that will hold other people's agent identities. Transfer is
/// supported because an agent changing hands is a real thing; approvals are
/// not, because nothing in this system ever needs a third party to move an
/// identity on an owner's behalf.
///
/// The `register(string)` selector is 0xf2c298be, byte-identical to the
/// Galileo registry's, so the publish CLI and the browser publish page work
/// against either chain with no branch.
contract AgentIdentityRegistry {
    /// @notice ERC-721's transfer event. Minting is a transfer from the zero
    /// address, which is how `publish` learns the id it was just given: a
    /// non-view function cannot return a value to an external caller.
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    /// @notice Emitted when an agent's registration document changes.
    event MetadataUpdate(uint256 indexed tokenId);

    error TokenDoesNotExist(uint256 tokenId);
    error NotOwner(uint256 tokenId, address caller, address owner);
    error ZeroAddress();

    string public constant name = "0G Flow Agent Identity";
    string public constant symbol = "AGENT";

    /// @dev Token ids start at 1. Zero is reserved to mean "no agent", which
    /// several places in this system rely on being unrepresentable.
    uint256 private _nextId = 1;

    mapping(uint256 => address) private _owners;
    mapping(uint256 => string) private _tokenURIs;
    mapping(address => uint256) private _balances;

    /// @notice Mint an agent identity to the caller.
    /// @param tokenURI_ The registration document -- a data: or ipfs: URI
    /// describing the agent. Not validated: it is the caller's own claim about
    /// their own agent, and a registry that adjudicated content would be
    /// making a judgement it has no basis for.
    /// @return agentId The newly minted identity.
    function register(string calldata tokenURI_) external returns (uint256 agentId) {
        agentId = _nextId++;
        _owners[agentId] = msg.sender;
        _balances[msg.sender] += 1;
        _tokenURIs[agentId] = tokenURI_;
        emit Transfer(address(0), msg.sender, agentId);
    }

    /// @notice The account that controls an agent identity.
    /// @dev Reverts for a nonexistent token, per ERC-721. "Is this agent
    /// registered" is therefore "does this call not revert" -- there is no
    /// separate existence method, and adding one would let a caller treat a
    /// missing agent as a present one with a falsy owner.
    function ownerOf(uint256 agentId) external view returns (address) {
        address owner = _owners[agentId];
        if (owner == address(0)) revert TokenDoesNotExist(agentId);
        return owner;
    }

    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert ZeroAddress();
        return _balances[owner];
    }

    function tokenURI(uint256 agentId) external view returns (string memory) {
        if (_owners[agentId] == address(0)) revert TokenDoesNotExist(agentId);
        return _tokenURIs[agentId];
    }

    /// @notice Replace an agent's registration document.
    /// @dev The identity is unchanged, so every receipt naming this agent
    /// stays valid. That is the point of keying receipts on the token id
    /// rather than on anything mutable.
    function setTokenURI(uint256 agentId, string calldata tokenURI_) external {
        address owner = _owners[agentId];
        if (owner == address(0)) revert TokenDoesNotExist(agentId);
        if (owner != msg.sender) revert NotOwner(agentId, msg.sender, owner);
        _tokenURIs[agentId] = tokenURI_;
        emit MetadataUpdate(agentId);
    }

    /// @notice Hand an agent identity to someone else.
    /// @dev Owner-only and direct: no approvals, no operators. Transferring to
    /// the zero address is refused rather than treated as a burn, because a
    /// burnt identity would make `ownerOf` revert for an agent that has
    /// historical receipts -- turning a verifiable past run into an
    /// unresolvable one.
    function transferFrom(address from, address to, uint256 agentId) external {
        address owner = _owners[agentId];
        if (owner == address(0)) revert TokenDoesNotExist(agentId);
        if (owner != msg.sender || owner != from) revert NotOwner(agentId, msg.sender, owner);
        if (to == address(0)) revert ZeroAddress();

        _balances[from] -= 1;
        _balances[to] += 1;
        _owners[agentId] = to;
        emit Transfer(from, to, agentId);
    }

    /// @notice How many identities have been registered.
    /// @dev Present because the Galileo registry's absence of it forced the
    /// indexer to enumerate `Transfer` logs to find agents at all.
    function totalSupply() external view returns (uint256) {
        return _nextId - 1;
    }

    /// @notice ERC-165. Reports ERC-721's interface id for the slice
    /// implemented, so tooling that probes before calling `ownerOf` proceeds.
    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 || interfaceId == 0x80ac58cd || interfaceId == 0x5b5e139f;
    }
}
