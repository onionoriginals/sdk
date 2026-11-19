/**
 * Scoped grants (P5.28, P5.29, P14.23; originals-spec #66, owner decision of
 * 19 November 2026). A grant's optional `scope` narrows what `resource: true`
 * allows. Its `type` names a scope type, which defines its other members, the
 * resources it applies to and how it is checked. This profile defines two:
 *
 * - `paths`: every path a change touches in a media type's *path view* (a map
 *   from path to a digest of everything the media type records for it, such
 *   as content and file mode) matches one of the scope's patterns.
 * - `items`: every change in a media type's *item view* (a map from item id
 *   to digest) is an add, edit or remove the scope lists.
 *
 * A media type defines its view in its own specification; this profile
 * defines none. A verifier checks a scope only for the media types whose view
 * it implements, registered here (`ScopeViews`). A view may need objects the
 * version references, beyond its own bytes (`ObjectLookup`); when one is not
 * held, or the type or view is unknown, the scope is *unchecked*: never a
 * pass, never a rejection (P5.28).
 *
 * Browser-safe: no Node APIs.
 */
import { fail } from "../errors.js";
import { canonicalize, isJsonObject, parseJson, type JsonObject, type JsonValue } from "../json/index.js";
import { checkDigest, resourceDigest } from "./state.js";

/** A grant's scope (P14.5): an object with a string `type` and the members its type defines. */
export type GrantScope = JsonObject & { type: string };

/** Patterns in a `paths` scope (P14.13, P14.23; provisional). */
export const MAX_SCOPE_PATTERNS = 64;
export const ITEM_OPS = ["add", "edit", "remove"] as const;
export type ItemOp = (typeof ITEM_OPS)[number];

function invalid(code: string, message: string): never {
  return fail("invalid-evidence", code, message);
}

const byCodeUnits = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * P14.23: a `paths` pattern. One or more `/`-separated segments, none empty,
 * none `.` or `..`, no leading or trailing `/`. A segment is `**`, or a run of
 * characters other than `/` in which `*` matches any run of characters,
 * possibly empty, other than `/`; a segment other than `**` never contains
 * `**`. `?`, `[` and `\` are literal.
 */
export function checkPathPattern(pattern: unknown): string {
  if (typeof pattern !== "string" || pattern.length === 0) invalid("SCOPE_PATTERN", `path pattern ${JSON.stringify(pattern)} is not a non-empty string (P14.23)`);
  for (const segment of pattern.split("/")) {
    if (segment === "") invalid("SCOPE_PATTERN", `path pattern ${JSON.stringify(pattern)} has an empty segment: a leading, trailing or doubled '/' (P14.23)`);
    if (segment === "." || segment === "..") invalid("SCOPE_PATTERN", `path pattern ${JSON.stringify(pattern)} has a '.' or '..' segment (P14.23)`);
    if (segment !== "**" && segment.includes("**")) invalid("SCOPE_PATTERN", `path pattern ${JSON.stringify(pattern)} uses '**' inside a segment; '**' is a whole segment (P14.23)`);
  }
  return pattern;
}

function segmentMatches(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  const parts = pattern.split("*");
  if (!name.startsWith(parts[0])) return false;
  let at = parts[0].length;
  for (let i = 1; i < parts.length - 1; i++) {
    const found = name.indexOf(parts[i], at);
    if (found < 0) return false;
    at = found + parts[i].length;
  }
  const last = parts[parts.length - 1];
  return name.length - at >= last.length && name.endsWith(last);
}

function matchFrom(p: string[], i: number, s: string[], j: number): boolean {
  if (i === p.length) return j === s.length;
  if (p[i] === "**") {
    // A `**` matches zero or more whole segments, except that a final `/**` matches one or more.
    const least = i === p.length - 1 && i > 0 ? j + 1 : j;
    for (let k = least; k <= s.length; k++) if (matchFrom(p, i + 1, s, k)) return true;
    return false;
  }
  return j < s.length && segmentMatches(p[i], s[j]) && matchFrom(p, i + 1, s, j + 1);
}

/** P14.23: whether `pattern` matches all of `path`, comparing code units exactly. */
export function matchPathPattern(pattern: string, path: string): boolean {
  checkPathPattern(pattern);
  return matchFrom(pattern.split("/"), 0, path.split("/"), 0);
}

