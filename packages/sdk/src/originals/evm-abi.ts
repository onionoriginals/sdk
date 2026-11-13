/**
 * The small part of the Solidity ABI and Ethereum JSON-RPC the EVM anchor
 * adapters need (originals-spec PR 59, P14.20), hand-rolled on @noble/hashes
 * so the SDK adds no EVM library and stays browser-safe. EXPERIMENTAL.
 *
 * Only the types the anchor contract's interface uses are supported: uint
 * (up to 256 bits), address, bytes32, bytes and string, as one flat tuple.
 * Decoding is strict: an offset, length or value out of range is a provider
 * answer that cannot have come from the pinned contract, and throws.
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { OriginalsError } from "@originals/vh";

export type AbiType = "uint256" | "uint64" | "uint32" | "address" | "bytes32" | "bytes" | "string";
export type AbiValue = bigint | number | string | Uint8Array;

function bad(code: string, message: string): never {
  throw new OriginalsError("invalid-evidence", code, message);
}

export const toHex = (bytes: Uint8Array): string => `0x${bytesToHex(bytes)}`;

/** `0x`-prefixed hex to bytes; an odd length or a non-hex digit throws. */
export function fromHex(value: string): Uint8Array {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) bad("EVM_HEX", "expected 0x-prefixed hex with an even number of digits");
  return hexToBytes(value.slice(2));
}

/** A JSON-RPC quantity (`0x` and minimal hex) to a bigint. */
export function quantity(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) bad("EVM_RPC_ANSWER", `${what} is not a JSON-RPC quantity`);
  return BigInt(value);
}

export const toQuantity = (n: bigint | number): string => `0x${BigInt(n).toString(16)}`;

export function keccak(bytes: Uint8Array): Uint8Array {
  return keccak_256(bytes);
}

export const keccakHex = (bytes: Uint8Array): string => toHex(keccak_256(bytes));

/** The 4-byte selector of a function signature such as `ownerOf(uint256)`. */
export function selector(signature: string): Uint8Array {
  return keccak_256(utf8ToBytes(signature)).slice(0, 4);
}

/** topic0 of an event signature such as `Published(uint256,uint32)`. */
export const eventTopic = (signature: string): string => keccakHex(utf8ToBytes(signature));

const isDynamic = (t: AbiType) => t === "bytes" || t === "string";
const MAX: Record<string, bigint> = { uint256: (1n << 256n) - 1n, uint64: (1n << 64n) - 1n, uint32: (1n << 32n) - 1n };

function word(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function padded(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(bytes.length / 32) * 32);
  out.set(bytes);
  return out;
}

function staticWord(type: AbiType, value: AbiValue): Uint8Array {
  if (type === "address") {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) bad("EVM_ABI", "an address is 0x and 40 hex digits");
    const out = new Uint8Array(32);
    out.set(fromHex(value), 12);
    return out;
  }
  if (type === "bytes32") {
    const b = typeof value === "string" ? fromHex(value) : value;
    if (!(b instanceof Uint8Array) || b.length !== 32) bad("EVM_ABI", "a bytes32 is 32 bytes");
    return Uint8Array.from(b);
  }
  const n = typeof value === "bigint" ? value : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : undefined;
  if (n === undefined || n < 0n || n > MAX[type]) bad("EVM_ABI", `${String(value)} is not a ${type}`);
  return word(n);
}

/** ABI-encode a flat tuple of `types` (the arguments of one call). */
export function encodeArgs(types: readonly AbiType[], values: readonly AbiValue[]): Uint8Array {
  if (types.length !== values.length) bad("EVM_ABI", "one value per type");
  const heads: Uint8Array[] = [];
  const tails: Uint8Array[] = [];
  let tailOffset = 32 * types.length;
  types.forEach((type, i) => {
    const value = values[i];
    if (!isDynamic(type)) {
      heads.push(staticWord(type, value));
      return;
    }
    const bytes = type === "string" ? (typeof value === "string" ? utf8ToBytes(value) : bad("EVM_ABI", "a string is a string")) : value;
    if (!(bytes instanceof Uint8Array)) bad("EVM_ABI", "bytes are a Uint8Array");
    heads.push(word(BigInt(tailOffset)));
    const tail = concatBytes(word(BigInt(bytes.length)), padded(bytes));
    tails.push(tail);
    tailOffset += tail.length;
  });
  return concatBytes(...heads, ...tails);
}

/** Calldata for `signature` (its argument types must match `types`). */
export function encodeCall(signature: string, types: readonly AbiType[], values: readonly AbiValue[]): Uint8Array {
  return concatBytes(selector(signature), encodeArgs(types, values));
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function readWord(data: Uint8Array, at: number): bigint {
  if (at + 32 > data.length) bad("EVM_ABI_DECODE", "return data is shorter than its types");
  let n = 0n;
  for (let i = at; i < at + 32; i++) n = (n << 8n) | BigInt(data[i]);
  return n;
}

const TEXT = new TextDecoder("utf-8", { fatal: true });

/**
 * Decode a flat tuple. uints come back as bigint, `address` as lowercase hex,
 * `bytes32` and `bytes` as Uint8Array, `string` as a string (strict UTF-8).
 */
export function decodeArgs(types: readonly AbiType[], data: Uint8Array): AbiValue[] {
  return types.map((type, i) => {
    const head = readWord(data, 32 * i);
    if (type === "address") {
      if (head >> 160n !== 0n) bad("EVM_ABI_DECODE", "an address word has high bits set");
      return `0x${head.toString(16).padStart(40, "0")}`;
    }
    if (type === "bytes32") return data.slice(32 * i, 32 * i + 32);
    if (!isDynamic(type)) {
      if (head > MAX[type]) bad("EVM_ABI_DECODE", `a ${type} is out of range`);
      return head;
    }
    if (head > BigInt(data.length)) bad("EVM_ABI_DECODE", "a dynamic offset points past the data");
    const at = Number(head);
    const length = readWord(data, at);
    if (length > BigInt(data.length - at - 32)) bad("EVM_ABI_DECODE", "a dynamic length runs past the data");
    const bytes = data.slice(at + 32, at + 32 + Number(length));
    if (type === "bytes") return bytes;
    try {
      return TEXT.decode(bytes);
    } catch {
      return bad("EVM_ABI_DECODE", "a string is not UTF-8");
    }
  });
}
