// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// The few Foundry cheatcodes these tests use, declared here so the project has no dependencies
/// (no forge-std submodule in the monorepo).
interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function expectRevert(bytes calldata) external;
    function expectRevert() external;
    function warp(uint256) external;
    function etch(address, bytes calldata) external;
    function getCode(string calldata) external view returns (bytes memory);
    function getNonce(address) external view returns (uint64);
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

abstract contract Base {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// ds-test style logs, which `forge test -vv` prints.
    event log_named_uint(string key, uint256 val);
    event log_named_bytes32(string key, bytes32 val);
    event log_named_address(string key, address val);

    function eq(uint256 a, uint256 b, string memory what) internal pure {
        if (a != b) revert(string.concat(what, ": not equal"));
    }

    function eq(address a, address b, string memory what) internal pure {
        if (a != b) revert(string.concat(what, ": addresses differ"));
    }

    function eq(bytes memory a, bytes memory b, string memory what) internal pure {
        if (keccak256(a) != keccak256(b)) revert(string.concat(what, ": bytes differ"));
    }

    function eq(string memory a, string memory b, string memory what) internal pure {
        if (keccak256(bytes(a)) != keccak256(bytes(b))) revert(string.concat(what, ": strings differ"));
    }

    function truth(bool ok, string memory what) internal pure {
        if (!ok) revert(what);
    }

    /// `n` deterministic pseudo-random bytes.
    function blob(uint256 n, uint256 seed) internal pure returns (bytes memory b) {
        b = new bytes(n);
        for (uint256 i; i < n; i += 32) {
            bytes32 w = keccak256(abi.encode(seed, i));
            assembly {
                mstore(add(add(b, 32), i), w)
            }
        }
        // Clean the padding after the last byte (the write may run into unallocated memory, which
        // Solidity never assumes clean).
        assembly {
            mstore(add(add(b, 32), n), 0)
        }
    }

    function slice(bytes memory b, uint256 from, uint256 to) internal pure returns (bytes memory out) {
        out = new bytes(to - from);
        for (uint256 i; i < out.length; ++i) out[i] = b[from + i];
    }

    function concat(bytes memory a, bytes memory b) internal pure returns (bytes memory) {
        return bytes.concat(a, b);
    }
}
