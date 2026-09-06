import { expect, test } from "bun:test";
import { encode } from "cborg";
import {
  canonicalizeValue,
  decodeValue,
  encodeValue,
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
