/**
 * The repo bundle (plan 049 phase 1; PROVISIONAL K8): a stored-only ZIP,
 * written and read with the SDK's own strict codec.
 *
 *   originals-code.json        the manifest
 *   originals/<scid>.zip       each Original's evidence package, exactly as
 *                              `sdk.package` writes it (P7.1, P14.10)
 *   originals/<scid>.<n>.zip   another copy of the same Original (a branch of
 *                              its log), so a fork can be carried and reported (P6.6)
 *   objects/index.json         [[digest, offset, length, size], …] sorted by digest
 *   objects/pack               each object deflate-raw compressed, concatenated
 *
 * The index is untrusted: the reader bounds counts and sizes before inflating,
 * inflates each object to at most its declared size, and checks its digest
 * (P4.3). An object that fails is reported, never used.
 */
import { isJsonObject, parseJson } from "@originals/vh/json";
import { readZip, writeZip, type ZipLimits } from "@originals/sdk/originals";
import { deflateSync, inflateSync } from "fflate";
import { CODE_PROFILE } from "./documents.js";
import { objectDigestAsync } from "./objects.js";
import { codeError } from "./errors.js";

export const BUNDLE_FORMAT = "originals-code-bundle/0.1";
export const BUNDLE_MANIFEST = "originals-code.json";

export interface BundleManifest {
  format: typeof BUNDLE_FORMAT;
  profile: typeof CODE_PROFILE;
  /** The repo Original. */
  repo: string;
  /** The repo checkpoint the bundle is evidence for. */
  checkpoint: string;
  /** Each evidence package: which Original, through which checkpoint, in which file. */
  originals: Array<{ original: string; checkpoint: string; file: string }>;
  objects: { count: number; bytes: number };
  completeness: "complete" | "partial";
  /** Objects reachable from a packaged version that the bundle does not carry. */
  missing: string[];
}

export interface BundleLimits {
  /** Bounds on the outer ZIP (the SDK's `ZIP_LIMITS` by default). */
  zip?: ZipLimits;
  /** Objects in one bundle. Default 1,000,000. */
  maxObjects?: number;
  /** One inflated object. Default 64 MiB, the hosted resource fetch cap (P14.13). */
  maxObjectBytes?: number;
  /** All inflated objects together. Default 2 GiB. */
  maxInflatedBytes?: number;
}

export const BUNDLE_LIMITS = Object.freeze({ maxObjects: 1_000_000, maxObjectBytes: 64 * 1024 * 1024, maxInflatedBytes: 2 * 1024 * 1024 * 1024 });

