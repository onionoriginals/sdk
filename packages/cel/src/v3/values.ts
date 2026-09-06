import { readCbor, writeCbor } from "./cbor.js";
import { CelError, limit, requireThat } from "./errors.js";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}
export const CEL_LIMITS = Object.freeze({
  bytes: 10_000_000,
  depth: 64,
  values: 100_000,
  stringBytes: 262_144,
});
const utf8 = new TextEncoder();
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function checkString(value: string): void {
  // Do not normalize Unicode or replace unpaired surrogates via TextEncoder.
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      requireThat(
        next >= 0xdc00 && next <= 0xdfff,
        "CEL_UNICODE",
        "Unpaired high surrogate",
      );
    } else
      requireThat(
        c < 0xdc00 || c > 0xdfff,
        "CEL_UNICODE",
        "Unpaired low surrogate",
      );
  }
  limit(
    utf8.encode(value).length <= CEL_LIMITS.stringBytes,
    "String exceeds UTF-8 byte limit",
  );
}

/** Validate and copy ordinary JSON data without invoking getters or toJSON. */
export function copyValue(input: unknown): JsonValue {
  let nodes = 0,
    size = 0;
  const ancestors = new Set<object>();
  const add = (bytes: number) => {
    size += bytes;
    limit(size <= CEL_LIMITS.bytes, "Canonical document exceeds byte limit");
  };
  function walk(value: unknown, depth: number): JsonValue {
    limit(++nodes <= CEL_LIMITS.values, "JSON value count exceeded");
    if (value === null || typeof value === "boolean") {
      add(value === null ? 4 : value ? 4 : 5);
      return value;
    }
    if (typeof value === "number") {
      requireThat(
        Number.isFinite(value),
        "CEL_NUMBER",
        "Nonfinite JSON number",
      );
      add(JSON.stringify(value).length);
      return Object.is(value, -0) ? 0 : value;
    }
    if (typeof value === "string") {
      checkString(value);
      add(utf8.encode(JSON.stringify(value)).length);
      return value;
    }
    requireThat(
      value !== null && typeof value === "object",
      "CEL_JSON",
      "Expected a JSON value",
    );
    limit(depth + 1 <= CEL_LIMITS.depth, "Container depth exceeded");
    requireThat(!ancestors.has(value), "CEL_JSON", "Cyclic JSON value");
    const array = Array.isArray(value),
      proto: unknown = Object.getPrototypeOf(value);
    requireThat(
      array
        ? proto === Array.prototype
        : proto === Object.prototype || proto === null,
      "CEL_JSON",
      "Expected ordinary arrays or plain objects",
    );
    ancestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    requireThat(
      Object.getOwnPropertySymbols(value).length === 0,
      "CEL_JSON",
      "Symbol properties are not JSON",
    );
    const names = Object.keys(descriptors);
    add(2);
    let result: JsonValue;
    if (array) {
      const length = descriptors.length.value as number;
      limit(length <= CEL_LIMITS.values, "Array value count exceeded");
      requireThat(
        names.length === length + 1,
        "CEL_JSON",
        "Array holes or extra properties",
      );
      const output: JsonValue[] = [];
      for (let i = 0; i < length; i++) {
        const d = descriptors[String(i)];
        requireThat(
          d && d.enumerable && "value" in d,
          "CEL_JSON",
          "Array accessors or holes",
        );
        if (i) add(1);
        output.push(walk(d.value, depth + 1));
      }
      result = output;
    } else {
      const output: JsonObject = Object.create(null) as JsonObject;
      for (const [i, name] of names.entries()) {
        const d = descriptors[name];
        requireThat(
          d.enumerable && "value" in d,
          "CEL_JSON",
          "Accessors or non-enumerable properties are not JSON",
        );
        checkString(name);
        add(utf8.encode(JSON.stringify(name)).length + 1 + (i ? 1 : 0));
        output[name] = walk(d.value, depth + 1);
      }
      result = output;
    }
    ancestors.delete(value);
    return result;
  }
  return walk(input, 0);
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
      .join(",") +
    "}"
  );
}

/** RFC 8785 serialization after bounded, noncoercing JSON validation. */
export function canonicalizeValue(value: unknown): string {
  return canonical(copyValue(value));
}

