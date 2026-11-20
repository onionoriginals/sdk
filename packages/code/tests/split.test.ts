/**
 * The split bundle (plan 049 §6 milestone 1, PROVISIONAL K19; CODE-33 to
 * CODE-35): the zip bundle's evidence as static files. The logs and trees
 * verify first, with the same code as the zip; each other object is fetched
 * by digest when asked and checked on arrival. An object not yet loaded is
 * reported missing, never verified and never a pass (section 7).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { deflateSync } from "fflate";
import { GitSource } from "../src/git.js";
import {
  ObjectNotLoadedError,
  SPLIT_LOOSE_INDEX,
  looseObjectPath,
  openSplitRepository,
  readSplitBundle,
  splitBundle,
  splitFilesFetch,
  verifyRepository,
  type SplitFetch,
} from "../src/index.js";
import { FixtureRepo, NOW, identity, workspace } from "./helpers.js";

const MAIN = "refs/heads/main";
const LATER = NOW + 3_600_000;
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

/**
 * The dogfood shape: the owner authors the branch, CI appends as an editor
 * with a `**` path grant (plan 049 §6). Editor entries need the trees for the
 * path-grant check, so this exercises the tree pack.
 */
async function fixture() {
  const owner = await identity(1);
  const ci = await identity(5);
  const ws = workspace();
  ws.addIdentity(ci);
  const up = new FixtureRepo();
  cleanup.push(() => up.remove());
  up.commit({ "README.md": "# Demo\n", "src/a.ts": "one\n", "docs/deep/x.md": "x" });
  const s1 = new GitSource(up.dir);
  cleanup.push(() => s1.close());
  const repo = await ws.initRepo({ name: "demo", identity: owner });
  const { branch } = await ws.mirror({ repo, ref: MAIN, identity: owner, source: s1 });
  await ws.grantPaths(repo, owner, ci.did, ["**"]);
  up.commit({ "src/a.ts": "one\ntwo\n", "src/b.ts": "b" });
  up.commit({ "docs/deep/x.md": "y", "bin.dat": "\u0000\u0001" });
  const s2 = new GitSource(up.dir);
  cleanup.push(() => s2.close());
  await ws.mirror({ repo, ref: MAIN, identity: ci, source: s2, branch });
  const zip = await ws.package(repo);
  const files = await splitBundle(zip);
  return { zip, files, ws, repo, branch, owner, ci };
}

/** A fetch over the split files that counts requests and can be tampered with. */
function host(files: Map<string, Uint8Array>) {
  const requests: string[] = [];
  const fetchFile: SplitFetch = (path) => {
    requests.push(path);
    return Promise.resolve(files.get(path));
  };
  return { fetchFile, requests };
}

const blobsOf = (files: Map<string, Uint8Array>) => (JSON.parse(new TextDecoder().decode(files.get(SPLIT_LOOSE_INDEX))) as Array<[string, number, number]>).map((r) => r[0]);

