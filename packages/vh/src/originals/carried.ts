/**
 * Carried logs (proposed; aviarytech/originals-spec PR 59 at 3ed0f89):
 * P7.11-P7.16 and P14.14-P14.17. Everything here is PROVISIONAL, as the
 * subsection itself is.
 *
 * A carried file is the exact bytes of one resource version with the
 * Original's asset log added in the carrier P14.14 assigns to that version's
 * `mediaType`: a trailer (P14.15), a text block in a comment (P14.16) or a
 * JSON member (P14.17). It is never an evidence package and makes no claim to
 * be complete (P7.11).
 *
 * - `carrierFor` is P14.14's table.
 * - `locateCarrier` finds and removes a carrier exactly, never decoding,
 *   re-encoding or normalizing what remains (P7.12). It tells "no carrier"
 *   from "a carrier with an invalid log".
 * - `writeCarriedFile` adds one, with the refusals of P14.16, P14.17 and
 *   P7.15, after the caller acknowledges `carriedDisclosure` (P7.15).
 * - `readCarriedFile` verifies a carried file (P7.12-P7.14). It resolves no
 *   DID unless the caller passes `resolveSigners`, the opt-in P7.13 requires;
 *   without signer histories it checks only that the entries chain from the
 *   genesis the identifier binds and that the remaining bytes match the last
 *   descriptor, and reports nothing as verified.
 *
 * Pure and browser-safe: no I/O of its own.
 */
import { resourceDigestAsync, ORIGINALS_LIMITS, type AuthorRef, type EntryState, type ResourceDescriptor } from "./state.js";
import { OriginalsError, fail, type ErrorCategory } from "../errors.js";
import { snapshotBytes } from "../crypto/index.js";
import { canonicalize, isJsonObject, parseJson, type JsonObject, type JsonValue } from "../json/index.js";
import { compactLineError, verifyLog, type LogCopy, type LogEntry, type LogVerification } from "../log/index.js";
import { exactNumberError, originalsSpecialisation } from "./profile.js";
import { anchoringIndex } from "./bitcoin.js";
import { evmSupport } from "./evm.js";
import { tokenNamedBy, type EvmEvidence } from "./evm-anchor.js";
import { verifyOriginal, type OriginalsReport, type RetainedVersions, type ValidAsOf } from "./verify.js";
import type { AuthorDidEvidence } from "./author.js";
import type { SatEvidence } from "./btco.js";
import { textBlockRefusal, type TextBlockRefusal } from "./carried-syntax.js";

// ---------------------------------------------------------------------------
// P14.14: the carrier for a media type

/** P14.14: a carrier is at most 16 MiB; a larger one is no carrier. */
export const CARRIER_MAX_BYTES = 16 * 1024 * 1024;

/** P14.15: the trailer footer's 16-byte magic, `\x89ORIGINALLOG\r\n\x1A\n`. */
export const TRAILER_MAGIC: Uint8Array = Uint8Array.of(0x89, 0x4f, 0x52, 0x49, 0x47, 0x49, 0x4e, 0x41, 0x4c, 0x4c, 0x4f, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** P14.16: a text block's comment syntax: none, a block comment by its opener, or a line comment by its prefix. */
export type CommentSyntax = "none" | "<!--" | "/*" | "//" | "#" | "--";

export type Carrier = { kind: "trailer" } | { kind: "text-block"; comment: CommentSyntax } | { kind: "json-member" };

const TRAILER_TYPES = ["image/png", "image/jpeg", "image/gif", "image/tiff", "image/heic", "audio/mp4", "audio/wav", "audio/aiff"];
const JSON_TYPES = ["application/json", "application/geo+json"];
const TEXT_TYPES: Record<string, CommentSyntax> = {
  "text/plain": "none",
  "text/markdown": "<!--",
  "text/html": "<!--",
  "application/xhtml+xml": "<!--",
  "image/svg+xml": "<!--",
  "application/xml": "<!--",
  "text/xml": "<!--",
  "text/css": "/*",
  "text/javascript": "//",
  "application/typescript": "//",
  "text/x-c": "//",
  "text/x-c++": "//",
  "text/x-java-source": "//",
  "text/x-go": "//",
  "text/x-rust": "//",
  "text/x-swift": "//",
  "text/x-kotlin": "//",
  "text/x-python": "#",
  "text/x-shellscript": "#",
  "application/yaml": "#",
  "application/toml": "#",
  "application/sql": "--",
};

const CLOSERS: Partial<Record<CommentSyntax, string>> = { "<!--": "-->", "/*": "*/" };

/** ASCII lower case only, never Unicode case folding (P14.14). */
function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/**
 * P14.14: the carrier for a version of `mediaType`, compared ASCII
 * case-insensitively, or null when it has none. Aliases (`audio/x-wav`,
 * `application/javascript`), other `+json` types, PDF, ZIP-based formats and
 * other `text/` types have none. PROVISIONAL: a media type with parameters
 * (`text/plain; charset=utf-8`) is compared whole and so has none.
 */
export function carrierFor(mediaType: string): Carrier | null {
  const type = asciiLower(mediaType);
  if (TRAILER_TYPES.includes(type)) return { kind: "trailer" };
  if (JSON_TYPES.includes(type)) return { kind: "json-member" };
  const comment = Object.prototype.hasOwnProperty.call(TEXT_TYPES, type) ? TEXT_TYPES[type] : undefined;
  return comment === undefined ? null : { kind: "text-block", comment };
}

/** Whether two carriers are the same, comment syntax included (P7.12). */
export function sameCarrier(a: Carrier | null, b: Carrier | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind !== "text-block" || a.comment === (b as { comment: CommentSyntax }).comment;
}

// ---------------------------------------------------------------------------
// Locating a carrier (P14.15-P14.17)

export interface CarriedLogFailure {
  category: ErrorCategory;
  code: string;
  message: string;
  /** The zero-based entry the failure is at, when it is at one. */
  index?: number;
}

/**
 * The log a carrier holds: its entries as parsed, or why it is invalid. An
 * invalid log is still a carrier (P14.15, P14.16, P14.17), never content.
 */
export type CarriedLog =
  | { status: "parsed"; entries: JsonValue[]; /** For a trailer, each entry's line size (P14.13, P14.14). */ lineBytes?: number[] }
  | { status: "invalid"; entries: JsonValue[]; failure: CarriedLogFailure };

/**
 * A log found where section 14 defines no carrier: an `originalLog` member
 * that is not the root object's last, or after an earlier root member of that
 * name (P14.17). It may be reported only as P7.12 allows: with a statement
 * that the file is not a version of the Original it names.
 */
export interface StrayLog {
  where: "json-member-not-last" | "json-member-repeated";
  log: CarriedLog;
}

export type CarrierLocation =
  | { status: "none"; stray?: StrayLog }
  | {
      status: "found";
      carrier: Carrier;
      /** The carrier is `file[start, end)`; `end` is the file's length except for a JSON member. */
      start: number;
      end: number;
      /** Exactly the file without the carrier's bytes (P7.12): a copy, never normalized. */
      version: Uint8Array;
      log: CarriedLog;
    };

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

function decodeUtf8(bytes: Uint8Array): string | undefined {
  try {
    return utf8.decode(bytes);
  } catch {
    return undefined;
  }
}

function invalidLog(entries: JsonValue[], code: string, message: string, index?: number, category: ErrorCategory = "invalid-evidence"): CarriedLog {
  return { status: "invalid", entries, failure: { category, code, message, ...(index !== undefined ? { index } : {}) } };
}

function asFailure(error: unknown, index: number): CarriedLogFailure {
  if (!(error instanceof OriginalsError)) throw error;
  return { category: error.category, code: error.code, message: error.message, index };
}

/** Remove `file[start, end)`; a copy of the rest, byte for byte (P7.12). */
function without(file: Uint8Array, start: number, end: number): Uint8Array {
  const out = new Uint8Array(file.length - (end - start));
  out.set(file.subarray(0, start), 0);
  out.set(file.subarray(end), start);
  return out;
}

/**
 * P14.15: a trailer is `L`, then the byte length of `L` as a u64 big-endian,
 * then TRAILER_MAGIC. Decided from the footer alone: at least 24 bytes, the
 * magic last, and `24 + length` at most 16 MiB and at most the file's size.
 */
function findTrailer(file: Uint8Array): { start: number; log: Uint8Array } | null {
  const n = file.length;
  if (n < 24) return null;
  for (let i = 0; i < 16; i++) if (file[n - 16 + i] !== TRAILER_MAGIC[i]) return null;
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  // Without overflow: a length with any of its high 32 bits set is far over 16 MiB.
  if (view.getUint32(n - 24) !== 0) return null;
  const length = view.getUint32(n - 20);
  const total = 24 + length;
  if (total > CARRIER_MAX_BYTES || total > n) return null;
  return { start: n - total, log: file.subarray(n - total, n - 24) };
}

/** P14.15, P14.2: `L` exactly as `did.jsonl`: compact JSON lines, each ending in one LF; each line measured as stored (P14.13). */
function parseTrailerLog(bytes: Uint8Array): CarriedLog {
  const text = decodeUtf8(bytes);
  if (text === undefined) return invalidLog([], "LOG_ENCODING", "the trailer's log is not UTF-8 (P14.15, P14.2)");
  if (text.length === 0) return invalidLog([], "LOG_EMPTY", "the trailer's log has no entries (P14.15)");
  if (!text.endsWith("\n")) return invalidLog([], "LOG_LINE_FORMAT", "the trailer's log does not end in a line feed (P14.2)");
  const lines = text.slice(0, -1).split("\n");
  const entries: JsonValue[] = [];
  const lineBytes: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length === 0) return invalidLog(entries, "JSONL_BLANK_LINE", `line ${i + 1} is empty (P14.2)`, i);
    const form = compactLineError(line);
    if (form) return invalidLog(entries, "LOG_LINE_FORMAT", `line ${i + 1}: ${form} (P14.2)`, i);
    const size = encoder.encode(line).length;
    if (size > ORIGINALS_LIMITS.entryBytes) return invalidLog(entries, "ENTRY_TOO_LARGE", `line ${i + 1} is ${size} bytes, over the entry limit (P14.13, P14.14)`, i, "limit-exceeded");
    const number = exactNumberError(line);
    if (number) return invalidLog(entries, "JSON_UNSAFE_NUMBER", `line ${i + 1}: ${number}`, i);
    try {
      entries.push(parseJson(line));
    } catch (error) {
      return { status: "invalid", entries, failure: asFailure(error, i) };
    }
    lineBytes.push(size);
  }
  if (entries.length > ORIGINALS_LIMITS.entries) return invalidLog(entries, "LOG_TOO_LONG", `the log has more than ${ORIGINALS_LIMITS.entries} entries (P14.13)`, undefined, "limit-exceeded");
  return { status: "parsed", entries, lineBytes };
}

