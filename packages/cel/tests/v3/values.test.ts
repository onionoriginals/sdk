import { expect, test } from "bun:test";
import {
  canonicalizeValue,
  decodeValue,
  encodeValue,
} from "../../src/v3/index.js";
import inputs from "../../../../docs/research/cel-profile-vectors/transport-inputs.json";

test("retains signed metadata keys and canonicalizes numeric member names lexically", () => {
  const value = decodeValue('{"10":10,"2":2,"__proto__":{"x":1}}', "json");
  expect(canonicalizeValue(value)).toBe('{"10":10,"2":2,"__proto__":{"x":1}}');
  expect(Object.hasOwn(value as object, "__proto__")).toBe(true);
});

for (const vector of inputs.cbor)
  test(`CBOR JSON subset: ${vector.id}`, () => {
    const bytes = new Uint8Array(Buffer.from(vector.hex, "hex"));
    if (vector.expected === "accepted")
      expect(() => decodeValue(bytes, "cbor")).not.toThrow();
    else expect(() => decodeValue(bytes, "cbor")).toThrow();
  });

test("deterministic CBOR uses integers for exact integral binary64 values beyond the safe range", () => {
  expect(Buffer.from(encodeValue({ a: 2 ** 61 }, "cbor")).toString("hex")).toBe(
    "a161611b2000000000000000",
  );
  expect(Buffer.from(encodeValue({ a: -0 }, "cbor")).toString("hex")).toBe(
    "a1616100",
  );
  expect(Buffer.from(encodeValue({ a: 1.5 }, "cbor")).toString("hex")).toBe(
    "a16161f93e00",
  );
});

for (const vector of inputs.json)
  test(`strict JSON: ${vector.id}`, () => {
    if (vector.expected === "accepted")
      expect(() => decodeValue(vector.source, "json")).not.toThrow();
    else expect(() => decodeValue(vector.source, "json")).toThrow();
  });

test("runtime inputs reject coercion, holes and excessive nesting without executing getters", () => {
  let called = false;
  const getter = Object.defineProperty({}, "x", {
    enumerable: true,
    get() {
      called = true;
      return 1;
    },
  });
  const cycle: unknown[] = [];
  cycle.push(cycle);
  for (const value of [
    getter,
    new Date(),
    [undefined],
    [NaN],
    new Array(2),
    cycle,
    {
      toJSON() {
        called = true;
        return 1;
      },
    },
  ]) {
    expect(() => canonicalizeValue(value)).toThrow();
  }
  expect(called).toBe(false);
});
