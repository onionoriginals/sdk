/**
 * The did:og evidence package (P14.10, P7.1, P7.5): a ZIP archive of stored
 * entries, written byte for byte as P14.10 fixes it (PROVISIONAL, 21 November
 * 2026), read with the import bounds of P7.5, and its manifest
 * `originals-evidence.json`.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalBytes, isJsonObject, type JsonObject } from "../json/index.js";
import { parseStrict, isDigest } from "./log.js";
import { OG_METHOD, reject } from "./rules.js";

export const MANIFEST_NAME = "originals-evidence.json";
export const ASSET_LOG_NAME = "asset/did.jsonl";
export const PACKAGE_FORMAT = "originals-evidence/0.1";
/** P14.10, P7.5. */
export const PACKAGE_LIMITS = Object.freeze({ entries: 20_000, totalBytes: 512 * 1024 * 1024, nameBytes: 255 });

const encoder = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `signers/<lowercase hex SHA-256 of the DID>/` (P14.10). */
export function signerDirectory(did: string): string {
  return `signers/${bytesToHex(sha256(encoder.encode(did)))}/`;
}

// ---------------------------------------------------------------------------
// CRC-32 (ISO 3309)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Writer (P14.10)

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Check a name a writer or reader handles (P7.5, P14.10). */
function checkName(name: string, bytes: Uint8Array): void {
  if (bytes.length === 0 || bytes.length > PACKAGE_LIMITS.nameBytes) reject("P14.10", "PACKAGE_NAME", `entry name ${JSON.stringify(name)} is empty or over 255 bytes`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.includes("\\")) reject("P7.5", "PACKAGE_PATH", `entry name ${JSON.stringify(name)} is an absolute path`);
  const segments = name.split("/");
  if (segments.some((s) => s === ".." || s === "." || s === "")) reject("P7.5", "PACKAGE_PATH", `entry name ${JSON.stringify(name)} has an empty, . or .. segment`);
  if (name.includes("\0")) reject("P7.5", "PACKAGE_PATH", "entry name contains NUL");
}

/**
 * Write the archive P14.10 fixes: entries sorted by UTF-8 name, stored, date
 * 1980-01-01 00:00, UTF-8 flag only, mode 0100644, no extra fields, comments,
 * directories or ZIP64, so that the same contents give the same bytes.
 */
export function writePackageZip(files: Readonly<Record<string, Uint8Array>>): Uint8Array {
  const items = Object.entries(files).map(([name, data]) => ({ name, nameBytes: encoder.encode(name), data }));
  items.sort((a, b) => compareBytes(a.nameBytes, b.nameBytes));
  if (items.length > PACKAGE_LIMITS.entries) reject("P14.10", "PACKAGE_ENTRIES", "more than 20,000 entries");
  for (const item of items) checkName(item.name, item.nameBytes);
  let size = 22;
  for (const i of items) size += 30 + 46 + 2 * i.nameBytes.length + i.data.length;
  if (size > 0xffffffff) reject("P14.10", "PACKAGE_SIZE", "the archive would need ZIP64");
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];
  const crcs: number[] = [];
  for (const i of items) {
    const crc = crc32(i.data);
    crcs.push(crc);
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 10, true);
    view.setUint16(at + 6, 0x0800, true);
    view.setUint16(at + 8, 0, true);
    view.setUint16(at + 10, 0x0000, true);
    view.setUint16(at + 12, 0x0021, true);
    view.setUint32(at + 14, crc, true);
    view.setUint32(at + 18, i.data.length, true);
    view.setUint32(at + 22, i.data.length, true);
    view.setUint16(at + 26, i.nameBytes.length, true);
    view.setUint16(at + 28, 0, true);
    out.set(i.nameBytes, at + 30);
    out.set(i.data, at + 30 + i.nameBytes.length);
    at += 30 + i.nameBytes.length + i.data.length;
  }
  const cdStart = at;
  items.forEach((i, k) => {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 0x0314, true);
    view.setUint16(at + 6, 10, true);
    view.setUint16(at + 8, 0x0800, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, 0x0000, true);
    view.setUint16(at + 14, 0x0021, true);
    view.setUint32(at + 16, crcs[k], true);
    view.setUint32(at + 20, i.data.length, true);
    view.setUint32(at + 24, i.data.length, true);
    view.setUint16(at + 28, i.nameBytes.length, true);
    view.setUint16(at + 30, 0, true);
    view.setUint16(at + 32, 0, true);
    view.setUint16(at + 34, 0, true);
    view.setUint16(at + 36, 0, true);
    view.setUint32(at + 38, 0x81a40000, true);
    view.setUint32(at + 42, offsets[k], true);
    out.set(i.nameBytes, at + 46);
    at += 46 + i.nameBytes.length;
  });
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, items.length, true);
  view.setUint16(at + 10, items.length, true);
  view.setUint32(at + 12, at - cdStart, true);
  view.setUint32(at + 16, cdStart, true);
  return out;
}