const BEGIN = "=====BEGIN ORIGINAL=====";
const END = "=====END ORIGINAL=====";
const LF = 0x0a;
const CR = 0x0d;

/** The marker or entry text of a block line with `comment`'s prefix removed, or undefined when the line lacks it. */
function unprefixed(line: string, comment: CommentSyntax): string | undefined {
  if (comment === "//" || comment === "#" || comment === "--") return line.startsWith(`${comment} `) ? line.slice(comment.length + 1) : undefined;
  return line;
}

/** The comment syntax whose block ends in `last`, the file's last line once trailing whitespace is removed. */
function syntaxOfLastLine(last: string): CommentSyntax | undefined {
  if (last === "-->") return "<!--";
  if (last === "*/") return "/*";
  if (last === END) return "none";
  for (const prefix of ["//", "#", "--"] as const) if (last === `${prefix} ${END}`) return prefix;
  return undefined;
}

interface Line {
  /** Byte offset of the line's first byte. */
  start: number;
  /** The line's text, without its line end. */
  text: string;
}

/**
 * P14.16: a text block, found from the end. After removing spaces, tabs, CRs
 * and LFs at the end, the last line is the closer (block comment) or the END
 * marker; the block runs back through entry lines to the nearest BEGIN
 * marker and, for a block comment, the opener just before it. The first line
 * must be preceded by a LF, which starts the carrier; the carrier runs to the
 * end of the file. A block with a non-ASCII byte, a CR not before its LF, the
 * closer before the closer line, or `--` inside a `<!--` comment outside its
 * opener and closer, is no carrier. Lines between the markers that are not
 * valid entry lines make an invalid log, not content.
 */
function findTextBlock(file: Uint8Array): { start: number; comment: CommentSyntax; log: CarriedLog } | null {
  let end = file.length;
  while (end > 0 && (file[end - 1] === 0x20 || file[end - 1] === 0x09 || file[end - 1] === CR || file[end - 1] === LF)) end--;
  if (end === 0) return null;
  // A line ending at `lineEnd` (its LF's offset, or `end` for the last line). Every byte read must be ASCII.
  const lineBefore = (lineEnd: number, hasLineEnd: boolean): Line | null => {
    let s = lineEnd;
    while (s > 0 && file[s - 1] !== LF) s--;
    let e = lineEnd;
    if (hasLineEnd && e > s && file[e - 1] === CR) e--;
    let text = "";
    for (let i = s; i < e; i++) {
      const b = file[i];
      if (b >= 0x80 || b === CR) return null; // P14.16: non-ASCII, or a CR other than before its LF
      text += String.fromCharCode(b);
    }
    return { start: s, text };
  };
  const last = lineBefore(end, false);
  if (!last) return null;
  const comment = syntaxOfLastLine(last.text);
  if (!comment) return null;
  const closer = CLOSERS[comment];
  const lines: Line[] = [last];
  let cursor = last;
  const previous = (): Line | null => {
    // A block's lines lie within the last 16 MiB: no need to read further back (P14.14).
    if (cursor.start === 0 || file.length - cursor.start > CARRIER_MAX_BYTES) return null;
    const line = lineBefore(cursor.start - 1, true);
    if (line) cursor = line;
    return line;
  };
  if (closer) {
    const endLine = previous();
    if (!endLine || endLine.text !== END) return null;
    lines.push(endLine);
  }
  // Back through entry lines to the nearest BEGIN marker (P14.16).
  for (;;) {
    const line = previous();
    if (!line) return null;
    lines.push(line);
    if (unprefixed(line.text, comment) === BEGIN) break;
  }
  if (closer) {
    const opener = previous();
    if (!opener || opener.text !== comment) return null; // PROVISIONAL: a BEGIN marker not right after the opener is no block
    lines.push(opener);
  }
  const first = lines[lines.length - 1];
  if (first.start === 0) return null; // P14.16: no LF before the block
  const start = first.start - 1;
  if (file.length - start > CARRIER_MAX_BYTES) return null;
  const ordered = lines.reverse();
  for (let i = 0; i < ordered.length; i++) {
    const t = ordered[i].text;
    const isOpener = closer !== undefined && i === 0;
    const isCloser = closer !== undefined && i === ordered.length - 1;
    if (closer && !isCloser && t.includes(closer)) return null;
    if (comment === "<!--" && !isOpener && !isCloser && t.includes("--")) return null;
  }
  const inner = ordered.slice(closer ? 2 : 1, closer ? -2 : -1);
  return { start, comment, log: parseEntryLines(inner.map((l) => l.text), comment) };
}

