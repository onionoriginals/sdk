/**
 * Originals inscriptions (P14.12, P9.17, P9.31, P9.32): the CBOR metadata
 * `{entries, part?}` in the writer order P14.12 fixes, the ord
 * 0.29.1 envelope (content type, metaprotocol `og`, metadata pushes, body),
 * and the reader that applies P14.12's restrictions to an envelope as ord
 * reads it. Raw transactions are parsed to find the envelopes in a reveal's
 * witness.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../json/index.js";
import { decodeCbor, encodeCbor } from "../originals/cbor.js";
import { checkStrictValue, entryBytes } from "./log.js";
import { OG_LIMITS, reject } from "./rules.js";
import type { BitcoinNetwork } from "./state.js";

/** PROVISIONAL (P14.12): the metaprotocol value of an Originals inscription. */
export const OG_METAPROTOCOL = "og";

const TAG = { contentType: 1, pointer: 2, parent: 3, metadata: 5, metaprotocol: 7, contentEncoding: 9, delegate: 11 } as const;

/**
 * Originals inscriptions carry no signer DID histories (D22, 22 November 2026; P14.12): a did:vh or
 * did:webvh signer's log is supplied to the verifier from resolution (P7.8, P7.17). A `signers` member in
 * an inscription written before D22 is ignored by the reader and is never evidence; only those inscriptions
 * may carry one (see `LEGACY_SIGNERS_LAST_HEIGHT`).
 */
export interface Metadata {
  entries: JsonObject[];
  /** `[i, n]` in a publication in parts (P9.32). */
  part?: [number, number];
}

// ---------------------------------------------------------------------------
// Writer

/** The value with every object's members in JCS order (UTF-16 code unit order), recursively. */
export function jcsOrdered(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(jcsOrdered);
  if (isJsonObject(value)) {
    const out: JsonObject = {};
    for (const k of Object.keys(value).sort()) out[k] = jcsOrdered(value[k]);
    return out;
  }
  return value;
}

/**
 * The metadata's CBOR (P14.12). Map members may be in any order at every
 * level, and readers accept any order (originals-spec b4f3604); this writer
 * writes the members in the order entries, part, and each entry in JCS
 * order, and never a `signers` member (D22), so the same publication gives the same
 * bytes. Hashes and proofs never cover these bytes, only the JCS form of the
 * decoded JSON. ord's JSON-to-CBOR mapping (PROVISIONAL): text keys,
 * shortest integers, narrowest exact floats.
 */
export function encodeMetadata(m: Metadata, options: { keepOrder?: boolean } = {}): Uint8Array {
  const order = options.keepOrder ? (v: JsonValue) => v : jcsOrdered;
  const out: JsonObject = { entries: m.entries.map((e) => order(e)) };
  if (m.part) out.part = [...m.part];
  return encodeCbor(out);
}

function push(data: Uint8Array): number[] {
  const n = data.length;
  if (n <= 75) return [n, ...data];
  if (n <= 0xff) return [0x4c, n, ...data];
  if (n <= 520) return [0x4d, n & 0xff, n >> 8, ...data];
  throw new Error("a push is at most 520 bytes");
}

function chunks(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += 520) out.push(bytes.subarray(i, i + 520));
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/**
 * An envelope as ord 0.29.1 writes it (P14.12): `OP_FALSE OP_IF "ord"`, then
 * content type, metaprotocol, the metadata in 520-byte pushes, then the body
 * (an empty push, then 520-byte pushes), then `OP_ENDIF`. `body: null` writes
 * no body at all; an empty body is present.
 */
export function encodeEnvelope(e: { contentType?: string | null; metadata: Uint8Array; body?: Uint8Array | null }): Uint8Array {
  const s: number[] = [0x00, 0x63, ...push(utf8("ord"))];
  if (e.contentType) s.push(...push(Uint8Array.of(TAG.contentType)), ...push(utf8(e.contentType)));
  s.push(...push(Uint8Array.of(TAG.metaprotocol)), ...push(utf8(OG_METAPROTOCOL)));
  for (const c of chunks(e.metadata)) s.push(...push(Uint8Array.of(TAG.metadata)), ...push(c));
  if (e.body) {
    // An empty body is present: the empty push that begins it, and no data (P14.12).
    s.push(0x00);
    for (const c of chunks(e.body)) s.push(...push(c));
  }
  s.push(0x68);
  return new Uint8Array(s);
}

/** Bytes the inscription's metadata and body take together (P9.17: at most 350,000). */
export const inscriptionPayload = (metadata: Uint8Array, body: Uint8Array | null | undefined) => metadata.length + (body?.length ?? 0);

// ---------------------------------------------------------------------------
// Reader

export interface ParsedEnvelope {
  /** Every field by tag, values in order. */
  fields: Map<number, Uint8Array[]>;
  /** The body, or null when the envelope has no body push (P14.12). */
  body: Uint8Array | null;
}

