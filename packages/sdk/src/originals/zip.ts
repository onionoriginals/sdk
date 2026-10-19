/**
 * A minimal, strict ZIP codec for evidence packages (PROVISIONAL format, D4;
 * owner decision Q3). Only uncompressed ("stored") entries are written or
 * accepted, so sizes are known from the central directory and no
 * decompression bomb is possible. Every check of P7.5 runs on the central
 * directory before any entry's data is read: bounded entry count and total
 * size, no absolute paths, `..` segments, backslashes, directories, symbolic
 * links or duplicate names. Browser-safe: no Node builtins.
 */
import { OriginalsError } from "@originals/vh";

export interface ZipLimits {
  maxEntries?: number;
  /** Maximum total uncompressed size. */
  maxTotalBytes?: number;
}

export const ZIP_LIMITS = Object.freeze({ maxEntries: 20_000, maxTotalBytes: 512 * 1024 * 1024 });

/** One raw entry for `encodeZip`. Defaults produce a normal stored file. */
export interface RawZipEntry {
  name: string;
  data: Uint8Array;
  method?: number;
  flags?: number;
  externalAttributes?: number;
}

function archiveError(code: string, message: string): never {
  throw new OriginalsError("invalid-evidence", code, message);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const UTF8 = 0x0800;
const REGULAR_FILE = (0o100644 << 16) >>> 0;
const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1;

/** Check one archive path (P7.5). */
export function checkArchivePath(name: string): void {
  const bad = (why: string) => archiveError("ARCHIVE_PATH", `archive path ${JSON.stringify(name)} ${why}`);
  if (name.length === 0 || name.length > 255) bad("is empty or too long");
  if (name.includes("\u0000")) bad("contains NUL");
  if (name.includes("\\")) bad("contains a backslash");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) bad("is absolute");
  for (const segment of name.split("/")) {
    if (segment === "" || segment === "." || segment === "..") bad("has an empty, . or .. segment");
  }
}

/** Write raw entries, unchecked. For producing test archives; use `writeZip` otherwise. */
export function encodeZip(entries: RawZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const flags = entry.flags ?? UTF8;
    const method = entry.method ?? 0;
    const local = new Uint8Array(30 + name.length + entry.data.length);
    const l = new DataView(local.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(6, flags, true);
    l.setUint16(8, method, true);
    l.setUint16(10, 0, true);
    l.setUint16(12, DOS_DATE_1980_01_01, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, entry.data.length, true);
    l.setUint32(22, entry.data.length, true);
    l.setUint16(26, name.length, true);
    l.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(entry.data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const c = new DataView(central.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, (3 << 8) | 20, true); // made by: Unix
    c.setUint16(6, 20, true);
    c.setUint16(8, flags, true);
    c.setUint16(10, method, true);
    c.setUint16(12, 0, true);
    c.setUint16(14, DOS_DATE_1980_01_01, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, entry.data.length, true);
    c.setUint32(24, entry.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(38, entry.externalAttributes ?? REGULAR_FILE, true);
    c.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, entries.length, true);
  e.setUint16(10, entries.length, true);
  e.setUint32(12, centralSize, true);
  e.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A deterministic archive: sorted names, fixed timestamps, stored entries. */
export function writeZip(files: Map<string, Uint8Array>): Uint8Array {
  const names = [...files.keys()].sort();
  for (const name of names) checkArchivePath(name);
  return encodeZip(names.map((name) => ({ name, data: files.get(name)! })));
}

/** Read an archive, checking every entry before extracting any data. */
export function readZip(bytes: Uint8Array, limits: ZipLimits = {}): Map<string, Uint8Array> {
  const maxEntries = limits.maxEntries ?? ZIP_LIMITS.maxEntries;
  const maxTotal = limits.maxTotalBytes ?? ZIP_LIMITS.maxTotalBytes;
  if (!(bytes instanceof Uint8Array) || bytes.length < 22) archiveError("ARCHIVE_INVALID", "not a ZIP archive");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) archiveError("ARCHIVE_INVALID", "no end of central directory record");
  if (view.getUint16(eocd + 4, true) !== 0 || view.getUint16(eocd + 6, true) !== 0) archiveError("ARCHIVE_INVALID", "multi-disk archives are not supported");
  const count = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || centralOffset === 0xffffffff) archiveError("ARCHIVE_INVALID", "ZIP64 archives are not supported");
  if (count > maxEntries) archiveError("ARCHIVE_TOO_MANY_ENTRIES", `archive has ${count} entries; at most ${maxEntries}`);
  if (centralOffset + centralSize > eocd) archiveError("ARCHIVE_INVALID", "central directory is out of bounds");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: Array<{ name: string; size: number; crc: number; offset: number }> = [];
  const seen = new Set<string>();
  let total = 0;
  let at = centralOffset;
  for (let i = 0; i < count; i++) {
    if (at + 46 > eocd || view.getUint32(at, true) !== 0x02014b50) archiveError("ARCHIVE_INVALID", "corrupt central directory");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const external = view.getUint32(at + 38, true);
    const offset = view.getUint32(at + 42, true);
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    } catch {
      return archiveError("ARCHIVE_PATH", "an archive path is not UTF-8");
    }
    if (flags & 0x0001) archiveError("ARCHIVE_ENCRYPTED", `${name} is encrypted`);
    if (flags & 0x0008) archiveError("ARCHIVE_INVALID", `${name} uses a data descriptor`);
    if (method !== 0) archiveError("ARCHIVE_COMPRESSED", `${name} is compressed; evidence packages are uncompressed`);
    if (compressed !== size) archiveError("ARCHIVE_INVALID", `${name} has inconsistent sizes`);
    const type = (external >>> 16) & 0o170000;
    if (type === 0o120000) archiveError("ARCHIVE_SYMLINK", `${name} is a symbolic link`);
    if (type !== 0 && type !== 0o100000) archiveError("ARCHIVE_PATH", `${name} is not a regular file`);
    checkArchivePath(name);
    const key = name.normalize("NFC");
    if (seen.has(key)) archiveError("ARCHIVE_DUPLICATE", `${name} appears twice`);
    seen.add(key);
    total += size;
    if (total > maxTotal) archiveError("ARCHIVE_TOO_LARGE", `archive content exceeds ${maxTotal} bytes`);
    entries.push({ name, size, crc, offset });
    at += 46 + nameLength + extraLength + commentLength;
  }

  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const o = entry.offset;
    if (o + 30 > centralOffset || view.getUint32(o, true) !== 0x04034b50) archiveError("ARCHIVE_INVALID", `${entry.name} has no local header`);
    const nameLength = view.getUint16(o + 26, true);
    const extraLength = view.getUint16(o + 28, true);
    if (decoder.decode(bytes.subarray(o + 30, o + 30 + nameLength)) !== entry.name) archiveError("ARCHIVE_INVALID", `${entry.name}'s local header names another file`);
    const start = o + 30 + nameLength + extraLength;
    if (start + entry.size > centralOffset) archiveError("ARCHIVE_INVALID", `${entry.name} is out of bounds`);
    const data = bytes.slice(start, start + entry.size);
    if (crc32(data) !== entry.crc) archiveError("ARCHIVE_CRC", `${entry.name} fails its CRC`);
    files.set(entry.name, data);
  }
  return new Map([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
