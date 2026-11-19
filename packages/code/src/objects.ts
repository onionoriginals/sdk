/**
 * Content-addressed objects of `originals-code/0.1` (plan 049 §1.1).
 *
 * PROVISIONAL (K2): a blob is a file's exact bytes; a tree is one directory,
 * the JCS bytes of `{ entries: { <name>: { mode, digest } }, format }`, with
 * git's raw tree modes, so a verifier holding the objects can recompute git's
 * tree SHA-1. Digests are the Originals resource digest, a sha2-256 multihash
 * in base58btc multibase, over the exact bytes (P4.3, P14.7).
 */
import { sha1 } from "@noble/hashes/legacy.js";
import { canonicalize, isJsonObject, parseJson } from "@originals/vh/json";
import { checkDigest, resourceDigest, resourceDigestAsync } from "@originals/vh/originals";
import { codeError } from "./errors.js";

/** PROVISIONAL (K2): the tree object format. */
export const TREE_FORMAT = "originals-code-tree/0.1";
/** PROVISIONAL (K3): the media type of a root tree, a branch Original's resource. RFC 6838, no parameters. */
export const TREE_MEDIA_TYPE = "application/vnd.originals.code-tree+json";

/** git's raw tree modes for a file, an executable, a symlink and a directory. Gitlinks are refused (K9). */
export type Mode = "100644" | "100755" | "120000" | "40000";
const MODES = new Set<string>(["100644", "100755", "120000", "40000"]);
const MAX_NAME_BYTES = 255;

export interface TreeEntry {
  mode: Mode;
  digest: string;
}

export interface Tree {
  entries: Record<string, TreeEntry>;
}

/** Where object bytes come from: undefined when they are not held. */
export type ObjectSource = (digest: string) => Promise<Uint8Array | undefined> | Uint8Array | undefined;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** The digest of an object's exact bytes (P4.3). */
export const objectDigest = resourceDigest;
export const objectDigestAsync = resourceDigestAsync;

/** PROVISIONAL (K2): a name is one path segment that git can check out safely. */
export function checkName(name: string): void {
  const bad = (why: string) => codeError("invalid-evidence", "TREE_NAME", `tree entry name ${JSON.stringify(name)} ${why}`);
  if (name.length === 0) bad("is empty");
  if (name === "." || name === "..") bad("is a relative segment");
  if (name.includes("/") || name.includes("\u0000")) bad("contains '/' or NUL");
  if (name.toLowerCase() === ".git") bad("is .git");
  if (encoder.encode(name).length > MAX_NAME_BYTES) bad(`is over ${MAX_NAME_BYTES} UTF-8 bytes`);
}

function checkEntry(name: string, value: unknown): TreeEntry {
  checkName(name);
  if (!isJsonObject(value) || Object.keys(value).length !== 2 || !("mode" in value) || !("digest" in value)) {
    codeError("invalid-evidence", "TREE_MEMBERS", `tree entry ${JSON.stringify(name)} is exactly { mode, digest }`);
  }
  const { mode, digest } = value as { mode: unknown; digest: unknown };
  if (mode === "160000") codeError("unsupported-profile", "GITLINK_UNSUPPORTED", `tree entry ${JSON.stringify(name)} is a gitlink (submodule), which originals-code/0.1 does not mirror (PROVISIONAL, K9)`);
  if (typeof mode !== "string" || !MODES.has(mode)) codeError("invalid-evidence", "TREE_MODE", `tree entry ${JSON.stringify(name)} has mode ${JSON.stringify(mode)}; allowed: 100644, 100755, 120000, 40000`);
  return { mode: mode as Mode, digest: checkDigest(digest, `tree entry ${name}`) };
}

function checkTree(value: unknown): Tree {
  if (!isJsonObject(value) || Object.keys(value).length !== 2 || !("entries" in value) || !("format" in value)) {
    codeError("invalid-evidence", "TREE_MEMBERS", "a tree is exactly { entries, format }");
  }
  if (value.format !== TREE_FORMAT) codeError("unsupported-profile", "TREE_FORMAT", `unsupported tree format ${JSON.stringify(value.format)}`);
  if (!isJsonObject(value.entries)) codeError("invalid-evidence", "TREE_MEMBERS", "tree entries must be an object");
  const entries: Record<string, TreeEntry> = {};
  for (const [name, entry] of Object.entries(value.entries)) entries[name] = checkEntry(name, entry);
  return { entries };
}

