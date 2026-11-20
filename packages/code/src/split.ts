/**
 * The split bundle (plan 049 §6 milestone 1; PROVISIONAL K19): the same
 * evidence as the zip bundle, laid out as static files so a reader can verify
 * the logs first and fetch file contents by digest only when they are opened.
 *
 *   originals-code.json     the manifest, exactly as in the zip bundle
 *   originals/<scid>.zip    each Original's evidence package, as in the zip bundle
 *   objects/index.json      the pack's index, [[digest, offset, length, size], …]
 *   objects/pack            every tree and commit object (K12), deflate-raw compressed, concatenated
 *   objects/loose.json      [[digest, length, size], …] sorted: every other object
 *   objects/<digest>        one such object, deflate-raw compressed
 *
 * Trees and commit objects load with the logs: the code checks need the
 * trees (path grants diff them, K7), and the commit objects (K12) are small
 * and carry what the commits pages show. Blobs are loose. Every file is untrusted: the reader bounds
 * the indexes before using them, inflates each object to at most its declared
 * size and checks its digest on arrival (P4.3). An object not yet fetched is
 * reported "not loaded" and counts as missing in the content report: it is
 * never verified, and never a pass (section 7).
 */
import { parseJson } from "@originals/vh/json";
import { parseLog, type LogEntry } from "@originals/vh/log";
import { readEvidence } from "@originals/sdk/originals";
import { deflateSync } from "fflate";
import {
  BUNDLE_LIMITS,
  BUNDLE_MANIFEST,
  inflateObject,
  isObjectDigest,
  parseBundleManifest,
  readBundle,
  readObjectPack,
  writeObjectPack,
  type BundleLimits,
  type BundleManifest,
} from "./bundle.js";
import { codeError } from "./errors.js";
import { decodeTree } from "./objects.js";
import { openEvidence, type OpenedRepository, type RepositoryReport, type VerifyRepositoryOptions } from "./verify.js";

export const SPLIT_TREE_INDEX = "objects/index.json";
export const SPLIT_TREE_PACK = "objects/pack";
export const SPLIT_LOOSE_INDEX = "objects/loose.json";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** The path of a loose object in the split layout. */
export const looseObjectPath = (digest: string) => `objects/${digest}`;

function bad(code: string, message: string): never {
  return codeError("invalid-evidence", code, message);
}

/**
 * The split layout of a zip bundle, as relative paths and bytes. The bundle
 * is read (and every object checked) first; a bundle with an object that
 * fails its digest is refused rather than republished.
 */
export async function splitBundle(zip: Uint8Array, limits: BundleLimits = {}): Promise<Map<string, Uint8Array>> {
  const contents = await readBundle(zip, limits);
  if (contents.failed.size > 0) bad("SPLIT_FAILED_OBJECT", `${contents.failed.size} object(s) in the bundle fail their digest; nothing is split`);
  // Trees: everything reachable as a directory from a root tree an evidence package carries.
  const resources = new Map<string, Uint8Array>();
  for (const p of contents.packages) for (const [d, b] of Object.entries(readEvidence(p.bytes).bytes)) resources.set(d, b);
  const trees = new Set<string>();
  const walk = (digest: string, bytes: Uint8Array | undefined) => {
    if (!bytes || trees.has(digest)) return;
    let entries;
    try {
      entries = decodeTree(bytes).entries;
    } catch {
      return; // a repo document, not a tree; a broken subtree stays loose, and the verifier reports it
    }
    trees.add(digest);
    for (const e of Object.values(entries)) if (e.mode === "40000") walk(e.digest, contents.objects.get(e.digest) ?? resources.get(e.digest));
  };
  for (const [d, b] of resources) walk(d, b);
  // Commit objects (K12): named by each entry's metadata.
  for (const p of contents.packages) {
    for (const e of parseLog(readEvidence(p.bytes).log) as unknown as LogEntry[]) {
      const code = (e.state as { asset?: { metadata?: { code?: { commitObject?: unknown } } } }).asset?.metadata?.code;
      if (typeof code?.commitObject === "string" && contents.objects.has(code.commitObject)) trees.add(code.commitObject);
    }
  }

  const files = new Map<string, Uint8Array>();
  files.set(BUNDLE_MANIFEST, encoder.encode(`${JSON.stringify(contents.manifest, null, 2)}\n`));
  for (const p of contents.packages) files.set(p.file, p.bytes);
  const packed = new Map<string, Uint8Array>();
  const loose: Array<[string, number, number]> = [];
  for (const d of [...contents.objects.keys()].sort()) {
    const raw = contents.objects.get(d)!;
    if (trees.has(d)) {
      packed.set(d, raw);
      continue;
    }
    const z = deflateSync(raw, { level: 6 });
    loose.push([d, z.length, raw.length]);
    files.set(looseObjectPath(d), z);
  }
  const { index, pack } = writeObjectPack(packed);
  files.set(SPLIT_TREE_INDEX, encoder.encode(JSON.stringify(index)));
  files.set(SPLIT_TREE_PACK, pack);
  files.set(SPLIT_LOOSE_INDEX, encoder.encode(JSON.stringify(loose)));
  return files;
}