/** The paths no pattern matches, in the order given; empty when every one is matched (P5.29). */
export function pathsOutside(patterns: readonly string[], paths: readonly string[]): string[] {
  return paths.filter((path) => !patterns.some((p) => matchPathPattern(p, path)));
}

function sortedUnique(list: readonly string[], what: string): void {
  for (let i = 1; i < list.length; i++) {
    if (!(list[i - 1] < list[i])) invalid("SCOPE_MEMBERS", `${what} are sorted in UTF-16 code unit order, with none twice (P14.23)`);
  }
}

/**
 * P5.28, P14.5, P14.23: a grant's `scope`. An object with a string `type`; a
 * `paths` or `items` scope has exactly its members, which follow P14.23; a
 * scope of another type is not rejected, and its members are not checked
 * here beyond being JSON (P14.3).
 */
export function checkScope(value: unknown): GrantScope {
  if (!isJsonObject(value) || typeof value.type !== "string") invalid("SCOPE_MEMBERS", "a scope is an object with a string `type` (P5.28, P14.5)");
  const exactly = (keys: string[]) => {
    const own = Object.keys(value).sort(byCodeUnits);
    if (own.length !== keys.length || !keys.every((k, i) => own[i] === k)) invalid("SCOPE_MEMBERS", `a ${JSON.stringify(value.type)} scope is exactly {${keys.join(", ")}} (P14.23)`);
  };
  if (value.type === "paths") {
    exactly(["paths", "type"]);
    const paths = value.paths;
    if (!Array.isArray(paths) || paths.length === 0) invalid("SCOPE_MEMBERS", "a paths scope lists 1 or more patterns (P14.23)");
    if (paths.length > MAX_SCOPE_PATTERNS) fail("limit-exceeded", "SCOPE_TOO_MANY_PATTERNS", `a paths scope lists at most ${MAX_SCOPE_PATTERNS} patterns (P14.13, P14.23)`);
    for (const p of paths) checkPathPattern(p);
    sortedUnique(paths as string[], "a paths scope's patterns");
  } else if (value.type === "items") {
    exactly(["ops", "type"]);
    const ops = value.ops;
    if (!Array.isArray(ops) || ops.length === 0 || ops.length > ITEM_OPS.length) invalid("SCOPE_MEMBERS", "an items scope lists 1 to 3 operations (P14.23)");
    for (const op of ops) if (!ITEM_OPS.includes(op as ItemOp)) invalid("SCOPE_MEMBERS", `${JSON.stringify(op)} is not an items operation: add, edit or remove (P14.23)`);
    sortedUnique(ops as string[], "an items scope's operations");
  }
  return value as GrantScope;
}

// ---------------------------------------------------------------------------- views

/** Where the bytes of a referenced object come from, by digest; undefined when not held. */
export type ObjectLookup = (digest: string) => Uint8Array | undefined;

/**
 * What a view of one version is: its map, or the digests of the referenced
 * objects it needs and the lookup does not hold, or why the bytes are not a
 * version of the media type.
 */
export type ViewResult =
  | { kind: "view"; entries: ReadonlyMap<string, string>; read: string[] }
  | { kind: "missing"; digests: string[]; read: string[] }
  | { kind: "invalid"; message: string };

/**
 * A media type whose path view or item view this verifier implements
 * (P5.29). `view` maps a version's bytes, with the objects it references, to
 * path → digest or item id → digest. A view needing objects beyond the
 * version reads them through `objects`, lists those it read in `read`, and
 * reports the ones not held as `missing` rather than guessing.
 */