describe("CODE-33 the split layout verifies as the zip does", () => {
  test("layout: manifest, packages, a tree pack, a loose index and one file per loose object", async () => {
    const { files } = await fixture();
    const names = [...files.keys()];
    expect(names).toContain("originals-code.json");
    expect(names).toContain("objects/index.json");
    expect(names).toContain("objects/pack");
    expect(names).toContain(SPLIT_LOOSE_INDEX);
    expect(names.filter((n) => /^originals\/.+\.zip$/.test(n)).length).toBe(2);
    const loose = blobsOf(files);
    expect(loose.length).toBeGreaterThan(0);
    for (const d of loose) expect(files.has(looseObjectPath(d))).toBe(true);
    expect(names.every((n) => n === "originals-code.json" || n.startsWith("originals/") || n.startsWith("objects/"))).toBe(true);
  });

  test("before any blob is fetched: Originals and code history as the zip; content partial, git trees unchecked", async () => {
    const { zip, files } = await fixture();
    const zipReport = await verifyRepository(zip, { now: LATER });
    const { fetchFile, requests } = host(files);
    const opened = await openSplitRepository(fetchFile, { now: LATER });
    const r = opened.report;
    // Only the logs, trees and indexes were read: no loose object.
    expect(requests.some((p) => blobsOf(files).some((d) => p === looseObjectPath(d)))).toBe(false);
    expect(r.repo.report).toEqual(zipReport.repo.report);
    expect(r.repo.code).toEqual(zipReport.repo.code);
    const b = r.branches[0];
    expect(b.report).toEqual(zipReport.branches[0].report);
    // The CI editor's entries are checked against the `**` grant with trees alone.
    expect(b.code!.history).toEqual(zipReport.branches[0].code!.history);
    expect(b.code!.history.status).toBe("valid");
    expect(b.code!.grants.every((g) => g.status === "allowed")).toBe(true);
    expect(b.code!.grants.length).toBe(2);
    // Not loaded is missing: never a pass.
    expect(b.code!.content.status).toBe("partial");
    expect(new Set(b.code!.content.missing)).toEqual(new Set(blobsOf(files)));
    expect(b.code!.gitBinding.status).toBe("unchecked");
    expect(r.canonical).toEqual(zipReport.canonical);
    expect(r.current).toBe(false);
    expect(opened.split.counts()).toMatchObject({ loose: blobsOf(files).length, loaded: 0, notLoaded: blobsOf(files).length, failed: 0 });
  });

  test("after every object is loaded, the report equals the zip bundle's", async () => {
    const { zip, files } = await fixture();
    const opened = await openSplitRepository(splitFilesFetch(files), { now: LATER });
    await opened.split.loadAll({ concurrency: 3 });
    const again = await opened.reverify();
    expect(again).toEqual(await verifyRepository(zip, { now: LATER }));
    expect(again.branches[0].code!.content.status).toBe("complete");
    expect(again.branches[0].code!.gitBinding.status).toBe("matches");
    expect(opened.report).toBe(again);
  });
});

describe("CODE-34 objects fetched by digest, checked on arrival", () => {
  test("an object is fetched once, when asked, and checked", async () => {
    const { files } = await fixture();
    const { fetchFile, requests } = host(files);
    const opened = await openSplitRepository(fetchFile);
    const d = blobsOf(files)[0];
    expect(opened.split.status(d)).toBe("not-loaded");
    const a = await opened.objects(d);
    const b = await opened.objects(d);
    expect(a).toEqual(b!);
    expect(requests.filter((p) => p === looseObjectPath(d)).length).toBe(1);
    expect(opened.split.status(d)).toBe("loaded");
  });

  test("a tampered object fails its digest: refused, reported failed, never used", async () => {
    const { files } = await fixture();
    const d = blobsOf(files)[0];
    const loose = JSON.parse(new TextDecoder().decode(files.get(SPLIT_LOOSE_INDEX))) as Array<[string, number, number]>;
    const row = loose.find((r) => r[0] === d)!;
    // Same length and size as listed, different bytes.
    const forged = deflateSync(new Uint8Array(row[2]).fill(65), { level: 0 });
    const tampered = new Map(files);
    tampered.set(looseObjectPath(d), forged);
    row[1] = forged.length;
    tampered.set(SPLIT_LOOSE_INDEX, new TextEncoder().encode(JSON.stringify(loose)));
    const opened = await openSplitRepository(splitFilesFetch(tampered), { now: LATER });
    await expect(opened.objects(d)).rejects.toBeInstanceOf(ObjectNotLoadedError);
    expect(opened.split.status(d)).toBe("failed");
    await opened.split.loadAll();
    const r = await opened.reverify();
    expect(r.branches[0].code!.content.status).toBe("digest-failure");
    expect(r.branches[0].code!.content.failures).toContain(d);
  });

  test("an object the host does not serve, or serves at another length, is not loaded", async () => {
    const { files } = await fixture();
    const [d1, d2] = blobsOf(files);
    const broken = new Map(files);
    broken.delete(looseObjectPath(d1));
    broken.set(looseObjectPath(d2), new Uint8Array([1, 2, 3]));
    const opened = await openSplitRepository(splitFilesFetch(broken));
    await expect(opened.objects(d1)).rejects.toMatchObject({ code: "OBJECT_NOT_LOADED", digest: d1 });
    await expect(opened.objects(d2)).rejects.toMatchObject({ code: "OBJECT_NOT_LOADED", digest: d2 });
    expect(opened.split.counts().failed).toBe(2);
  });

  test("a network error is not a verdict: the object stays not loaded and can be fetched again", async () => {
    const { files } = await fixture();
    const d = blobsOf(files)[0];
    let fail = true;
    const opened = await openSplitRepository((path) => {
      if (path === looseObjectPath(d) && fail) return Promise.reject(new Error("offline"));
      return Promise.resolve(files.get(path));
    });
    await expect(opened.objects(d)).rejects.toBeInstanceOf(ObjectNotLoadedError);
    expect(opened.split.status(d)).toBe("not-loaded");
    fail = false;
    expect(await opened.objects(d)).toBeInstanceOf(Uint8Array);
  });

  test("a digest the bundle does not list is absent: undefined, never fetched", async () => {
    const { files } = await fixture();
    const { fetchFile, requests } = host(files);
    const opened = await openSplitRepository(fetchFile);
    const before = requests.length;
    expect(await opened.objects("zQmYyQSo1c1Ym7orWxLYvCrM2EmxFTANf8wXmmE7DWjhx5N")).toBeUndefined();
    expect(requests.length).toBe(before);
  });
});

