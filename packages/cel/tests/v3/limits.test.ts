import { expect, test } from "bun:test";
import { encode } from "cborg";
import { base58 } from "@scure/base";
import {
  canonicalizeValue,
  decodeValue,
  encodeValue,
  validateDocument,
  createLocalSigner,
  digestBytes,
  CelError,
} from "../../src/v3/index.js";

function rejectsLimit(run: () => unknown) {
  try {
    run();
    throw new Error("unexpected acceptance");
  } catch (error) {
    expect(error).toBeInstanceOf(CelError);
    expect((error as CelError).status).toBe("limit");
  }
}
test("limits depth before recursive parsers can exhaust their stacks", () => {
  expect(() =>
    decodeValue("[".repeat(64) + "0" + "]".repeat(64), "json"),
  ).not.toThrow();
  rejectsLimit(() =>
    decodeValue("[".repeat(65) + "0" + "]".repeat(65), "json"),
  );
  rejectsLimit(() =>
    decodeValue(new Uint8Array([...new Array(65).fill(0x81), 0]), "cbor"),
  );
});
test("bounds JSON values, strings and encoded input on all public value paths", () => {
  rejectsLimit(() => canonicalizeValue(new Array(100000).fill(null)));
  rejectsLimit(() => encodeValue({ value: "a".repeat(262145) }, "json"));
  rejectsLimit(() => decodeValue(" ".repeat(10000001), "json"));
  rejectsLimit(() => decodeValue(new Uint8Array(10000001), "cbor"));
});
test("compact CBOR cannot bypass canonical decoded byte limits", () => {
  const compact = encode(new Array(7).fill("\u0000".repeat(262144)));
  expect(compact.length).toBeLessThan(10000000);
  rejectsLimit(() => decodeValue(compact, "cbor"));
});
// #683: the documented 1-10,000-entry ceiling and the 100,000-JSON-value
// ceiling are both enforced simultaneously (specs/originals-cel-v3-profile.md,
// "Enforce these limits consistently"). Every non-trivial entry costs several
// value nodes, so a 10,000-entry document is not independently guaranteed to
// be reachable -- only that neither ceiling alone permits more.
test("the entries ceiling is not independently reachable once the values ceiling binds first", () => {
  const signer = createLocalSigner("Ed25519", new Uint8Array(32).fill(9));
  const verificationMethod = `${signer.controller}#${signer.controller.slice(8)}`;
  const proofValue = "z" + base58.encode(new Uint8Array(64).fill(1));
  const placeholderDigest = digestBytes(new Uint8Array(32));
  const buildLog = (count: number) =>
    Array.from({ length: count }, () => ({
      event: {
        operation: {
          type: "update",
          data: { profile: "originals/cel/3", metadata: {} },
        },
        previousEvent: placeholderDigest,
      },
      proof: {
        type: "DataIntegrityProof",
        cryptosuite: "eddsa-jcs-2022",
        verificationMethod,
        proofPurpose: "assertionMethod",
        proofValue,
      },
    }));

  // A document at the documented 10,000-entry ceiling, built from
  // minimally-shaped entries, still exceeds the independent 100,000
  // JSON-value ceiling.
  try {
    validateDocument({ log: buildLog(10000) });
    throw new Error("unexpected acceptance");
  } catch (error) {
    expect(error).toBeInstanceOf(CelError);
    expect((error as CelError).status).toBe("limit");
  }

  // A document safely under both ceilings simultaneously is accepted.
  expect(() => validateDocument({ log: buildLog(1000) })).not.toThrow();
});
test("fatal UTF-8 and runtime descriptors are enforced without normalization", () => {
  expect(() =>
    decodeValue(new Uint8Array([0x22, 0xff, 0x22]), "json"),
  ).toThrow();
  const hidden = Object.defineProperty({}, "a", {
    value: 1,
    enumerable: false,
  });
  const symbol = { [Symbol("a")]: 1 };
  const array = [1];
  Object.defineProperty(array, "extra", { value: 2 });
  for (const value of [hidden, symbol, array])
    expect(() => canonicalizeValue(value)).toThrow();
});