export interface MediaTypeView {
  mediaType: string;
  view(version: Uint8Array, objects: ObjectLookup): ViewResult;
  /**
   * Optional: the keys a change touches, reading only what differs (for
   * example unchanged subtrees skipped by digest). Without it the two views
   * are compared whole.
   */
  touched?(before: Uint8Array, after: Uint8Array, objects: ObjectLookup): { kind: "touched"; added: string[]; removed: string[]; changed: string[]; read: string[] } | Exclude<ViewResult, { kind: "view" }>;
}

/** The views a verifier implements, by scope type and media type. */
export interface ScopeViews {
  paths?: readonly MediaTypeView[];
  items?: readonly MediaTypeView[];
}

/** What checking one scope found (P5.28). */
export type ScopeCheck =
  | { status: "checked"; type: string; read: string[] }
  | { status: "outside"; type: string; outside: string[]; read: string[] }
  | { status: "unchecked"; type: string; reason: "unknown-type" | "no-view" | "missing-bytes" | "invalid-version"; missing?: string[]; read: string[]; message: string };

const encoder = new TextEncoder();

function diffViews(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): { added: string[]; removed: string[]; changed: string[] } {
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const changed = [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k));
  return { added, removed, changed };
}

/**
 * P5.28, P5.29: check the change from `before` to `after` (two versions of
 * the Original's one resource, by descriptor) against `scope`. Unknown types,
 * media types with no view here (both versions need one), and missing bytes
 * are unchecked; a change outside the scope lists what is outside.
 */
export function checkScopeChange(
  scope: GrantScope,
  before: { mediaType: string; digest: string },
  after: { mediaType: string; digest: string },
  lookup: ObjectLookup,
  views: ScopeViews,
): ScopeCheck {
  const type = scope.type;
  if (type !== "paths" && type !== "items") return { status: "unchecked", type, reason: "unknown-type", read: [], message: `scope type ${JSON.stringify(type)} is not one this verifier knows (P5.28)` };
  const list = (type === "paths" ? views.paths : views.items) ?? [];
  const a = list.find((v) => v.mediaType === before.mediaType);
  const b = list.find((v) => v.mediaType === after.mediaType);
  if (!a || !b) {
    const which = !a ? before.mediaType : after.mediaType;
    return { status: "unchecked", type, reason: "no-view", read: [], message: `this verifier has no ${type === "paths" ? "path" : "item"} view of ${which} (P5.28, P5.29)` };
  }
  const read = new Set<string>();
  const missing = new Set<string>();
  const bytesOf = (digest: string) => {
    read.add(digest);
    const got = lookup(digest);
    if (!got) missing.add(digest);
    return got;
  };
  const beforeBytes = bytesOf(before.digest);
  const afterBytes = bytesOf(after.digest);
  if (!beforeBytes || !afterBytes) {
    return { status: "unchecked", type, reason: "missing-bytes", missing: [...missing], read: [...read], message: `the bytes of ${[...missing].join(", ")} are not held (P5.28)` };
  }
  let added: string[];
  let removed: string[];
  let changed: string[];
  const objects: ObjectLookup = (d) => {
    read.add(d);
    return lookup(d);
  };
  const failed = (r: Exclude<ViewResult, { kind: "view" }>): ScopeCheck => {
    for (const d of r.kind === "missing" ? r.read : []) read.add(d);
    return r.kind === "missing"
      ? { status: "unchecked", type, reason: "missing-bytes", missing: r.digests, read: [...read], message: `objects ${r.digests.join(", ")} that the check needs are not held (P5.28)` }
      : { status: "unchecked", type, reason: "invalid-version", read: [...read], message: r.message };
  };
  if (a === b && a.touched) {
    const t = a.touched(beforeBytes, afterBytes, objects);
    if (t.kind !== "touched") return failed(t);
    ({ added, removed, changed } = t);
  } else {
    const va = a.view(beforeBytes, objects);
    if (va.kind !== "view") return failed(va);
    const vb = b.view(afterBytes, objects);
    if (vb.kind !== "view") return failed(vb);
    ({ added, removed, changed } = diffViews(va.entries, vb.entries));
  }
  if (type === "paths") {
    const touched = [...new Set([...added, ...removed, ...changed])].sort(byCodeUnits);
    const outside = pathsOutside(scope.paths as string[], touched);
    return outside.length > 0 ? { status: "outside", type, outside, read: [...read] } : { status: "checked", type, read: [...read] };
  }
  const ops = scope.ops as ItemOp[];
  const outside = [
    ...(ops.includes("add") ? [] : added.map((id) => `add ${id}`)),
    ...(ops.includes("edit") ? [] : changed.map((id) => `edit ${id}`)),
    ...(ops.includes("remove") ? [] : removed.map((id) => `remove ${id}`)),
  ];
  return outside.length > 0 ? { status: "outside", type, outside, read: [...read] } : { status: "checked", type, read: [...read] };
}

