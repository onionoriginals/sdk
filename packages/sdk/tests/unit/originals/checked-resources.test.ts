/**
 * Resource bytes checked when stored (P4.3; owner decision, 9 November 2026).
 * A store that hashed bytes when it kept them, and knows they have not
 * changed since, reports them through `checkedResource`; the SDK then counts
 * the version verified without reading and hashing it again. Every report is
 * the one a store without the capability gives: the same `verified`,
 * `missing` and `mismatch` per version (C12-02, C12-10), and bytes that
 * changed on disk are hashed again and fail.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resourceDigest } from "@originals/vh/originals";
import { FileStore } from "../../../src/originals/fs-store.js";
import { MemoryStore, OriginalsSDK, type OriginalsStore } from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KEY = seed(29);
const V = [bytes("first version"), bytes("second version"), bytes("third version")];

/** The same store without the capability: every held byte is read and hashed. */
function unchecked(store: OriginalsStore): OriginalsStore {
  return new Proxy(store, {
    get(target, key, receiver) {
      if (key === "checkedResource") return undefined;
      const value = Reflect.get(target, key, receiver) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

async function threeVersions(store: OriginalsStore) {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const sdk = OriginalsSDK.create({ store, authors: [alice.evidence()], clock: clock() });
  const signer = alice.signer("orig", KEY);
  const author = alice.ref("orig");
  const c = await sdk.create({ name: "Checked", resource: { mediaType: "text/plain", bytes: V[0] }, author, signer });
  if (c.kind !== "original") throw new Error("expected an Original");
  let view = c.original;
  for (const b of V.slice(1)) view = (await sdk.edit(view.did, { parent: view.checkpoint, resource: { bytes: b }, author, signer })).original;
  return { alice, sdk, did: view.did };
}

/** `get` through the store with and without checking, with a fixed clock so reports compare exactly. */
async function bothWays(alice: Author, store: OriginalsStore, did: string) {
  const at = Date.parse("2026-10-18T14:00:00Z");
  const withChecks = await OriginalsSDK.create({ store, authors: [alice.evidence()], clock: () => at }).get(did);
  const without = await OriginalsSDK.create({ store: unchecked(store), authors: [alice.evidence()], clock: () => at }).get(did);
  return { withChecks, without };
}

describe("MemoryStore checks bytes when they are put", () => {
  test("matching bytes are checked by size; others, absent and forgotten ones are not", async () => {
    const store = new MemoryStore();
    const d = resourceDigest(V[0]);
    await store.putResource(d, V[0]);
    expect(await store.checkedResource(d)).toBe(V[0].length);
    const wrong = resourceDigest(V[1]);
    await store.putResource(wrong, V[2]); // bytes that are not the digest's
    expect(await store.checkedResource(wrong)).toBeUndefined();
    expect(await store.checkedResource(resourceDigest(V[2]))).toBeUndefined();
    store.deleteResource(d);
    expect(await store.checkedResource(d)).toBeUndefined();
    // Deleted while being checked: never reported checked.
    const p = store.putResource(d, V[0]);
    store.deleteResource(d);
    await p;
    expect(await store.checkedResource(d)).toBeUndefined();
  });

  test("C12-02, C12-10: reports equal a store without checking, for verified, mismatched and missing versions", async () => {
    const store = new MemoryStore();
    const { alice, did } = await threeVersions(store);
    let r = await bothWays(alice, store, did);
    expect(r.withChecks).toEqual(r.without);
    expect(r.withChecks.resources.map((v) => v.bytes)).toEqual(["verified", "verified", "verified"]);

    // Version 2 lost, version 1's bytes replaced by others under its digest.
    store.deleteResource(resourceDigest(V[1]));
    store.deleteResource(resourceDigest(V[0]));
    await store.putResource(resourceDigest(V[0]), bytes("first versioN"));
    r = await bothWays(alice, store, did);
    expect(r.withChecks).toEqual(r.without);
    expect(r.withChecks.resources.map((v) => v.bytes)).toEqual(["mismatch", "missing", "verified"]);
    expect(r.withChecks.report.reasons).toContain("resources-digest-failure");
  });
});

describe("FileStore checks bytes once per process, while the file is unchanged", () => {
  test("reports equal a store without checking, and a file changed on disk is hashed again and fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "originals-checked-"));
    const store = await FileStore.open(dir);
    try {
      const { alice, did } = await threeVersions(store);
      const d0 = resourceDigest(V[0]);
      expect(await store.checkedResource(d0)).toBe(V[0].length);
      let r = await bothWays(alice, store, did);
      expect(r.withChecks).toEqual(r.without);
      expect(r.withChecks.resources.map((v) => v.bytes)).toEqual(["verified", "verified", "verified"]);

      // Rewritten in place, same size, its times put back: the change time still moves.
      const path = join(dir, "resources", d0);
      const { atime, mtime } = statSync(path);
      writeFileSync(path, bytes("first versioN"));
      utimesSync(path, atime, mtime);
      expect(await store.checkedResource(d0)).toBeUndefined();
      r = await bothWays(alice, store, did);
      expect(r.withChecks).toEqual(r.without);
      expect(r.withChecks.resources.map((v) => v.bytes)).toEqual(["mismatch", "verified", "verified"]);

      // Put back: hashed again, and checked again.
      writeFileSync(path, V[0]);
      expect(await store.checkedResource(d0)).toBe(V[0].length);
      expect(await store.checkedResource(resourceDigest(bytes("never stored")))).toBeUndefined();
      expect(await store.checkedResource("not-a-digest")).toBeUndefined();
    } finally {
      await store.close();
    }
  });
});
