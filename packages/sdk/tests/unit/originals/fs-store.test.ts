import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OriginalsError } from "@originals/vh";
import { FileStore, fileRecoveryStore } from "../../../src/originals/fs-store.js";
import type { InscriptionRecoveryRecord } from "../../../src/bitcoin/inscription-recovery.js";
import { OriginalsSDK } from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KEY = seed(21);

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "originals-store-"));
}

async function withOriginal(dir: string, faults?: ConstructorParameters<typeof FileStore>[1]) {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const store = await FileStore.open(dir, faults);
  const sdk = OriginalsSDK.create({ store, authors: [alice.evidence()], clock: clock() });
  return { alice, store, sdk, signer: alice.signer("orig", KEY), author: alice.ref("orig") };
}

describe("FileStore: durable local commit (P6.2)", () => {
  test("commits survive reopening, bytes included", async () => {
    const dir = tempDir();
    try {
      const { sdk, signer, author, alice } = await withOriginal(dir);
      const c = await sdk.create({ name: "x", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: bytes("one") }], author, signer });
      if (c.kind !== "original") throw new Error("expected an Original");
      const reopened = OriginalsSDK.create({ store: await FileStore.open(dir), authors: [alice.evidence()], clock: clock() });
      const view = await reopened.get(c.original.did);
      expect(view.checkpoint).toBe(c.original.checkpoint);
      expect(view.report.reasons).toEqual(["not-anchored"]);
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

  test("the anchor reported for an anchored Original survives reopening, so a later change is reported (P9.16)", async () => {
    const dir = tempDir();
    try {
      const did = "did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ";
      const anchor = { inscription: `${"e".repeat(64)}i0`, sat: "did:btco:reg:5000000000", owner: `${"cc".repeat(32)}:0` };
      const store = await FileStore.open(dir);
      expect(await store.getRetainedAnchor(did)).toBeUndefined();
      await store.putRetainedAnchor(did, anchor);
      expect(await (await FileStore.open(dir)).getRetainedAnchor(did)).toEqual(anchor);
      expect(await store.getRetainedAnchor("did:vh:QmOther")).toBeUndefined();
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
      const reader = OriginalsSDK.create({ store: recovered, authors: [alice.evidence()], clock: clock(Date.parse("2026-10-18T12:10:00Z")) });
      const prior = await reader.get(c.original.did);
      expect(prior.checkpoint).toBe(c.original.checkpoint);
      expect(prior.report.reasons).toEqual(["not-anchored"]);
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
      const reader = OriginalsSDK.create({ store: await FileStore.open(dir), authors: [alice.evidence()], clock: clock() });
      const view = await reader.get(c.original.did);
      expect(view.report.resources.status).toBe("digest-failure");
      expect(view.current).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("FileStore: one writer per root (08b review C5)", () => {
  test("C12-14: two handles on one root in one process serialize commits: the second on the same parent is stale, none is lost", async () => {
    const dir = tempDir();
    try {
      const { sdk, signer, author, alice } = await withOriginal(dir);
      const c = await sdk.create({ name: "x", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: bytes("one") }], author, signer });
      if (c.kind !== "original") throw new Error("expected an Original");
      const other = OriginalsSDK.create({ store: await FileStore.open(dir), authors: [alice.evidence()], clock: clock(Date.parse("2026-10-18T12:05:00Z")) });
      const parent = c.original.checkpoint;
      const d1 = await sdk.prepareEdit(c.original.did, { parent, resources: [{ id: "photo", bytes: bytes("mine") }], author });
      const d2 = await other.prepareEdit(c.original.did, { parent, resources: [{ id: "photo", bytes: bytes("theirs") }], author });
      const results = await Promise.allSettled([sdk.commit(d1, signer), other.commit(d2, signer)]);
      const committed = results.filter((r) => r.status === "fulfilled" && r.value.status === "committed");
      expect(committed).toHaveLength(1);
      const winner = (committed[0] as PromiseFulfilledResult<{ original: { checkpoint: string } }>).value.original.checkpoint;
      const reader = OriginalsSDK.create({ store: await FileStore.open(dir), authors: [alice.evidence()], clock: clock(Date.parse("2026-10-18T12:10:00Z")) });
      expect((await reader.get(c.original.did)).checkpoint).toBe(winner);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("opening a root does not delete a temporary file another handle is writing", async () => {
    const dir = tempDir();
    try {
      const did = "did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ";
      const scidDir = join(dir, "originals", did.slice("did:vh:".length));
      let during: string[] = [];
      const faulty = await FileStore.open(dir, {
        beforeRename: async () => {
          // Another handle opens the root while this write's temporary file is in place.
          await FileStore.open(dir);
          during = readdirSync(scidDir).filter((f) => f.endsWith(".tmp"));
        },
      });
      await faulty.commit(did, { expectedHead: null, log: '{"versionId":"1-a"}\n' });
      expect(during).toHaveLength(1);
      expect((await faulty.get(did))?.log).toBe('{"versionId":"1-a"}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("close() hands the root to another process; until then that process is refused, and a closed handle refuses writes", async () => {
    const dir = tempDir();
    const script = join(dir, "..", `open-${process.pid}-${Date.now()}.ts`);
    try {
      writeFileSync(script, `import { FileStore } from ${JSON.stringify(new URL("../../../src/originals/fs-store.ts", import.meta.url).pathname)};\ntry { await FileStore.open(process.argv[2]); console.log("opened"); } catch (e) { console.log((e as { code?: string }).code); }\n`);
      const child = () => new TextDecoder().decode(Bun.spawnSync([process.execPath, script, dir]).stdout).trim();
      const a = await FileStore.open(dir);
      const b = await FileStore.open(dir);
      expect(child()).toBe("STORE_LOCKED");
      await a.close();
      expect(child()).toBe("STORE_LOCKED"); // b still holds the root
      await b.close();
      await b.close(); // idempotent
      expect(child()).toBe("opened");
      const refused = await a.commit("did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ", { expectedHead: null, log: '{"versionId":"1-a"}\n' }).then(() => undefined, (e: unknown) => e as OriginalsError);
      expect(refused?.code).toBe("STORE_CLOSED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(script, { force: true });
    }
  });

  test("a root held by another live process is refused clearly; a stale lock is taken over", async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, ".lock"), String(process.ppid));
      const refused = await FileStore.open(dir).then(() => undefined, (e: unknown) => e as OriginalsError);
      expect(refused).toBeInstanceOf(OriginalsError);
      expect(refused!.code).toBe("STORE_LOCKED");
      // A lock left by a process that no longer runs is stale.
      const dead = Bun.spawnSync(["true"]).pid;
      writeFileSync(join(dir, ".lock"), String(dead));
      expect(await FileStore.open(dir)).toBeInstanceOf(FileStore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const FS_STORE = new URL("../../../src/originals/fs-store.ts", import.meta.url).pathname;

  /** Start `count` processes that each open `dir` at the same instant, hold it briefly, and report. */
  async function race(dir: string, count: number): Promise<string[]> {
    const script = join(dir, "..", `race-${process.pid}-${Date.now()}.ts`);
    writeFileSync(
      script,
      `import { FileStore } from ${JSON.stringify(FS_STORE)};\nconst at = Number(process.argv[3]);\nwhile (Date.now() < at) {}\ntry { await FileStore.open(process.argv[2]); console.log("opened " + process.pid); await new Promise((r) => setTimeout(r, 400)); } catch (e) { console.log((e as { code?: string }).code); }\n`,
    );
    try {
      const at = Date.now() + 600;
      const children = Array.from({ length: count }, () => Bun.spawn([process.execPath, script, dir, String(at)], { stdout: "pipe" }));
      return await Promise.all(children.map(async (child) => (await new Response(child.stdout).text()).trim()));
    } finally {
      rmSync(script, { force: true });
    }
  }

  test("08b review r2 #1: processes racing to take over one stale lock leave exactly one holder", async () => {
    for (let trial = 0; trial < 4; trial++) {
      const dir = tempDir();
      try {
        writeFileSync(join(dir, ".lock"), String(Bun.spawnSync(["true"]).pid)); // stale: that process has exited
        const results = await race(dir, 6);
        const opened = results.filter((r) => r.startsWith("opened "));
        expect(opened).toHaveLength(1);
        expect(results.filter((r) => r === "STORE_LOCKED")).toHaveLength(5);
        // The winner's record is the lock; no takeover leftovers remain.
        expect(JSON.parse(readFileSync(join(dir, ".lock"), "utf8")).pid).toBe(Number(opened[0]!.slice("opened ".length)));
        expect(readdirSync(dir).filter((f) => f.startsWith(".lock."))).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("08b review r2 #1: processes racing to open a free root leave exactly one holder", async () => {
    const dir = tempDir();
    try {
      const results = await race(dir, 6);
      expect(results.filter((r) => r.startsWith("opened "))).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("08b review r2 #2: close() waits for every write in flight, not only commits; a closed handle refuses every write", async () => {
    const dir = tempDir();
    try {
      const a = await FileStore.open(dir);
      const digest = "zQmbyV4BASLJCFiCfKz37eNwFX8y6hefQ7LGpzvEwJQzNft";
      let written = false;
      const write = a.putResource(digest, new Uint8Array(32 * 1024 * 1024).fill(1)).then(() => {
        written = true;
      });
      const evidence = a.putAuthorEvidence({ did: "did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ", log: "{}\n" });
      await a.close();
      // The lock is released only after the writes landed, so a new process cannot sweep or race them.
      expect(written).toBe(true);
      expect(existsSync(join(dir, ".lock"))).toBe(false);
      await write;
      await evidence;
      expect(readdirSync(join(dir, "resources"))).toEqual([digest]);
      const did = "did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ";
      const refused = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: unknown) => e as OriginalsError))?.code;
      expect(await refused(a.putResource("zQmOther1", bytes("x")))).toBe("STORE_CLOSED");
      expect(await refused(a.putBranch(did, '{"versionId":"1-a"}\n'))).toBe("STORE_CLOSED");
      expect(await refused(a.putAuthorEvidence({ did, log: "{}\n" }))).toBe("STORE_CLOSED");
      expect(await refused(a.putRetained(did, "1-a"))).toBe("STORE_CLOSED");
      expect(await refused(a.commit(did, { expectedHead: null, log: '{"versionId":"1-a"}\n' }))).toBe("STORE_CLOSED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("08b review r2 #3: an open() racing the last close() in one process ends holding the lock", async () => {
    for (let i = 0; i < 20; i++) {
      const dir = tempDir();
      try {
        const a = await FileStore.open(dir);
        const closing = a.close();
        await new Promise((r) => setImmediate(r));
        const b = await FileStore.open(dir);
        await closing;
        expect(existsSync(join(dir, ".lock"))).toBe(true);
        expect(JSON.parse(readFileSync(join(dir, ".lock"), "utf8")).pid).toBe(process.pid);
        await b.close();
        expect(existsSync(join(dir, ".lock"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("08b review r4 #1: a worker thread of the holding process never takes over its live lock", async () => {
    const dir = tempDir();
    const script = join(dir, "..", `worker-${process.pid}-${Date.now()}.ts`);
    try {
      writeFileSync(
        script,
        `import { parentPort, workerData } from "node:worker_threads";\nimport { FileStore } from ${JSON.stringify(FS_STORE)};\ntry { await FileStore.open(workerData); parentPort!.postMessage("opened"); } catch (e) { parentPort!.postMessage((e as { code?: string }).code); }\n`,
      );
      const a = await FileStore.open(dir);
      const held = readFileSync(join(dir, ".lock"), "utf8");
      const { Worker } = await import("node:worker_threads");
      const worker = new Worker(script, { workerData: dir });
      const answer = await new Promise<unknown>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      await worker.terminate();
      expect(answer).toBe("STORE_LOCKED");
      expect(readFileSync(join(dir, ".lock"), "utf8")).toBe(held);
      await a.close();
      expect(existsSync(join(dir, ".lock"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(script, { force: true });
    }
  });

  test("08b review r4 #2: a takeover claim left by a taker that died is broken by a later opener, by exactly one", async () => {
    const { createHash } = await import("node:crypto");
    const claimOf = (text: string) => `.lock.break.${createHash("sha256").update(text).digest("hex").slice(0, 32)}`;
    const deadPid = () => Bun.spawnSync(["true"]).pid;
    // A live claimant is still taking over: refused.
    {
      const dir = tempDir();
      try {
        const stale = JSON.stringify({ pid: deadPid(), host: hostname(), token: "aa" });
        writeFileSync(join(dir, ".lock"), stale);
        writeFileSync(join(dir, claimOf(stale)), JSON.stringify({ pid: process.ppid, host: hostname(), token: "bb" }));
        expect((await FileStore.open(dir).then(() => undefined, (e: unknown) => e as OriginalsError))?.code).toBe("STORE_LOCKED");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    for (let trial = 0; trial < 3; trial++) {
      const dir = tempDir();
      try {
        const stale = JSON.stringify({ pid: deadPid(), host: hostname(), token: "aa" });
        writeFileSync(join(dir, ".lock"), stale);
        // The taker was killed between claiming the break and the rename.
        writeFileSync(join(dir, claimOf(stale)), JSON.stringify({ pid: deadPid(), host: hostname(), token: "bb" }));
        const results = await race(dir, 6);
        const opened = results.filter((r) => r.startsWith("opened "));
        expect(opened).toHaveLength(1);
        expect(results.filter((r) => r === "STORE_LOCKED")).toHaveLength(5);
        expect(JSON.parse(readFileSync(join(dir, ".lock"), "utf8")).pid).toBe(Number(opened[0]!.slice("opened ".length)));
        expect(readdirSync(dir).filter((f) => f.startsWith(".lock."))).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 30_000);

  test("08b review r2 #4: a lock is a record with a token; a reused pid is recognised where it can be, and an unconfirmable holder is refused", async () => {
    const dir = tempDir();
    try {
      // This process's pid under a token this thread never issued: another thread of this process, or an
      // earlier process that had the pid. Only a recorded start time that is not this process's tells (Linux).
      writeFileSync(join(dir, ".lock"), JSON.stringify({ pid: process.pid, host: hostname(), token: "f00d" }));
      expect((await FileStore.open(dir).then(() => undefined, (e: unknown) => e as OriginalsError))?.code).toBe("STORE_LOCKED");
      writeFileSync(join(dir, ".lock"), JSON.stringify({ pid: process.pid, host: hostname(), token: "f00d", start: "1" }));
      const earlier = await FileStore.open(dir).then((s) => s, (e: unknown) => e as OriginalsError);
      if (process.platform === "linux") {
        expect(earlier).toBeInstanceOf(FileStore);
        const record = JSON.parse(readFileSync(join(dir, ".lock"), "utf8"));
        expect(record).toMatchObject({ pid: process.pid, host: hostname() });
        expect(record.token).toMatch(/^[0-9a-f]{32}$/);
        await (earlier as FileStore).close();
      } else {
        expect((earlier as OriginalsError).code).toBe("STORE_LOCKED");
      }
      // Another host's holder cannot be checked: refused, never taken over.
      writeFileSync(join(dir, ".lock"), JSON.stringify({ pid: 1, host: `not-${hostname()}`, token: "f00d" }));
      expect((await FileStore.open(dir).then(() => undefined, (e: unknown) => e as OriginalsError))?.code).toBe("STORE_LOCKED");
      // An unreadable record is refused too.
      writeFileSync(join(dir, ".lock"), "");
      expect((await FileStore.open(dir).then(() => undefined, (e: unknown) => e as OriginalsError))?.code).toBe("STORE_LOCKED");
      // A live pid whose recorded start time is not that process's: a reused pid, stale where /proc tells (Linux).
      writeFileSync(join(dir, ".lock"), JSON.stringify({ pid: process.ppid, host: hostname(), token: "f00d", start: "1" }));
      const reused = await FileStore.open(dir).then((s) => s, (e: unknown) => e as OriginalsError);
      if (process.platform === "linux") expect(reused).toBeInstanceOf(FileStore);
      else expect((reused as OriginalsError).code).toBe("STORE_LOCKED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("refused candidates (P6.8)", () => {
  const DID = "did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ";
  const record = (n: number) => ({ label: "refused" as const, parent: "1-a", entry: `{"versionId":"2-${n}"}`, hostHead: "2-host" });

  test("C12-125: FileStore keeps refused candidates beside, never in, the committed log, across reopening", async () => {
    const dir = tempDir();
    try {
      const store = await FileStore.open(dir);
      await store.commit(DID, { expectedHead: null, log: '{"versionId":"1-a"}\n' });
      await store.putRefused(DID, record(1));
      await store.putRefused(DID, record(1)); // idempotent
      await store.putRefused(DID, record(2));
      const scidDir = join(dir, "originals", DID.slice("did:vh:".length));
      writeFileSync(join(scidDir, "refused", "x.json.abc.tmp"), "partial");
      const reopened = await FileStore.open(dir);
      expect(readdirSync(join(scidDir, "refused")).some((f) => f.endsWith(".tmp"))).toBe(false);
      expect((await reopened.getRefused(DID)).map((r) => r.entry).sort()).toEqual([record(1).entry, record(2).entry]);
      expect((await reopened.get(DID))?.log).toBe('{"versionId":"1-a"}\n');
      await reopened.dropRefused(DID, "2-1");
      await reopened.dropRefused(DID, "2-404");
      expect((await reopened.getRefused(DID)).map((r) => r.entry)).toEqual([record(2).entry]);
      expect(await reopened.list()).toEqual([DID]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("08b review r2 #2: a closed handle refuses refused-candidate and pending writes too, and close() waits for them", async () => {
    const dir = tempDir();
    try {
      const store = await FileStore.open(dir);
      const writes = [store.putRefused(DID, record(1)), store.putPending(DID, { parent: "1-a", entry: record(1).entry })];
      await store.close();
      expect(existsSync(join(dir, ".lock"))).toBe(false);
      await Promise.all(writes);
      const reopened = await FileStore.open(dir);
      expect((await reopened.getRefused(DID)).map((r) => r.entry)).toEqual([record(1).entry]);
      expect((await reopened.getPending(DID))?.entry).toBe(record(1).entry);
      await reopened.close();
      const code = async (p: Promise<unknown>) => (await p.then(() => undefined, (e: unknown) => e as OriginalsError))?.code;
      expect(await code(store.putRefused(DID, record(2)))).toBe("STORE_CLOSED");
      expect(await code(store.putPending(DID, null))).toBe("STORE_CLOSED");
      expect(await code(store.dropRefused(DID, "2-1"))).toBe("STORE_CLOSED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fileRecoveryStore: the Bitcoin writer's durable pairs (#975)", () => {
  const ID = "ab".repeat(32);
  const OTHER = "cd".repeat(32);
  const record = (broadcast: InscriptionRecoveryRecord["broadcast"], id = ID): InscriptionRecoveryRecord =>
    ({ recoveryId: id, broadcast, prepared: { commitTxId: id } as InscriptionRecoveryRecord["prepared"] });

  test("records survive a fresh store over the same directory, one file each, and are listed", async () => {
    const dir = tempDir();
    try {
      const store = fileRecoveryStore(join(dir, "recovery"));
      expect(await store.list()).toEqual([]);
      expect(await store.load(ID)).toBeUndefined();
      await store.save(record("prepared"));
      await store.save(record("commit_broadcast_unknown"));
      await store.save(record("prepared", OTHER));
      const reopened = fileRecoveryStore(join(dir, "recovery"));
      expect(await reopened.list()).toEqual([ID, OTHER]);
      expect(await reopened.load(ID)).toEqual(record("commit_broadcast_unknown"));
      expect(readdirSync(join(dir, "recovery")).sort()).toEqual([`${ID}.json`, `${OTHER}.json`]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a write torn by a crash is ignored: the previous record stays whole and nothing new is listed", async () => {
    const dir = tempDir();
    try {
      await fileRecoveryStore(dir).save(record("commit_broadcast_unknown"));
      // The process died mid-write: a partial temporary file beside the record, and one for a pair never saved.
      const torn = JSON.stringify(record("reveal_broadcast_unknown"));
      writeFileSync(join(dir, `${ID}.json.0a1b2c3d4e5f.tmp`), torn.slice(0, torn.length >> 1));
      writeFileSync(join(dir, `${OTHER}.json.f00dfeedbeef.tmp`), torn.slice(0, 10));
      const restarted = fileRecoveryStore(dir);
      expect(await restarted.list()).toEqual([ID]);
      expect(await restarted.load(ID)).toEqual(record("commit_broadcast_unknown"));
      expect(await restarted.load(OTHER)).toBeUndefined();
      // The next save replaces the record atomically, whatever temporary files remain.
      await restarted.save(record("reveal_broadcast"));
      expect(await fileRecoveryStore(dir).load(ID)).toEqual(record("reveal_broadcast"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a damaged record is refused, not read as absent; ids must be commit txids", async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, `${ID}.json`), "{\"recoveryId\":");
      await expect(fileRecoveryStore(dir).load(ID)).rejects.toMatchObject({ code: "RECOVERY_RECORD_DAMAGED" });
      await expect(fileRecoveryStore(dir).load("../escape")).rejects.toMatchObject({ code: "RECOVERY_ID_INVALID" });
      await expect(fileRecoveryStore(dir).save(record("prepared", "not-a-txid"))).rejects.toMatchObject({ code: "RECOVERY_ID_INVALID" });
      // A record filed under another id is not this pair.
      writeFileSync(join(dir, `${OTHER}.json`), JSON.stringify(record("prepared")));
      expect(await fileRecoveryStore(dir).load(OTHER)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