/**
 * P14.16: each line between the markers is one entry, compact JSON as in
 * P14.2 once its comment prefix and line end are removed. Entries are
 * measured as their JCS form (P14.14), not as the line.
 */
function parseEntryLines(lines: string[], comment: CommentSyntax): CarriedLog {
  if (lines.length === 0) return invalidLog([], "LOG_EMPTY", "the text block has no entry line (P14.16)");
  const entries: JsonValue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = unprefixed(lines[i], comment);
    if (text === undefined) return invalidLog(entries, "CARRIED_LINE_PREFIX", `entry line ${i + 1} lacks the comment prefix "${comment} " (P14.16)`, i);
    if (text.length === 0) return invalidLog(entries, "JSONL_BLANK_LINE", `entry line ${i + 1} is empty (P14.16)`, i);
    const form = compactLineError(text);
    if (form) return invalidLog(entries, "LOG_LINE_FORMAT", `entry line ${i + 1}: ${form} (P14.16, P14.2)`, i);
    const number = exactNumberError(text);
    if (number) return invalidLog(entries, "JSON_UNSAFE_NUMBER", `entry line ${i + 1}: ${number}`, i);
    try {
      entries.push(parseJson(text));
    } catch (error) {
      return { status: "invalid", entries, failure: asFailure(error, i) };
    }
  }
  if (entries.length > ORIGINALS_LIMITS.entries) return invalidLog(entries, "LOG_TOO_LONG", `the log has more than ${ORIGINALS_LIMITS.entries} entries (P14.13)`, undefined, "limit-exceeded");
  return { status: "parsed", entries };
}

// --------------------------------------------------------------------- JSON

/**
 * P14.17: a document nested deeper than this outside the entries has no JSON
 * member. PROVISIONAL: the root object counts as level 1.
 */
export const JSON_MEMBER_MAX_DEPTH = 1024;
const ORIGINAL_LOG = "originalLog";

class NotJson extends Error {}

function hasBom(b: Uint8Array): boolean {
  return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
}

const isDigit = (c: number | undefined) => c !== undefined && c >= 0x30 && c <= 0x39;
const isHex = (c: number | undefined) => c !== undefined && (isDigit(c) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66));

/**
 * A byte-offset JSON scanner (RFC 8259) for P14.17. It validates syntax and
 * reports offsets; it builds no values, so duplicate keys and large numbers
 * outside the entries are accepted, as P14.17 requires.
 */
class Scanner {
  i = 0;
  constructor(readonly b: Uint8Array) {}

  ws(): void {
    const b = this.b;
    while (this.i < b.length && (b[this.i] === 0x20 || b[this.i] === 0x09 || b[this.i] === 0x0a || b[this.i] === 0x0d)) this.i++;
  }

  expect(byte: number): void {
    if (this.b[this.i] !== byte) throw new NotJson();
    this.i++;
  }

  string(): { start: number; end: number } {
    const start = this.i;
    this.expect(0x22);
    const b = this.b;
    while (this.i < b.length) {
      const c = b[this.i];
      if (c === 0x22) {
        this.i++;
        return { start, end: this.i };
      }
      if (c < 0x20) throw new NotJson();
      if (c === 0x5c) {
        const e = b[this.i + 1];
        if (e === 0x75) {
          for (let k = 2; k < 6; k++) if (!isHex(b[this.i + k])) throw new NotJson();
          this.i += 6;
          continue;
        }
        if (![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].includes(e)) throw new NotJson();
        this.i += 2;
        continue;
      }
      this.i++;
    }
    throw new NotJson();
  }

  number(): void {
    const b = this.b;
    if (b[this.i] === 0x2d) this.i++;
    if (b[this.i] === 0x30) this.i++;
    else if (isDigit(b[this.i])) while (isDigit(b[this.i])) this.i++;
    else throw new NotJson();
    if (b[this.i] === 0x2e) {
      this.i++;
      if (!isDigit(b[this.i])) throw new NotJson();
      while (isDigit(b[this.i])) this.i++;
    }
    if (b[this.i] === 0x65 || b[this.i] === 0x45) {
      this.i++;
      if (b[this.i] === 0x2b || b[this.i] === 0x2d) this.i++;
      if (!isDigit(b[this.i])) throw new NotJson();
      while (isDigit(b[this.i])) this.i++;
    }
  }

  literal(word: string): void {
    for (let k = 0; k < word.length; k++) if (this.b[this.i + k] !== word.charCodeAt(k)) throw new NotJson();
    this.i += word.length;
  }

  /** Skip one value, iteratively; the deepest nesting inside it, the value itself counting 1 when it is a container. */
  value(): number {
    const b = this.b;
    const stack: number[] = [];
    let deepest = 0;
    for (;;) {
      this.ws();
      const c = b[this.i];
      if (c === 0x7b || c === 0x5b) {
        this.i++;
        stack.push(c);
        if (stack.length > deepest) deepest = stack.length;
        this.ws();
        const close = c === 0x7b ? 0x7d : 0x5d;
        if (b[this.i] === close) {
          this.i++;
          stack.pop();
        } else {
          if (c === 0x7b) {
            this.string();
            this.ws();
            this.expect(0x3a);
          }
          continue;
        }
      } else if (c === 0x22) this.string();
      else if (c === 0x74) this.literal("true");
      else if (c === 0x66) this.literal("false");
      else if (c === 0x6e) this.literal("null");
      else this.number();
      // After a value: close containers, or move on to the next member or element.
      for (;;) {
        if (stack.length === 0) return deepest;
        this.ws();
        const top = stack[stack.length - 1];
        const d = b[this.i];
        if (d === 0x2c) {
          this.i++;
          if (top === 0x7b) {
            this.ws();
            this.string();
            this.ws();
            this.expect(0x3a);
          }
          break;
        }
        if ((top === 0x7b && d === 0x7d) || (top === 0x5b && d === 0x5d)) {
          this.i++;
          stack.pop();
          continue;
        }
        throw new NotJson();
      }
    }
  }
}

/** A JSON string token's decoded value: member names are compared after their escapes are decoded (P14.17). */
function decodeName(b: Uint8Array, token: { start: number; end: number }): string {
  return JSON.parse(utf8.decode(b.subarray(token.start, token.end))) as string;
}

interface RootMember {
  name: string;
  /** The first byte after the previous member's value, or after `{` for the first member. */
  from: number;
  valueStart: number;
  valueEnd: number;
  /** For an array value of a member named `originalLog`: each element's byte range. */
  elements?: Array<[number, number]>;
}

/**
 * The root object's members with their byte offsets; null when the document
 * is not UTF-8 JSON, its root is not an object, or it is nested deeper than
 * JSON_MEMBER_MAX_DEPTH outside the entries (P14.17). A leading UTF-8 BOM is
 * skipped and stays part of the version.
 */