export interface BundleContents {
  manifest: BundleManifest;
  packages: Array<{ original: string; checkpoint: string; file: string; bytes: Uint8Array }>;
  /** Objects whose bytes inflate to their declared size and hash to their digest. */
  objects: Map<string, Uint8Array>;
  /** Objects the index lists whose bytes do not inflate or do not match their digest. */
  failed: Set<string>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const DIGEST = /^z[1-9A-HJ-NP-Za-km-z]{1,120}$/;
const PACKAGE_FILE = /^originals\/[1-9A-HJ-NP-Za-km-z]+(?:\.[1-9][0-9]*)?\.zip$/;

function bad(code: string, message: string): never {
  return codeError("invalid-evidence", code, message);
}

export interface WriteBundleInput {
  repo: string;
  checkpoint: string;
  packages: Array<{ original: string; checkpoint: string; bytes: Uint8Array }>;
  objects: Iterable<[string, Uint8Array]>;
  missing?: string[];
}

/** Write a bundle. Objects are deduplicated by digest and sorted. */
export function writeBundle(input: WriteBundleInput): Uint8Array {
  const files = new Map<string, Uint8Array>();
  const originals: BundleManifest["originals"] = [];
  const copies = new Map<string, number>();
  for (const p of input.packages) {
    const scid = p.original.slice("did:vh:".length);
    const n = copies.get(scid) ?? 0;
    copies.set(scid, n + 1);
    const file = n === 0 ? `originals/${scid}.zip` : `originals/${scid}.${n}.zip`;
    files.set(file, p.bytes);
    originals.push({ original: p.original, checkpoint: p.checkpoint, file });
  }
  const objects = new Map<string, Uint8Array>();
  for (const [d, b] of input.objects) objects.set(d, b);
  const digests = [...objects.keys()].sort();
  const index: Array<[string, number, number, number]> = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let total = 0;
  for (const d of digests) {
    const raw = objects.get(d)!;
    const z = deflateSync(raw, { level: 6 });
    index.push([d, offset, z.length, raw.length]);
    chunks.push(z);
    offset += z.length;
    total += raw.length;
  }
  const pack = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) {
    pack.set(c, at);
    at += c.length;
  }
  const missing = [...new Set(input.missing ?? [])].sort();
  const manifest: BundleManifest = {
    format: BUNDLE_FORMAT,
    profile: CODE_PROFILE,
    repo: input.repo,
    checkpoint: input.checkpoint,
    originals,
    objects: { count: digests.length, bytes: total },
    completeness: missing.length === 0 ? "complete" : "partial",
    missing,
  };
  files.set(BUNDLE_MANIFEST, encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`));
  files.set("objects/index.json", encoder.encode(JSON.stringify(index)));
  files.set("objects/pack", pack);
  return writeZip(files);
}

function exactly(value: unknown, keys: string[]): value is Record<string, unknown> {
  return isJsonObject(value) && Object.keys(value).length === keys.length && keys.every((k) => k in value);
}

function text(bytes: Uint8Array, name: string): string {
  try {
    return decoder.decode(bytes);
  } catch {
    return bad("BUNDLE_ENCODING", `${name} is not UTF-8`);
  }
}

function checkManifest(value: unknown): BundleManifest {
  if (!exactly(value, ["checkpoint", "completeness", "format", "missing", "objects", "originals", "profile", "repo"])) {
    bad("BUNDLE_MANIFEST", "the manifest is exactly { format, profile, repo, checkpoint, originals, objects, completeness, missing }");
  }
  if (value.format !== BUNDLE_FORMAT) codeError("unsupported-profile", "BUNDLE_FORMAT", `unsupported bundle format ${JSON.stringify(value.format)}`);
  if (value.profile !== CODE_PROFILE) codeError("unsupported-profile", "CODE_PROFILE", `unsupported code profile ${JSON.stringify(value.profile)}`);
  if (typeof value.repo !== "string" || typeof value.checkpoint !== "string") bad("BUNDLE_MANIFEST", "repo and checkpoint are strings");
  if (!Array.isArray(value.originals) || !value.originals.every((o) => exactly(o, ["checkpoint", "file", "original"]) && typeof o.original === "string" && typeof o.checkpoint === "string" && typeof o.file === "string" && PACKAGE_FILE.test(o.file))) {
    bad("BUNDLE_MANIFEST", "originals is a list of { original, checkpoint, file }");
  }
  if (!exactly(value.objects, ["bytes", "count"]) || !Number.isSafeInteger(value.objects.count) || !Number.isSafeInteger(value.objects.bytes)) bad("BUNDLE_MANIFEST", "objects is { count, bytes }");
  if (value.completeness !== "complete" && value.completeness !== "partial") bad("BUNDLE_MANIFEST", "completeness is complete or partial");
  if (!Array.isArray(value.missing) || !value.missing.every((d) => typeof d === "string" && DIGEST.test(d))) bad("BUNDLE_MANIFEST", "missing lists object digests");
  return value as unknown as BundleManifest;
}

/** Read a bundle: its manifest, packages and objects. Verification is separate (`verifyRepository`). */
export async function readBundle(zip: Uint8Array, limits: BundleLimits = {}): Promise<BundleContents> {
  const maxObjects = limits.maxObjects ?? BUNDLE_LIMITS.maxObjects;
  const maxObjectBytes = limits.maxObjectBytes ?? BUNDLE_LIMITS.maxObjectBytes;
  const maxInflated = limits.maxInflatedBytes ?? BUNDLE_LIMITS.maxInflatedBytes;
  const files = readZip(zip, limits.zip);
  for (const name of files.keys()) {
    if (name !== BUNDLE_MANIFEST && name !== "objects/index.json" && name !== "objects/pack" && !PACKAGE_FILE.test(name)) bad("BUNDLE_LAYOUT", `${name} is not part of the bundle layout`);
  }
  const m = files.get(BUNDLE_MANIFEST);
  if (!m) bad("BUNDLE_LAYOUT", `${BUNDLE_MANIFEST} is required`);
  const manifest = checkManifest(parseJson(text(m, BUNDLE_MANIFEST)));
  const listed = new Set(manifest.originals.map((o) => o.file));
  if (listed.size !== manifest.originals.length) bad("BUNDLE_MANIFEST", "a package file is listed twice");
  for (const name of files.keys()) if (PACKAGE_FILE.test(name) && !listed.has(name)) bad("BUNDLE_LAYOUT", `${name} is not listed in the manifest`);
  const packages = manifest.originals.map((o) => {
    const bytes = files.get(o.file);
    if (!bytes) return bad("BUNDLE_LAYOUT", `${o.file} is listed but absent`);
    return { ...o, bytes };
  });

  const objects = new Map<string, Uint8Array>();
  const failed = new Set<string>();
  const indexBytes = files.get("objects/index.json");
  const pack = files.get("objects/pack");
  if (!indexBytes || !pack) bad("BUNDLE_LAYOUT", "objects/index.json and objects/pack are required");
  const index = parseJson(text(indexBytes, "objects/index.json"));
  if (!Array.isArray(index)) bad("BUNDLE_INDEX", "the object index is an array");
  if (index.length > maxObjects) codeError("limit-exceeded", "BUNDLE_TOO_MANY_OBJECTS", `the bundle lists ${index.length} objects; the limit is ${maxObjects}`);
  // Check the whole index before inflating anything.
  let expected = 0;
  let inflated = 0;
  let previous = "";
  const rows: Array<[string, number, number, number]> = [];
  for (const row of index) {
    if (!Array.isArray(row) || row.length !== 4) bad("BUNDLE_INDEX", "an index row is [digest, offset, length, size]");
    const [digest, offset, length, size] = row as unknown[];
    if (typeof digest !== "string" || !DIGEST.test(digest) || digest <= previous) bad("BUNDLE_INDEX", "index digests are unique, sorted multibase digests");
    if (!Number.isSafeInteger(offset) || offset !== expected || !Number.isSafeInteger(length) || (length as number) < 0) bad("BUNDLE_INDEX", "index rows cover the pack contiguously, in order");
    if (!Number.isSafeInteger(size) || (size as number) < 0) bad("BUNDLE_INDEX", "an object size is a non-negative integer");
    if ((size as number) > maxObjectBytes) codeError("limit-exceeded", "BUNDLE_OBJECT_TOO_LARGE", `object ${digest} declares ${String(size)} bytes; the limit is ${maxObjectBytes}`);
    inflated += size as number;
    if (inflated > maxInflated) codeError("limit-exceeded", "BUNDLE_TOO_LARGE", `the objects inflate to more than ${maxInflated} bytes`);
    expected += length as number;
    previous = digest;
    rows.push([digest, offset, length as number, size as number]);
  }
  if (expected !== pack.length) bad("BUNDLE_INDEX", "the index does not cover the pack exactly");
  for (const [digest, offset, length, size] of rows) {
    let raw: Uint8Array;
    try {
      // One byte more than declared: a stream that inflates further is caught without inflating it all.
      raw = inflateSync(pack.subarray(offset, offset + length), { out: new Uint8Array(size + 1) });
    } catch {
      failed.add(digest);
      continue;
    }
    if (raw.length !== size || (await objectDigestAsync(raw)) !== digest) {
      failed.add(digest);
      continue;
    }
    objects.set(digest, raw.slice());
  }
  return { manifest, packages, objects, failed };
}