/** Reads one file of a split bundle by its relative path; undefined when it is absent (404). */
export type SplitFetch = (path: string) => Promise<Uint8Array | undefined>;

/** Where an object stands in a split bundle the reader has opened. */
export type SplitObjectStatus = "tree" | "loaded" | "not-loaded" | "failed" | "absent";

/** An object the bundle lists that could not be loaded or did not match its digest. It is never used. */
export class ObjectNotLoadedError extends Error {
  readonly code = "OBJECT_NOT_LOADED";
  constructor(
    readonly digest: string,
    readonly reason: string,
  ) {
    super(`object ${digest} was not loaded: ${reason}. It is not verified.`);
  }
}

/**
 * The objects of a split bundle: trees (loaded with the logs) and loose
 * objects, fetched one by one and checked against their digest on arrival.
 */
export class SplitObjects {
  private readonly loaded = new Map<string, Uint8Array>();
  private readonly failures = new Map<string, string>();
  private readonly inflight = new Map<string, Promise<Uint8Array | undefined>>();

  constructor(
    private readonly fetchFile: SplitFetch,
    readonly trees: ReadonlyMap<string, Uint8Array>,
    /** Loose objects the bundle lists: compressed length and declared size. */
    readonly loose: ReadonlyMap<string, { length: number; size: number }>,
    /** Trees in the pack that failed their digest. */
    readonly failedTrees: ReadonlySet<string>,
  ) {}

  status(digest: string): SplitObjectStatus {
    if (this.trees.has(digest)) return "tree";
    if (this.failedTrees.has(digest) || this.failures.has(digest)) return "failed";
    if (this.loaded.has(digest)) return "loaded";
    return this.loose.has(digest) ? "not-loaded" : "absent";
  }

  /** Counts for the content summary: loose objects loaded, not loaded and failed. */
  counts(): { trees: number; loose: number; loaded: number; notLoaded: number; failed: number } {
    const failed = this.failures.size;
    return { trees: this.trees.size, loose: this.loose.size, loaded: this.loaded.size, notLoaded: this.loose.size - this.loaded.size - failed, failed: failed + this.failedTrees.size };
  }

  /** Digests that failed (pack trees and loose objects), for the content report. */
  failed(): Set<string> {
    return new Set([...this.failedTrees, ...this.failures.keys()]);
  }

  /** Bytes already held and checked; never fetches. Verification uses this view. */
  peek(digest: string): Uint8Array | undefined {
    return this.trees.get(digest) ?? this.loaded.get(digest);
  }

  /**
   * The object's bytes, fetched and checked on first use. Undefined when the
   * bundle does not list it; throws `ObjectNotLoadedError` when it is listed
   * but cannot be fetched or does not match its digest.
   */
  async get(digest: string): Promise<Uint8Array | undefined> {
    const held = this.peek(digest);
    if (held) return held;
    const failure = this.failures.get(digest);
    if (failure !== undefined) throw new ObjectNotLoadedError(digest, failure);
    if (this.failedTrees.has(digest)) throw new ObjectNotLoadedError(digest, "it does not match its digest");
    const row = this.loose.get(digest);
    if (!row) return undefined;
    let pending = this.inflight.get(digest);
    if (!pending) {
      pending = this.fetchOne(digest, row).finally(() => this.inflight.delete(digest));
      this.inflight.set(digest, pending);
    }
    const bytes = await pending;
    if (!bytes) throw new ObjectNotLoadedError(digest, this.failures.get(digest) ?? "unavailable");
    return bytes;
  }

  private async fetchOne(digest: string, row: { length: number; size: number }): Promise<Uint8Array | undefined> {
    let z: Uint8Array | undefined;
    try {
      z = await this.fetchFile(looseObjectPath(digest));
    } catch (e) {
      // A network failure is not a verdict on the object: it can be retried.
      throw new ObjectNotLoadedError(digest, e instanceof Error ? e.message : String(e));
    }
    if (!z) return this.fail(digest, "the host does not serve it");
    if (z.length !== row.length) return this.fail(digest, `the host served ${z.length} bytes, the index lists ${row.length}`);
    const raw = await inflateObject(digest, z, row.size);
    if (!raw) return this.fail(digest, "it does not match its digest");
    this.loaded.set(digest, raw);
    return raw;
  }

  private fail(digest: string, reason: string): undefined {
    this.failures.set(digest, reason);
    return undefined;
  }

  /** Fetch every loose object not yet loaded, `concurrency` at a time. Failures are recorded, not thrown. */
  async loadAll(options: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {}): Promise<void> {
    const todo = [...this.loose.keys()].filter((d) => this.status(d) === "not-loaded");
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < todo.length) {
        const d = todo[next++];
        try {
          await this.get(d);
        } catch (e) {
          if (!(e instanceof ObjectNotLoadedError)) throw e;
          if (!this.failures.has(d)) this.failures.set(d, e.reason);
        }
        options.onProgress?.(++done, todo.length);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 16) }, worker));
  }
}

