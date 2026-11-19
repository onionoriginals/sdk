/**
 * CODE-17: the bundle reader bounds what it reads before inflating, inflates
 * each object to at most its declared size and checks its digest (K8, P4.3).
 */
import { describe, expect, test } from "bun:test";
import { readZip, writeZip } from "@originals/sdk/originals";
import { resourceDigest } from "@originals/vh/originals";
import { deflateSync } from "fflate";
import { BUNDLE_MANIFEST, readBundle, writeBundle } from "../src/index.js";

const enc = new TextEncoder();
const obj = (s: string): [string, Uint8Array] => [resourceDigest(enc.encode(s)), enc.encode(s)];

function base(objects: Array<[string, Uint8Array]> = [obj("a"), obj("b"), obj("")]) {
  return writeBundle({ repo: "did:vh:QmRepo", checkpoint: "1-QmX", packages: [], objects });
}

function edit(bundle: Uint8Array, change: (files: Map<string, Uint8Array>) => void): Uint8Array {
  const files = readZip(bundle);
  change(files);
  return writeZip(files);
}

describe("CODE-17 bundle reader bounds", () => {
  test("round-trips objects, including an empty one", async () => {
    const r = await readBundle(base());
    expect(r.objects.size).toBe(3);
    expect(r.failed.size).toBe(0);
    expect(r.manifest.objects).toEqual({ count: 3, bytes: 2 });
  });

  test("an object declaring more than the limit is refused before inflating", async () => {
    await expect(readBundle(base([obj("x".repeat(100))]), { maxObjectBytes: 10 })).rejects.toMatchObject({ code: "BUNDLE_OBJECT_TOO_LARGE", category: "limit-exceeded" });
    await expect(readBundle(base(), { maxObjects: 2 })).rejects.toMatchObject({ code: "BUNDLE_TOO_MANY_OBJECTS" });
    await expect(readBundle(base([obj("x".repeat(100)), obj("y".repeat(100))]), { maxInflatedBytes: 150 })).rejects.toMatchObject({ code: "BUNDLE_TOO_LARGE" });
  });

  test("an inflate bomb under a small declared size fails that object only, without inflating it all", async () => {
    const [digest] = obj("small");
    const bomb = deflateSync(new Uint8Array(50 * 1024 * 1024));
    const bundle = edit(base(), (files) => {
      files.set("objects/pack", bomb);
      files.set("objects/index.json", enc.encode(JSON.stringify([[digest, 0, bomb.length, 5]])));
    });
    const r = await readBundle(bundle);
    expect([...r.failed]).toEqual([digest]);
    expect(r.objects.size).toBe(0);
  });

  test("an index that does not cover the pack exactly, or is unsorted, is refused", async () => {
    const good = base();
    const index = JSON.parse(new TextDecoder().decode(readZip(good).get("objects/index.json"))) as Array<[string, number, number, number]>;
    const gap = structuredClone(index);
    gap[1][1] += 1;
    await expect(readBundle(edit(good, (f) => f.set("objects/index.json", enc.encode(JSON.stringify(gap)))))).rejects.toMatchObject({ code: "BUNDLE_INDEX" });
    const unsorted = [index[1], index[0], index[2]];
    await expect(readBundle(edit(good, (f) => f.set("objects/index.json", enc.encode(JSON.stringify(unsorted)))))).rejects.toMatchObject({ code: "BUNDLE_INDEX" });
    await expect(readBundle(edit(good, (f) => f.set("objects/pack", new Uint8Array([...f.get("objects/pack")!, 0]))))).rejects.toMatchObject({ code: "BUNDLE_INDEX" });
  });

  test("files outside the layout, unlisted packages and manifest drift are refused", async () => {
    await expect(readBundle(edit(base(), (f) => f.set("extra.txt", enc.encode("x"))))).rejects.toMatchObject({ code: "BUNDLE_LAYOUT" });
    await expect(readBundle(edit(base(), (f) => f.set("originals/QmUnlisted.zip", enc.encode("x"))))).rejects.toMatchObject({ code: "BUNDLE_LAYOUT" });
    await expect(
      readBundle(
        edit(base(), (f) => {
          const m = JSON.parse(new TextDecoder().decode(f.get(BUNDLE_MANIFEST))) as Record<string, unknown>;
          m.extra = true;
          f.set(BUNDLE_MANIFEST, enc.encode(JSON.stringify(m)));
        }),
      ),
    ).rejects.toMatchObject({ code: "BUNDLE_MANIFEST" });
  });
});
