// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Base} from "./Base.sol";
import {OriginalsAnchor} from "../src/OriginalsAnchor.sol";

/// P14.21: deployed with CREATE2 through the deterministic deployment proxy [S34] with a zero salt,
/// so it has one address on every chain. Also measures gas for README.md.
contract DeployTest is Base {
    address internal constant PROXY = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// The proxy's runtime code (Arachnid/deterministic-deployment-proxy): calldata is salt ++ init code.
    bytes internal constant PROXY_CODE =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    function deploy() internal returns (OriginalsAnchor) {
        vm.etch(PROXY, PROXY_CODE);
        bytes memory init = type(OriginalsAnchor).creationCode;
        (bool ok, bytes memory ret) = PROXY.call(bytes.concat(bytes32(0), init));
        truth(ok && ret.length == 20, "proxy deployment");
        address deployed = address(bytes20(ret));
        address expected = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), PROXY, bytes32(0), keccak256(init)))))
        );
        eq(deployed, expected, "CREATE2 address");
        emit log_named_address("CREATE2 address (zero salt)", deployed);
        emit log_named_bytes32("init code hash", keccak256(init));
        emit log_named_bytes32("runtime code hash", deployed.codehash);
        emit log_named_uint("runtime code size", deployed.code.length);
        return OriginalsAnchor(deployed);
    }

    function test_deterministicDeployment() public {
        OriginalsAnchor a = deploy();
        eq(a.name(), "Originals Anchor (experimental)", "deployed and callable");
        truth(deployed_size(address(a)) <= 24_576, "EIP-170");
    }

    function deployed_size(address x) internal view returns (uint256) {
        return x.code.length;
    }

    /// Execution gas inside the EVM (excludes the 21,000 base and calldata costs of a transaction,
    /// which README.md reports from anvil receipts).
    function test_gas_publish100kBAndSameBody() public {
        OriginalsAnchor a = deploy();
        address alice = address(0xA11CE);
        vm.prank(alice);
        uint256 id = a.mint(keccak256("did:vh:QmGas"));
        bytes memory m = blob(2_000, 1);
        bytes memory b = blob(100_000, 2);

        vm.prank(alice);
        uint256 g = gasleft();
        a.publish(id, "image/png", m, b);
        emit log_named_uint("publish 2,000 B metadata + 100,000 B body: execution gas", g - gasleft());

        vm.prank(alice);
        g = gasleft();
        a.publishSameBody(id, blob(2_000, 3), 0);
        emit log_named_uint("publishSameBody 2,000 B metadata: execution gas", g - gasleft());

        g = gasleft();
        a.body(id, 0, 0, type(uint32).max);
        emit log_named_uint("body() read of 100,000 B: execution gas", g - gasleft());
    }
}
