/**
 * Phase 2 in the SDK (plan 011, PR 6): retained versionIds per Original and
 * per author DID, stale evidence, and forks kept and reported as unresolved
 * (P6.6, P7.5, P7.6, P7.8; owner decision Q5).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStore } from "../../../src/originals/fs-store.js";
import { MemoryStore, OriginalsSDK, readZip, writeZip, type OriginalsStore } from "../../../src/originals/index.js";
import { authorPath } from "../../../src/originals/evidence.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KEY = seed(21);
const LATER = Date.parse("2026-10-18T13:00:00Z");

async function harbor() {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => alice.evidence(), freshness: "asserted", clock: clock() });
  const signer = alice.signer("orig", KEY);
  const c = await sdk.create({ name: "Harbor at dawn", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: bytes("first crop") }], author: alice.ref("orig"), signer });
  if (c.kind !== "original") throw new Error("expected an Original");
  const did = c.original.did;
  const v1 = c.original.checkpoint;
  const v1Package = await sdk.package(did);
  const e = await sdk.edit(did, { parent: v1, name: "Harbor at dawn, cropped", author: alice.ref("orig"), signer });
  return { alice, sdk, signer, did, v1, v2: e.original.checkpoint, v1Package };
}

const reader = (store: OriginalsStore = new MemoryStore()) =>
  OriginalsSDK.create({ store, authors: [], freshness: "asserted", clock: clock(LATER) });

describe("C12-22: an old valid prefix is not the latest state (P7.6)", () => {
  test("loading an older prefix of an Original this reader holds is stale, not current", async () => {
    const { sdk, did, v2, v1Package } = await harbor();
    const local = reader();
    await local.import((await sdk.package(did)).bytes);
    const loaded = await local.load(v1Package.bytes);
    expect(loaded.report.history.status).toBe("valid");
    expect(loaded.report.assetFreshness).toMatchObject({ status: "stale", retainedVersionId: v2 });
    expect(loaded.report.current).toBe(false);
    expect(loaded.reasons).toContain("asset-log-older-than-retained");
  });

  test("the retained versionId survives reopening a FileStore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "originals-retained-"));
    try {
      const { sdk, did, v1Package } = await harbor();
      await reader(await FileStore.open(dir)).import((await sdk.package(did)).bytes);
      const reopened = reader(await FileStore.open(dir));
      expect((await reopened.load(v1Package.bytes)).report.assetFreshness.status).toBe("stale");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("C12-73: stale author DID history is not currently authorized (P7.8)", () => {
  async function withStaleAuthorPackage() {
    const h = await harbor();
    const before = h.alice.entries.slice();
    await h.alice.rotate([{ fragment: "orig", secret: KEY }, { fragment: "spare", secret: seed(24) }]);
    const fresh = await h.sdk.package(h.did);
    // A host serves the current asset log with the author DID log as it was before the rotation.
    const files = readZip(fresh.bytes);
    files.set(`${authorPath(h.alice.did)}/did.jsonl`, bytes(h.alice.evidence(before).log as string));
    return { ...h, fresh, stale: writeZip(files), oldAuthorVersion: before[before.length - 1].versionId };
  }

  test("a reader that has seen a newer author DID version reports the older one as stale", async () => {
    const { alice, fresh, stale, oldAuthorVersion } = await withStaleAuthorPackage();
    const local = reader();
    expect((await local.import(fresh.bytes)).original.current).toBe(true);
    const loaded = await local.load(stale);
    expect(loaded.report.identityEvidence).toMatchObject({ freshness: "stale", latestVersionId: oldAuthorVersion, retainedVersionId: alice.versionId });
    expect(loaded.report.current).toBe(false);
  });

  test("importing stale author evidence never replaces newer stored evidence", async () => {
    const { alice, sdk, did, v1, stale } = await withStaleAuthorPackage();
    const local = reader();
    // The reader first sees the older asset checkpoint with the current author DID log,
    await local.import((await sdk.package(did, { checkpoint: v1 })).bytes);
    // then the newer asset log arrives with an author DID log from before the rotation.
    expect((await local.import(stale)).status).toBe("imported");
    const view = await local.get(did);
    expect(view.report.identityEvidence.latestVersionId).toBe(alice.versionId);
    expect(view.current).toBe(true);
  });
});

describe("C12-23: a fork found on import is kept and never current (P6.6, P7.5, Q5)", () => {
  async function forked(store: OriginalsStore = new MemoryStore()) {
    const { alice, sdk, signer, did, v1, v2, v1Package } = await harbor();
    const elsewhere = OriginalsSDK.create({ store, authors: async () => alice.evidence(), freshness: "asserted", clock: clock(LATER) });
    await elsewhere.import(v1Package.bytes);
    const other = await elsewhere.edit(did, { parent: v1, name: "Harbor, renamed elsewhere", author: alice.ref("orig"), signer });
    return { alice, sdk, elsewhere, did, v2, theirs: other.original.checkpoint };
  }

  test("both branches are reported, the local state is kept, and neither is current", async () => {
    const { sdk, elsewhere, did, v2, theirs } = await forked();
    const result = await elsewhere.import((await sdk.package(did)).bytes);
    expect(result.status).toBe("conflict");
    const view = await elsewhere.get(did);
    expect(view.state.name).toBe("Harbor, renamed elsewhere");
    expect(view.report.fork?.version).toBe(2);
    expect(view.report.fork?.branches.map((b) => b.versionId).sort()).toEqual([theirs, v2].sort());
    expect(view.current).toBe(false);
    expect(view.report.reasons).toContain("fork-unresolved");
  });

  test("the fork stays unresolved after more edits on one branch and after reopening", async () => {
    const dir = mkdtempSync(join(tmpdir(), "originals-fork-"));
    try {
      const { alice, sdk, elsewhere, did, theirs } = await forked(await FileStore.open(dir));
      await elsewhere.import((await sdk.package(did)).bytes);
      const more = await elsewhere.edit(did, { parent: theirs, name: "Still elsewhere", author: alice.ref("orig"), signer: alice.signer("orig", KEY) });
      expect(more.original.current).toBe(false);
      const reopened = OriginalsSDK.create({ store: await FileStore.open(dir), authors: async () => alice.evidence(), freshness: "asserted", clock: clock(LATER) });
      const view = await reopened.get(did);
      expect(view.report.fork).not.toBeNull();
      expect(view.current).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
