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
const clockOver = (times: number[]) => new InscriptionClock(async (h) => times[h] ?? times[times.length - 1] + (h - times.length + 1) * 600);

function snapshot(publications: Array<{ id: string; height: number; content: string; mediaType?: string; complete?: boolean }>, tip = 10): SatSnapshot {
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
      creation: { height: p.height, blockHash: "bb".repeat(32), transactionIndex: 1, inscriptionIndex: 0 },
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
    const clock = new InscriptionClock(async () => Number.NaN);
    await expect(clock.at(0)).rejects.toMatchObject({ code: "BLOCK_TIME_UNAVAILABLE" });
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
});
