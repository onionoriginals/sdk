/**
 * Bitcoin evidence in the SDK (plan 012; plan 011 PR 9a): inscription times,
 * sat snapshots as verifier evidence, and an anchored Original read through
 * the SDK. Chain facts are fixtures here; the writer and its real regtest
 * journey are PR 10.
 */
import { describe, expect, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import { ORIGINALS_INSCRIPTION_TYPE } from "@originals/vh/originals";
import type { SatSnapshot } from "../../../src/bitcoin/sat-snapshot-types.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileClockStore } from "../../../src/originals/fs-store.js";
import { InscriptionClock, MemoryStore, OriginalsSDK, btcoAlias, readZip, satEvidence, type BlockInfo } from "../../../src/originals/index.js";
import { SyntheticChain, memoryClockStore } from "../../../scripts/bench-inscription-clock.js";
import { Author, bytes, seed } from "./helpers.js";

const KEY = seed(21);
const SAT = "5000000000";
const T = Date.parse("2026-10-18T12:00:00Z") / 1000;

/** Header timestamps that go backwards at heights 2 and 5. */
const HEADERS = [T, T + 600, T + 300, T + 900, T + 1800, T + 1500];
/** A distinct 64-hex block hash per height and chain. */
const hashAt = (h: number, chain = "a") => `${chain}${h.toString(16).padStart(63, "0")}`;
const clockOver = (times: number[]) =>
  new InscriptionClock(async (h) => ({ time: times[h] ?? times[times.length - 1] + (h - times.length + 1) * 600, hash: hashAt(h) }));

function snapshot(publications: Array<{ id: string; height: number; content: string; mediaType?: string; complete?: boolean; blockHash?: string; metadata?: Uint8Array }>, tip = 10): SatSnapshot {
  return {
    network: "regtest",
    sat: SAT,
    tipBefore: { height: tip, hash: "aa".repeat(32) },
    tipAfter: { height: tip, hash: "aa".repeat(32) },
    indexTip: { height: tip, hash: "aa".repeat(32) },
    indexHealthy: true,
    enumerationComplete: true,
    blocks: [],
    publications: publications.map((p) => ({
      id: p.id,
      revealTxid: p.id.slice(0, 64),
      network: "regtest",
      sat: SAT,
      confirmed: true,
      creation: { height: p.height, blockHash: p.blockHash ?? hashAt(p.height), transactionIndex: 1, inscriptionIndex: 0 },
      body: p.complete === false ? { status: "unavailable" } : { status: "complete", mediaType: p.mediaType ?? ORIGINALS_INSCRIPTION_TYPE, bytes: bytes(p.content), metadata: p.metadata ?? null },
    })),
    ownership: { owner: "bcrt1qowner", satpoint: `${"cc".repeat(32)}:0:0` },
  };
}

describe("inscription time (P9.15)", () => {
  test("C12-45: a block whose timestamp is earlier than an ancestor's has the ancestors' greatest timestamp", async () => {
    const clock = clockOver(HEADERS);
    expect(await clock.at(1)).toBe((T + 600) * 1000);
    expect(await clock.at(2)).toBe((T + 600) * 1000); // its own time went back
    expect(await clock.at(4)).toBe((T + 1800) * 1000);
    expect(await clock.at(5)).toBe((T + 1800) * 1000);
    expect(await clock.at(3)).toBe((T + 900) * 1000);
  });

  test("a missing header timestamp is unavailable evidence, never a guess", async () => {
    const clock = new InscriptionClock(async () => ({ time: Number.NaN, hash: hashAt(0) }));
    await expect(clock.at(0)).rejects.toMatchObject({ code: "BLOCK_TIME_UNAVAILABLE" });
  });

  test("a reorganisation rewinds the clock to the fork point; a block no longer on the chain is refused", async () => {
    let chain = HEADERS.map((time, h) => ({ time, hash: hashAt(h) }));
    const clock = new InscriptionClock(async (h) => chain[h]);
    expect(await clock.at(5, hashAt(5))).toBe((T + 1800) * 1000);
    // Blocks 4 and 5 are replaced by blocks with earlier timestamps.
    chain = [...chain.slice(0, 4), { time: T + 1000, hash: hashAt(4, "f") }, { time: T + 1100, hash: hashAt(5, "f") }];
    expect(await clock.at(5, hashAt(5, "f"))).toBe((T + 1100) * 1000);
    expect(await clock.at(4, hashAt(4, "f"))).toBe((T + 1000) * 1000);
    expect(await clock.at(3, hashAt(3))).toBe((T + 900) * 1000);
    await expect(clock.at(4, hashAt(4))).rejects.toMatchObject({ code: "BLOCK_NOT_ON_CHAIN" });
  });

  test("#971: a read past the cache first checks the cached boundary, so an orphaned block's maximum never carries over (C12-45)", async () => {
    let headers = [
      { time: 10, hash: "1".repeat(64) },
      { time: 20, hash: "2".repeat(64) },
      { time: 100, hash: "3".repeat(64) },
    ];
    const clock = new InscriptionClock(async (height) => headers[height]);
    expect(await clock.at(2, headers[2].hash)).toBe(100_000);

    headers = [
      headers[0],
      headers[1],
      { time: 30, hash: "4".repeat(64) },
      { time: 40, hash: "5".repeat(64) },
    ];
    expect(await clock.at(3, headers[3].hash)).toBe(40_000);
    expect(await clock.at(2, headers[2].hash)).toBe(30_000);
    await expect(clock.at(2, "3".repeat(64))).rejects.toMatchObject({ code: "BLOCK_NOT_ON_CHAIN" });
  });

  test("#971: cached and fresh clocks agree after shallower and deeper reorganisations, with decreasing timestamps (C12-45)", async () => {
    let seed = 0x9e3779b9;
    const random = () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 2 ** 32);
    let fork = 0;
    const block = (time: number) => ({ time, hash: hashAt(fork, "b").slice(0, 32) + Math.floor(random() * 2 ** 32).toString(16).padStart(8, "0") + "0".repeat(24) });
    // Timestamps wander up and down around a rising trend, as Bitcoin's do within its rules.
    const extend = (chain: Array<{ time: number; hash: string }>, n: number) => {
      for (let i = 0; i < n; i++) chain.push(block(T + chain.length * 600 + Math.floor((random() - 0.6) * 7200)));
    };
    let chain: Array<{ time: number; hash: string }> = [];
    extend(chain, 40);
    const cached = new InscriptionClock(async (h) => chain[h]);
    // A clock that persists every block, and a new "process" restored from it each round (#973).
    const store = memoryClockStore();
    const persisted = new InscriptionClock(async (h) => chain[h], { network: "regtest", store, saveEvery: 1 });
    for (let round = 0; round < 60; round++) {
      // Replace the top `depth` blocks (shallow and deep), then grow past the old tip or not.
      fork++;
      const depth = [1, 2, 3, 8, 20, 35][round % 6];
      chain = chain.slice(0, Math.max(1, chain.length - depth));
      extend(chain, depth + Math.floor(random() * 4) - 1);
      const fresh = new InscriptionClock(async (h) => chain[h]);
      const restored = new InscriptionClock(async (h) => chain[h], { network: "regtest", store });
      const heights = [chain.length - 1, Math.floor(random() * chain.length), Math.max(0, chain.length - depth - 1)];
      for (const h of round % 2 ? heights : heights.reverse()) {
        const expected = await fresh.at(h, chain[h].hash);
        expect(expected).toBe(Math.max(...chain.slice(0, h + 1).map((b) => b.time)) * 1000); // P9.15 by definition
        expect(await cached.at(h, chain[h].hash)).toBe(expected);
        expect(await restored.at(h, chain[h].hash)).toBe(expected);
        expect(await cached.at(h)).toBe(expected);
      }
      await persisted.at(chain.length - 1);
    }
  });

  test("block hashes compare without regard to hex case", async () => {
    const clock = new InscriptionClock(async (h) => ({ time: HEADERS[h], hash: hashAt(h).toUpperCase() }));
    expect(await clock.at(3, hashAt(3))).toBe((T + 900) * 1000);
    expect(await clock.at(1)).toBe((T + 600) * 1000);
    expect(await clock.at(4, hashAt(4).toUpperCase())).toBe((T + 1800) * 1000);
  });

  test("a read with a hash that is not a block hash is refused", async () => {
    await expect(clockOver(HEADERS).at(1, "not-a-hash")).rejects.toMatchObject({ code: "BLOCK_HASH_INVALID" });
    await expect(clockOver(HEADERS).at(-1)).rejects.toMatchObject({ code: "BLOCK_HEIGHT_INVALID" });
  });

  test("an inscription in a block the clock does not find on the chain fails the read", async () => {
    const s = snapshot([{ id: `${"d".repeat(64)}i0`, height: 4, content: "{}\n" }]);
    s.publications[0].creation!.blockHash = hashAt(4, "f");
    await expect(satEvidence(s, { clock: clockOver(HEADERS), ownerConfirmations: 1, index: "ord-a" })).rejects.toMatchObject({ code: "BLOCK_NOT_ON_CHAIN" });
  });
});

