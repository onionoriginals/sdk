/**
 * Strict CBOR for inscription metadata: did:btco DID documents (did:btco
 * method v0.2.0; plan 012 §3.8; P5.13) and Originals entries (P14.12;
 * originals-spec #53, #54). Only what JSON needs: unsigned and negative
 * integers of magnitude at most 2^53 − 1 (P14.3); half-, single- and
 * double-precision floats that are finite, not negative zero and within the
 * same bound, for non-integer numbers (P14.12, #54); text strings, arrays,
 * maps with text keys, true, false and null, all definite-length. Indefinite
 * lengths, byte strings, tags, undefined and other simple values, duplicate
 * keys, a `__proto__` key and trailing bytes are rejected, and a leading BOM
 * in text is kept, so a metadata blob decodes to one JSON value or not at all.
 * The encoder writes ord's mapping (P14.12, PROVISIONAL): integers in shortest
 * form, other numbers as the narrowest float that holds them exactly.
 */
import { fail } from "../errors.js";
import type { JsonValue } from "../json/index.js";

const MAX_DEPTH = 64;

function invalid(message: string): never {
  return fail("invalid-evidence", "CBOR_INVALID", message);
}

const TWO = (e: number) => 2 ** e; // exact for every exponent used here

/** A half-precision float's value (IEEE 754 binary16). */
function fromHalf(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * TWO(-24);
  if (exp === 31) return mant ? Number.NaN : sign * Infinity;
  return sign * (mant + 1024) * TWO(exp - 25);
}

/** The binary16 bits of `v` when it is exactly representable as a half float, else undefined. */
function toHalf(v: number): number | undefined {
  const sign = v < 0 || Object.is(v, -0) ? 0x8000 : 0;
  const a = Math.abs(v);
  if (a === 0) return sign;
  if (a < TWO(-14)) {
    const m = a / TWO(-24);
    return Number.isInteger(m) && m < 1024 ? sign | m : undefined;
  }
  let e = Math.floor(Math.log2(a));
  if (TWO(e) > a) e--;
  else if (TWO(e + 1) <= a) e++;
  if (e > 15) return undefined;
  const m = a / TWO(e - 10) - 1024;
  return Number.isInteger(m) && m >= 0 && m < 1024 ? sign | ((e + 15) << 10) | m : undefined;
}

/** The narrowest CBOR float encoding that holds `v` exactly (ciborium's, as ord writes `--json-metadata`). */
function floatBytes(v: number): number[] {
  const half = toHalf(v);
  if (half !== undefined) return [0xf9, half >> 8, half & 0xff];
  const view = new DataView(new ArrayBuffer(8));
  if (Math.fround(v) === v) {
    view.setFloat32(0, v);
    return [0xfa, ...new Uint8Array(view.buffer, 0, 4)];
  }
  view.setFloat64(0, v);
  return [0xfb, ...new Uint8Array(view.buffer)];
}

/** P14.12, P14.3 (originals-spec #54): a float in an entry is finite, not negative zero, and within 2^53 − 1. */
function checkFloat(v: number): number {
  if (!Number.isFinite(v)) invalid("a float that is NaN or infinite is no JSON number (P14.12)");
  if (Object.is(v, -0)) invalid("negative zero is rejected (P14.3, P14.12)");
  if (Math.abs(v) > Number.MAX_SAFE_INTEGER) invalid("a float of magnitude above 2^53 - 1 is rejected (P14.3, P14.12)");
  return v;
}

export interface DecodeCborOptions {
  /**
   * Require each integer and length in its shortest form (default true), as a
   * did:btco DID document must be (P14.12). Originals entries need not be:
   * they are checked over their JCS form (P14.3, P14.12).
   */
  shortest?: boolean;
}

/** Decode `bytes` as one strict CBOR data item. */
export function decodeCbor(bytes: Uint8Array, options: DecodeCborOptions = {}): JsonValue {
  const shortest = options.shortest !== false;
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
    if (shortest && value < min) invalid("non-shortest integer encoding");
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
      case 1: {
        // P14.3: no magnitude above 2^53 − 1, so -2^53 is out of range too.
        const n = argument(info);
        if (n >= Number.MAX_SAFE_INTEGER) invalid("integer beyond the safe range");
        return -1 - n;
      }
      case 3: {
        const n = argument(info);
        need(n);
        let text: string;
        try {
          text = decoder.decode(bytes.subarray(at, at + n));
        } catch {
          // Not well-formed (P14.12): rejected as invalid CBOR, never a thrown TypeError, so a sat
          // holder cannot make every read of an Original fail (P9.12).
          return invalid("a text string is not valid UTF-8");
        }
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
        if (info === 25 || info === 26 || info === 27) {
          const size = info === 25 ? 2 : info === 26 ? 4 : 8;
          need(size);
          const view = new DataView(bytes.buffer, bytes.byteOffset + at, size);
          const value = size === 2 ? fromHalf(view.getUint16(0)) : size === 4 ? view.getFloat32(0) : view.getFloat64(0);
          const raw = [...bytes.subarray(at - 1, at + size)];
          at += size;
          checkFloat(value);
          // A did:btco DID document is in shortest form (P14.12): its float in the narrowest exact width.
          if (shortest && floatBytes(value).length !== raw.length) invalid("non-shortest float encoding");
          return value;
        }
        return invalid("undefined and simple values are not JSON");
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
      if (Number.isInteger(v) && !Object.is(v, -0) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) {
        if (v >= 0) head(0, v);
        else head(1, -1 - v);
      } else out.push(...floatBytes(checkFloat(v)));
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
