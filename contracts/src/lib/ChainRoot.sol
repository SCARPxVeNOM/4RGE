// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title ChainRoot
/// @notice Folds receipt hashes into a run's chain root — spec §1.1.
///
///   chainRoot[0] = keccak256(abi.encode(receipt[0]))
///   chainRoot[n] = keccak256(chainRoot[n-1] || keccak256(abi.encode(receipt[n])))
///
/// Leaves must be supplied in ascending stepIndex order. The fold is
/// deliberately not commutative: a run whose parallel branches complete in a
/// different order must produce the same root, but a run whose step contents
/// are swapped must not.
///
/// This must stay byte-identical to foldChainRoot() in the TypeScript core
/// package (packages/core/src/chain-root.ts).
library ChainRoot {
    error EmptyRun();

    function fold(bytes32[] memory leaves) internal pure returns (bytes32 root) {
        if (leaves.length == 0) revert EmptyRun();

        root = leaves[0];
        for (uint256 i = 1; i < leaves.length; i++) {
            root = keccak256(abi.encodePacked(root, leaves[i]));
        }
    }
}
