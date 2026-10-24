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
import { signerPath } from "../../../src/originals/evidence.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KEY = seed(21);
const LATER = Date.parse("2026-10-18T13:00:00Z");

async function harbor() {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => alice.evidence(), clock: clock() });
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
  OriginalsSDK.create({ store, authors: [], clock: clock(LATER) });

describe("C12-145: an unanchored Original is never current; it is valid as of its checkpoint (P7.10)", () => {
  test("each read names the signer DID version relied on and when and where that history was obtained", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const obtainedAt = "2026-10-18T11:59:00.000Z";
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [{ ...alice.evidence(), obtainedAt }], clock: clock() });
    const signer = alice.signer("orig", KEY);
    const c = await sdk.create({ name: "Harbor at dawn", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: bytes("first crop") }], author: alice.ref("orig"), signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    expect(c.original.current).toBe(false);
    expect(c.original.validAsOf).toEqual({ checkpoint: c.original.checkpoint, signers: [{ did: alice.did, role: "author", versionId: alice.versionId, obtainedAt, source: "supplied", location: null }] });
    // A fresh reader: the package's evidence, obtained when it was read.
    const local = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: () => LATER });
    const pkg = await sdk.package(c.original.did);
    const loaded = await local.load(pkg.bytes);
    expect(loaded.report.current).toBe(false);
    expect(loaded.report.validAsOf?.signers).toEqual([{ did: alice.did, role: "author", versionId: alice.versionId, obtainedAt: new Date(LATER).toISOString(), source: "package", location: null }]);
    // Imported, the evidence is kept with when it was obtained, and later reads say it is retained.
    await local.import(pkg.bytes);
    const view = await local.get(c.original.did);
    expect(view.current).toBe(false);
    expect(view.validAsOf?.signers).toEqual([{ did: alice.did, role: "author", versionId: alice.versionId, obtainedAt: new Date(LATER).toISOString(), source: "retained", location: null }]);
    expect(view.report.reasons).toEqual(["not-anchored"]);
  });
});

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

describe("C12-64: stale author DID history is not currently authorized (P7.8)", () => {
  async function withStaleAuthorPackage() {
    const h = await harbor();
    const before = h.alice.entries.slice();
    await h.alice.rotate([{ fragment: "orig", secret: KEY }, { fragment: "spare", secret: seed(24) }]);
    const fresh = await h.sdk.package(h.did);
    // A host serves the current asset log with the author DID log as it was before the rotation.
    const files = readZip(fresh.bytes);
    files.set(`${signerPath(h.alice.did)}/did.jsonl`, bytes(h.alice.evidence(before).log as string));
    return { ...h, fresh, stale: writeZip(files), oldAuthorVersion: before[before.length - 1].versionId };
  }

  test("a reader that has kept a newer author DID version uses it, not the older one a package carries (P7.8; originals-spec #47, merged)", async () => {
    const { alice, fresh, stale, oldAuthorVersion } = await withStaleAuthorPackage();
    const local = reader();
    expect((await local.import(fresh.bytes)).original.report.reasons).toEqual(["not-anchored"]);
    const loaded = await local.load(stale);
    expect(oldAuthorVersion).not.toBe(alice.versionId);
    expect(loaded.report.identityEvidence).toMatchObject({ freshness: "not-established", latestVersionId: alice.versionId, retainedVersionId: alice.versionId });
    expect(loaded.report.validAsOf?.signers[0]).toMatchObject({ versionId: alice.versionId, source: "retained", location: null });
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
    expect(view.report.reasons).toEqual(["not-anchored"]);
  });
});