// ---------------------------------------------------------------------------
// Reader (P7.5, P14.10)

/**
 * Read a package archive with P7.5's bounds, before extracting anything: at
 * most 20,000 entries and 512 MiB in total, stored entries only, names of at
 * most 255 bytes of valid UTF-8, no absolute path, `..` segment, directory,
 * symbolic link or other non-regular file, and no duplicate. Order, dates and
 * flags other than encryption are not required (P14.10 lets a reader ignore them).
 */
export function readPackageZip(archive: Uint8Array): Record<string, Uint8Array> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const n = archive.length;
  // Find the end of central directory record (with any comment up to 65,535 bytes).
  let eocd = -1;
  for (let i = n - 22; i >= Math.max(0, n - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) reject("P14.10", "PACKAGE_ZIP", "no end of central directory record");
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (view.getUint16(eocd + 8, true) !== count || count === 0xffff || cdOffset === 0xffffffff) reject("P14.10", "PACKAGE_ZIP64", "ZIP64 and multi-disk archives are not packages");
  if (count > PACKAGE_LIMITS.entries) reject("P7.5", "PACKAGE_ENTRIES", `more than ${PACKAGE_LIMITS.entries} archive entries`, "limit-exceeded");
  if (cdOffset + cdSize > eocd) reject("P14.10", "PACKAGE_ZIP", "central directory out of range");
  // Pass 1: the central directory alone, so every bound is checked before any data is read.
  const entries: Array<{ name: string; offset: number; size: number; crc: number; nameLength: number }> = [];
  const names = new Set<string>();
  let total = 0;
  let at = cdOffset;
  for (let k = 0; k < count; k++) {
    if (at + 46 > eocd || view.getUint32(at, true) !== 0x02014b50) reject("P14.10", "PACKAGE_ZIP", "bad central directory header");
    const made = view.getUint16(at + 4, true);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const csize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const external = view.getUint32(at + 38, true);
    const offset = view.getUint32(at + 42, true);
    const nameBytes = archive.subarray(at + 46, at + 46 + nameLength);
    let name: string;
    try {
      name = strictUtf8.decode(nameBytes);
    } catch {
      return reject("P14.10", "PACKAGE_NAME_UTF8", "an entry name is not valid UTF-8");
    }
    if (flags & 0x0001) reject("P7.5", "PACKAGE_ENCRYPTED", `${name} is encrypted`);
    if (method !== 0 || csize !== size) reject("P14.10", "PACKAGE_COMPRESSED", `${name} is compressed; every entry is stored`);
    checkName(name, nameBytes);
    if (name.endsWith("/")) reject("P7.5", "PACKAGE_DIRECTORY", `${name} is a directory entry`);
    // Unix mode, when the archive records one (made by Unix): a regular file only (P14.10).
    if (made >> 8 === 3) {
      const mode = external >>> 16;
      if ((mode & 0o170000) !== 0o100000) reject("P14.10", "PACKAGE_MODE", `${name} is not a regular file (mode ${mode.toString(8)})`);
    } else if (external & 0x10) reject("P7.5", "PACKAGE_DIRECTORY", `${name} is a directory`);
    if (names.has(name)) reject("P7.5", "PACKAGE_DUPLICATE", `${name} appears twice`);
    names.add(name);
    total += size;
    if (total > PACKAGE_LIMITS.totalBytes) reject("P7.5", "PACKAGE_TOO_LARGE", "the archive's entries exceed 512 MiB", "limit-exceeded");
    entries.push({ name, offset, size, crc, nameLength });
    at += 46 + nameLength + extraLength + commentLength;
  }
  // Pass 2: read each entry's data.
  const files: Record<string, Uint8Array> = {};
  for (const e of entries) {
    const o = e.offset;
    if (o + 30 > n || view.getUint32(o, true) !== 0x04034b50) reject("P14.10", "PACKAGE_ZIP", `bad local header for ${e.name}`);
    if (view.getUint16(o + 8, true) !== 0) reject("P14.10", "PACKAGE_COMPRESSED", `${e.name} is compressed`);
    const start = o + 30 + view.getUint16(o + 26, true) + view.getUint16(o + 28, true);
    if (start + e.size > n) reject("P14.10", "PACKAGE_ZIP", `${e.name} runs past the archive`);
    const data = archive.slice(start, start + e.size);
    if (crc32(data) !== e.crc) reject("P14.10", "PACKAGE_CRC", `${e.name} fails its CRC-32`);
    files[e.name] = data;
  }
  return files;
}

// ---------------------------------------------------------------------------
// Manifest (P14.10)

export type MissingItem =
  | { kind: "resource"; version: number; digest: string; versionId: string }
  | { kind: "identity"; did: string; role: "author" | "editor" };

export interface Manifest {
  format: typeof PACKAGE_FORMAT;
  profile: string;
  original: string;
  checkpoint: string;
  head: string;
  completeness: "complete" | "partial";
  missing: MissingItem[];
}

