import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OriginalsError } from "@originals/vh";
import { FileStore } from "../../../src/originals/fs-store.js";
import { OriginalsSDK } from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KEY = seed(21);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "originals-store-"));
}

async function withOriginal(dir: string, faults?: ConstructorParameters<typeof FileStore>[1]) {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const store = await FileStore.open(dir, faults);
  const sdk = OriginalsSDK.create({ store, authors: [alice.evidence()], freshness: "asserted", clock: clock() });
  return { alice, store, sdk, signer: alice.signer("orig", KEY), author: alice.ref("orig") };
}

describe("FileStore: durable local commit (P6.2)", () => {
  test("commits survive reopening, bytes included", async () => {
    const dir = tempDir();
    try {
      const { sdk, signer, author, alice } = await withOriginal(dir);
      const c = await sdk.create({ name: "x", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: bytes("one") }], author, signer });
      if (c.kind !== "original") throw new Error("expected an Original");
      const reopened = OriginalsSDK.create({ store: await FileStore.open(dir), authors: [alice.evidence()], freshness: "asserted", clock: clock() });
      const view = await reopened.get(c.original.did);
      expect(view.checkpoint).toBe(c.original.checkpoint);
      expect(view.current).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the store refuses a commit whose expected head is stale", async () => {
    const dir = tempDir();
    try {
      const store = await FileStore.open(dir);
      await store.commit("did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ", { expectedHead: null, log: '{"versionId":"1-a"}\n' });
      let caught: unknown;
      try {
        await store.commit("did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ", { expectedHead: null, log: '{"versionId":"1-b"}\n' });
      } catch (error) {
        caught = error;
      }
      expect((caught as OriginalsError).category).toBe("stale-parent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("C12-14: an interrupted commit recovers the prior or the fully committed checkpoint", async () => {
    const dir = tempDir();
    try {
      // Crash after the new log is written and synced, before it replaces the old one.
      let crash = false;
      const { sdk, signer, author, alice } = await withOriginal(dir, { beforeRename: () => { if (crash) throw new Error("power lost"); } });
      const c = await sdk.create({ name: "x", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: bytes("one") }], author, signer });
      if (c.kind !== "original") throw new Error("expected an Original");
      crash = true;
      await expect(sdk.edit(c.original.did, { parent: c.original.checkpoint, resources: [{ id: "photo", bytes: bytes("two") }], author, signer })).rejects.toThrow("power lost");

      const scidDir = join(dir, "originals", c.original.did.slice("did:vh:".length));
      expect(readdirSync(scidDir).some((f) => f.includes(".tmp"))).toBe(true);
      const recovered = await FileStore.open(dir);
      expect(readdirSync(scidDir).some((f) => f.includes(".tmp"))).toBe(false);
      const reader = OriginalsSDK.create({ store: recovered, authors: [alice.evidence()], freshness: "asserted", clock: clock(Date.parse("2026-10-18T12:10:00Z")) });
      const prior = await reader.get(c.original.did);
      expect(prior.checkpoint).toBe(c.original.checkpoint);
      expect(prior.current).toBe(true);
      // The staged bytes may remain but are not a committed version.
      expect(prior.resources.length).toBe(1);

      // The same edit, retried after recovery, commits fully.
      const done = await reader.edit(c.original.did, { parent: prior.checkpoint, resources: [{ id: "photo", bytes: bytes("two") }], author, signer });
      const later = OriginalsSDK.create({ store: await FileStore.open(dir), authors: [alice.evidence()], clock: clock(Date.parse("2026-10-18T12:20:00Z")) });
      expect((await later.get(c.original.did)).checkpoint).toBe(done.original.checkpoint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bytes read from storage are checked against their digest, not trusted (P8.1)", async () => {
    const dir = tempDir();
    try {
      const { sdk, signer, author, alice } = await withOriginal(dir);
      const c = await sdk.create({ name: "x", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: bytes("one") }], author, signer });
      if (c.kind !== "original") throw new Error("expected an Original");
      const [digest] = readdirSync(join(dir, "resources"));
      writeFileSync(join(dir, "resources", digest), "tampered");
      const reader = OriginalsSDK.create({ store: await FileStore.open(dir), authors: [alice.evidence()], freshness: "asserted", clock: clock() });
      const view = await reader.get(c.original.did);
      expect(view.report.resources.status).toBe("digest-failure");
      expect(view.current).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
