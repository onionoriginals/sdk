import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { canonicalize, parseJson, parseJsonLines } from "../src/json/index.js";
import { OriginalsError } from "../src/errors.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/w3c-eddsa-jcs-2022/${name}`, import.meta.url), "utf8");

function rejects(text: string, code: string) {
  let caught: unknown;
  try {
    parseJson(text);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OriginalsError);
  expect((caught as OriginalsError).code).toBe(code);
}

describe("strict JSON parsing (P5.7)", () => {
  test("parses ordinary JSON exactly", () => {
    expect(parseJson('{"a":[1,-2.5,true,false,null,"x\\u00e9\\n"],"b":{}}')).toEqual({
      a: [1, -2.5, true, false, null, "xé\n"],
      b: {},
    });
  });

  test("C12-88: rejects duplicate keys, at any depth", () => {
    rejects('{"a":1,"a":2}', "JSON_DUPLICATE_KEY");
    rejects('{"x":{"b":1,"b":1}}', "JSON_DUPLICATE_KEY");
    // An escaped spelling of the same key is still the same key.
    rejects('{"a":1,"\\u0061":2}', "JSON_DUPLICATE_KEY");
  });

  test("rejects values JCS cannot represent exactly", () => {
    rejects('{"n":9007199254740993}', "JSON_UNSAFE_NUMBER");
    rejects('{"n":-0}', "JSON_UNSAFE_NUMBER");
    rejects('{"n":1e400}', "JSON_UNSAFE_NUMBER");
    rejects('"\\ud800"', "JSON_LONE_SURROGATE");
    rejects('"\\udc00x"', "JSON_LONE_SURROGATE");
  });

  test("rejects non-JSON syntax", () => {
    for (const text of ["{a:1}", "[1,]", "{\"a\":1,}", "NaN", "01", "1.", "'x'", "[1] x", "﻿{}", "", '"tab\there"']) {
      rejects(text, "JSON_SYNTAX");
    }
  });

  test("bounds input size and nesting depth before building values", () => {
    expect(() => parseJson("[1]", { maxBytes: 2 })).toThrow(OriginalsError);
    rejects("[".repeat(200) + "]".repeat(200), "JSON_TOO_DEEP");
  });

  test("JSON Lines: one strict value per line, newline-terminated", () => {
    expect(parseJsonLines('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }]);
    expect(parseJsonLines('{"a":1}')).toEqual([{ a: 1 }]);
    expect(() => parseJsonLines('{"a":1}\n\n{"b":2}\n')).toThrow(OriginalsError);
    expect(() => parseJsonLines('{"a":1,"a":2}\n')).toThrow(OriginalsError);
  });
});

describe("JCS (RFC 8785)", () => {
  test("matches the W3C eddsa-jcs-2022 canonical document", () => {
    const unsigned = parseJson(fixture("unsigned.json"));
    expect(canonicalize(unsigned)).toBe(fixture("canonDocJCS.txt").trim());
  });

  test("sorts keys by UTF-16 code units (RFC 8785 section 3.2.3 example)", () => {
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    // Compare the text: re-parsing would let JS move the integer-like key "1" first.
    const order = ["\r", "1", "\u0080", "ö", "€", "😀", "דּ"];
    const expected = `{${order.map((key) => `${JSON.stringify(key)}:${JSON.stringify(input[key as keyof typeof input])}`).join(",")}}`;
    expect(canonicalize(input)).toBe(expected);
  });

  test("serializes numbers as ECMAScript does (RFC 8785 appendix B)", () => {
    const cases: Array<[number, string]> = [
      [0, "0"], [1e21, "1e+21"], [1e-7, "1e-7"], [0.000001, "0.000001"],
      [-1.5, "-1.5"], [333333333.3333333, "333333333.3333333"],
      [9007199254740991, "9007199254740991"], [5e-324, "5e-324"],
    ];
    for (const [value, text] of cases) expect(canonicalize(value)).toBe(text);
  });

  test("escapes strings minimally", () => {
    expect(canonicalize("a\"\\\b\f\n\r\t\u0001\u007f€")).toBe('"a\\"\\\\\\b\\f\\n\\r\\t\\u0001\u007f€"');
  });

  test("refuses values outside the JSON data model", () => {
    for (const value of [undefined, NaN, Infinity, -0, () => 1, new Date(0), new Uint8Array(1), "\ud800"]) {
      expect(() => canonicalize(value as never)).toThrow(OriginalsError);
    }
    expect(() => canonicalize({ a: undefined } as never)).toThrow(OriginalsError);
  });
});
