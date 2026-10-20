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
import { InscriptionClock, MemoryStore, OriginalsSDK, btcoAlias, readZip, satEvidence } from "../../../src/originals/index.js";
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

function snapshot(publications: Array<{ id: string; height: number; content: string; mediaType?: string; complete?: boolean; blockHash?: string }>, tip = 10): SatSnapshot {
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
      body: p.complete === false ? { status: "unavailable" } : { status: "complete", mediaType: p.mediaType ?? ORIGINALS_INSCRIPTION_TYPE, bytes: bytes(p.content), metadata: null },
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
    for (let round = 0; round < 60; round++) {
      // Replace the top `depth` blocks (shallow and deep), then grow past the old tip or not.
      fork++;
      const depth = [1, 2, 3, 8, 20, 35][round % 6];
      chain = chain.slice(0, Math.max(1, chain.length - depth));
      extend(chain, depth + Math.floor(random() * 4) - 1);
      const fresh = new InscriptionClock(async (h) => chain[h]);
      const heights = [chain.length - 1, Math.floor(random() * chain.length), Math.max(0, chain.length - depth - 1)];
      for (const h of round % 2 ? heights : heights.reverse()) {
        expect(await cached.at(h, chain[h].hash)).toBe(await fresh.at(h, chain[h].hash));
      }
    }
  });

  test("an inscription in a block the clock does not find on the chain fails the read", async () => {
    const s = snapshot([{ id: `${"d".repeat(64)}i0`, height: 4, content: "{}\n" }]);
    s.publications[0].creation!.blockHash = hashAt(4, "f");
    await expect(satEvidence(s, { clock: clockOver(HEADERS), ownerConfirmations: 1 })).rejects.toMatchObject({ code: "BLOCK_NOT_ON_CHAIN" });
  });
});

describe("sat snapshots as evidence", () => {
  test("maps chain position, depth, inscription time, the did:btco alias and the holder", async () => {
    const e = await satEvidence(snapshot([{ id: `${"d".repeat(64)}i0`, height: 4, content: "{}\n" }]), { clock: clockOver(HEADERS), ownerConfirmations: 2 });
    expect(e.sat).toBe(btcoAlias("regtest", SAT));
    expect(e.sat).toBe("did:btco:reg:5000000000");
    expect(e.inscriptions[0]).toMatchObject({ height: 4, transactionIndex: 1, inscriptionIndex: 0, confirmations: 7, inscriptionTime: (T + 1800) * 1000 });
    expect(e.owner).toEqual({ output: `${"cc".repeat(32)}:0`, address: "bcrt1qowner", confirmations: 2 });
    expect(e.indexes).toBe(1);
  });

  test("an inscription the reader could not read fails the whole read (VH-Log PR 2)", async () => {
    const s = snapshot([{ id: `${"d".repeat(64)}i0`, height: 4, content: "", complete: false }]);
    await expect(satEvidence(s, { clock: clockOver(HEADERS), ownerConfirmations: 1 })).rejects.toMatchObject({ code: "SAT_READ_INCOMPLETE" });
    await expect(satEvidence({ ...snapshot([]), enumerationComplete: false }, { clock: clockOver(HEADERS), ownerConfirmations: 1 })).rejects.toBeInstanceOf(OriginalsError);
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

    // The adapter reads the sat: the anchoring entry inscribed at height 4.
    const log = new TextDecoder().decode(readZip((await sdk.package(c.original.did)).bytes).get("asset/did.jsonl")!);
    const anchorLine = `${log.trimEnd().split("\n").pop()}\n`;
    const evidence = await satEvidence(snapshot([{ id: `${"e".repeat(64)}i0`, height: 4, content: anchorLine }]), { clock: clockOver(HEADERS), ownerConfirmations: 3 });
    const view = await sdk.get(c.original.did, { bitcoin: [evidence] });
    expect(view.report.anchoring).toMatchObject({ status: "anchored", sat, anchor: { height: 4, confirmations: 7 } });
    expect(view.report.ordering).toBe("anchored");
    expect(view.report.ownership).toMatchObject({ status: "provisional", output: `${"cc".repeat(32)}:0`, confirmations: 3 });
    expect(view.current, JSON.stringify(view.report.reasons)).toBe(true);
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
    const [anchorLine, editLine] = lines.slice(-2).map((l) => `${l}\n`);

    const B = Date.parse("2026-10-18T10:10:00Z") / 1000;
    // Chain A: the edit is inscribed at height 2, whose header claims a time 50 minutes on.
    let chain = [
      { time: B, hash: hashAt(0) },
      { time: B + 60, hash: hashAt(1) },
      { time: B + 3000, hash: hashAt(2) },
    ];
    const clock = new InscriptionClock(async (h) => chain[h]);
    const first = await satEvidence(snapshot([
      { id: `${"e".repeat(64)}i0`, height: 1, content: anchorLine },
      { id: `${"f".repeat(64)}i0`, height: 2, content: editLine },
    ]), { clock, ownerConfirmations: 1 });
    expect(first.inscriptions[1].inscriptionTime).toBe((B + 3000) * 1000);

    // Block 2 is reorganised away; the edit is re-included at height 3 of the new chain, at 10:13.
    chain = [chain[0], chain[1], { time: B + 120, hash: hashAt(2, "b") }, { time: B + 180, hash: hashAt(3, "b") }];
    // The author removes the key at 10:30: after the edit's true inscription time, before the orphaned one.
    await alice.rotate([{ fragment: "orig2", secret: seed(22) }], "2026-10-18T10:30:00Z");
    t = Date.parse("2026-10-18T12:00:00Z");
    const evidence = await satEvidence(snapshot([
      { id: `${"e".repeat(64)}i0`, height: 1, content: anchorLine },
      { id: `${"f".repeat(64)}i0`, height: 3, content: editLine, blockHash: hashAt(3, "b") },
    ]), { clock, ownerConfirmations: 1 });
    const view = await sdk.get(c.original.did, { bitcoin: [evidence] });
    expect(view.report.anchoring?.ignored, JSON.stringify(view.report.anchoring?.ignored)).toEqual([]);
    expect(view.checkpoint).toBe(edited.original.checkpoint);
    expect(view.current, JSON.stringify(view.report.reasons)).toBe(true);
    expect(evidence.inscriptions[1].inscriptionTime).toBe((B + 180) * 1000);
  });
});