/** Strict UTF-8 decoding that never repairs invalid sequences or removes a BOM. */
export function decodeUtf8(input: Uint8Array): string {
  try {
    return fatalUtf8.decode(input);
  } catch {
    throw new CelError("invalid", "CEL_UTF8", "Invalid UTF-8");
  }
}

// Parse object members before JSON.parse could discard duplicate decoded names.
function parseJson(source: string): JsonValue {
  let offset = 0,
    nodes = 0;
  const whitespace = () => {
    while ([" ", "\t", "\n", "\r"].includes(source[offset] ?? "x")) offset++;
  };
  function string(): string {
    const start = offset++;
    while (offset < source.length) {
      const char = source[offset++];
      if (char === "\\") offset++;
      else if (char === '"') {
        let result: string;
        try {
          result = JSON.parse(source.slice(start, offset)) as string;
        } catch {
          throw new CelError("invalid", "CEL_JSON", "Invalid JSON string");
        }
        checkString(result);
        return result;
      }
    }
    throw new CelError("invalid", "CEL_JSON", "Unterminated JSON string");
  }
  function value(depth: number): JsonValue {
    whitespace();
    limit(++nodes <= CEL_LIMITS.values, "JSON value count exceeded");
    const char = source[offset];
    if (char === '"') return string();
    if (char === "{" || char === "[") {
      limit(depth + 1 <= CEL_LIMITS.depth, "Container depth exceeded");
      offset++;
      whitespace();
      const array = char === "[",
        end = array ? "]" : "}";
      const output: JsonObject = Object.create(null) as JsonObject,
        items: JsonValue[] = [];
      if (source[offset] !== end)
        for (;;) {
          if (array) items.push(value(depth + 1));
          else {
            requireThat(
              source[offset] === '"',
              "CEL_JSON",
              "Expected JSON member name",
            );
            const key = string();
            whitespace();
            requireThat(
              !Object.prototype.hasOwnProperty.call(output, key),
              "CEL_DUPLICATE_KEY",
              "Duplicate decoded JSON member",
            );
            requireThat(source[offset++] === ":", "CEL_JSON", "Expected colon");
            output[key] = value(depth + 1);
          }
          whitespace();
          if (source[offset] === end) break;
          requireThat(source[offset++] === ",", "CEL_JSON", "Expected comma");
          whitespace();
        }
      offset++;
      return array ? items : output;
    }
    for (const [token, result] of [
      ["null", null],
      ["true", true],
      ["false", false],
    ] as const) {
      if (source.startsWith(token, offset)) {
        offset += token.length;
        return result;
      }
    }
    const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    number.lastIndex = offset;
    const match = number.exec(source);
    requireThat(match, "CEL_JSON", "Expected JSON value");
    offset = number.lastIndex;
    const result = Number(match[0]);
    requireThat(Number.isFinite(result), "CEL_NUMBER", "Nonfinite JSON number");
    return result;
  }
  const result = value(0);
  whitespace();
  requireThat(offset === source.length, "CEL_JSON", "Trailing JSON input");
  return result;
}

/** Decode transport values; this supplies no cryptographic or application authority. */
export function decodeValue(
  input: string | Uint8Array,
  format: "json" | "cbor",
): JsonValue {
  requireThat(
    format === "json" || format === "cbor",
    "CEL_FORMAT",
    "Expected JSON or CBOR",
  );
  limit(
    (typeof input === "string" ? utf8.encode(input).length : input.length) <=
      CEL_LIMITS.bytes,
    "Encoded document exceeds byte limit",
  );
  if (format === "cbor") {
    requireThat(
      input instanceof Uint8Array,
      "CEL_FORMAT",
      "CBOR input must be bytes",
    );
    return copyValue(readCbor(input));
  }
  return copyValue(
    parseJson(typeof input === "string" ? input : decodeUtf8(input)),
  );
}

/** Encode validated JSON data using JCS or core deterministic RFC 8949 CBOR. */
export function encodeValue(
  input: unknown,
  format: "json" | "cbor",
): Uint8Array {
  requireThat(
    format === "json" || format === "cbor",
    "CEL_FORMAT",
    "Expected JSON or CBOR",
  );
  const value = copyValue(input);
  const result =
    format === "json" ? utf8.encode(canonical(value)) : writeCbor(value);
  limit(
    result.length <= CEL_LIMITS.bytes,
    "Encoded document exceeds byte limit",
  );
  return result;
}