function rootMembers(file: Uint8Array): RootMember[] | null {
  if (decodeUtf8(file) === undefined) return null;
  const s = new Scanner(file);
  if (hasBom(file)) s.i = 3;
  try {
    s.ws();
    s.expect(0x7b);
    const members: RootMember[] = [];
    let from = s.i;
    s.ws();
    if (file[s.i] === 0x7d) s.i++;
    else {
      for (;;) {
        s.ws();
        const name = decodeName(file, s.string());
        s.ws();
        s.expect(0x3a);
        s.ws();
        const valueStart = s.i;
        let elements: Array<[number, number]> | undefined;
        if (name === ORIGINAL_LOG && file[s.i] === 0x5b) {
          // The entries' own nesting is not counted here (P14.17); P14.3 limits it per entry.
          elements = [];
          s.i++;
          s.ws();
          if (file[s.i] === 0x5d) s.i++;
          else {
            for (;;) {
              s.ws();
              const at = s.i;
              s.value();
              elements.push([at, s.i]);
              s.ws();
              if (file[s.i] === 0x2c) {
                s.i++;
                continue;
              }
              s.expect(0x5d);
              break;
            }
          }
        } else if (1 + s.value() > JSON_MEMBER_MAX_DEPTH) {
          return null;
        }
        members.push({ name, from, valueStart, valueEnd: s.i, ...(elements ? { elements } : {}) });
        from = s.i;
        s.ws();
        if (file[s.i] === 0x2c) {
          s.i++;
          continue;
        }
        s.expect(0x7d);
        break;
      }
    }
    s.ws();
    return s.i === file.length ? members : null;
  } catch (error) {
    if (error instanceof NotJson || error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * P14.17: each element of an `originalLog` array is one entry, a JSON object
 * checked under P14.3 on its own (its nesting counted from the entry) and
 * measured as its JCS form (P14.14). Whitespace, key order and escapes are free.
 */
function parseMemberLog(file: Uint8Array, member: RootMember): CarriedLog {
  if (!member.elements) return invalidLog([], "CARRIED_LOG_NOT_ARRAY", "the originalLog member's value is not an array of entries (P14.17)");
  if (member.elements.length === 0) return invalidLog([], "LOG_EMPTY", "the originalLog member has no entries (P14.17)");
  const entries: JsonValue[] = [];
  for (let i = 0; i < member.elements.length; i++) {
    const [s, e] = member.elements[i];
    const text = utf8.decode(file.subarray(s, e));
    const number = exactNumberError(text);
    if (number) return invalidLog(entries, "JSON_UNSAFE_NUMBER", `entry ${i + 1}: ${number}`, i);
    let value: JsonValue;
    try {
      value = parseJson(text);
    } catch (error) {
      return { status: "invalid", entries, failure: asFailure(error, i) };
    }
    if (!isJsonObject(value)) return invalidLog(entries, "LOG_LINE_INVALID", `entry ${i + 1} is not a JSON object (P14.17)`, i);
    entries.push(value);
  }
  if (entries.length > ORIGINALS_LIMITS.entries) return invalidLog(entries, "LOG_TOO_LONG", `the log has more than ${ORIGINALS_LIMITS.entries} entries (P14.13)`, undefined, "limit-exceeded");
  return { status: "parsed", entries };
}

function findJsonMember(file: Uint8Array): { found: RootMember } | { stray: StrayLog } | null {
  const members = rootMembers(file);
  if (!members || members.length === 0) return null;
  const named = members.filter((m) => m.name === ORIGINAL_LOG);
  if (named.length === 0) return null;
  const last = members[members.length - 1];
  if (last.name === ORIGINAL_LOG && named.length === 1) {
    if (last.valueEnd - last.from > CARRIER_MAX_BYTES) return null;
    return { found: last };
  }
  // PROVISIONAL: of several members of that name, the last is the log reported, as P7.12 allows.
  const where = last.name === ORIGINAL_LOG ? "json-member-repeated" : "json-member-not-last";
  return { stray: { where, log: parseMemberLog(file, named[named.length - 1]) } };
}

/**
 * Find the carrier in `file` and remove exactly its bytes (P7.12). At most
 * one carrier kind can match: a trailer ends in its magic, a text block in a
 * closer or END line, a JSON document in `}`. Whether it is the carrier the
 * version's media type requires is checked against the log's last entry
 * (`readCarriedFile`), which cannot be known before the carrier is found.
 */
export function locateCarrier(file: Uint8Array): CarrierLocation {
  const bytes = snapshotBytes(file);
  if (!bytes) fail("invalid-evidence", "INPUT_INVALID", "a carried file is a Uint8Array");
  const trailer = findTrailer(bytes);
  if (trailer) {
    return { status: "found", carrier: { kind: "trailer" }, start: trailer.start, end: bytes.length, version: bytes.slice(0, trailer.start), log: parseTrailerLog(trailer.log) };
  }
  const block = findTextBlock(bytes);
  if (block) {
    return { status: "found", carrier: { kind: "text-block", comment: block.comment }, start: block.start, end: bytes.length, version: bytes.slice(0, block.start), log: block.log };
  }
  const json = findJsonMember(bytes);
  if (json && "found" in json) {
    const m = json.found;
    return { status: "found", carrier: { kind: "json-member" }, start: m.from, end: m.valueEnd, version: without(bytes, m.from, m.valueEnd), log: parseMemberLog(bytes, m) };
  }
  return json && "stray" in json ? { status: "none", stray: json.stray } : { status: "none" };
}

// ---------------------------------------------------------------------------
// Disclosure (P7.15)

/**
 * P7.15: what a carried file discloses, which the user must be told before a
 * carrier is written. `text` is a plain statement for people.
 */
export interface CarriedDisclosure {
  original: string;
  /** The checkpoint carried: the last entry's versionId. */
  checkpoint: string;
  mediaType: string;
  carrier: Carrier;
  /** The whole history from genesis: every entry, not only the version carried. */
  entries: number;
  /** Every name the Original has had through the checkpoint, oldest first. */
  names: string[];
  /** Whether any entry carries metadata. */
  metadata: boolean;
  /** Every signer DID: the author and each editor named (P8.3). */
  signers: string[];
  /** For a JSON carrier: the document's data gains an `originalLog` member (P14.17). */
  dataGainsMember: boolean;
  /** For a log with an `anchor` member: the chain and minter's address it ties the Original to (P14.18). */
  anchor: { chain: string; minter: string } | null;
  text: string;
}

function entryState(entry: unknown): EntryState | undefined {
  const state = isJsonObject(entry) ? entry.state : undefined;
  return isJsonObject(state) && isJsonObject(state.asset) ? (state as unknown as EntryState) : undefined;
}

function anchorMember(entry: unknown): { chain: string; minter: string } | undefined {
  const asset = entryState(entry)?.asset as unknown as JsonObject | undefined;
  if (!asset || !Object.prototype.hasOwnProperty.call(asset, "anchor")) return undefined;
  const a = asset.anchor;
  return isJsonObject(a) && typeof a.chain === "string" && typeof a.minter === "string" ? { chain: a.chain, minter: a.minter } : { chain: "unknown", minter: "unknown" };
}

function signerDids(entries: unknown[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const state = entryState(e);
    if (!state) continue;
    for (const ref of [state.author, state.editor] as Array<AuthorRef | undefined>) {
      if (ref && typeof ref.did === "string" && !out.includes(ref.did)) out.push(ref.did);
    }
  }
  return out;
}

function lastDescriptor(entries: unknown[]): ResourceDescriptor {
  const d = entryState(entries[entries.length - 1])?.asset.resource as unknown;
  if (!isJsonObject(d) || typeof d.mediaType !== "string" || typeof d.size !== "number" || typeof d.digest !== "string") {
    fail("invalid-evidence", "CARRIED_DESCRIPTOR", "the last entry names no resource descriptor (P7.11)");
  }
  return d as unknown as ResourceDescriptor;
}

/** P7.15: what writing a carrier for `entries` (genesis through the checkpoint) discloses. */
export function carriedDisclosure(entries: LogEntry[]): CarriedDisclosure {
  if (!Array.isArray(entries) || entries.length === 0) fail("invalid-evidence", "INPUT_INVALID", "a carried log has at least the genesis entry");
  const d = lastDescriptor(entries);
  const carrier = carrierFor(d.mediaType);
  if (!carrier) fail("unsupported-profile", "CARRIER_NONE_FOR_MEDIA_TYPE", `${d.mediaType} has no carrier (P14.14); offer the log separately (P7.15)`);
  const last = entries[entries.length - 1];
  const original = String(entryState(last)?.id ?? "");
  const names: string[] = [];
  let metadata = false;
  for (const e of entries) {
    const asset = entryState(e)?.asset;
    if (asset && typeof asset.name === "string" && names[names.length - 1] !== asset.name) names.push(asset.name);
    if (asset?.metadata !== undefined) metadata = true;
  }
  const signers = signerDids(entries);
  const anchor = entries.map(anchorMember).find((a) => a !== undefined) ?? null;
  const dataGainsMember = carrier.kind === "json-member";
  const parts = [
    `This file will carry the whole history of ${original}: all ${entries.length} entries from its creation through ${last.versionId},`,
    `including every name it has had (${names.map((n) => JSON.stringify(n)).join(", ")})${metadata ? " and its metadata in every entry" : ""},`,
    `and the DIDs of everyone who signed it (${signers.join(", ")}). Anyone who receives the file can read all of it.`,
  ];
  if (anchor) parts.push(`It also discloses the chain ${anchor.chain} and the minter's address ${anchor.minter}, which tie this Original to that account even before it is anchored.`);
  if (dataGainsMember) parts.push("The JSON document's data gains a member named originalLog, which programs reading the document will see.");
  parts.push("The file is not an evidence package and makes no claim to be complete.");
  return { original, checkpoint: last.versionId, mediaType: d.mediaType, carrier, entries: entries.length, names, metadata, signers, dataGainsMember, anchor, text: parts.join(" ") };
}

// ---------------------------------------------------------------------------
// Writing (P7.15, P14.15-P14.17)

/** Why a carrier cannot be added as section 14 requires (P7.15): the log is offered separately instead. */
export type CarrierRefusal = TextBlockRefusal | "not-utf8" | "json-root-not-object" | "json-has-original-log" | "json-not-readable" | "too-large" | "does-not-read-back";

function refuse(reason: CarrierRefusal, message: string): never {
  fail("unsupported-profile", "CARRIER_CANNOT_ADD", `${message}; offer the log separately (P7.15)`, { reason });
}

const hex4 = (code: number) => `\\u${code.toString(16).padStart(4, "0")}`;

/**
 * P14.16: an entry as one ASCII line, members in JCS order. Every non-ASCII
 * character is a `\u` escape; for `/*` comments a `/` after `*` is written
 * `\/`, and for `<!--` comments a `-` after `-` is `-`, so no line holds
 * the closer or `--`. None of this changes the entry's JCS form (P14.3).
 */
export function asciiEntryLine(value: JsonValue, comment: CommentSyntax): string {
  let out = "";
  const str = (s: string) => {
    out += '"';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      const ch = s[i];
      const prev = out[out.length - 1];
      if (ch === '"') out += '\\"';
      else if (ch === "\\") out += "\\\\";
      else if (c === 0x08) out += "\\b";
      else if (c === 0x09) out += "\\t";
      else if (c === 0x0a) out += "\\n";
      else if (c === 0x0c) out += "\\f";
      else if (c === 0x0d) out += "\\r";
      else if (c < 0x20 || c > 0x7e) out += hex4(c);
      else if (comment === "<!--" && ch === "-" && prev === "-") out += hex4(c);
      else if (comment === "/*" && ch === "/" && prev === "*") out += "\\/";
      else out += ch;
    }
    out += '"';
  };
  const walk = (v: JsonValue) => {
    if (v === null || typeof v === "boolean" || typeof v === "number") out += canonicalize(v);
    else if (typeof v === "string") str(v);
    else if (Array.isArray(v)) {
      out += "[";
      v.forEach((x, i) => {
        if (i > 0) out += ",";
        walk(x);
      });
      out += "]";
    } else {
      out += "{";
      Object.keys(v).sort().forEach((k, i) => {
        if (i > 0) out += ",";
        str(k);
        out += ":";
        walk(v[k]);
      });
      out += "}";
    }
  };
  walk(value);
  return out;
}

/** Whether the version's own lines end in CR LF: some do and none ends in a bare LF (P14.16). PROVISIONAL for mixed endings. */
function usesCrLf(text: string): boolean {
  return text.includes("\r\n") && !/(^|[^\r])\n/.test(text);
}

function textBlock(version: Uint8Array, entries: LogEntry[], comment: CommentSyntax, mediaType: string): Uint8Array {
  const text = decodeUtf8(version);
  if (text === undefined) refuse("not-utf8", "the version is not valid UTF-8, so it cannot take a text block (P14.16)");
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const why = textBlockRefusal(body, asciiLower(mediaType));
  if (why) refuse(why, `the version ends where appended lines would be content, not a comment (${why}; P14.16)`);
  const eol = usesCrLf(body) ? "\r\n" : "\n";
  const prefix = comment === "//" || comment === "#" || comment === "--" ? `${comment} ` : "";
  const closer = CLOSERS[comment];
  const lines = [
    ...(closer ? [comment] : []),
    `${prefix}${BEGIN}`,
    ...entries.map((e) => `${prefix}${asciiEntryLine(e as unknown as JsonValue, comment)}`),
    `${prefix}${END}`,
    ...(closer ? [closer] : []),
  ];
  // A single LF, never preceded by a CR of the writer's own (P14.16); every line ends, the last too.
  return encoder.encode(`\n${lines.join(eol)}${eol}`);
}

function jsonMember(version: Uint8Array, entries: LogEntry[]): { at: number; carrier: Uint8Array } {
  if (decodeUtf8(version) === undefined) refuse("not-utf8", "the document is not valid UTF-8 JSON (P14.17)");
  const members = rootMembers(version);
  if (!members) {
    const s = new Scanner(version);
    if (hasBom(version)) s.i = 3;
    s.ws();
    if (version[s.i] !== 0x7b) refuse("json-root-not-object", "the document's root is not an object (P14.17, P7.15)");
    refuse("json-not-readable", `the document is not JSON, or is nested deeper than ${JSON_MEMBER_MAX_DEPTH} levels, so no reader could find the member (P14.17)`);
  }
  if (members.some((m) => m.name === ORIGINAL_LOG)) refuse("json-has-original-log", "the document already has a root member named originalLog (P14.17, P7.15)");
  const array = `[${entries.map((e) => canonicalize(e as unknown as JsonValue)).join(",")}]`;
  if (members.length === 0) {
    // Just after the root's `{`: removing the member leaves the document exactly (P14.17).
    const s = new Scanner(version);
    if (hasBom(version)) s.i = 3;
    s.ws();
    return { at: s.i + 1, carrier: encoder.encode(`"${ORIGINAL_LOG}":${array}`) };
  }
  // Immediately after the last member's value, so the carrier starts at the first byte after it.
  return { at: members[members.length - 1].valueEnd, carrier: encoder.encode(`,"${ORIGINAL_LOG}":${array}`) };
}

export interface WriteCarriedOptions {
  /**
   * The disclosure the user was shown before writing (P7.15):
   * `carriedDisclosure(entries)`. Required; one for another Original,
   * checkpoint or carrier is refused.
   */
  disclosed: CarriedDisclosure;
}

/**
 * Write a carried file: `version` with `entries`, genesis through an accepted
 * checkpoint, in the carrier P14.14 assigns to the last entry's `mediaType`
 * (P7.11, P7.15). Refuses with an `OriginalsError`:
 * - CARRIER_NOT_ACCEPTED: an entry without a proof, a draft (P6.3, P7.15).
 *   Whether a signed checkpoint is accepted, and after anchoring accepted on
 *   the anchor, is for the caller holding the history to decide (the SDK does).
 * - CARRIER_VERSION_MISMATCH: `version` is not the last entry's version.
 * - CARRIER_NONE_FOR_MEDIA_TYPE: P14.14 assigns that media type no carrier.
 * - CARRIER_CANNOT_ADD (`details.reason`): P14.16 or P14.17 forbids it, or
 *   the carrier would exceed 16 MiB.
 * - CARRIER_DISCLOSURE_REQUIRED: no matching disclosure was passed.
 * Adding a carrier signs nothing (P7.16).
 */
export async function writeCarriedFile(version: Uint8Array, entries: LogEntry[], options: WriteCarriedOptions): Promise<Uint8Array> {
  const bytes = snapshotBytes(version);
  if (!bytes) fail("invalid-evidence", "INPUT_INVALID", "the version is a Uint8Array");
  if (!Array.isArray(entries) || entries.length === 0) fail("invalid-evidence", "INPUT_INVALID", "a carried log has at least the genesis entry");
  for (const e of entries) {
    if (!isJsonObject(e) || !Array.isArray(e.proof) || e.proof.length === 0) {
      fail("invalid-evidence", "CARRIER_NOT_ACCEPTED", "a carrier is written only for an accepted checkpoint, never for a draft (P7.15, P6.3)");
    }
  }
  const disclosure = carriedDisclosure(entries);
  const d = options?.disclosed;
  if (!d || d.original !== disclosure.original || d.checkpoint !== disclosure.checkpoint || !sameCarrier(d.carrier, disclosure.carrier) || d.dataGainsMember !== disclosure.dataGainsMember) {
    fail("invalid-evidence", "CARRIER_DISCLOSURE_REQUIRED", "tell the user what the file discloses first, and pass that disclosure (P7.15)");
  }
  const descriptor = lastDescriptor(entries);
  if (bytes.length !== descriptor.size || (await resourceDigestAsync(bytes)) !== descriptor.digest) {
    fail("invalid-evidence", "CARRIER_VERSION_MISMATCH", "the file's bytes must be the version the last entry names (P7.15)");
  }
  const carrier = disclosure.carrier;
  let out: Uint8Array;
  if (carrier.kind === "trailer") {
    // `L` exactly as `did.jsonl` (P14.15, P14.2).
    const log = encoder.encode(entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
    if (log.length + 24 > CARRIER_MAX_BYTES) refuse("too-large", "the trailer would exceed 16 MiB (P14.14)");
    out = new Uint8Array(bytes.length + log.length + 24);
    out.set(bytes, 0);
    out.set(log, bytes.length);
    const view = new DataView(out.buffer);
    view.setUint32(bytes.length + log.length, 0);
    view.setUint32(bytes.length + log.length + 4, log.length);
    out.set(TRAILER_MAGIC, out.length - 16);
  } else if (carrier.kind === "text-block") {
    const block = textBlock(bytes, entries, carrier.comment, descriptor.mediaType);
    if (block.length > CARRIER_MAX_BYTES) refuse("too-large", "the text block would exceed 16 MiB (P14.14)");
    out = new Uint8Array(bytes.length + block.length);
    out.set(bytes, 0);
    out.set(block, bytes.length);
  } else {
    const { at, carrier: member } = jsonMember(bytes, entries);
    if (member.length > CARRIER_MAX_BYTES) refuse("too-large", "the JSON member would exceed 16 MiB (P14.14)");
    out = new Uint8Array(bytes.length + member.length);
    out.set(bytes.subarray(0, at), 0);
    out.set(member, at);
    out.set(bytes.subarray(at), at + member.length);
  }
  // The file must read back as written: the same carrier, removing to exactly the version (P7.12).
  const back = locateCarrier(out);
  if (back.status !== "found" || !sameCarrier(back.carrier, carrier) || back.log.status !== "parsed" || back.version.length !== bytes.length || !back.version.every((b, i) => b === bytes[i])) {
    refuse("does-not-read-back", "the carrier would not read back exactly (P14.14-P14.17)");
  }
  return out;
}

/**
 * P7.16: the version's bytes without a carrier, for inscribing or publishing
 * a carried file's bytes: with the carrier they do not match the descriptor.
 * A copy of the file itself when it has none.
 */
export function removeCarrier(file: Uint8Array): Uint8Array {
  const found = locateCarrier(file);
  return found.status === "found" ? found.version : (snapshotBytes(file) as Uint8Array);
}

// ---------------------------------------------------------------------------
// Reading (P7.12-P7.14)

export interface ReadCarriedOptions {
  /** Signer DID histories the caller retained or was given (P7.13). Using them makes no request. */
  authors?: AuthorDidEvidence[];
  /**
   * The caller's opt-in to resolve signer DIDs (P7.13, P8.5): called once for
   * each signer DID the carried log names that `authors` does not cover. A
   * reader must not resolve merely because a file was opened or previewed,
   * since the log's author chose the DIDs and can learn who resolves them, so
   * pass this only on the caller's explicit request.
   */
  resolveSigners?: (did: string) => Promise<AuthorDidEvidence | undefined>;
  /**
   * What an adapter read from the anchoring sat. For an anchored Original the
   * state is derived from the anchor; the carried log is not preferred to it
   * (P7.14, P9.13).
   */
  bitcoin?: SatEvidence[];
  /**
   * EXPERIMENTAL: for a log with an `anchor` member, the anchor contract pin and
   * what providers read from the tokens (P7.14, P9.21-P9.29). Without a pin
   * (the spec pins none, P14.21) the Original is unsupported and nothing is
   * verified.
   */
  evm?: EvmEvidence;
  /** The highest versionIds verified before, and other copies, as for `verifyOriginal` (P7.6, P7.8). */
  retained?: RetainedVersions;
  copies?: LogCopy[];
  now?: number | Date;
}

/**
 * The result of reading a carried file, its parts reported separately
 * (section 7). Never labelled an evidence package, and no claim to be
 * complete (P7.11).
 */
export interface CarriedFileReport {
  kind: "carried-file";
  completeness: "no-claim";
  /**
   * found: a carrier, the one the last entry's media type requires (comment
   * syntax included). none: no carrier. mismatch: another carrier, or one for
   * a media type with none: the file is not a carried version (P7.12). stray:
   * a log where section 14 defines no carrier, such as an `originalLog` member
   * that is not the root's last (P14.17).
   */
  carrierStatus: "found" | "none" | "mismatch" | "stray";
  carrier: Carrier | null;
  /** The carrier P14.14 assigns the last entry's media type, when the log names one. */
  expectedCarrier: Carrier | null;
  /** The file without the carrier, byte for byte (P7.12); null without one. */
  version: Uint8Array | null;
  log: { status: "parsed" | "invalid" | "absent"; entries: number; failure?: CarriedLogFailure };
  /** The did:vh the entries name: a claim until `verified.log`. */
  original: string | null;
  /** The last entry's versionId: a claim until `verified.log`. */
  checkpoint: string | null;
  descriptor: ResourceDescriptor | null;
  /**
   * Checked without any key (P7.13): every rule but each signer's
   * authorization and signature, so whether the entries chain from the
   * genesis the identifier binds. Anyone can arrange this.
   */
  chain: { status: "chains-from-genesis" | "broken" | "not-checked"; entries: number; failure?: CarriedLogFailure };
  /** The remaining bytes against the last entry's descriptor (P7.12); never a verification by itself. */
  bytes: "match" | "mismatch" | "not-checked";
  /** checked: signer DID histories were had, and the log was verified with them. */
  proofs: "checked" | "unchecked";
  /** P7.13: what was relied on. `requested`: the caller opted in to resolution. */
  signers: { requested: boolean; given: string[]; resolved: string[]; unavailable: string[] };
  history: OriginalsReport["history"]["status"] | "unchecked";
  identityEvidence: "complete" | "incomplete";
  authorBinding: "valid" | "failed" | "incomplete";
  /**
   * P7.14. not-anchored: no anchor named. bitcoin: the anchoring sat was read
   * and decides the state. bitcoin-unread: a did:btco anchor the reader did
   * not read: missing evidence. unsupported: an `anchor` member, on a chain
   * this revision pins no contract for (P14.21): unsupported, not invalid.
   */
  anchoring: {
    status: "not-anchored" | "bitcoin" | "bitcoin-unread" | "evm" | "evm-unread" | "unsupported";
    sat?: string;
    chain?: string;
    /** Entries from the anchoring entry on not checked against the anchor (P7.14, P9.12, P9.15). */
    notCheckedAgainstAnchor: string[];
  };
  /** log: the carried log verified through its last entry. version: and the remaining bytes are its version (P7.12). */
  verified: { log: boolean; version: boolean };
  /** P7.10, P7.14: what the result is valid as of; for an unanchored Original, never more. */
  validAsOf: ValidAsOf | null;
  /** Only an anchored Original's state derived from its anchor can be current (P7.14). */
  current: boolean;
  /** The verification the result relies on, when one ran. */
  report: OriginalsReport | null;
  /** Plain statements for people, only those P7.12-P7.14 permit. */
  statements: string[];
  reasons: string[];
}

const ENGINE_LIMITS = { maxEntries: ORIGINALS_LIMITS.entries, maxEntryBytes: ORIGINALS_LIMITS.entryBytes };

/** P7.13: every rule but each signer's authorization and signature. */
async function chainCheck(entries: JsonValue[], lineBytes: number[] | undefined, now: number | Date | undefined): Promise<CarriedFileReport["chain"]> {
  const all = new Set(entries.map((_, i) => i));
  const v: LogVerification = await verifyLog(entries, { specialisation: originalsSpecialisation([]), unauthorized: all, now, limits: ENGINE_LIMITS }, lineBytes);
  if (!v.failure && v.entries.length === entries.length) return { status: "chains-from-genesis", entries: v.entries.length };
  const f = v.failure!;
  return { status: "broken", entries: v.entries.length, failure: { category: f.error.category, code: f.error.code, message: f.error.message, index: f.index } };
}

function blankReport(): CarriedFileReport {
  return {
    kind: "carried-file",
    completeness: "no-claim",
    carrierStatus: "none",
    carrier: null,
    expectedCarrier: null,
    version: null,
    log: { status: "absent", entries: 0 },
    original: null,
    checkpoint: null,
    descriptor: null,
    chain: { status: "not-checked", entries: 0 },
    bytes: "not-checked",
    proofs: "unchecked",
    signers: { requested: false, given: [], resolved: [], unavailable: [] },
    history: "unchecked",
    identityEvidence: "incomplete",
    authorBinding: "incomplete",
    anchoring: { status: "not-anchored", notCheckedAgainstAnchor: [] },
    verified: { log: false, version: false },
    validAsOf: null,
    current: false,
    report: null,
    statements: [],
    reasons: [],
  };
}

function versionIdOf(entry: unknown): string | null {
  return isJsonObject(entry) && typeof entry.versionId === "string" ? entry.versionId : null;
}

/**
 * Read a carried file (P7.12-P7.14): remove exactly the carrier, check it is
 * the one the last entry's media type requires, check the remaining bytes
 * against that entry's descriptor, and verify the log under this profile
 * (P3.5). Without signer DID histories, given or resolved on the caller's
 * opt-in, the proofs are unchecked: identity evidence and author binding are
 * incomplete and nothing is verified (P7.13).
 */
export async function readCarriedFile(file: Uint8Array, options: ReadCarriedOptions = {}): Promise<CarriedFileReport> {
  const report = blankReport();
  const found = locateCarrier(file);
  let log: CarriedLog;
  if (found.status === "none") {
    if (!found.stray) {
      report.reasons.push("no-carrier");
      report.statements.push("This file has no carried log.");
      return report;
    }
    report.carrierStatus = "stray";
    report.reasons.push(found.stray.where);
    log = found.stray.log;
  } else {
    report.carrierStatus = "found";
    report.carrier = found.carrier;
    report.version = found.version;
    log = found.log;
  }
  report.log = { status: log.status, entries: log.entries.length, ...(log.status === "invalid" ? { failure: log.failure } : {}) };
  if (log.status === "invalid") {
    report.reasons.push("carried-log-invalid");
    report.statements.push("This file has a carried log, but the log is invalid: nothing in it is verified.");
    return report;
  }
  const entries = log.entries;
  report.checkpoint = versionIdOf(entries[entries.length - 1]);
  const genesisId = entryState(entries[0])?.id;
  report.original = typeof genesisId === "string" ? genesisId : null;
  try {
    report.descriptor = lastDescriptor(entries);
  } catch (error) {
    if (!(error instanceof OriginalsError)) throw error;
  }
  const descriptor = report.descriptor;
  report.expectedCarrier = descriptor ? carrierFor(descriptor.mediaType) : null;
  if (report.carrierStatus === "found" && !sameCarrier(report.carrier, report.expectedCarrier)) {
    report.carrierStatus = "mismatch";
    report.reasons.push("carrier-not-for-media-type");
  }
  const carried = report.carrierStatus === "found";

  // P14.21, P7.14: an `anchor` member names a chain this revision pins no contract for: unsupported, not invalid.
  const evm = entries.map(anchorMember).find((a) => a !== undefined);
  const evmSupported = evm !== undefined && evmSupport(evm.chain, options.evm?.pin ?? null).supported;
  if (evm && !evmSupported) {
    const why = options.evm?.pin ? "this reader's revision of P14.22 does not list it" : "no anchor contract is pinned (P14.21)";
    report.anchoring = { status: "unsupported", chain: evm.chain, notCheckedAgainstAnchor: entries.map(versionIdOf).filter((v): v is string => v !== null) };
    report.reasons.push("anchor-chain-unsupported");
    report.statements.push(
      `This file carries the log of an Original anchored on ${evm.chain}, which this reader does not support: ${why}. The Original is unsupported, not invalid, and nothing is verified.`,
    );
    return report;
  }

  report.chain = await chainCheck(entries, found.status === "found" && found.carrier.kind === "trailer" && log.status === "parsed" ? log.lineBytes : undefined, options.now);
  if (carried && descriptor && report.version) {
    const remaining = report.version;
    report.bytes = remaining.length === descriptor.size && (await resourceDigestAsync(remaining)) === descriptor.digest ? "match" : "mismatch";
  }

  // P7.13: signer histories as given, then resolved only on the caller's opt-in.
  const dids = signerDids(entries);
  const authors = (options.authors ?? []).filter((a) => dids.includes(a.did));
  report.signers.given = authors.map((a) => a.did);
  if (options.resolveSigners) {
    report.signers.requested = true;
    for (const did of dids) {
      if (authors.some((a) => a.did === did)) continue;
      const evidence = await options.resolveSigners(did);
      if (evidence && evidence.did === did) {
        authors.push({ ...evidence, source: evidence.source ?? "fetched" });
        report.signers.resolved.push(did);
      } else report.signers.unavailable.push(did);
    }
  } else {
    report.signers.unavailable = dids.filter((did) => !authors.some((a) => a.did === did));
  }

  // The anchoring entry: the first that lists a did:btco alias, or for an `anchor` member, a token alias (P9.10, P9.20).
  const k = evm ? entries.findIndex((e) => tokenNamedBy(e) !== undefined) : anchoringIndex(entries);
  const sat = k >= 0 ? (entryState(entries[k])?.asset.aliases ?? []).find((a) => typeof a === "string" && a.startsWith("did:btco:")) : undefined;
  const fromAnchor = k >= 0 ? entries.slice(k).map(versionIdOf).filter((v): v is string => v !== null) : [];
  const onBitcoin = k >= 0 && (options.bitcoin?.length ?? 0) > 0;
  const onEvm = evm !== undefined && (options.evm?.tokens.length ?? 0) > 0;
  if (evm) {
    // P7.14: the anchor is the token; without its evidence, missing evidence and at most the entries before the anchoring entry.
    report.anchoring = onEvm ? { status: "evm", chain: evm.chain, notCheckedAgainstAnchor: [] } : { status: "evm-unread", chain: evm.chain, notCheckedAgainstAnchor: fromAnchor };
  } else if (k >= 0) {
    report.anchoring = onBitcoin
      ? { status: "bitcoin", ...(sat ? { sat } : {}), notCheckedAgainstAnchor: [] }
      : { status: "bitcoin-unread", ...(sat ? { sat } : {}), notCheckedAgainstAnchor: fromAnchor };
  }

  // The log verified under this profile (P3.5). With no signer history at all nothing runs: the proofs stay unchecked (P7.13).
  // Bytes that do not match are not that version, and the log's own result is reported separately (P7.12).
  const bytes = carried && descriptor && report.version && report.bytes === "match" ? { [descriptor.digest]: report.version } : undefined;
  const common = {
    authors,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(bytes ? { bytes } : {}),
    ...(options.retained ? { retained: options.retained } : {}),
    ...(options.copies ? { copies: options.copies } : {}),
  };
  let verified: OriginalsReport | null = null;
  if (authors.length > 0) {
    if (evm) verified = await verifyOriginal({ ...common, log: entries, evm: options.evm!, ...(options.bitcoin ? { bitcoin: options.bitcoin } : {}) });
    else if (k < 0) verified = await verifyOriginal({ ...common, log: entries });
    else if (onBitcoin) verified = await verifyOriginal({ ...common, log: entries, bitcoin: options.bitcoin! });
    // P7.14: without the anchor, at most the entries before the anchoring entry.
    else if (k > 0) verified = await verifyOriginal({ ...common, log: entries.slice(0, k) });
  }
  report.report = verified;
  if (verified) {
    report.proofs = "checked";
    report.history = verified.history.status;
    report.identityEvidence = verified.identityEvidence.status;
    report.authorBinding = verified.authorBinding.status;
    report.validAsOf = verified.validAsOf;
    for (const r of verified.reasons) if (!report.reasons.includes(r)) report.reasons.push(r);
  } else {
    report.reasons.push("proofs-unchecked");
  }
  if (report.identityEvidence === "incomplete" && !report.reasons.includes("identity-evidence-incomplete")) report.reasons.push("identity-evidence-incomplete");

  const valid = verified !== null && verified.validAsOf !== null;
  let logVerified = false;
  if (evm) {
    // State from the token; the carried log counts only where the anchors accepted every entry of it (P7.14, P9.13, P9.29).
    const r = verified?.evm;
    const accepted = new Set((r?.stretches ?? []).filter((x) => x.status === "anchored").flatMap((x) => [...x.carried, ...x.entries]));
    const all = entries.map(versionIdOf);
    const onAnchor = r !== undefined && r !== null && (r.status === "anchored" || r.status === "moved-to-bitcoin");
    logVerified = valid && onAnchor && all.every((v) => v !== null && accepted.has(v));
    if (onAnchor && !logVerified && valid) report.reasons.push("carried-log-not-accepted-on-anchor");
    if (!onAnchor) report.anchoring.notCheckedAgainstAnchor = fromAnchor;
    report.current = verified?.current === true;
    if (!onEvm && !report.reasons.includes("evm-evidence-missing")) report.reasons.push("evm-evidence-missing");
  } else if (k < 0) logVerified = valid && verified!.checkpoint === report.checkpoint;
  else if (onBitcoin) {
    // State from the anchor; the carried log counts only where Bitcoin accepted every entry of it (P7.14, P9.13).
    const a = verified?.anchoring;
    logVerified = valid && a?.status === "anchored" && a.copy === "agrees" && a.superseded === 0;
    if (a?.status === "anchored" && (a.copy === "differs" || a.superseded > 0)) report.reasons.push("carried-log-not-accepted-on-anchor");
    if (a && a.status !== "anchored") report.anchoring.notCheckedAgainstAnchor = fromAnchor;
    report.current = verified?.current === true;
  } else if (!report.reasons.includes("bitcoin-evidence-missing")) {
    report.reasons.push("bitcoin-evidence-missing");
  }
  report.verified = { log: logVerified, version: logVerified && carried && report.bytes === "match" };

  // Statements, only as P7.12-P7.14 permit them.
  const named = `${report.original ?? "an unidentified Original"} at ${report.checkpoint ?? "an unidentified checkpoint"}`;
  if (report.carrierStatus !== "found" || report.bytes === "mismatch") {
    const why =
      report.carrierStatus === "stray" ? "the log is not where section 14 defines a carrier"
      : report.carrierStatus === "mismatch" ? "its carrier is not the one that version's media type requires"
      : "the bytes without the carrier do not match that entry's descriptor";
    report.statements.push(`This file carries the log of ${named}, but it is not a version of that Original: ${why}.`);
  }
  if (report.proofs === "unchecked") {
    if (report.chain.status === "chains-from-genesis") {
      report.statements.push(
        `Unverified: the entries chain from the genesis that ${report.original} binds${report.bytes === "match" ? ", and the remaining bytes match the last entry's descriptor" : ""}. Anyone can arrange this without a key; the signatures stay unchecked until the signers' DIDs are resolved.`,
      );
    } else report.statements.push("Unverified: the entries do not chain from a genesis, and the signatures are unchecked.");
  } else if (report.verified.version) {
    report.statements.push(`Verified: this file is the version ${named} names, valid as of that checkpoint${report.current ? ", and current on its anchor" : ", never current"}.`);
  } else if (report.verified.log) {
    report.statements.push(`The carried log of ${named} verifies, valid as of that checkpoint${report.current ? "" : ", never current"}.`);
  }
  if (report.anchoring.status === "evm-unread") {
    report.statements.push(
      `This Original is anchored on ${report.anchoring.chain}, which this reader did not read: evidence is missing. At most the entries before the anchoring entry are reported; the anchoring entry and every later entry are not checked against the anchor.`,
    );
  }
  if (report.anchoring.status === "bitcoin-unread") {
    report.statements.push(
      `This Original is anchored on Bitcoin (${report.anchoring.sat ?? "unknown sat"}), which this reader did not read: evidence is missing. At most the entries before the anchoring entry are reported, valid as of the checkpoint before it with claimed ordering; the anchoring entry and every later entry are not checked against the anchor.`,
    );
  }
  report.statements.push("A carried file is not an evidence package and makes no claim to be complete.");
  return report;
}
