import { encode, rfc8949EncodeOptions } from "cborg";
import { limit, requireThat } from "./errors.js";
import {
  CEL_LIMITS,
  decodeUtf8,
  type JsonValue,
  type JsonObject,
} from "./values.js";

/** Internal bounded decoder for the CEL JSON subset of definite-length CBOR. */
export function readCbor(input: Uint8Array): JsonValue {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let offset = 0,
    nodes = 0;
  const need = (length: number) =>
    requireThat(
      offset + length <= input.length,
      "CEL_CBOR",
      "Truncated CBOR item",
    );
  function argument(info: number): bigint {
    if (info < 24) return BigInt(info);
    requireThat(info <= 27, "CEL_CBOR", "Indefinite or reserved CBOR length");
    const length = 2 ** (info - 24);
    need(length);
    let value = 0n;
    for (let i = 0; i < length; i++)
      value = (value << 8n) | BigInt(input[offset++]);
    return value;
  }
  function item(depth: number, member = false): JsonValue {
    need(1);
    if (!member)
      limit(++nodes <= CEL_LIMITS.values, "CBOR value count exceeded");
    const header = input[offset++],
      major = header >> 5,
      info = header & 31;
    if (member)
      requireThat(major === 3, "CEL_CBOR", "CBOR map keys must be text");
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      requireThat(
        info >= 25 && info <= 27,
        "CEL_CBOR",
        "Unsupported CBOR simple value",
      );
      const length = 2 ** (info - 24);
      need(length);
      let value: number;
      if (info === 25) {
        const half = view.getUint16(offset),
          sign = half & 0x8000 ? -1 : 1;
        const exponent = (half >> 10) & 31,
          fraction = half & 1023;
        value =
          exponent === 31
            ? fraction
              ? NaN
              : sign * Infinity
            : sign *
              (exponent ? 1 + fraction / 1024 : fraction / 1024) *
              2 ** (exponent ? exponent - 15 : -14);
      } else
        value = info === 26 ? view.getFloat32(offset) : view.getFloat64(offset);
      offset += length;
      requireThat(Number.isFinite(value), "CEL_NUMBER", "Nonfinite CBOR float");
      return value;
    }
    requireThat(
      major === 0 || major === 1 || major === 3 || major === 4 || major === 5,
      "CEL_CBOR",
      "CBOR tags and byte strings are outside CEL",
    );
    const arg = argument(info);
    if (major <= 1) {
      const integer = major === 0 ? arg : -1n - arg,
        number = Number(integer);
      requireThat(
        BigInt(number) === integer,
        "CEL_NUMBER",
        "CBOR integer is not exactly representable as binary64",
      );
      return number;
    }
    if (major === 3) {
      limit(
        arg <= BigInt(CEL_LIMITS.stringBytes),
        "CBOR string byte limit exceeded",
      );
      const length = Number(arg);
      need(length);
      const result = decodeUtf8(input.subarray(offset, offset + length));
      offset += length;
      return result;
    }
    limit(depth + 1 <= CEL_LIMITS.depth, "Container depth exceeded");
    limit(arg <= BigInt(CEL_LIMITS.values), "CBOR container count exceeded");
    const length = Number(arg);
    if (major === 4) return Array.from({ length }, () => item(depth + 1));
    const result: JsonObject = Object.create(null) as JsonObject;
    for (let i = 0; i < length; i++) {
      const key = item(depth + 1, true) as string;
      requireThat(
        !Object.prototype.hasOwnProperty.call(result, key),
        "CEL_DUPLICATE_KEY",
        "Duplicate CBOR text key",
      );
      result[key] = item(depth + 1);
    }
    return result;
  }
  const result = item(0);
  requireThat(offset === input.length, "CEL_CBOR", "Trailing CBOR items");
  return result;
}

export function writeCbor(value: JsonValue): Uint8Array {
  function integers(child: JsonValue): unknown {
    if (typeof child === "number" && Number.isInteger(child)) {
      const n = BigInt(child);
      if (n >= -(1n << 64n) && n < 1n << 64n) return n;
    }
    if (Array.isArray(child)) return child.map(integers);
    if (child !== null && typeof child === "object")
      return new Map(
        Object.entries(child).map(([key, v]) => [key, integers(v)]),
      );
    return child;
  }
  return encode(integers(value), rfc8949EncodeOptions);
}