// ---------------------------------------------------------------------------- the code tree path view

/** PROVISIONAL (plan 049 K2, K3): the media type of an Originals code tree, a branch's resource. */
export const CODE_TREE_MEDIA_TYPE = "application/vnd.originals.code-tree+json";
/** PROVISIONAL (plan 049 K2): the tree object format. */
export const CODE_TREE_FORMAT = "originals-code-tree/0.1";
/** git's raw tree modes a code tree records: a file, an executable, a symlink and a directory. */
export const CODE_TREE_MODES = ["100644", "100755", "120000", "40000"] as const;
export type CodeTreeMode = (typeof CODE_TREE_MODES)[number];
export interface CodeTreeEntry {
  mode: CodeTreeMode;
  digest: string;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Parse one tree object of a code tree (PROVISIONAL, plan 049 K2): exactly
 * the JCS bytes of `{entries: {<name>: {mode, digest}}, format}`. Throws an
 * `OriginalsError` for anything else. Names are checked as path segments
 * here; `@originals/code` adds its own checkout rules.
 */
export function decodeCodeTree(bytes: Uint8Array): Record<string, CodeTreeEntry> {
  let value: JsonValue;
  let text: string;
  try {
    text = utf8.decode(bytes);
    value = parseJson(text);
  } catch {
    return invalid("TREE_ENCODING", "a code tree is UTF-8 JSON");
  }
  if (!isJsonObject(value) || Object.keys(value).length !== 2 || !isJsonObject(value.entries) || value.format !== CODE_TREE_FORMAT) {
    invalid("TREE_MEMBERS", `a code tree is exactly {entries, format: ${CODE_TREE_FORMAT}}`);
  }
  const entries: Record<string, CodeTreeEntry> = {};
  for (const [name, e] of Object.entries(value.entries)) {
    if (name === "" || name === "." || name === ".." || name.includes("/")) invalid("TREE_NAME", `tree entry name ${JSON.stringify(name)} is not one path segment`);
    if (!isJsonObject(e) || Object.keys(e).length !== 2 || typeof e.mode !== "string" || !CODE_TREE_MODES.includes(e.mode as CodeTreeMode)) {
      invalid("TREE_MEMBERS", `tree entry ${JSON.stringify(name)} is exactly {mode, digest}, mode one of ${CODE_TREE_MODES.join(", ")}`);
    }
    entries[name] = { mode: e.mode as CodeTreeMode, digest: checkDigest(e.digest, `tree entry ${name}`) };
  }
  if (canonicalize(value) !== text) invalid("TREE_NOT_CANONICAL", "a code tree's bytes are the JCS form of its content");
  return entries;
}

/** The path view digest of a code tree file: what the tree records for it, its mode and its content digest (P5.29). */
export function codeTreePathDigest(entry: CodeTreeEntry): string {
  return resourceDigest(encoder.encode(canonicalize({ digest: entry.digest, mode: entry.mode })));
}

const joinPath = (prefix: string, name: string) => (prefix ? `${prefix}/${name}` : name);

/**
 * The code tree's path view (P5.29; PROVISIONAL with the media type): every
 * file under the root tree, through its subtrees, with the digest of its mode
 * and content. Subtrees are objects the root references; blobs are not read.
 */
export const codeTreePathView: MediaTypeView = {
  mediaType: CODE_TREE_MEDIA_TYPE,
  view(version, objects) {
    const out = new Map<string, string>();
    const missing: string[] = [];
    const read: string[] = [];
    try {
      const walk = (entries: Record<string, CodeTreeEntry>, prefix: string) => {
        for (const [name, e] of Object.entries(entries)) {
          const path = joinPath(prefix, name);
          if (e.mode !== "40000") {
            out.set(path, codeTreePathDigest(e));
            continue;
          }
          read.push(e.digest);
          const sub = objects(e.digest);
          if (!sub) missing.push(e.digest);
          else walk(decodeCodeTree(sub), path);
        }
      };
      walk(decodeCodeTree(version), "");
    } catch (error) {
      return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
    }
    return missing.length > 0 ? { kind: "missing", digests: missing, read } : { kind: "view", entries: out, read };
  },
  touched(before, after, objects) {
    const added = new Set<string>();
    const removed = new Set<string>();
    const changed = new Set<string>();
    const missing: string[] = [];
    const read: string[] = [];
    const tree = (digest: string): Record<string, CodeTreeEntry> | undefined => {
      read.push(digest);
      const bytes = objects(digest);
      if (!bytes) missing.push(digest);
      return bytes ? decodeCodeTree(bytes) : undefined;
    };
    /** Every file under `entry`, at `path`: a file itself, or all a directory holds. */
    const all = (entry: CodeTreeEntry, path: string, into: Set<string>) => {
      if (entry.mode !== "40000") return void into.add(path);
      const t = tree(entry.digest);
      if (t) for (const [name, child] of Object.entries(t)) all(child, joinPath(path, name), into);
    };
    const walk = (a: Record<string, CodeTreeEntry>, b: Record<string, CodeTreeEntry>, prefix: string) => {
      for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const ea = a[name];
        const eb = b[name];
        const path = joinPath(prefix, name);
        if (ea && eb && ea.mode === eb.mode && ea.digest === eb.digest) continue;
        if (ea?.mode === "40000" && eb?.mode === "40000") {
          const ta = tree(ea.digest);
          const tb = tree(eb.digest);
          if (ta && tb) walk(ta, tb, path);
          continue;
        }
        if (ea && eb && ea.mode !== "40000" && eb.mode !== "40000") {
          changed.add(path);
          continue;
        }
        if (ea) all(ea, path, removed);
        if (eb) all(eb, path, added);
      }
    };
    try {
      walk(decodeCodeTree(before), decodeCodeTree(after), "");
    } catch (error) {
      return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
    }
    if (missing.length > 0) return { kind: "missing", digests: [...new Set(missing)], read };
    return { kind: "touched", added: [...added], removed: [...removed], changed: [...changed], read };
  },
};

