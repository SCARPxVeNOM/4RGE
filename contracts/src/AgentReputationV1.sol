// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AgentAdapterRegistryV2} from "./AgentAdapterRegistryV2.sol";
import {IIdentityRegistry} from "./interfaces/IIdentityRegistry.sol";

/// @title AgentReputationV1
/// @notice A bond attached to an agent identity, slashable on provable
/// misbehaviour.
///
/// WHY A BOND AT ALL
///
/// An agent's record is derivable from its receipts, and that is genuinely
/// useful — but it does not survive the obvious dodge. An agent with a bad
/// record mints a fresh identity and starts clean. Minting costs gas and
/// nothing else, so a record alone prices poor work only for an agent that
/// chooses to keep its name.
///
/// A bond changes that arithmetic. Discarding an identity means abandoning
/// capital or waiting out a cooldown, so a flow can ask for skin in the game
/// rather than only a history.
///
/// WHAT IS AND IS NOT SLASHABLE
///
/// Only equivocation: the agent's own registered key signing two different
/// outputs for the same step of the same run. That is provable by anyone,
/// needs no arbiter, and admits no honest explanation — a step has one answer,
/// and offering two means telling different parties different things about the
/// same work.
///
/// Nothing else is slashable, deliberately. "Did poor work" is not decidable
/// on chain: judging it needs an oracle, an oracle needs to be trusted, and a
/// trusted judge is exactly what this project does not have. Pretending
/// otherwise would be worse than admitting the limit. So the bond is a sybil
/// cost and an equivocation deterrent, and it is not a quality guarantee.
///
/// The unbonding cooldown is what stops the bond being theatre: without it an
/// agent could stake, take a job, and withdraw before anyone could react.
contract AgentReputationV1 {
    /// keccak256("0gflow-agent-output-v1") — must match packages/core.
    bytes32 public constant AGENT_OUTPUT_DOMAIN =
        0x15c09898cb7db4f292f4362b60ea464352690737ff2225b4063ae967f0dccd75;

    /// How long a withdrawal waits after being requested.
    uint64 public constant UNBONDING_PERIOD = 7 days;

    /// One thing an agent signed. Grouped rather than passed flat because
    /// nine parameters overflow the EVM's 16-slot stack — and because "two
    /// claims" is what this function is actually about.
    struct SignedClaim {
        bytes32 inputHash;
        bytes32 outputHash;
        bytes signature;
    }

    struct Bond {
        uint256 amount;
        /// Zero means no withdrawal has been requested.
        uint64 unlockAt;
        bool slashed;
    }

    AgentAdapterRegistryV2 public immutable registry;
    IIdentityRegistry public immutable identityRegistry;
    /// The receipts contract an agent's signature commits to.
    address public immutable receipts;

    mapping(uint256 => Bond) private _bonds;
    /// Equivocation is provable once; the second attempt has nothing to take.
    mapping(uint256 => bool) private _proven;

    event Staked(uint256 indexed agentId, address indexed from, uint256 amount, uint256 total);
    event UnstakeRequested(uint256 indexed agentId, uint64 unlockAt);
    event Withdrawn(uint256 indexed agentId, address indexed to, uint256 amount);
    event Slashed(
        uint256 indexed agentId,
        address indexed prover,
        uint256 rewarded,
        uint256 burned,
        bytes32 runId,
        uint32 stepIndex
    );

    error NothingStaked(uint256 agentId);
    error AlreadySlashed(uint256 agentId);
    error NotAuthorised(uint256 agentId, address caller);
    error AgentNotRegistered(uint256 agentId);
    error WithdrawalNotRequested(uint256 agentId);
    error StillBonded(uint256 agentId, uint64 unlockAt, uint64 nowTs);
    error ZeroStake();
    error AgentNotListed(uint256 agentId);
    error MalformedSignature(uint256 length);
    error NotTheAgentsKey(uint256 agentId, address recovered, address expected);
    error NotEquivocation(uint256 agentId, bytes32 runId, uint32 stepIndex);
    error TransferFailed(address to, uint256 amount);

    constructor(address registry_, address receipts_) {
        registry = AgentAdapterRegistryV2(registry_);
        identityRegistry = registry.identityRegistry();
        receipts = receipts_;
    }

    /// @notice Bonds funds to an agent identity.
    ///
    /// Permissionless: anyone may top up an agent's bond. There is no way to
    /// hurt an agent by staking for it, and requiring ownership would stop a
    /// backer vouching for an agent they did not mint.
    ///
    /// A stake cancels any pending withdrawal. Otherwise an agent could
    /// request unbonding, keep the bond visible while it counts down, and take
    /// jobs on the strength of a number it was in the middle of removing.
    function stake(uint256 agentId) external payable {
        if (msg.value == 0) revert ZeroStake();
        Bond storage bond = _bonds[agentId];
        if (bond.slashed) revert AlreadySlashed(agentId);

        // ownerOf reverts for a token that does not exist, so this also
        // refuses a bond on an identity nobody has minted — funds sent there
        // would be unreclaimable by anyone.
        _requireExists(agentId);

        bond.amount += msg.value;
        bond.unlockAt = 0;

        emit Staked(agentId, msg.sender, msg.value, bond.amount);
    }

    /// @notice Starts the unbonding cooldown. Owner or operator only.
    function requestUnstake(uint256 agentId) external {
        Bond storage bond = _bonds[agentId];
        // Slashed before empty: a slashed bond is zero, so checking the amount
        // first would report every slashed agent as merely unstaked and hide
        // the reason it has nothing left.
        if (bond.slashed) revert AlreadySlashed(agentId);
        if (bond.amount == 0) revert NothingStaked(agentId);
        _requireAuthorised(agentId);

        bond.unlockAt = uint64(block.timestamp) + UNBONDING_PERIOD;
        emit UnstakeRequested(agentId, bond.unlockAt);
    }

    /// @notice Returns the bond to the agent's owner, once the cooldown has
    /// elapsed.
    ///
    /// Paid to `ownerOf`, not to the caller and not to the registry's `payTo`.
    /// The bond belongs to whoever holds the identity; `payTo` is where
    /// earnings go and may be an operator's address.
    function withdraw(uint256 agentId) external {
        Bond storage bond = _bonds[agentId];
        // Slashed before empty: a slashed bond is zero, so checking the amount
        // first would report every slashed agent as merely unstaked and hide
        // the reason it has nothing left.
        if (bond.slashed) revert AlreadySlashed(agentId);
        if (bond.amount == 0) revert NothingStaked(agentId);
        if (bond.unlockAt == 0) revert WithdrawalNotRequested(agentId);
        if (block.timestamp < bond.unlockAt) {
            revert StillBonded(agentId, bond.unlockAt, uint64(block.timestamp));
        }
        _requireAuthorised(agentId);

        address owner = identityRegistry.ownerOf(agentId);
        uint256 amount = bond.amount;

        bond.amount = 0;
        bond.unlockAt = 0;

        emit Withdrawn(agentId, owner, amount);

        (bool sent,) = owner.call{value: amount}("");
        if (!sent) revert TransferFailed(owner, amount);
    }

    /// @notice Proves the agent's registered key signed two different outputs
    /// for the same step, and takes its bond.
    ///
    /// Permissionless, because the proof stands on its own: both signatures
    /// must recover to the key that agent published, over the same run and
    /// step, with different claims. Nobody can fabricate that without the
    /// agent's key.
    ///
    /// Half the bond goes to whoever proves it and half is destroyed. Paying
    /// the whole bond to the prover would let a misbehaving agent slash itself
    /// and recover its own stake instantly, skipping the cooldown; burning
    /// half means self-reporting costs half the bond, so the penalty is real
    /// whoever submits it.
    function proveEquivocation(
        uint256 agentId,
        bytes32 runId,
        uint32 stepIndex,
        SignedClaim calldata a,
        SignedClaim calldata b
    ) external {
        Bond storage bond = _bonds[agentId];
        if (bond.slashed) revert AlreadySlashed(agentId);
        if (bond.amount == 0) revert NothingStaked(agentId);

        // Two signatures over the same claim are one signature submitted
        // twice, which proves nothing and must not be slashable.
        if (a.inputHash == b.inputHash && a.outputHash == b.outputHash) {
            revert NotEquivocation(agentId, runId, stepIndex);
        }

        _checkClaims(agentId, runId, stepIndex, a, b);

        uint256 amount = bond.amount;
        uint256 reward = amount / 2;

        // Effects before interaction. The remainder stays here permanently:
        // this contract has no path that pays it out, which is the burn.
        bond.amount = 0;
        bond.unlockAt = 0;
        bond.slashed = true;
        _proven[agentId] = true;

        emit Slashed(agentId, msg.sender, reward, amount - reward, runId, stepIndex);

        if (reward > 0) {
            (bool sent,) = msg.sender.call{value: reward}("");
            if (!sent) revert TransferFailed(msg.sender, reward);
        }
    }

    /// @dev Both claims must carry the agent's own signature. In its own
    /// frame so `proveEquivocation` keeps enough stack to move the money.
    function _checkClaims(
        uint256 agentId,
        bytes32 runId,
        uint32 stepIndex,
        SignedClaim calldata a,
        SignedClaim calldata b
    ) private view {
        address expected = registry.signerOf(agentId);
        if (expected == address(0)) revert AgentNotListed(agentId);

        _requireSignedBy(expected, agentId, runId, stepIndex, a);
        _requireSignedBy(expected, agentId, runId, stepIndex, b);
    }

    /// @notice The digest an agent signs, identical to `FlowEscrowV2`'s and to
    /// `agentOutputDigest` in packages/core.
    function agentOutputDigest(
        bytes32 runId,
        uint32 stepIndex,
        uint256 agentId,
        bytes32 inputHash,
        bytes32 outputHash
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                AGENT_OUTPUT_DOMAIN,
                block.chainid,
                receipts,
                runId,
                uint256(stepIndex),
                agentId,
                inputHash,
                outputHash
            )
        );
    }

    /// @notice The live bond. Zero for an agent that never staked or was
    /// slashed — a caller comparing against a threshold needs no special case.
    function stakeOf(uint256 agentId) external view returns (uint256) {
        return _bonds[agentId].amount;
    }

    function unlockAtOf(uint256 agentId) external view returns (uint64) {
        return _bonds[agentId].unlockAt;
    }

    /// @notice Whether this agent has been caught equivocating. Permanent: a
    /// slashed identity cannot be rehabilitated by staking again.
    function isSlashed(uint256 agentId) external view returns (bool) {
        return _proven[agentId];
    }

    function bondOf(uint256 agentId)
        external
        view
        returns (uint256 amount, uint64 unlockAt, bool slashed)
    {
        Bond storage bond = _bonds[agentId];
        return (bond.amount, bond.unlockAt, bond.slashed);
    }

    // -----------------------------------------------------------------------

    function _requireExists(uint256 agentId) private view {
        try identityRegistry.ownerOf(agentId) returns (address owner) {
            if (owner == address(0)) revert AgentNotRegistered(agentId);
        } catch {
            revert AgentNotRegistered(agentId);
        }
    }

    function _requireAuthorised(uint256 agentId) private view {
        address owner;
        try identityRegistry.ownerOf(agentId) returns (address resolved) {
            owner = resolved;
        } catch {
            revert AgentNotRegistered(agentId);
        }
        if (msg.sender != owner && msg.sender != registry.operatorOf(agentId)) {
            revert NotAuthorised(agentId, msg.sender);
        }
    }

    function _requireSignedBy(
        address expected,
        uint256 agentId,
        bytes32 runId,
        uint32 stepIndex,
        SignedClaim calldata claim
    ) private view {
        bytes32 digest =
            agentOutputDigest(runId, stepIndex, agentId, claim.inputHash, claim.outputHash);
        bytes32 message = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        address recovered = _recover(message, claim.signature);
        if (recovered != expected) revert NotTheAgentsKey(agentId, recovered, expected);
    }

    /// @dev ecrecover with the malleable high-s form rejected, mirroring
    /// `parseSignature` in packages/core and `FlowEscrowV2`.
    function _recover(bytes32 hash, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) revert MalformedSignature(signature.length);

        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (v < 27) v += 27;

        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        return ecrecover(hash, v, r, s);
    }
}