function parseLoose(bytes: Uint8Array, limits: BundleLimits, trees: number): Map<string, { length: number; size: number }> {
  const maxObjects = limits.maxObjects ?? BUNDLE_LIMITS.maxObjects;
  const maxObjectBytes = limits.maxObjectBytes ?? BUNDLE_LIMITS.maxObjectBytes;
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return bad("BUNDLE_ENCODING", `${SPLIT_LOOSE_INDEX} is not UTF-8`);
  }
  const rows = parseJson(text);
  if (!Array.isArray(rows)) bad("BUNDLE_INDEX", "the loose object index is an array");
  if (rows.length + trees > maxObjects) codeError("limit-exceeded", "BUNDLE_TOO_MANY_OBJECTS", `the bundle lists ${rows.length + trees} objects; the limit is ${maxObjects}`);
  const out = new Map<string, { length: number; size: number }>();
  let previous = "";
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 3) bad("BUNDLE_INDEX", "a loose index row is [digest, length, size]");
    const [digest, length, size] = row as unknown[];
    if (!isObjectDigest(digest) || digest <= previous) bad("BUNDLE_INDEX", "loose index digests are unique, sorted multibase digests");
    if (!Number.isSafeInteger(length) || (length as number) < 0 || !Number.isSafeInteger(size) || (size as number) < 0) bad("BUNDLE_INDEX", "a loose object's length and size are non-negative integers");
    if ((size as number) > maxObjectBytes) codeError("limit-exceeded", "BUNDLE_OBJECT_TOO_LARGE", `object ${digest} declares ${String(size)} bytes; the limit is ${maxObjectBytes}`);
    out.set(digest, { length: length as number, size: size as number });
    previous = digest;
  }
  return out;
}

export interface SplitContents {
  manifest: BundleManifest;
  packages: Array<{ original: string; checkpoint: string; file: string; bytes: Uint8Array }>;
  objects: SplitObjects;
}

/**
 * Read a split bundle's manifest, evidence packages and tree pack, and the
 * loose index. No loose object is fetched here.
 */
export async function readSplitBundle(fetchFile: SplitFetch, limits: BundleLimits = {}): Promise<SplitContents> {
  const need = async (path: string) => (await fetchFile(path)) ?? bad("BUNDLE_LAYOUT", `${path} is required`);
  const manifest = parseBundleManifest(await need(BUNDLE_MANIFEST));
  const packages = [];
  for (const o of manifest.originals) packages.push({ ...o, bytes: await need(o.file) });
  const { objects: trees, failed } = await readObjectPack(await need(SPLIT_TREE_INDEX), await need(SPLIT_TREE_PACK), limits);
  const loose = parseLoose(await need(SPLIT_LOOSE_INDEX), limits, trees.size + failed.size);
  for (const d of loose.keys()) if (trees.has(d) || failed.has(d)) bad("BUNDLE_INDEX", `object ${d} is listed twice`);
  return { manifest, packages, objects: new SplitObjects(fetchFile, trees, loose, failed) };
}

/** A split bundle, verified and opened for reading. */
export interface OpenedSplitRepository extends OpenedRepository {
  /** The bundle's objects and where each stands. */
  split: SplitObjects;
  /** Verify again over the objects loaded so far (after `split.loadAll()`, the full content check). */
  reverify(): Promise<RepositoryReport>;
}

/**
 * Verify a split bundle as `openRepository` verifies a zip: the same code,
 * over the objects held so far (trees, and any loose object already loaded).
 * `objects` on the result fetches a loose object when asked and checks it on
 * arrival; it throws `ObjectNotLoadedError` for one that cannot be loaded.
 */
export async function openSplitRepository(fetchFile: SplitFetch, options: VerifyRepositoryOptions = {}): Promise<OpenedSplitRepository> {
  const contents = await readSplitBundle(fetchFile, options.limits);
  const split = contents.objects;
  const verify = () => openEvidence({ manifest: contents.manifest, packages: contents.packages, objects: (d) => split.peek(d), failed: split.failed() }, options);
  const opened = await verify();
  const result: OpenedSplitRepository = {
    ...opened,
    // Held bytes (trees, loaded objects, the Originals' resources) first; then fetch by digest.
    objects: async (d) => (await opened.objects(d)) ?? (await split.get(d)),
    split,
    async reverify() {
      const again = await verify();
      result.report = again.report;
      result.entries = again.entries;
      return again.report;
    },
  };
  return result;
}

/** A `SplitFetch` over a map of files (tests, or a split bundle already in memory). */
export function splitFilesFetch(files: ReadonlyMap<string, Uint8Array>): SplitFetch {
  return (path) => Promise.resolve(files.get(path));
}

