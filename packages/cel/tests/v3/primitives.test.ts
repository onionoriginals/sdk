import { expect, test } from "bun:test";
import { base58 } from "@scure/base";
import { decodeController, parseAssetAlias, CelError } from "../../src/v3/index.js";

/**
 * decodeController's FailureStatus taxonomy (issue #721, sibling of #700):
 * a did:key using a recognized-but-out-of-profile multicodec (e.g.
 * secp256k1, bls12_381-g2 — both recognized elsewhere in this codebase per
 * packages/cel/src/crypto/Multikey.ts) must report "unsupported", while a
 * malformed/noncanonical or wholly-unrecognized codec stays "invalid".
 */

function didKeyFor(codec: [number, number], length: number): string {
  const body = new Uint8Array(length);
  body[0] = 0x02; // compressed-point-looking leading byte; not curve-validated for these codecs
  const bytes = Uint8Array.from([...codec, ...body]);
  return "did:key:z" + base58.encode(bytes);
}

test("decodeController: recognized secp256k1 did:key is 'unsupported', not 'invalid'", () => {
  const controller = didKeyFor([0xe7, 0x01], 33);
  expect(() => decodeController(controller)).toThrow(CelError);
  try {
    decodeController(controller);
    throw new Error("expected throw");
  } catch (e) {
    expect((e as CelError).status).toBe("unsupported");
    expect((e as CelError).code).toBe("CEL_CONTROLLER");
  }
});

test("decodeController: recognized bls12_381-g2 did:key is 'unsupported', not 'invalid'", () => {
  const controller = didKeyFor([0xeb, 0x01], 96);
  try {
    decodeController(controller);
    throw new Error("expected throw");
  } catch (e) {
    expect((e as CelError).status).toBe("unsupported");
  }
});

test("decodeController: unrecognized/malformed codec stays 'invalid'", () => {
  // 0x12, 0x05 is not a codec this SDK recognizes anywhere (RSA-ish, arbitrary length).
  const controller = didKeyFor([0x12, 0x05], 4);
  try {
    decodeController(controller);
    throw new Error("expected throw");
  } catch (e) {
    expect((e as CelError).status).toBe("invalid");
  }
});

test("decodeController: noncanonical Ed25519 encoding stays 'invalid'", () => {
  // Right codec/length, but not a canonical base58 round-trip target isn't
  // reachable here (decodeBase58 already enforces that) — instead exercise a
  // structurally malformed controller string, which must still be 'invalid'.
  try {
    decodeController("did:key:znotbase58");
    throw new Error("expected throw");
  } catch (e) {
    expect((e as CelError).status).toBe("invalid");
  }
});

test("parseAssetAlias: unrelated DID method remains 'invalid' (unchanged by #721)", () => {
  try {
    parseAssetAlias("did:example:abc");
    throw new Error("expected throw");
  } catch (e) {
    expect((e as CelError).status).toBe("invalid");
    expect((e as CelError).code).toBe("CEL_DID");
  }
});