describe("CODE-35 the split reader's bounds and layout", () => {
  test("required files", async () => {
    const { files } = await fixture();
    for (const name of ["originals-code.json", "objects/index.json", "objects/pack", SPLIT_LOOSE_INDEX]) {
      const without = new Map(files);
      without.delete(name);
      await expect(readSplitBundle(splitFilesFetch(without))).rejects.toMatchObject({ code: "BUNDLE_LAYOUT" });
    }
  });

  test("loose index: unsorted, duplicate with the pack, oversize and over the object count are refused", async () => {
    const { files } = await fixture();
    const rows = JSON.parse(new TextDecoder().decode(files.get(SPLIT_LOOSE_INDEX))) as Array<[string, number, number]>;
    const withLoose = (v: unknown) => new Map(files).set(SPLIT_LOOSE_INDEX, new TextEncoder().encode(JSON.stringify(v)));
    await expect(readSplitBundle(splitFilesFetch(withLoose([...rows].reverse())))).rejects.toMatchObject({ code: "BUNDLE_INDEX" });
    await expect(readSplitBundle(splitFilesFetch(withLoose([[rows[0][0], 1, 64 * 1024 * 1024 + 1]])))).rejects.toMatchObject({ code: "BUNDLE_OBJECT_TOO_LARGE" });
    await expect(readSplitBundle(splitFilesFetch(withLoose([["../../etc/passwd", 1, 1]])))).rejects.toMatchObject({ code: "BUNDLE_INDEX" });
    await expect(readSplitBundle(splitFilesFetch(files), { maxObjects: rows.length })).rejects.toMatchObject({ code: "BUNDLE_TOO_MANY_OBJECTS" });
    const tree = (JSON.parse(new TextDecoder().decode(files.get("objects/index.json"))) as Array<[string]>)[0][0];
    const dup = [...rows, [tree, 1, 1]].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    await expect(readSplitBundle(splitFilesFetch(withLoose(dup)))).rejects.toMatchObject({ code: "BUNDLE_INDEX" });
  });

  test("an inflate bomb is caught at the declared size", async () => {
    const { files } = await fixture();
    const rows = JSON.parse(new TextDecoder().decode(files.get(SPLIT_LOOSE_INDEX))) as Array<[string, number, number]>;
    const bomb = deflateSync(new Uint8Array(4 * 1024 * 1024));
    rows[0][1] = bomb.length;
    const tampered = new Map(files).set(SPLIT_LOOSE_INDEX, new TextEncoder().encode(JSON.stringify(rows))).set(looseObjectPath(rows[0][0]), bomb);
    const opened = await openSplitRepository(splitFilesFetch(tampered));
    await expect(opened.objects(rows[0][0])).rejects.toMatchObject({ code: "OBJECT_NOT_LOADED" });
  });

  test("a bundle with an object failing its digest is not split", async () => {
    const { zip } = await fixture();
    const { readZip, writeZip } = await import("@originals/sdk/originals");
    const f = readZip(zip);
    const pack = f.get("objects/pack")!.slice();
    pack[pack.length - 2] ^= 0xff;
    f.set("objects/pack", pack);
    await expect(splitBundle(writeZip(f))).rejects.toMatchObject({ code: "SPLIT_FAILED_OBJECT" });
  });
});