/** The canonical bytes of a tree: JCS (RFC 8785). */
export function encodeTree(tree: Tree): Uint8Array {
  const checked = checkTree({ entries: tree.entries, format: TREE_FORMAT });
  return encoder.encode(canonicalize({ entries: checked.entries as never, format: TREE_FORMAT }));
}

/** Parse a tree, refusing any bytes that are not exactly its JCS form (one encoding per tree). */
export function decodeTree(bytes: Uint8Array): Tree {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return codeError("invalid-evidence", "TREE_ENCODING", "a tree is UTF-8 JSON");
  }
  const tree = checkTree(parseJson(text));
  if (canonicalize({ entries: tree.entries as never, format: TREE_FORMAT }) !== text) {
    codeError("invalid-evidence", "TREE_NOT_CANONICAL", "a tree's bytes must be the JCS form of its content");
  }
  return tree;
}

/** Something that can hold objects: see `ObjectStore`. */
interface Puttable {
  put(digest: string, bytes: Uint8Array): Promise<void>;
}

/** Encode a tree, store it and return its digest. */
export async function putTree(store: Puttable, tree: Tree): Promise<string> {
  const bytes = encodeTree(tree);
  const digest = await objectDigestAsync(bytes);
  await store.put(digest, bytes);
  return digest;
}

async function required(get: ObjectSource, digest: string, what: string): Promise<Uint8Array> {
  const bytes = await get(digest);
  if (!bytes) return codeError("unavailable-bytes", "OBJECT_MISSING", `${what} ${digest} is not held`, { digest });
  return bytes;
}

/** Read and decode a tree by digest; a missing tree is `unavailable-bytes` (OBJECT_MISSING). */
export async function readTree(digest: string, get: ObjectSource): Promise<Tree> {
  return decodeTree(await required(get, digest, "tree"));
}

const join = (prefix: string, name: string) => (prefix ? `${prefix}/${name}` : name);