// ---------------------------------------------------------------------------- a reference item view

/**
 * PROVISIONAL (plan 050 W3): the media type of the reference item list, a
 * JSON object `{items: {<id>: <any JSON>}}` in its JCS form. Its item view
 * maps each id to the digest of the JCS bytes of its value. A list media type
 * such as Boop's defines its own item view and registers it in `ScopeViews`.
 */
export const ITEM_LIST_MEDIA_TYPE = "application/vnd.originals.items+json";

export const itemListView: MediaTypeView = {
  mediaType: ITEM_LIST_MEDIA_TYPE,
  view(version) {
    try {
      const value = parseJson(utf8.decode(version));
      if (!isJsonObject(value) || Object.keys(value).length !== 1 || !isJsonObject(value.items)) return { kind: "invalid", message: "an item list is exactly {items: {<id>: <value>}}" };
      const entries = new Map(Object.entries(value.items).map(([id, item]) => [id, resourceDigest(encoder.encode(canonicalize(item)))]));
      return { kind: "view", entries, read: [] };
    } catch (error) {
      return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
    }
  },
};

/** The views this package implements: the code tree's path view and the reference item list's item view. */
export const DEFAULT_SCOPE_VIEWS: ScopeViews = Object.freeze({ paths: [codeTreePathView], items: [itemListView] });