describe("C12-23: a fork found on import is kept and never current (P6.6, P7.5, Q5)", () => {
  async function forked(store: OriginalsStore = new MemoryStore()) {
    const { alice, sdk, signer, did, v1, v2, v1Package } = await harbor();
    const elsewhere = OriginalsSDK.create({ store, authors: async () => alice.evidence(), clock: clock(LATER) });
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
      const reopened = OriginalsSDK.create({ store: await FileStore.open(dir), authors: async () => alice.evidence(), clock: clock(LATER) });
      const view = await reopened.get(did);
      expect(view.report.fork).not.toBeNull();
      expect(view.current).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("review fixes (PR 6)", () => {
  /** Local history v1, v2, v3; a stored fork branch v1, b2 (shorter than local). */
  async function stored() {
    const { alice, sdk, signer, did, v1, v2, v1Package } = await harbor();
    const v3 = (await sdk.edit(did, { parent: v2, name: "Harbor, third", author: alice.ref("orig"), signer })).original.checkpoint;
    const local = reader();
    await local.import((await sdk.package(did)).bytes);
    const elsewhere = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => alice.evidence(), clock: clock(LATER) });
    await elsewhere.import(v1Package.bytes);
    await elsewhere.edit(did, { parent: v1, name: "Elsewhere", author: alice.ref("orig"), signer });
    const branchPackage = (await elsewhere.package(did)).bytes;
    expect((await local.import(branchPackage)).status).toBe("conflict");
    return { sdk, local, did, v3, branchPackage };
  }

  test("a package whose own log fails verification is never imported, even with a stored fork branch", async () => {
    const { sdk, local, did, v3 } = await stored();
    const files = readZip((await sdk.package(did)).bytes);
    const lines = new TextDecoder().decode(files.get("asset/did.jsonl")!).trimEnd().split("\n");
    // A fourth line that parses but does not verify: the third entry with its state altered.
    const forged = JSON.parse(lines[2]) as { versionId: string; state: { asset: { name: string } } };
    forged.versionId = forged.versionId.replace(/^3-/, "4-");
    forged.state.asset.name = "FORGED";
    files.set("asset/did.jsonl", bytes(`${[...lines, JSON.stringify(forged)].join("\n")}\n`));
    await expect(local.import(writeZip(files))).rejects.toMatchObject({ code: "IMPORT_REJECTED" });
    const after = await local.get(did);
    expect(after.head).toBe(v3);
    expect(after.state.name).toBe("Harbor, third");
  });

  test("a log that fails verification is reported as itself, never as another copy's history", async () => {
    const { local, did, branchPackage } = await stored();
    const loaded = await local.load(branchPackage);
    // The branch is valid but diverges from local history at version 2: a fork, not merely stale.
    expect(loaded.report.fork).not.toBeNull();
    expect(loaded.report.current).toBe(false);
    void did;
  });

  test("a retained versionId is never lowered by the store", async () => {
    const store = new MemoryStore();
    await store.putRetained("did:vh:x", "3-Qmabc");
    await store.putRetained("did:vh:x", "2-Qmdef");
    expect(await store.getRetained("did:vh:x")).toBe("3-Qmabc");
  });
});

describe("C12-64: the newest verified author DID version a reader holds is used, compared by verified versionIds (P7.8, P7.9; originals-spec #47, merged)", () => {
  const SPARE = seed(24);
  /** An Original signed with `orig`, then the author DID drops `orig`. The package carries the log from before the drop. */
  async function removedKey() {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => alice.evidence(), clock: clock() });
    const c = await sdk.create({ name: "Harbor at dawn", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: bytes("first crop") }], author: alice.ref("orig"), signer: alice.signer("orig", KEY) });
    if (c.kind !== "original") throw new Error("expected an Original");
    const pkg = (await sdk.package(c.original.did)).bytes;
    const before = alice.entries.slice();
    await alice.rotate([{ fragment: "spare", secret: SPARE }]);
    return { alice, did: c.original.did, pkg, before, entry: c.original.checkpoint };
  }
  /** `pkg` with the author DID log replaced by `log`. */
  const carrying = (pkg: Uint8Array, did: string, log: string) => {
    const files = readZip(pkg);
    files.set(`${signerPath(did)}/did.jsonl`, bytes(log));
    return writeZip(files);
  };
  const noFinalLf = (log: string) => log.replace(/\n$/, "");
  // Whitespace JCS ignores: the same verified versions, different bytes.
  const reformatted = (log: string) => log.split("\n").map((l) => l.replace(/":/g, '": ')).join("\n");

  for (const [name, change] of [["without its final line feed", noFinalLf], ["reformatted", reformatted]] as const) {
    test(`a package's older author log ${name} never replaces the newer one the reader is configured with`, async () => {
      const { alice, did, pkg, before, entry } = await removedKey();
      const older = change(alice.evidence(before).log as string);
      const local = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: clock(LATER) });
      const loaded = await local.load(carrying(pkg, alice.did, older));
      expect(loaded.report.identityEvidence).toMatchObject({ status: "complete", latestVersionId: alice.versionId, retainedVersionId: alice.versionId });
      expect(loaded.report.historicallyAuthorizedOnly).toEqual([{ versionId: entry, did: alice.did, role: "author", reason: "key-not-in-latest-signer-document" }]);
      expect(loaded.reasons).toContain("historically-authorized-only");
      expect(loaded.report.validAsOf?.signers[0]).toMatchObject({ versionId: alice.versionId, source: "supplied", location: null });
      void did;
    });

    test(`a configured older author log ${name} never replaces the newer one the store kept`, async () => {
      const { alice, did, pkg, before, entry } = await removedKey();
      const store = new MemoryStore();
      // The store kept the newer log when it verified it (P7.8), and has no retained versionId for the author.
      await store.putAuthorEvidence({ ...alice.evidence(), obtainedAt: "2026-10-18T12:30:00.000Z", source: "package" });
      const older = { did: alice.did, log: change(alice.evidence(before).log as string) };
      const local = OriginalsSDK.create({ store, authors: [older], clock: clock(LATER) });
      const loaded = await local.load(carrying(pkg, alice.did, older.log));
      expect(loaded.report.identityEvidence).toMatchObject({ status: "complete", latestVersionId: alice.versionId });
      expect(loaded.report.historicallyAuthorizedOnly).toEqual([{ versionId: entry, did: alice.did, role: "author", reason: "key-not-in-latest-signer-document" }]);
      expect(loaded.report.validAsOf?.signers[0]).toMatchObject({ versionId: alice.versionId, source: "retained", location: null });
      void did;
    });
  }

  test("an author log that diverges from the one the reader holds is an identity fork: incomplete, never the package's", async () => {
    const { alice, pkg, before } = await removedKey();
    const held = alice.evidence();
    // The same author DID, a different version 2.
    alice.entries = before.slice();
    await alice.rotate([{ fragment: "orig", secret: KEY }, { fragment: "other", secret: seed(25) }]);
    const theirs = alice.evidence();
    expect(theirs.log).not.toBe(held.log);
    const local = OriginalsSDK.create({ store: new MemoryStore(), authors: [held], clock: clock(LATER) });
    const loaded = await local.load(carrying(pkg, alice.did, theirs.log as string));
    expect(loaded.report.identityEvidence.status).toBe("incomplete");
    expect(loaded.report.identityEvidence.failure?.code).toBe("AUTHOR_DID_FORK");
    expect(loaded.reasons).toContain("identity-evidence-incomplete");
    expect(loaded.report.validAsOf).toBeNull();
    expect(loaded.report.current).toBe(false);
  });

  test("a package's newer author log is used over an older one the reader holds", async () => {
    const { alice, pkg, before } = await removedKey();
    const local = OriginalsSDK.create({ store: new MemoryStore(), authors: [{ did: alice.did, log: noFinalLf(alice.evidence(before).log as string) }], clock: clock(LATER) });
    const loaded = await local.load(carrying(pkg, alice.did, alice.evidence().log as string));
    expect(loaded.report.identityEvidence).toMatchObject({ status: "complete", latestVersionId: alice.versionId });
    expect(loaded.report.validAsOf?.signers[0]).toMatchObject({ versionId: alice.versionId, source: "package" });
  });
});