/** Read one data push of a script at `at`: [bytes, next offset], or undefined at an opcode that is not a push. */
function readPush(s: Uint8Array, at: number): [Uint8Array, number] | undefined {
  const op = s[at];
  if (op === 0x00) return [new Uint8Array(0), at + 1];
  if (op >= 1 && op <= 75) return [s.subarray(at + 1, at + 1 + op), at + 1 + op];
  if (op === 0x4c) return [s.subarray(at + 2, at + 2 + s[at + 1]), at + 2 + s[at + 1]];
  if (op === 0x4d) {
    const n = s[at + 1] | (s[at + 2] << 8);
    return [s.subarray(at + 3, at + 3 + n), at + 3 + n];
  }
  if (op === 0x4e) {
    const n = (s[at + 1] | (s[at + 2] << 8) | (s[at + 3] << 16) | (s[at + 4] << 24)) >>> 0;
    return [s.subarray(at + 5, at + 5 + n), at + 5 + n];
  }
  if (op === 0x4f) return [Uint8Array.of(0x81), at + 1];
  if (op >= 0x51 && op <= 0x60) return [Uint8Array.of(op - 0x50), at + 1];
  return undefined;
}

/**
 * Parse an envelope `OP_FALSE OP_IF "ord" ... OP_ENDIF`, as ord does: pairs of
 * a tag push and a value push until the empty push that begins the body.
 * Returns undefined when the bytes are not an ord envelope.
 */
