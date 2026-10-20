/**
 * Strict CBOR for did:btco DID-document metadata (did:btco method v0.2.0;
 * plan 012 §3.8). Only what a JSON DID document needs: unsigned and negative
 * integers within the safe range, text strings, arrays, maps with text keys,
 * true, false and null, all definite-length. Indefinite lengths, byte
 * strings, tags, floats, undefined, duplicate keys, a `__proto__` key and
 * trailing bytes are rejected, and a leading BOM in text is kept, so a
 * metadata blob decodes one way or not at all.
 */
import { fail } from "../errors.js";
import type { JsonValue } from "../json/index.js";

const MAX_DEPTH = 64;

function invalid(message: string): never {
  return fail("invalid-evidence", "CBOR_INVALID", message);
}

/** Decode `bytes` as one strict CBOR data item. */
export function decodeCbor(bytes: Uint8Array): JsonValue {
  let at = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const need = (n: number) => {
    if (at + n > bytes.length) invalid("truncated");
  };
  const argument = (info: number): number => {
    if (info < 24) return info;
    const size = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : invalid(`unsupported additional information ${info}`);
    need(size);
    let value = 0n;
    for (let k = 0; k < size; k++) value = (value << 8n) | BigInt(bytes[at++]);
    // Preferred (shortest) serialization only, so each value has one encoding.
    const min = size === 1 ? 24n : size === 2 ? 0x100n : size === 4 ? 0x10000n : 0x100000000n;
    if (value < min) invalid("non-shortest integer encoding");
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid("integer beyond the safe range");
    return Number(value);
  };
  const item = (depth: number): JsonValue => {
    if (depth > MAX_DEPTH) invalid("nested too deeply");
    need(1);
    const head = bytes[at++];
    const major = head >> 5;
    const info = head & 0x1f;
    switch (major) {
      case 0:
        return argument(info);
      case 1:
        return -1 - argument(info);
      case 3: {
        const n = argument(info);
        need(n);
        const text = decoder.decode(bytes.subarray(at, at + n));
        at += n;
        return text;
      }
      case 4: {
        const n = argument(info);
        const out: JsonValue[] = [];
        for (let k = 0; k < n; k++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const n = argument(info);
        const out: Record<string, JsonValue> = {};
        for (let k = 0; k < n; k++) {
          const key = item(depth + 1);
          if (typeof key !== "string") invalid("map keys must be text");
          if (key === "__proto__") invalid("a __proto__ key would set the prototype");
          if (Object.prototype.hasOwnProperty.call(out, key)) invalid(`duplicate key ${key}`);
          out[key] = item(depth + 1);
        }
        return out;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        return invalid("floats, undefined and simple values are not JSON");
      default:
        return invalid(major === 2 ? "byte strings are not JSON" : major === 6 ? "tags are not allowed" : "unsupported major type");
    }
  };
  const value = item(0);
  if (at !== bytes.length) invalid("trailing bytes");
  return value;
}

/** Encode a JSON value as strict CBOR (the inverse of decodeCbor, map keys in insertion order). */
export function encodeCbor(value: JsonValue): Uint8Array {
  const out: number[] = [];
  const head = (major: number, n: number) => {
    if (!Number.isSafeInteger(n) || n < 0) invalid("length or integer out of range");
    if (n < 24) out.push((major << 5) | n);
    else if (n < 0x100) out.push((major << 5) | 24, n);
    else if (n < 0x10000) out.push((major << 5) | 25, n >> 8, n & 0xff);
    else if (n < 0x100000000) out.push((major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
    else {
      const big = BigInt(n);
      out.push((major << 5) | 27);
      for (let k = 7; k >= 0; k--) out.push(Number((big >> BigInt(k * 8)) & 0xffn));
    }
  };
  const write = (v: JsonValue) => {
    if (v === null) out.push(0xf6);
    else if (v === true) out.push(0xf5);
    else if (v === false) out.push(0xf4);
    else if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) invalid("only safe integers are encoded");
      if (v >= 0) head(0, v);
      else head(1, -1 - v);
    } else if (typeof v === "string") {
      const b = new TextEncoder().encode(v);
      head(3, b.length);
      out.push(...b);
    } else if (Array.isArray(v)) {
      head(4, v.length);
      v.forEach(write);
    } else {
      const entries = Object.entries(v);
      head(5, entries.length);
      for (const [k, x] of entries) {
        write(k);
        write(x);
      }
    }
  };
  write(value);
  return new Uint8Array(out);
}