/** The flat view of a tree: `path → { mode, digest }` for every file, in path order (code unit order). */
export async function flattenTree(root: string, get: ObjectSource): Promise<Map<string, TreeEntry>> {
  const out = new Map<string, TreeEntry>();
  async function walk(digest: string, prefix: string): Promise<void> {
    const tree = await readTree(digest, get);
    for (const name of Object.keys(tree.entries).sort()) {
      const entry = tree.entries[name];
      if (entry.mode === "40000") await walk(entry.digest, join(prefix, name));
      else out.set(join(prefix, name), entry);
    }
  }
  await walk(root, "");
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The file paths a change from `before` to `after` touches: added, removed,
 * or with new content or mode. A file replaced by a directory touches both.
 * Unchanged subtrees are skipped by digest and never read. `before` null is
 * the empty tree (a branch's genesis).
 */
export async function diffTrees(before: string | null, after: string, get: ObjectSource): Promise<string[]> {
  const touched = new Set<string>();
  async function all(entry: TreeEntry, path: string): Promise<void> {
    if (entry.mode !== "40000") {
      touched.add(path);
      return;
    }
    const tree = await readTree(entry.digest, get);
    for (const [name, child] of Object.entries(tree.entries)) await all(child, join(path, name));
  }
  async function walk(a: string | null, b: string | null, prefix: string): Promise<void> {
    if (a === b) return;
    const ta = a ? (await readTree(a, get)).entries : {};
    const tb = b ? (await readTree(b, get)).entries : {};
    for (const name of new Set([...Object.keys(ta), ...Object.keys(tb)])) {
      const ea = ta[name];
      const eb = tb[name];
      const path = join(prefix, name);
      if (ea && eb && ea.mode === eb.mode && ea.digest === eb.digest) continue;
      if (ea?.mode === "40000" && eb?.mode === "40000") {
        await walk(ea.digest, eb.digest, path);
        continue;
      }
      if (ea) await all(ea, path);
      if (eb) await all(eb, path);
    }
  }
  await walk(before, after, "");
  return [...touched].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}

const hexOf = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** git's blob object id (SHA-1 of `blob <size>\0<bytes>`). */
export function gitBlobId(bytes: Uint8Array): string {
  return hexOf(sha1(concat([encoder.encode(`blob ${bytes.length}\u0000`), bytes])));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * git's tree object id for the tree `digest`, recomputed from the objects:
 * entries in git's order (bytes, a directory compared as if its name ended in
 * '/'). `memo` maps `t:<digest>` (a tree) and `b:<digest>` (a blob) to git
 * ids across calls, so each object is hashed once; the same bytes as a blob
 * and as a tree have different git ids. Throws OBJECT_MISSING when an object
 * is not held.
 */
export async function gitTreeIdOf(digest: string, get: ObjectSource, memo: Map<string, string> = new Map()): Promise<string> {
  const known = memo.get(`t:${digest}`);
  if (known) return known;
  const tree = await readTree(digest, get);
  const rows: Array<{ key: Uint8Array; line: Uint8Array }> = [];
  for (const [name, entry] of Object.entries(tree.entries)) {
    let id: string;
    if (entry.mode === "40000") id = await gitTreeIdOf(entry.digest, get, memo);
    else {
      id = memo.get(`b:${entry.digest}`) ?? gitBlobId(await required(get, entry.digest, "blob"));
      memo.set(`b:${entry.digest}`, id);
    }
    const nameBytes = encoder.encode(name);
    const key = entry.mode === "40000" ? concat([nameBytes, encoder.encode("/")]) : nameBytes;
    const idBytes = Uint8Array.from(id.match(/../g)!.map((h) => parseInt(h, 16)));
    rows.push({ key, line: concat([encoder.encode(`${entry.mode} `), nameBytes, new Uint8Array([0]), idBytes]) });
  }
  rows.sort((a, b) => compareBytes(a.key, b.key));
  const body = concat(rows.map((r) => r.line));
  const id = hexOf(sha1(concat([encoder.encode(`tree ${body.length}\u0000`), body])));
  memo.set(`t:${digest}`, id);
  return id;
}

/** git's commit object id: SHA-1 of `commit <size>\0<bytes>` (plan 049 O3, K12). */
export function gitCommitId(bytes: Uint8Array): string {
  return hexOf(sha1(concat([encoder.encode(`commit ${bytes.length}\u0000`), bytes])));
}

/** The members of a raw git commit object the code profile checks (K12). */
export interface GitCommitHeader {
  tree: string;
  /** Parent commit ids in order; the first is the first parent. */
  parents: string[];
}

/**
 * Parse the header of a raw git commit object: a first line `tree <hex>`,
 * then zero or more `parent <hex>` lines. The rest (author, committer,
 * signatures, message) is kept verbatim in the object and never interpreted.
 * Throws GIT_COMMIT_PARSE for anything else.
 */
export function parseGitCommit(bytes: Uint8Array): GitCommitHeader {
  // Header lines up to the blank line are ASCII in their tree and parent members; latin1 keeps byte offsets.
  let end = bytes.indexOf(10);
  let at = 0;
  const line = () => {
    if (end < 0) return codeError("invalid-evidence", "GIT_COMMIT_PARSE", "a git commit object's header ends with a newline");
    const text = Array.from(bytes.subarray(at, end), (b) => String.fromCharCode(b)).join("");
    at = end + 1;
    end = bytes.indexOf(10, at);
    return text;
  };
  const tree = /^tree ([0-9a-f]{40})$/.exec(line())?.[1];
  if (!tree) return codeError("invalid-evidence", "GIT_COMMIT_PARSE", "a git commit object starts with `tree <40 hex>`");
  const parents: string[] = [];
  for (;;) {
    if (end < 0) break;
    const save = { at, end };
    const p = /^parent ([0-9a-f]{40})$/.exec(line())?.[1];
    if (!p) {
      ({ at, end } = save);
      break;
    }
    parents.push(p);
  }
  return { tree, parents };
}