export function parseEnvelope(s: Uint8Array): ParsedEnvelope | undefined {
  if (s[0] !== 0x00 || s[1] !== 0x63) return undefined;
  const id = readPush(s, 2);
  if (!id || new TextDecoder().decode(id[0]) !== "ord") return undefined;
  let at = id[1];
  const fields = new Map<number, Uint8Array[]>();
  let body: Uint8Array | null = null;
  while (at < s.length && s[at] !== 0x68) {
    const tag = readPush(s, at);
    if (!tag) return undefined;
    at = tag[1];
    if (tag[0].length === 0) {
      const parts: Uint8Array[] = [];
      while (at < s.length && s[at] !== 0x68) {
        const p = readPush(s, at);
        if (!p) return undefined;
        parts.push(p[0]);
        at = p[1];
      }
      body = concat(parts);
      break;
    }
    const value = readPush(s, at);
    if (!value) return undefined;
    at = value[1];
    // ord reads a tag as the integer its bytes encode (little-endian); one byte in every field it defines.
    const t = tag[0].length === 1 ? tag[0][0] : -1;
    fields.set(t, [...(fields.get(t) ?? []), value[0]]);
  }
  if (s[at] !== 0x68) return undefined;
  return { fields, body };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Where an inscription is: the network and the height of the block that holds it. */
export interface InscriptionPlace {
  network: BitcoinNetwork;
  height: number;
}

/**
 * Owner decision (22 November 2026, bounding P14.12's legacy `signers` member): a reader ignores a
 * `signers` member only in an inscription on mainnet in a block at this height or lower, where
 * inscriptions written before D22 are; the D22 mainnet gate's tip was 977,150. Anywhere else a `signers`
 * member makes the metadata invalid, like any other unknown member.
 */
export const LEGACY_SIGNERS_LAST_HEIGHT = 977_150;

/** Whether an inscription at this place may carry a legacy `signers` member, which is then ignored. */
export const legacySignersAllowed = (at?: InscriptionPlace): boolean => !!at && at.network === "mainnet" && at.height <= LEGACY_SIGNERS_LAST_HEIGHT;

export type InscriptionReading =
  /** Not an Originals inscription (P9.31): no `og` metaprotocol. Its own metadata may be a did:btco version (P5.13). */
  | { kind: "other"; metadata: Uint8Array | null; contentType: string | null }
  /**
   * An Originals inscription that is rejected, with its publication (P9.31, P14.12). `partial` is its metadata's
   * `entries` and `part` as far as they can be read, used only to find the publication it belongs to (P9.32)
   * and to label the entries rejected with it; never evidence.
   */
  | { kind: "invalid"; rule: string; reason: string; partial?: { entries: JsonObject[]; part?: [number, number]; contentType: string | null; body: Uint8Array | null } }
  | { kind: "originals"; metadata: Metadata; metadataBytes: number; contentType: string | null; body: Uint8Array | null };

const strictText = new TextDecoder("utf-8", { fatal: true });

/**
 * Read an inscription's envelope under P14.12 and P9.31. `at` is where the inscription is; without it, or
 * outside the legacy window, a `signers` member makes the metadata invalid (`LEGACY_SIGNERS_LAST_HEIGHT`).
 */
export function readInscription(envelope: Uint8Array, at?: InscriptionPlace): InscriptionReading {
  const p = parseEnvelope(envelope);
  if (!p) return { kind: "invalid", rule: "P14.12", reason: "not an ord envelope" };
  const mp = p.fields.get(TAG.metaprotocol);
  const metadataPushes = p.fields.get(TAG.metadata) ?? [];
  const metadata = metadataPushes.length ? concat(metadataPushes) : null;
  const ct = p.fields.get(TAG.contentType)?.[0];
  let contentType: string | null = null;
  try {
    contentType = ct ? strictText.decode(ct) : null;
  } catch {
    contentType = null;
  }
  const isOg = !!mp && mp.length === 1 && (() => {
    try {
      return strictText.decode(mp[0]) === OG_METAPROTOCOL;
    } catch {
      return false;
    }
  })();
  if (!isOg) return { kind: "other", metadata, contentType };
  const fail = (rule: string, reason: string): InscriptionReading => {
    const partial = metadata ? partialMetadata(metadata) : undefined;
    return partial ? { kind: "invalid", rule, reason, partial: { ...partial, contentType, body: p.body } } : { kind: "invalid", rule, reason };
  };
  // P14.12, P9.17, P9.31: no delegate, pointer, parent, content encoding, or field ord does not recognise.
  for (const tag of p.fields.keys()) {
    if (tag === TAG.delegate) return fail("P9.17", "an Originals inscription names no delegate");
    if (tag === TAG.contentEncoding) return fail("P9.17", "an Originals inscription has no content encoding");
    if (tag === TAG.pointer || tag === TAG.parent) return fail("P14.12", "an Originals inscription names no pointer or parent");
    if (tag !== TAG.contentType && tag !== TAG.metadata && tag !== TAG.metaprotocol) return fail("P14.12", `field ${tag} is not one an Originals inscription carries`);
  }
  if ((p.fields.get(TAG.contentType)?.length ?? 0) > 1) return fail("P14.12", "two content types do not decode deterministically");
  if (ct && contentType === null) return fail("P14.12", "the content type is not UTF-8");
  if (contentType !== null && p.body === null) return fail("P9.17", "a content type with no body");
  if (!metadata) return fail("P14.12", "an Originals inscription carries its entries in its metadata");
  let decoded: JsonValue;
  try {
    decoded = decodeCbor(metadata, { shortest: false });
  } catch (error) {
    return fail("P14.12", (error as Error).message);
  }
  try {
    return { kind: "originals", metadata: checkMetadata(decoded, { legacySigners: legacySignersAllowed(at) }), metadataBytes: metadata.length, contentType, body: p.body };
  } catch (error) {
    const e = error as { details?: { rule?: string }; message: string };
    return fail(e.details?.rule ?? "P14.12", e.message);
  }
}

/** The `entries` and `part` of metadata that fails P14.12, as far as they can be read; never evidence. */
function partialMetadata(metadata: Uint8Array): { entries: JsonObject[]; part?: [number, number] } | undefined {
  let v: JsonValue;
  try {
    v = decodeCbor(metadata, { shortest: false });
  } catch {
    return undefined;
  }
  if (!isJsonObject(v) || !Array.isArray(v.entries)) return undefined;
  const entries = v.entries.filter(isJsonObject);
  const p = v.part;
  const part = Array.isArray(p) && p.length === 2 && p.every((x) => Number.isSafeInteger(x)) && (p[1] as number) >= 2 && (p[1] as number) <= OG_LIMITS.publicationParts && (p[0] as number) >= 1 && (p[0] as number) <= (p[1] as number)
    ? [p[0], p[1]] as [number, number] : undefined;
  return { entries, ...(part ? { part } : {}) };
}

/**
 * P14.12 (D22): an object of `entries` and, in a publication in parts, `part`, and nothing else. A
 * `signers` member is ignored whatever it holds only when `legacySigners` is set, for an inscription in the
 * legacy window (`LEGACY_SIGNERS_LAST_HEIGHT`): it is dropped from the result and is never evidence of a
 * signer's history (P7.8, P9.33). Anywhere else it is an unknown member.
 */
export function checkMetadata(v: JsonValue, options: { legacySigners?: boolean } = {}): Metadata {
  if (!isJsonObject(v)) reject("P14.12", "METADATA_SHAPE", "the metadata is an object, not an array of entries (T14-003)");
  for (const k of Object.keys(v)) {
    if (k === "entries" || k === "part" || (k === "signers" && options.legacySigners)) continue;
    reject("P14.12", "METADATA_MEMBERS", k === "signers" ? "a signers member is ignored only in inscriptions on mainnet at or below block 977,150; here it is not defined" : `metadata member ${k} is not defined`);
  }
  if (!Array.isArray(v.entries) || !v.entries.every(isJsonObject)) reject("P14.12", "METADATA_ENTRIES", "entries is an array of entries");
  for (const e of v.entries) {
    checkStrictValue(e);
    if (entryBytes(e) > OG_LIMITS.entryBytes) reject("P14.13", "ENTRY_TOO_LARGE", "an entry over 65,536 bytes as its JCS form", "limit-exceeded");
  }
  if ("part" in v) {
    const p = v.part;
    if (!Array.isArray(p) || p.length !== 2 || !p.every((x) => Number.isSafeInteger(x)) || (p[1] as number) < 2 || (p[1] as number) > OG_LIMITS.publicationParts || (p[0] as number) < 1 || (p[0] as number) > (p[1] as number)) {
      reject("P9.32", "METADATA_PART", "part is [i, n] with 1 ≤ i ≤ n and 2 ≤ n ≤ 16 (P14.13)");
    }
  }
  const out: Metadata = { entries: v.entries };
  if ("part" in v) out.part = v.part as [number, number];
  return out;
}

// ---------------------------------------------------------------------------
// Transactions

export interface ParsedTransaction {
  txid: string;
  inputs: Array<{ txid: string; vout: number; witness: Uint8Array[] }>;
  outputs: Array<{ value: bigint; script: Uint8Array }>;
}

/** Parse a raw transaction (segwit or legacy) and compute its txid. */
export function parseTransaction(raw: Uint8Array | string): ParsedTransaction {
  const tx = typeof raw === "string" ? hexToBytes(raw.trim()) : raw;
  let i = 0;
  const u8 = () => tx[i++];
  const u32 = () => {
    const v = (tx[i] | (tx[i + 1] << 8) | (tx[i + 2] << 16) | (tx[i + 3] << 24)) >>> 0;
    i += 4;
    return v;
  };
  const varint = () => {
    const f = u8();
    if (f < 0xfd) return f;
    if (f === 0xfd) {
      const v = tx[i] | (tx[i + 1] << 8);
      i += 2;
      return v;
    }
    if (f === 0xfe) return u32();
    const lo = u32();
    const hi = u32();
    return hi * 2 ** 32 + lo;
  };
  const start = 0;
  i = 4;
  const segwit = tx[4] === 0 && tx[5] === 1;
  if (segwit) i = 6;
  const bodyStart = i;
  const nin = varint();
  const inputs: ParsedTransaction["inputs"] = [];
  for (let k = 0; k < nin; k++) {
    const prev = bytesToHex(tx.slice(i, i + 32).reverse());
    i += 32;
    const vout = u32();
    const scriptSig = varint();
    i += scriptSig + 4;
    inputs.push({ txid: prev, vout, witness: [] });
  }
  const nout = varint();
  const outputs: ParsedTransaction["outputs"] = [];
  for (let k = 0; k < nout; k++) {
    let value = 0n;
    for (let b = 7; b >= 0; b--) value = (value << 8n) | BigInt(tx[i + b]);
    i += 8;
    const n = varint();
    outputs.push({ value, script: tx.slice(i, i + n) });
    i += n;
  }
  const bodyEnd = i;
  if (segwit) {
    for (const input of inputs) {
      const n = varint();
      for (let m = 0; m < n; m++) {
        const l = varint();
        input.witness.push(tx.slice(i, i + l));
        i += l;
      }
    }
  }
  const lock = tx.slice(i, i + 4);
  i += 4;
  if (i !== tx.length) reject("P14.12", "TX_PARSE", "trailing bytes after the transaction");
  const legacy = concat([tx.slice(start, 4), tx.slice(bodyStart, bodyEnd), lock]);
  const txid = bytesToHex(sha256(sha256(legacy)).reverse());
  return { txid, inputs, outputs };
}

/**
 * The ord envelopes in an input's tapscript, in order (ord reads the
 * tapscript, the witness item before the control block, without an annex).
 */
export function envelopesInWitness(witness: Uint8Array[]): Uint8Array[] {
  let items = witness;
  if (items.length >= 2 && items[items.length - 1][0] === 0x50) items = items.slice(0, -1);
  if (items.length < 2) return [];
  const script = items[items.length - 2];
  const out: Uint8Array[] = [];
  for (let at = 0; at + 6 <= script.length; at++) {
    if (script[at] === 0x00 && script[at + 1] === 0x63 && script[at + 2] === 0x03 && script[at + 3] === 0x6f && script[at + 4] === 0x72 && script[at + 5] === 0x64) {
      // Find the matching OP_ENDIF by walking pushes.
      let j = at + 6;
      while (j < script.length && script[j] !== 0x68) {
        const p = readPush(script, j);
        if (!p) break;
        j = p[1];
      }
      if (script[j] === 0x68) {
        out.push(script.slice(at, j + 1));
        at = j;
      }
    }
  }
  return out;
}