describe("inscription time at scale (#973, P9.15)", () => {
  const sourceOf = (chain: SyntheticChain, extra: Partial<ConstructorParameters<typeof InscriptionClock>[1]> = {}) =>
    new InscriptionClock(chain.header, { network: "mainnet", headers: chain.headers, batch: 100, ...extra });

  test("a batched source derives the same times as one request per header, in a fraction of the requests", async () => {
    const chain = new SyntheticChain(1000, 3);
    const batched = sourceOf(chain);
    const single = new InscriptionClock(chain.header);
    expect(await batched.at(999, chain.hash(999))).toBe(chain.expected(999));
    expect(batched.stats).toMatchObject({ requests: 10, headers: 1000, blocks: 1000 });
    for (const h of [0, 1, 101, 202, 500, 999]) expect(await single.at(h)).toBe(chain.expected(h));
    expect(chain.decreasing()).toBeGreaterThan(50);
  });

  test("a restart reuses the saved state: a known block costs only the genesis check", async () => {
    const chain = new SyntheticChain(1000, 3);
    const store = memoryClockStore();
    const first = sourceOf(chain, { store });
    await first.flush(); // nothing read yet: nothing to save
    expect(store.bytes).toBeNull();
    await first.at(999);
    await first.flush();
    const second = sourceOf(chain, { store });
    await second.flush(); // not opened: the saved state is left alone
    expect(store.bytes).not.toBeNull();
    expect(await second.at(500, chain.hash(500))).toBe(chain.expected(500));
    expect(second.stats).toMatchObject({ requests: 1, restored: 1000 });
  });

  test("a saved state for another network is refused; one from another chain's genesis is refused", async () => {
    const chain = new SyntheticChain(300, 3);
    const store = memoryClockStore();
    const first = sourceOf(chain, { store });
    await first.at(299);
    await first.flush();
    await expect(sourceOf(chain, { store, network: "signet" }).at(10)).rejects.toMatchObject({ category: "invalid-evidence", code: "CLOCK_STORE_NETWORK_MISMATCH" });
    const other = new SyntheticChain(300, 4);
    await expect(sourceOf(other, { store }).at(10)).rejects.toMatchObject({ code: "BLOCK_SOURCE_NETWORK_MISMATCH" });
    expect(() => new InscriptionClock(chain.header, { store })).toThrow(OriginalsError);
  });

  test("a corrupt or truncated saved state is discarded and rebuilt from headers", async () => {
    const chain = new SyntheticChain(300, 3);
    const store = memoryClockStore();
    const first = sourceOf(chain, { store });
    await first.at(299);
    await first.flush();
    const good = store.bytes!;
    for (const bad of [
      (() => { const b = good.slice(); b[100] ^= 1; return b; })(), // a flipped hash bit
      good.slice(0, good.length - 7), // truncated
      new Uint8Array([1, 2, 3]),
      (() => { const b = good.slice(); new DataView(b.buffer).setUint32(8, 1, true); return b; })(), // wrong count
    ]) {
      store.bytes = bad;
      const clock = sourceOf(chain, { store });
      expect(await clock.at(250, chain.hash(250))).toBe(chain.expected(250));
      expect(clock.stats).toMatchObject({ discarded: "corrupt", restored: 0 });
    }
  });

  test("a reorganisation across the saved boundary rewinds a restarted clock to the fork point", async () => {
    const chain = new SyntheticChain(500, 3);
    const store = memoryClockStore();
    const first = sourceOf(chain, { store });
    await first.at(499);
    await first.flush();
    const orphan = chain.hash(495);
    chain.reorg(10, 2);
    const clock = sourceOf(chain, { store });
    expect(await clock.at(501, chain.hash(501))).toBe(chain.expected(501));
    for (let h = 485; h <= 501; h++) expect(await clock.at(h, chain.hash(h))).toBe(chain.expected(h));
    await expect(clock.at(495, orphan)).rejects.toMatchObject({ code: "BLOCK_NOT_ON_CHAIN" });
  });

  test("a request budget refuses with incomplete evidence, keeps progress, and a retry continues", async () => {
    const chain = new SyntheticChain(1000, 3);
    const clock = new InscriptionClock(chain.header, { maxRequests: 300 });
    const refused = await clock.at(999).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(OriginalsError);
    expect(refused).toMatchObject({ category: "incomplete-evidence", code: "BLOCK_TIME_BUDGET_EXCEEDED", details: { height: 999, blocks: 300, maxRequests: 300 } });
    expect(clock.stats.blocks).toBe(300);
    expect(await clock.at(999, chain.hash(999), { maxRequests: 701 })).toBe(chain.expected(999));
  });

  test("a cancelled read is incomplete evidence, before or during a request", async () => {
    const chain = new SyntheticChain(100, 3);
    const controller = new AbortController();
    controller.abort();
    const clock = new InscriptionClock(chain.header, { signal: controller.signal });
    await expect(clock.at(5)).rejects.toMatchObject({ category: "incomplete-evidence", code: "BLOCK_TIME_ABORTED" });
    expect(clock.stats.requests).toBe(0);
    const during = new AbortController();
    const hanging = new InscriptionClock((_h, signal) => new Promise<BlockInfo>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")))));
    const read = hanging.at(5, undefined, { signal: during.signal });
    during.abort();
    await expect(read).rejects.toMatchObject({ code: "BLOCK_TIME_ABORTED" });
    const s = snapshot([{ id: `${"d".repeat(64)}i0`, height: 4, content: "{}\n" }]);
    await expect(satEvidence(s, { clock: clockOver(HEADERS), ownerConfirmations: 1, index: "ord-a", signal: controller.signal })).rejects.toMatchObject({ code: "BLOCK_TIME_ABORTED" });
  });

  test("a block that does not extend the one before it means the chain moved mid-read: the clock reconciles", async () => {
    const chain = new SyntheticChain(400, 3);
    let reorgOnNextBatch = false;
    const clock = new InscriptionClock(chain.header, {
      batch: 100,
      headers: async (from, count) => {
        // The boundary check has passed; blocks from 140 up are replaced before the batch is served.
        if (reorgOnNextBatch) chain.reorg(chain.length - 140, 0, 50_000);
        reorgOnNextBatch = false;
        return chain.headers(from, count);
      },
    });
    await clock.at(150);
    reorgOnNextBatch = true;
    // Without the parent-hash check, blocks 151-155 of the new chain would sit on 140-150 of the old.
    expect(await clock.at(155)).toBe(chain.expected(155));
    for (const h of [139, 140, 150, 155, 399]) expect(await clock.at(h, chain.hash(h))).toBe(chain.expected(h));
  });

  test("concurrent reads are serialised and agree with sequential ones", async () => {
    const chain = new SyntheticChain(2000, 3);
    const clock = sourceOf(chain);
    const heights = [1999, 3, 1500, 700, 1999, 0, 1234];
    const times = await Promise.all(heights.map((h) => clock.at(h, chain.hash(h))));
    expect(times).toEqual(heights.map((h) => chain.expected(h)));
    expect(clock.stats.requests).toBe(20); // one cold walk in batches; reads of held blocks by hash are free
  });

  test("the file store (@originals/sdk/originals/fs) survives a restart and rebuilds a damaged file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "inscription-clock-"));
    try {
      const chain = new SyntheticChain(300, 3);
      const path = join(dir, "nested", "clock.bin");
      expect(await fileClockStore(path).load()).toBeNull();
      const first = sourceOf(chain, { store: fileClockStore(path) });
      await first.at(299);
      await first.flush();
      const second = sourceOf(chain, { store: fileClockStore(path) });
      expect(await second.at(299, chain.hash(299))).toBe(chain.expected(299));
      expect(second.stats).toMatchObject({ requests: 1, restored: 300 });
      writeFileSync(path, "garbage");
      const third = sourceOf(chain, { store: fileClockStore(path) });
      expect(await third.at(299, chain.hash(299))).toBe(chain.expected(299));
      expect(third.stats.discarded).toBe("corrupt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("sat snapshots as evidence", () => {
  test("maps chain position, depth, inscription time, the did:btco alias, the index, the placement it reports and the holder (P9.10, P9.11)", async () => {
    const e = await satEvidence(snapshot([{ id: `${"d".repeat(64)}i0`, height: 4, content: "{}\n" }]), { clock: clockOver(HEADERS), ownerConfirmations: 2, index: "ord-a" });
    expect(e.sat).toBe(btcoAlias("regtest", SAT));
    expect(e.sat).toBe("did:btco:reg:5000000000");
    expect(e.inscriptions[0]).toMatchObject({ height: 4, transactionIndex: 1, inscriptionIndex: 0, confirmations: 7, inscriptionTime: (T + 1800) * 1000 });
    expect(e.owner).toEqual({ output: `${"cc".repeat(32)}:0`, address: "bcrt1qowner", confirmations: 2 });
    expect(e.index).toBe("ord-a");
    // Placement is what the index reports for each inscription, not the sat the read was asked about.
    expect(e.inscriptions[0]).toMatchObject({ sat: SAT, network: "regtest", metadata: null });
    const meta = new Uint8Array([0xa0]);
    const tagged = await satEvidence(snapshot([{ id: `${"d".repeat(64)}i0`, height: 4, content: "{}\n", metadata: meta }]), { clock: clockOver(HEADERS), ownerConfirmations: 2, index: "ord-a" });
    expect(tagged.inscriptions[0].metadata).toEqual(meta);
  });

  test("a read must name the index that served it (P9.11)", async () => {
    await expect(satEvidence(snapshot([]), { clock: clockOver(HEADERS), ownerConfirmations: 1, index: "" })).rejects.toMatchObject({ code: "SAT_INDEX_REQUIRED" });
  });

  test("row 95: an inscription the reader could not read fails the whole read (P9.17; VH-Log PR 2)", async () => {
    const s = snapshot([{ id: `${"d".repeat(64)}i0`, height: 4, content: "", complete: false }]);
    await expect(satEvidence(s, { clock: clockOver(HEADERS), ownerConfirmations: 1, index: "ord-a" })).rejects.toMatchObject({ code: "SAT_READ_INCOMPLETE" });
    await expect(satEvidence({ ...snapshot([]), enumerationComplete: false }, { clock: clockOver(HEADERS), ownerConfirmations: 1, index: "ord-a" })).rejects.toBeInstanceOf(OriginalsError);
  });
});

describe("an anchored Original through the SDK (P9.10, P9.12)", () => {
  test("anchoring commits the entry; it counts only once the sat shows it inscribed", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    let t = Date.parse("2026-10-18T11:00:00Z");
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => alice.evidence(), freshness: "asserted", clock: () => (t += 1000) });
    const signer = alice.signer("orig", KEY);
    const c = await sdk.create({ name: "Harbor", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: bytes("one") }], author: alice.ref("orig"), signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    const sat = btcoAlias("regtest", SAT);
    const anchored = await sdk.anchor(c.original.did, { parent: c.original.checkpoint, author: alice.ref("orig"), signer, sat });
    expect(anchored.original.state.aliases).toEqual([sat]);
    expect(anchored.original.report.anchoring?.status).toBe("unverified");
    expect(anchored.original.current).toBe(false);
    await expect(sdk.anchor(c.original.did, { parent: anchored.original.checkpoint, author: alice.ref("orig"), signer, sat })).rejects.toMatchObject({ code: "ALREADY_ANCHORED" });

    // The adapter reads the sat: the anchoring inscription, the whole log through the anchoring entry, at height 4 (P9.17).
    const log = new TextDecoder().decode(readZip((await sdk.package(c.original.did)).bytes).get("asset/did.jsonl")!);
    const evidence = await satEvidence(snapshot([{ id: `${"e".repeat(64)}i0`, height: 4, content: log }]), { clock: clockOver(HEADERS), ownerConfirmations: 3, index: "ord-a" });
    const view = await sdk.get(c.original.did, { bitcoin: [evidence] });
    expect(view.report.anchoring).toMatchObject({ status: "anchored", sat, anchor: { height: 4, confirmations: 7 } });
    expect(view.report.ordering).toBe("anchored");
    expect(view.report.ownership).toMatchObject({ status: "provisional", output: `${"cc".repeat(32)}:0`, confirmations: 3, indexes: ["ord-a"] });
    expect(view.current, JSON.stringify(view.report.reasons)).toBe(true);

    // Row 105 (P9.16): the store keeps the anchor reported, so learning of an earlier anchoring
    // inscription is reported as a change of anchor, once, never silently.
    const earlier = await satEvidence(snapshot([
      { id: `${"d".repeat(64)}i0`, height: 3, content: log },
      { id: `${"e".repeat(64)}i0`, height: 4, content: log },
    ]), { clock: clockOver(HEADERS), ownerConfirmations: 3, index: "ord-a" });
    const changed = await sdk.get(c.original.did, { bitcoin: [earlier] });
    expect(changed.report.anchoring?.anchor?.inscription).toBe(`${"d".repeat(64)}i0`);
    expect(changed.report.anchoring?.conflicting.map((a) => a.inscription)).toEqual([`${"e".repeat(64)}i0`]);
    expect(changed.report.anchoring?.change?.previous.inscription).toBe(`${"e".repeat(64)}i0`);
    expect(changed.report.reasons).toContain("anchor-changed");
    expect(changed.current).toBe(false);
    const settled = await sdk.get(c.original.did, { bitcoin: [earlier] });
    expect(settled.report.anchoring?.change).toBeNull();
    expect(settled.current, JSON.stringify(settled.report.reasons)).toBe(true);
  });

  test("row 93: an anchored Original loads from Bitcoin alone, whatever copy the package holds", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    let t = Date.parse("2026-10-18T11:00:00Z");
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => alice.evidence(), freshness: "asserted", clock: () => (t += 1000) });
    const signer = alice.signer("orig", KEY);
    const c = await sdk.create({ name: "Harbor", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: bytes("one") }], author: alice.ref("orig"), signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    const anchored = await sdk.anchor(c.original.did, { parent: c.original.checkpoint, author: alice.ref("orig"), signer, sat: btcoAlias("regtest", SAT) });
    const pkg = await sdk.package(c.original.did);
    const log = new TextDecoder().decode(readZip(pkg.bytes).get("asset/did.jsonl")!);
    const evidence = await satEvidence(snapshot([{ id: `${"e".repeat(64)}i0`, height: 4, content: log }]), { clock: clockOver(HEADERS), ownerConfirmations: 1, index: "ord-a" });
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => alice.evidence(), freshness: "asserted", clock: () => t });
    const loaded = await reader.load(pkg.bytes, { bitcoin: [evidence] });
    expect(loaded.report.head).toBe(anchored.original.checkpoint);
    expect(loaded.report.anchoring).toMatchObject({ status: "anchored", copy: "agrees" });
    expect(loaded.report.current, JSON.stringify(loaded.report.reasons)).toBe(true);
  });

  test("#971: an orphaned block's later timestamp does not carry into the new chain and push an edit past the author's key rotation (C12-41, C12-45)", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    let t = Date.parse("2026-10-18T10:00:00Z");
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => alice.evidence(), freshness: "asserted", clock: () => (t += 1000) });
    const signer = alice.signer("orig", KEY);
    const ref = alice.ref("orig");
    const c = await sdk.create({ name: "Harbor", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: bytes("one") }], author: ref, signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    const sat = btcoAlias("regtest", SAT);
    const anchored = await sdk.anchor(c.original.did, { parent: c.original.checkpoint, author: ref, signer, sat });
    const edited = await sdk.edit(c.original.did, { parent: anchored.original.checkpoint, name: "Harbor at dawn", author: ref, signer });
    const lines = new TextDecoder().decode(readZip((await sdk.package(c.original.did)).bytes).get("asset/did.jsonl")!).trimEnd().split("\n");
    const anchorLog = lines.slice(0, -1).map((l) => `${l}\n`).join("");
    const editLine = `${lines[lines.length - 1]}\n`;

    const B = Date.parse("2026-10-18T10:10:00Z") / 1000;
    // Chain A: the edit is inscribed at height 2, whose header claims a time 50 minutes on.
    let chain = [
      { time: B, hash: hashAt(0) },
      { time: B + 60, hash: hashAt(1) },
      { time: B + 3000, hash: hashAt(2) },
    ];
    const clock = new InscriptionClock(async (h) => chain[h]);
    const first = await satEvidence(snapshot([
      { id: `${"e".repeat(64)}i0`, height: 1, content: anchorLog },
      { id: `${"f".repeat(64)}i0`, height: 2, content: editLine },
    ]), { clock, ownerConfirmations: 1, index: "ord-a" });
    expect(first.inscriptions[1].inscriptionTime).toBe((B + 3000) * 1000);

    // Block 2 is reorganised away; the edit is re-included at height 3 of the new chain, at 10:13.
    chain = [chain[0], chain[1], { time: B + 120, hash: hashAt(2, "b") }, { time: B + 180, hash: hashAt(3, "b") }];
    // The author removes the key at 10:30: after the edit's true inscription time, before the orphaned one.
    await alice.rotate([{ fragment: "orig2", secret: seed(22) }], "2026-10-18T10:30:00Z");
    t = Date.parse("2026-10-18T12:00:00Z");
    const evidence = await satEvidence(snapshot([
      { id: `${"e".repeat(64)}i0`, height: 1, content: anchorLog },
      { id: `${"f".repeat(64)}i0`, height: 3, content: editLine, blockHash: hashAt(3, "b") },
    ]), { clock, ownerConfirmations: 1, index: "ord-a" });
    const view = await sdk.get(c.original.did, { bitcoin: [evidence] });
    expect(view.report.anchoring?.ignored, JSON.stringify(view.report.anchoring?.ignored)).toEqual([]);
    expect(view.checkpoint).toBe(edited.original.checkpoint);
    expect(view.current, JSON.stringify(view.report.reasons)).toBe(true);
    expect(evidence.inscriptions[1].inscriptionTime).toBe((B + 180) * 1000);
  });
});
