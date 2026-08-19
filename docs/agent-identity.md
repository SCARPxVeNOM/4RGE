# Agent identity on 0G

**Status:** resolved by on-chain probe. Changes `Receipt.agentId` from
`address` to `uint256`.

§4.1 of the spec types `agentId` as an `address` with the comment "ERC-8004
identity". That is not what is deployed. Both agent registries live on 0G
Galileo are ERC-721, and identify an agent by **uint256 token id**.

## What is actually deployed

Verified by calling the contracts, not by reading documentation:

| Registry | Address | `name()` / `symbol()` | Standard |
|---|---|---|---|
| ERC-8004 Trustless Agent | `0x7177a6867296406881E20d6647232314736Dd09A` | "ERC-8004 Trustless Agent" / `AGENT` | ERC-721 + Metadata |
| 0G Agentic ID (ERC-7857) | `0x2700F6A3e505402C9daB154C5c6ab9cAEC98EF1F` | "Agentic ID" / `AID` | ERC-721 |

Both return `true` for `supportsInterface(0x80ac58cd)` (ERC-721). The ERC-8004
registry has live agents: token 1 is owned by
`0x9B4Cef62a0ce1671ccFEFA6a6D8cBFa165c49831` with
`tokenURI` `ipfs://Qm0G-HighPerformance-Test-Agent`.

0G's own identity layer (`build.0g.ai/agentic-id`) is ERC-7857 — encrypted
model data, re-encryption on transfer, TEE/ZKP-verified proofs — registered via
`mint(address to, string encryptedURI, bytes32 metadataHash)`.

## Why `address` could not stand

1. **Nothing constrains an ERC-721 token id to 20 bytes.** Narrowing a
   `uint256` to an `address` truncates the high 96 bits, so two distinct agents
   can collide into one identity. A receipt would then attest to the wrong
   agent while verifying cleanly.
2. **There is no address to use.** An ERC-721 agent has an *owner* address, but
   ownership is transferable — ERC-7857's whole premise is transfer with
   re-encryption. Keying receipts on the owner would mean a transferred agent
   invalidates every historical receipt.
3. **§7.1's identity check has no `address` form.** "Is `agentId` registered
   and active" is `ownerOf(tokenId)` not reverting. There is no
   `isRegistered(address)` on either contract.

## The change

```solidity
struct Receipt {
    bytes32 flowId;
    bytes32 runId;
    uint32  stepIndex;
    uint256 agentId;   // was: address
    ...
}
```

The encoding stays eleven static words / 352 bytes, so nothing downstream
changes shape — only the pinned hash vectors move. This was done during Phase 1
precisely because §13 freezes contract interfaces at the end of Phase 1.

`IIdentityRegistry` is now just the ERC-721 slice 0G Flow needs:

```solidity
interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
}
```

Because that is the only surface, `AgentAdapterRegistry` can point at **either**
registry unchanged — the deployment takes the address as a constructor
argument. It is currently wired to the ERC-8004 registry.

ERC-721 requires `ownerOf` to revert for a nonexistent token, so existence and
ownership are one call. `AgentAdapterRegistry` catches that revert to report
`AgentNotRegistered` distinctly from `NotIdentityOwner`, and the test mock
reproduces the reverting behaviour rather than returning the zero address —
a mock that returned `address(0)` would pass the suite and fail against the
live contract.

## Consequence for the spec

§4.1 and §7.1 need updating to say `uint256 agentId`, and §2's "ERC-8004
registries" should note that 0G additionally ships ERC-7857 Agentic ID and that
either satisfies the identity requirement.

## Open

- **ReputationRegistry.** §7.2's `policy.minReputation` needs one; no
  reputation registry has been located on Galileo yet, so
  `contracts.reputationRegistry` is null and policy enforcement is unimplemented.
- **Which registry to standardise on.** ERC-8004 is what the spec names and
  what is currently wired. ERC-7857 is 0G-native and carries the TEE/ZKP proof
  machinery that pairs naturally with §6.3. Worth deciding before agents are
  registered in bulk.