/** The manifest's bytes: its JCS form in UTF-8, no BOM and no final line feed (P14.10). */
export function manifestBytes(manifest: Manifest): Uint8Array {
  return canonicalBytes(manifest as unknown as JsonObject);
}

const exactKeys = (o: JsonObject, keys: string[]) => {
  const k = Object.keys(o).sort();
  return k.length === keys.length && k.every((x, i) => x === [...keys].sort()[i]);
};

/**
 * Read a manifest (P14.10). `versionIds` are those of `asset/did.jsonl`, in
 * order, so `head` must be the last and `checkpoint` one of them. A manifest
 * whose `profile` is not this method's is returned with `unsupported` set,
 * so the caller can report outcome `unsupported` rather than invalid (P14.1).
 */
export function readManifest(bytes: Uint8Array, versionIds: readonly string[]): Manifest & { unsupported?: boolean } {
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch {
    return reject("P14.10", "MANIFEST", "the manifest is not UTF-8");
  }
  if (text.startsWith("﻿")) reject("P14.10", "MANIFEST", "the manifest has a byte order mark");
  const m = parseStrict(text);
  if (!isJsonObject(m) || !exactKeys(m, ["format", "profile", "original", "checkpoint", "head", "completeness", "missing"])) reject("P14.10", "MANIFEST", "the manifest has exactly format, profile, original, checkpoint, head, completeness and missing");
  if (m.format !== PACKAGE_FORMAT) reject("P14.10", "MANIFEST", `format is ${PACKAGE_FORMAT}`);
  if (typeof m.profile !== "string" || typeof m.original !== "string" || typeof m.checkpoint !== "string" || typeof m.head !== "string") reject("P14.10", "MANIFEST", "profile, original, checkpoint and head are strings");
  if (m.profile !== OG_METHOD) return { ...(m as unknown as Manifest), unsupported: true };
  if (m.completeness !== "complete" && m.completeness !== "partial") reject("P14.10", "MANIFEST", "completeness is complete or partial");
  if (!Array.isArray(m.missing)) reject("P14.10", "MANIFEST", "missing is an array");
  for (const item of m.missing) {
    const ok = isJsonObject(item) && (
      (item.kind === "resource" && exactKeys(item, ["kind", "version", "digest", "versionId"]) && Number.isSafeInteger(item.version) && (item.version as number) >= 1 && isDigest(item.digest) && typeof item.versionId === "string") ||
      (item.kind === "identity" && exactKeys(item, ["kind", "did", "role"]) && typeof item.did === "string" && (item.role === "author" || item.role === "editor")));
    if (!ok) reject("P14.10", "MANIFEST", "a missing item is {kind: resource, version, digest, versionId} or {kind: identity, did, role}");
  }
  if (m.head !== versionIds[versionIds.length - 1]) reject("P14.10", "MANIFEST_HEAD", "head is not the versionId of the asset log's last entry");
  if (!versionIds.includes(m.checkpoint)) reject("P14.10", "MANIFEST_CHECKPOINT", "checkpoint is not an entry of the asset log");
  return m as unknown as Manifest;
}

// ---------------------------------------------------------------------------
// Building a package

export interface PackageInput {
  original: string;
  /** The asset log file's exact bytes: the signed lines, never re-serialised (P7.2). */
  assetLog: Uint8Array;
  versionIds: readonly string[];
  checkpoint?: string;
  /** Each did:vh or did:webvh signer's `did.jsonl` and, where its method uses witnesses, `did-witness.json`. */
  signers: ReadonlyArray<{ did: string; log: Uint8Array; witness?: Uint8Array }>;
  /** Resource version bytes by digest. Previews are never resources (P14.10, P9.30). */
  resources: Readonly<Record<string, Uint8Array>>;
  missing: MissingItem[];
}

/** Build a package's files and archive (P14.10). did:btco signers are read from Bitcoin and never packaged (P7.1). */
export function buildPackage(input: PackageInput): { manifest: Manifest; files: Record<string, Uint8Array>; archive: Uint8Array } {
  const head = input.versionIds[input.versionIds.length - 1];
  const manifest: Manifest = {
    format: PACKAGE_FORMAT,
    profile: OG_METHOD,
    original: input.original,
    checkpoint: input.checkpoint ?? head,
    head,
    completeness: input.missing.length ? "partial" : "complete",
    missing: input.missing,
  };
  const files: Record<string, Uint8Array> = { [MANIFEST_NAME]: manifestBytes(manifest), [ASSET_LOG_NAME]: input.assetLog };
  for (const s of input.signers) {
    if (s.did.startsWith("did:btco:")) reject("P7.1", "PACKAGE_BTCO_SIGNER", "a did:btco signer's history is read from Bitcoin, not packaged");
    const dir = signerDirectory(s.did);
    files[`${dir}did.jsonl`] = s.log;
    if (s.witness) files[`${dir}did-witness.json`] = s.witness;
  }
  for (const [digest, bytes] of Object.entries(input.resources)) files[`resources/${digest}`] = bytes;
  return { manifest, files, archive: writePackageZip(files) };
}
