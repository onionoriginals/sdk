/**
 * P14.19 token ID: a fixed vector shared with the Solidity anchor contract's
 * test (`contracts/test/OriginalsAnchor.t.sol`, `test_tokenIdMatchesVhTokenIdOf`),
 * where `mint` computes `uint256(keccak256(abi.encode(original, msg.sender)))`.
 * Both suites hard-code the same numbers, so either side changing breaks one.
 * EXPERIMENTAL (originals-spec PR 59).
 */
import { describe, expect, test } from "bun:test";
import { originalHash, tokenIdOf } from "../src/originals/index.js";

const DID = "did:vh:QmTokenIdVectorTokenIdVectorTokenIdVectorAb";
const MINTER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";

describe("P14.19 token ID vector shared with the anchor contract", () => {
  test("keccak256(d) and uint256(keccak256(abi.encode(keccak256(d), m)))", () => {
    expect(Buffer.from(originalHash(DID)).toString("hex")).toBe("ae30a9c9c4b44f659595fc6f456c47965e3a65f51758731abe96e9f821d2afcf");
    const id = tokenIdOf(DID, MINTER);
    expect(id).toBe(20858368355252256299581551563604764185791125045720593045312434452299842003849n);
    expect(id).toBe(0x2e1d6b09f74f6881e988ff72ac0084a3c3bcd3aec5a113b1f027438a70ef2389n);
  });
});
