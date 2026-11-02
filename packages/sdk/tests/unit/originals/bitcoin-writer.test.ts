/**
 * The Bitcoin writer's refusals (plan 011 PR 10). The full journey, with real
 * transactions, is scripts/regtest/originals-anchor.ts on Bitcoin Core 31.1
 * and ord 0.29.0.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { parseWitness } from "micro-ordinals";
import { ORIGINALS_INSCRIPTION_MAX_BYTES, decodeCbor, encodeCbor, resourceDigest, type EditorGrant } from "@originals/vh/originals";
import { rawMetadataPerEnvelope } from "../../../src/bitcoin/ordinals-tags.js";
import { prepareInscriptionOnSat } from "../../../src/bitcoin/inscribe-on-sat.js";
import { inscriptionMetadata, inscriptionNotice } from "../../../src/originals/inscription.js";
import type { InscriptionRecoveryRecord, InscriptionRecoveryStore, PreparedInscriptionOnSat } from "../../../src/bitcoin/inscription-recovery.js";
import type { OrdinalsProvider } from "../../../src/adapters/types.js";
import type { BitcoinNetwork, SatSnapshot } from "../../../src/bitcoin/sat-snapshot-types.js";
import type { BitcoinSigner } from "../../../src/types/common.js";
import { InscriptionClock, MemoryStore, OriginalsSDK, btcoAlias, readZip } from "../../../src/originals/index.js";
import {
  catchUp, nextPendingEntry, prepareEntryInscription, readAnchored, resumeEntryInscription, resumeInscriptionOnSat, submitEntryInscription, submitPreparedInscriptionOnSat, transferHandoff, verifyHandoff,
  type EntryInscriptionParams,
} from "../../../src/originals/bitcoin-writer.js";
import { fileRecoveryStore } from "../../../src/originals/fs-store.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KEY = seed(21);
const SAT = "5000000000";
const T = Date.parse("2026-10-18T12:00:00Z") / 1000;
const utxo = { txid: "ab".repeat(32), vout: 0, value: 100_000, scriptPubKey: "0014" + "11".repeat(20) };
const satSigner: BitcoinSigner = { signAndFinalizeCommitPsbt: () => Promise.reject(new Error("not reached")) };
const INDEX = "ord-a";
const hashAt = (h: number) => h.toString(16).padStart(64, "0");
const blocks = () => new InscriptionClock(async (h) => ({ time: T + h * 600, hash: hashAt(h) }));

type Inscribed = string | { line: string; id?: string; height?: number; tx?: number };

/** Every resource version these tests write, by digest, so an inscription can carry its bytes (P9.17). */
const VERSIONS = new Map(["one", "two", "three", "bob's"].map((t) => [resourceDigest(bytes(t)), bytes(t)]));

/**
 * The body of an Originals inscription carrying `text`'s stored lines (P9.17, P14.12; originals-spec #53):
 * metadata, the CBOR of the entries as a JSON array; body, the resource version the last entry names;
 * content type, that version's media type.
 */
function carrying(text: string) {
  const entries = text.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l) as { state: { asset: { resource: { mediaType: string; digest: string } } } });
  const d = entries[entries.length - 1].state.asset.resource;
  return { status: "complete" as const, mediaType: d.mediaType, bytes: VERSIONS.get(d.digest) ?? new Uint8Array(), metadata: encodeCbor(entries) };
}

/** A complete read of SAT holding these entry lines, one inscription each from height 10 unless placed. */
function snapshot(lines: Inscribed[], network: BitcoinNetwork = "regtest"): SatSnapshot {
  const tip = { height: 20, hash: hashAt(20) };
  return {
    network, sat: SAT, tipBefore: tip, tipAfter: tip, indexTip: tip, indexHealthy: true, enumerationComplete: true, blocks: [],
    publications: lines.map((p, k) => typeof p === "string" ? { line: p } : p).map(({ line, id, height, tx }, k) => ({
      id: id ?? `${(k + 1).toString(16).padStart(64, "e")}i0`, revealTxid: "e".repeat(64), network, sat: SAT, confirmed: true,
      creation: { height: height ?? 10 + k, blockHash: hashAt(height ?? 10 + k), transactionIndex: tx ?? 1, inscriptionIndex: 0 },
      body: carrying(line),
    })),
    ownership: { owner: "bcrt1qholder", satpoint: `${"cc".repeat(32)}:0:0` },
  };
}

const provider = (sat: string, read: SatSnapshot = snapshot([])) =>
  ({
    getFirstSatOfOutput: () => Promise.resolve(sat),
    getSatSnapshot: () => Promise.resolve(read),
    getTransactionStatus: () => Promise.resolve({ confirmed: true, confirmations: 3 }),
  }) as unknown as OrdinalsProvider;

async function original(anchorTo?: string, edits = 0) {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => alice.evidence(), freshness: "asserted", clock: clock() });
  const signer = alice.signer("orig", KEY);
  const c = await sdk.create({ name: "Harbor", resource: { mediaType: "image/jpeg", bytes: bytes("one") }, author: alice.ref("orig"), signer });
  if (c.kind !== "original") throw new Error("expected an Original");
  let parent = c.original.checkpoint;
  if (anchorTo) parent = (await sdk.anchor(c.original.did, { parent, author: alice.ref("orig"), signer, sat: anchorTo })).original.checkpoint;
  for (let k = 0; k < edits; k++) parent = (await sdk.edit(c.original.did, { parent, name: `Harbor ${k}`, author: alice.ref("orig"), signer })).original.checkpoint;
  const lines = async () => new TextDecoder().decode(readZip((await sdk.package(c.original.did)).bytes).get("asset/did.jsonl")!).trimEnd().split("\n");
  return { sdk, did: c.original.did, lines, alice, signer };
}

const prepare = (sdk: OriginalsSDK, did: string, network: "regtest" | "mainnet", p: OrdinalsProvider, versionId?: string) =>
  prepareEntryInscription({ sdk, did, fundingUtxos: [utxo], satSigner, changeAddress: "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080", feeRate: 2, network, provider: p, clock: blocks(), index: INDEX, recoveryStore: null, ...(versionId ? { versionId } : {}) });

describe("inscribing an Original's head entry (P9.10, P9.12)", () => {
  test("an Original that is not anchored has nothing to inscribe yet", async () => {
    const { sdk, did } = await original();
    await expect(prepare(sdk, did, "regtest", provider(SAT))).rejects.toMatchObject({ code: "NOT_ANCHORED" });
  });

  test("the writer's network must be the anchoring sat's", async () => {
    const { sdk, did } = await original(btcoAlias("regtest", SAT));
    await expect(prepare(sdk, did, "mainnet", provider(SAT))).rejects.toMatchObject({ code: "NETWORK_MISMATCH" });
  });

  test("the first funding UTXO must hold the anchoring sat, so only its holder can extend the Original", async () => {
    const { sdk, did } = await original(btcoAlias("regtest", SAT));
    await expect(prepare(sdk, did, "regtest", provider("6000000000"))).rejects.toMatchObject({ code: "WRONG_SAT" });
  });
});

const idOf = (line: string) => (JSON.parse(line) as { versionId: string }).versionId;
/** The anchoring inscription's body lines: the stored log from genesis through the anchoring entry (P9.17). */
const anchorBody = (all: string[], anchor = 1) => all.slice(0, anchor + 1).join("\n");

describe("the writer's sat reads are asset reads (P9.12; r4 finding 6)", () => {
  test("they fetch only Originals bodies, so the sat's holder's other inscriptions cost no body reads", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT));
    const asked: unknown[] = [];
    const p = { ...provider(SAT), getSatSnapshot: (_sat: string, options?: unknown) => (asked.push(options), Promise.resolve(snapshot([]))) } as unknown as OrdinalsProvider;
    // The test signer stops at signing, after the sat was read.
    await expect(prepare(sdk, did, "regtest", p)).rejects.toThrow("not reached");
    expect(asked.length).toBeGreaterThan(0);
    for (const options of asked) expect(options).toEqual({ bodies: "originals" });
    expect((await lines()).length).toBe(2);
  });
});

describe("an explicitly requested entry must be the next one Bitcoin can accept (P9.13)", () => {
  test("before the anchor is on Bitcoin, only the anchoring entry can be inscribed", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 1);
    const all = await lines();
    await expect(prepare(sdk, did, "regtest", provider(SAT), idOf(all[2]))).rejects.toMatchObject({ code: "HEAD_NOT_NEXT" });
  });

  test("an entry Bitcoin already shows is not inscribed again", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT));
    const all = await lines();
    await expect(prepare(sdk, did, "regtest", provider(SAT, snapshot([anchorBody(all)])), idOf(all[1]))).rejects.toMatchObject({ code: "HEAD_NOT_NEXT" });
    await expect(prepare(sdk, did, "regtest", provider(SAT, snapshot([anchorBody(all)])))).rejects.toMatchObject({ code: "NOTHING_TO_INSCRIBE" });
  });

  test("an entry that skips one Bitcoin does not show is refused", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 2);
    const all = await lines();
    await expect(prepare(sdk, did, "regtest", provider(SAT, snapshot([anchorBody(all)])), idOf(all[3]))).rejects.toMatchObject({ code: "HEAD_NOT_NEXT" });
  });

  test("an entry the store does not hold is refused", async () => {
    const { sdk, did } = await original(btcoAlias("regtest", SAT), 1);
    await expect(prepare(sdk, did, "regtest", provider(SAT), "9-zzz")).rejects.toMatchObject({ code: "ENTRY_NOT_STORED" });
  });

  test("the entry after Bitcoin's head, and the anchoring entry itself, go on to signing", async () => {
    const anchoring = await original(btcoAlias("regtest", SAT));
    await expect(prepare(anchoring.sdk, anchoring.did, "regtest", provider(SAT))).rejects.toThrow("not reached");
    const next = await original(btcoAlias("regtest", SAT), 1);
    const all = await next.lines();
    await expect(prepare(next.sdk, next.did, "regtest", provider(SAT, snapshot([anchorBody(all)])))).rejects.toThrow("not reached");
  });
});

describe("reading an anchored Original back", () => {
  test("a read of another network than the anchoring sat's is refused", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT));
    const all = await lines();
    await expect(readAnchored(sdk, did, { provider: provider(SAT, snapshot([anchorBody(all)], "mainnet")), clock: blocks(), index: INDEX })).rejects.toMatchObject({ code: "NETWORK_MISMATCH" });
    const view = await readAnchored(sdk, did, { provider: provider(SAT, snapshot([anchorBody(all)])), clock: blocks(), index: INDEX });
    expect(view.report.anchoring?.status).toBe("anchored");
  });
});

// A wallet that really signs, so prepared pairs carry real bytes to check and resume.
const walletKey = seed(33);
const wallet = btc.p2wpkh(secp256k1.getPublicKey(walletKey, true), { ...btc.TEST_NETWORK, bech32: "bcrt" });
const realSigner: BitcoinSigner = {
  signAndFinalizeCommitPsbt(psbt) {
    const tx = btc.Transaction.fromPSBT(Buffer.from(psbt, "base64"), { allowUnknownOutputs: true });
    tx.sign(walletKey);
    tx.finalize();
    return Promise.resolve(tx.hex);
  },
};
/** The output holding the anchoring sat, as the snapshot's ownership names it. */
const holder = { txid: "cc".repeat(32), vout: 0, value: 10_000, scriptPubKey: hex.encode(wallet.script) };
const fee = { txid: "dd".repeat(32), vout: 1, value: 100_000, scriptPubKey: hex.encode(wallet.script) };
const parse = (raw: string) => btc.Transaction.fromRaw(hex.decode(raw), { allowUnknownInputs: true, allowUnknownOutputs: true });
const scriptOf = (p: PreparedInscriptionOnSat) => btc.Script.decode(parse(p.revealTxHex).getInput(0).finalScriptWitness![1]);
/** The entries a prepared reveal's metadata carries, as stored lines, its pushes concatenated first (P14.12). */
const inscribed = (p: PreparedInscriptionOnSat) =>
  (decodeCbor(rawMetadataPerEnvelope(scriptOf(p), 1)[0]!) as unknown[]).map((e) => `${JSON.stringify(e)}\n`).join("");
/** A prepared reveal's body and content type: the resource version its last entry names (P9.17). */
const bodyOf = (p: PreparedInscriptionOnSat) => {
  const [i] = parseWitness(parse(p.revealTxHex).getInput(0).finalScriptWitness!)!;
  return { body: i.body, contentType: i.tags.contentType, contentEncoding: i.tags.contentEncoding };
};

/**
 * A node: reads SAT as `read`, confirms the holder and the txids in `confirmed`, records broadcasts.
 * With `seesMempool` it reports `inMempool` for unconfirmed txids: true for `mempool` and anything it
 * was sent, false otherwise; without it, it cannot tell.
 */
function node(read: SatSnapshot, confirmed: string[] = [], { mempool = [], seesMempool = false }: { mempool?: string[]; seesMempool?: boolean } = {}) {
  const sent: string[] = [];
  const known = new Set([holder.txid, ...confirmed]);
  const pool = new Set(mempool);
  const p = {
    getFirstSatOfOutput: () => Promise.resolve(SAT),
    getSatSnapshot: () => Promise.resolve(read),
    getTransactionStatus: (txid: string) => Promise.resolve(known.has(txid) ? { confirmed: true, confirmations: 3 } : seesMempool ? { confirmed: false, inMempool: pool.has(txid) } : { confirmed: false }),
    broadcastTransaction: (raw: string) => (sent.push(raw), pool.add(parse(raw).id), Promise.resolve(parse(raw).id)),
  } as unknown as OrdinalsProvider;
  return { provider: p, sent };
}
/** A node that can see its mempool (`inMempool`), holding `mempool`. */
const seeing = (read: SatSnapshot, confirmed: string[] = [], mempool: string[] = []) => node(read, confirmed, { mempool, seesMempool: true });

function recovery() {
  const records = new Map<string, InscriptionRecoveryRecord>();
  const store: InscriptionRecoveryStore = {
    save: (r) => Promise.resolve(void records.set(r.recoveryId, structuredClone(r))),
    load: (id) => Promise.resolve(structuredClone(records.get(id))),
  };
  const put = (prepared: PreparedInscriptionOnSat, broadcast: InscriptionRecoveryRecord["broadcast"]) =>
    records.set(prepared.commitTxId, { recoveryId: prepared.commitTxId, prepared: structuredClone(prepared), broadcast });
  return { records, store, put, ids: () => [...records.keys()] };
}

const pairFor = (sdk: OriginalsSDK, did: string, p: OrdinalsProvider, versionId?: string, extra: Partial<EntryInscriptionParams> = {}) =>
  prepareEntryInscription({ sdk, did, fundingUtxos: [holder, fee], satSigner: realSigner, changeAddress: wallet.address!, feeRate: 2, network: "regtest", provider: p, clock: blocks(), index: INDEX, recoveryStore: null, ...(versionId ? { versionId } : {}), ...extra });

const step = (sdk: OriginalsSDK, did: string, p: OrdinalsProvider, r: ReturnType<typeof recovery>) =>
  catchUp({ sdk, did, provider: p, clock: blocks(), index: INDEX, recoveryStore: r.store, recoveryIds: r.ids() });

describe("catching up entries committed but not yet inscribed (P9.4, P9.13)", () => {
  test("C12-28: edits committed before the anchor is published: the log through the anchoring entry goes first, then one entry per inscription", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 2);
    const all = await lines();
    const before = await nextPendingEntry(sdk, did, { provider: provider(SAT), clock: blocks(), index: INDEX });
    expect(before).toMatchObject({ committed: idOf(all[3]), accepted: null, next: idOf(all[1]), queue: all.slice(1).map(idOf), remaining: 3 });
    const anchorPair = await pairFor(sdk, did, node(snapshot([])).provider);
    expect(anchorPair.versionId).toBe(idOf(all[1]));
    // The anchoring inscription is the whole stored log through the anchoring entry, exact lines, in order (P9.17).
    expect(inscribed(anchorPair.prepared)).toBe(`${all[0]}\n${all[1]}\n`);
    expect(anchorPair.remaining).toBe(2);
    // Once Bitcoin shows the anchor, the first edit is next.
    const after = await nextPendingEntry(sdk, did, { provider: provider(SAT, snapshot([anchorBody(all)])), clock: blocks(), index: INDEX });
    expect(after).toMatchObject({ committed: idOf(all[3]), accepted: idOf(all[1]), acceptedHeight: 10, next: idOf(all[2]), remaining: 2 });
    expect(inscribed((await pairFor(sdk, did, node(snapshot([anchorBody(all)])).provider)).prepared)).toBe(`${all[2]}\n`);
    expect(await lines()).toEqual(all); // nothing re-signed or rebased
  });

  test("several edits after anchoring are published one at a time, each after the head Bitcoin shows (C12-28, C12-30)", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 3);
    const all = await lines();
    const r = recovery();
    for (let k = 1; k <= 3; k++) {
      const read = snapshot([anchorBody(all), ...all.slice(2, k + 1)]);
      const pending = await nextPendingEntry(sdk, did, { provider: provider(SAT, read), clock: blocks(), index: INDEX });
      expect(pending).toMatchObject({ accepted: idOf(all[k]), acceptedHeight: 9 + k, next: idOf(all[k + 1]), remaining: 4 - k });
      expect(pending.view.current).toBe(true);
      const plan = await step(sdk, did, node(read).provider, r);
      expect(plan).toMatchObject({ action: "prepare", versionId: idOf(all[k + 1]) });
      expect(inscribed((await pairFor(sdk, did, node(read).provider)).prepared)).toBe(`${all[k + 1]}\n`);
    }
    const caughtUp = snapshot([anchorBody(all), ...all.slice(2)]);
    expect(await step(sdk, did, node(caughtUp).provider, r)).toMatchObject({ action: "done", pending: { next: null, remaining: 0, accepted: idOf(all[4]) } });
    await expect(pairFor(sdk, did, node(caughtUp).provider)).rejects.toMatchObject({ code: "NOTHING_TO_INSCRIBE" });
    expect(await lines()).toEqual(all);
  });

  test("a reveal already broadcast is waited on, never prepared again (C12-40)", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 2);
    const all = await lines();
    const read = snapshot([anchorBody(all)]);
    const r = recovery();
    expect(await step(sdk, did, node(read).provider, r)).toMatchObject({ action: "prepare", versionId: idOf(all[2]) });
    const pair = await pairFor(sdk, did, node(read).provider);
    r.put(pair.prepared, "reveal_broadcast");
    const plan = await step(sdk, did, node(read).provider, r);
    expect(plan).toMatchObject({ action: "wait-for-confirmation", reason: "unconfirmed", versionId: idOf(all[2]), recoveryId: pair.prepared.commitTxId, inscriptionId: pair.prepared.inscriptionId });
  });

  test("an interrupted pair is resumed as the same pair, then the queue moves on without re-inscribing it (C12-40)", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 2);
    const all = await lines();
    const read = snapshot([anchorBody(all)]);
    const r = recovery();
    const pair = await pairFor(sdk, did, node(read).provider);
    r.put(pair.prepared, "commit_broadcast_unknown"); // the process died between the two broadcasts
    const chain = node(read);
    const plan = await step(sdk, did, chain.provider, r);
    expect(plan).toMatchObject({ action: "resume", versionId: idOf(all[2]), recoveryId: pair.prepared.commitTxId, broadcast: "commit_broadcast_unknown" });
    if (plan.action !== "resume") throw new Error("unreachable");
    const resumed = await resumeInscriptionOnSat({ recoveryId: plan.recoveryId, provider: chain.provider, recoveryStore: r.store });
    expect(resumed.revealTxId).toBe(pair.prepared.revealTxId);
    expect(chain.sent).toEqual([pair.prepared.signedCommitHex, pair.prepared.revealTxHex]);
    // Broadcast, not yet mined: wait, do not prepare a duplicate.
    expect(await step(sdk, did, chain.provider, r)).toMatchObject({ action: "wait-for-confirmation", recoveryId: pair.prepared.commitTxId });
    // Mined and accepted: the record is for an entry Bitcoin accepted, so the next entry is prepared, nothing resumed.
    const mined = node(snapshot([anchorBody(all), { line: all[2], id: pair.prepared.inscriptionId }]), [pair.prepared.commitTxId, pair.prepared.revealTxId]);
    expect(await step(sdk, did, mined.provider, r)).toMatchObject({ action: "prepare", versionId: idOf(all[3]), replaces: [] });
    expect(mined.sent).toEqual([]);
  });

  test("after a restart, catchUp lists a file recovery store itself and resumes the same pair (#975, C12-40)", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 2);
    const all = await lines();
    const read = snapshot([anchorBody(all)]);
    const dir = mkdtempSync(join(tmpdir(), "originals-recovery-"));
    try {
      const pair = await pairFor(sdk, did, node(read).provider);
      // The writer persisted the pair and died between the two broadcasts.
      await fileRecoveryStore(dir).save({ recoveryId: pair.prepared.commitTxId, prepared: pair.prepared, broadcast: "reveal_broadcast_unknown" });
      // A fresh store over the same directory: no recovery ids passed.
      const reopened = fileRecoveryStore(dir);
      const chain = node(read);
      const plan = await catchUp({ sdk, did, provider: chain.provider, clock: blocks(), index: INDEX, recoveryStore: reopened });
      expect(plan).toMatchObject({ action: "resume", versionId: idOf(all[2]), recoveryId: pair.prepared.commitTxId });
      const resumed = await resumeInscriptionOnSat({ recoveryId: pair.prepared.commitTxId, provider: chain.provider, recoveryStore: reopened });
      expect([resumed.commitTxId, resumed.revealTxId, resumed.inscriptionId]).toEqual([pair.prepared.commitTxId, pair.prepared.revealTxId, pair.prepared.inscriptionId]);
      expect(await catchUp({ sdk, did, provider: chain.provider, clock: blocks(), index: INDEX, recoveryStore: fileRecoveryStore(dir) }))
        .toMatchObject({ action: "wait-for-confirmation", recoveryId: pair.prepared.commitTxId });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a store that cannot list needs the recovery ids passed", async () => {
    const { sdk, did } = await original(btcoAlias("regtest", SAT), 1);
    const r = recovery();
    await expect(catchUp({ sdk, did, provider: node(snapshot([])).provider, clock: blocks(), index: INDEX, recoveryStore: r.store }))
      .rejects.toMatchObject({ code: "RECOVERY_IDS_REQUIRED" });
    // A listing store is used when no ids are given; passed ids still take precedence.
    const listing = { ...r.store, list: () => Promise.resolve(r.ids()) };
    expect(await catchUp({ sdk, did, provider: node(snapshot([])).provider, clock: blocks(), index: INDEX, recoveryStore: listing })).toMatchObject({ action: "prepare" });
  });

  test("a pair whose input has moved on is not resumed", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 1);
    const all = await lines();
    const r = recovery();
    const pair = await pairFor(sdk, did, node(snapshot([anchorBody(all)])).provider);
    r.put(pair.prepared, "prepared");
    const moved = snapshot([anchorBody(all)]);
    moved.ownership = { owner: "bcrt1qholder", satpoint: `${"ff".repeat(32)}:0:0` };
    expect(await step(sdk, did, node(moved).provider, r)).toMatchObject({ action: "prepare", versionId: idOf(all[2]) });
  });

  test("a reorganisation during catch-up re-derives the queue from the head Bitcoin shows (C12-40)", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 3);
    const all = await lines();
    const r = recovery();
    const second = await pairFor(sdk, did, node(snapshot([anchorBody(all), all[2]])).provider);
    expect(second.versionId).toBe(idOf(all[3]));
    r.put(second.prepared, "reveal_broadcast");
    const shown = snapshot([anchorBody(all), all[2], { line: all[3], id: second.prepared.inscriptionId }]);
    expect(await nextPendingEntry(sdk, did, { provider: node(shown, [second.prepared.revealTxId]).provider, clock: blocks(), index: INDEX })).toMatchObject({ next: idOf(all[4]), remaining: 1 });
    // The block holding the second edit is replaced: its reveal is back in the mempool.
    const reorged = snapshot([anchorBody(all), all[2]]);
    const pending = await nextPendingEntry(sdk, did, { provider: node(reorged).provider, clock: blocks(), index: INDEX });
    expect(pending).toMatchObject({ accepted: idOf(all[2]), next: idOf(all[3]), queue: [idOf(all[3]), idOf(all[4])], remaining: 2 });
    expect(await step(sdk, did, node(reorged).provider, r)).toMatchObject({ action: "wait-for-confirmation", reason: "unconfirmed", recoveryId: second.prepared.commitTxId });
    // The new chain mines it in the same block as its parent: Bitcoin ignores it (P9.13), so a replacement is prepared.
    const sameBlock = snapshot([anchorBody(all), { line: all[2], height: 11 }, { line: all[3], id: second.prepared.inscriptionId, height: 11, tx: 2 }]);
    const plan = await step(sdk, did, node(sameBlock, [second.prepared.commitTxId, second.prepared.revealTxId]).provider, r);
    expect(plan).toMatchObject({ action: "prepare", versionId: idOf(all[3]), replaces: [second.prepared.inscriptionId] });
  });

  test("a confirmed reveal the sat read does not show yet is waited on, not paid for twice", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 1);
    const all = await lines();
    const r = recovery();
    const read = snapshot([anchorBody(all)]);
    const pair = await pairFor(sdk, did, node(read).provider);
    r.put(pair.prepared, "reveal_broadcast");
    expect(await step(sdk, did, node(read, [pair.prepared.commitTxId, pair.prepared.revealTxId]).provider, r))
      .toMatchObject({ action: "wait-for-confirmation", reason: "not-indexed", recoveryId: pair.prepared.commitTxId });
  });

  test("a head Bitcoin shows that the store does not hold is refused, never rebased", async () => {
    const behind = await original(btcoAlias("regtest", SAT));
    const ahead = await original(btcoAlias("regtest", SAT), 1);
    const all = await ahead.lines();
    expect((await behind.lines())[1]).toBe(all[1]);
    await expect(nextPendingEntry(behind.sdk, behind.did, { provider: provider(SAT, snapshot([anchorBody(all), all[2]])), clock: blocks(), index: INDEX }))
      .rejects.toMatchObject({ code: "BITCOIN_HEAD_NOT_STORED" });
  });
});

/** Alice grants Bob the photo; Bob replaces it before the anchor (an editor entry), then Alice anchors. */
async function edited() {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const bob = await Author.create([{ fragment: "edit", secret: seed(31) }]);
  const known = new Map([[alice.did, alice], [bob.did, bob]]);
  const store = new MemoryStore();
  const sdk = OriginalsSDK.create({ store, authors: async (d) => known.get(d)?.evidence(), freshness: "asserted", clock: clock() });
  const asAlice = { author: alice.ref("orig"), signer: alice.signer("orig", KEY) };
  const asBob = { editor: bob.ref("edit"), signer: bob.signer("edit", seed(31)) };
  const grant: EditorGrant = { did: bob.did, name: false, metadata: false, resource: true };
  const c = await sdk.create({ name: "Harbor", resource: { mediaType: "image/jpeg", bytes: bytes("one") }, editors: [grant], ...asAlice });
  if (c.kind !== "original") throw new Error("expected an Original");
  const did = c.original.did;
  const byBob = await sdk.edit(did, { parent: c.original.checkpoint, resource: { bytes: bytes("two") }, ...asBob });
  const anchored = await sdk.anchor(did, { parent: byBob.original.checkpoint, sat: btcoAlias("regtest", SAT), ...asAlice });
  const lines = async () => new TextDecoder().decode(readZip((await sdk.package(did)).bytes).get("asset/did.jsonl")!).trimEnd().split("\n");
  return { alice, bob, known, store, sdk, did, asAlice, asBob, anchored: anchored.original.checkpoint, lines };
}

describe("a confirmed inscription whose signer evidence the writer lacks is not settled (P9.12, P9.18; later-inscription-unverifiable)", () => {
  test("catch-up waits for the evidence and never prepares a replacement for it", async () => {
    const { alice, bob, store, sdk, did, asBob, anchored, lines } = await edited();
    // Bob rotates and edits after the anchor, naming his DID's version 2.
    await bob.rotate([{ fragment: "edit", secret: seed(31) }]);
    await sdk.edit(did, { parent: anchored, resource: { bytes: bytes("three") }, editor: bob.ref("edit"), signer: asBob.signer });
    const all = await lines();
    const r = recovery();
    const pair = await pairFor(sdk, did, node(snapshot([anchorBody(all, 2)])).provider);
    expect(pair.versionId).toBe(idOf(all[3]));
    r.put(pair.prepared, "reveal_broadcast");
    // The pair is mined and on the sat. A writer that holds Bob's DID only through version 1 cannot verify it.
    const fresh = new MemoryStore();
    await fresh.commit(did, { expectedHead: null, log: (await store.get(did))!.log });
    const bobV1 = bob.evidence(bob.entries.slice(0, 1));
    const writer = OriginalsSDK.create({ store: fresh, authors: async (d) => (d === alice.did ? alice.evidence() : d === bob.did ? bobV1 : undefined), freshness: "asserted", clock: clock() });
    const mined = snapshot([anchorBody(all, 2), { line: all[3], id: pair.prepared.inscriptionId }]);
    const chain = node(mined, [pair.prepared.commitTxId, pair.prepared.revealTxId]);
    const view = await readAnchored(writer, did, { provider: chain.provider, clock: blocks(), index: INDEX });
    expect(view.report.anchoring?.ignored).toEqual([expect.objectContaining({ inscription: pair.prepared.inscriptionId, reason: "later-inscription-unverifiable" })]);
    const plan = await step(writer, did, chain.provider, r);
    expect(plan).toMatchObject({ action: "wait-for-evidence", versionId: idOf(all[3]), recoveryId: pair.prepared.commitTxId, inscriptionId: pair.prepared.inscriptionId, signer: bob.did });
    // Nothing is prepared over it: a second pair must name the one it would replace (P9.6).
    await expect(pairFor(writer, did, chain.provider, undefined, { recoveryStore: r.store, recoveryIds: r.ids() })).rejects.toMatchObject({ code: "PAIR_IN_FLIGHT" });
    expect(chain.sent).toEqual([]);
    // With Bob's version 2, the same inscription is accepted and the queue is done.
    const informed = OriginalsSDK.create({ store: fresh, authors: async (d) => (d === alice.did ? alice.evidence() : d === bob.did ? bob.evidence() : undefined), freshness: "asserted", clock: clock() });
    expect(await step(informed, did, chain.provider, r)).toMatchObject({ action: "done" });
  });
});

describe("C12-181, C12-188: the writer's inscription waiting on an earlier unverifiable one is not settled (P9.15; waiting-for-earlier-unverifiable)", () => {
  test("catch-up waits for the evidence of the inscription it waits on, and prepares nothing over it", async () => {
    const { alice, bob, store, sdk, did, asAlice, anchored, lines } = await edited();
    // Elsewhere, Bob rotates and signs an edit on the anchored head naming his version 2.
    await bob.rotate([{ fragment: "edit", secret: seed(31) }]);
    const elsewhere = new MemoryStore();
    await elsewhere.commit(did, { expectedHead: null, log: (await store.get(did))!.log });
    const other = OriginalsSDK.create({ store: elsewhere, authors: async (d) => (d === alice.did ? alice.evidence() : d === bob.did ? bob.evidence() : undefined), freshness: "asserted", clock: clock() });
    await other.edit(did, { parent: anchored, resource: { bytes: bytes("bob's") }, editor: bob.ref("edit"), signer: bob.signer("edit", seed(31)) });
    const bobsLine = new TextDecoder().decode(readZip((await other.package(did)).bytes).get("asset/did.jsonl")!).trimEnd().split("\n")[3];
    // Here, Alice edits the same head; the writer inscribes her entry.
    await sdk.edit(did, { parent: anchored, name: "Harbor, renamed", ...asAlice });
    const all = await lines();
    const r = recovery();
    const pair = await pairFor(sdk, did, node(snapshot([anchorBody(all, 2)])).provider);
    expect(pair.versionId).toBe(idOf(all[3]));
    r.put(pair.prepared, "reveal_broadcast");
    // Bob's is mined first. A writer holding Bob's DID only through version 1 cannot verify it.
    const bobs = `${"b0".repeat(32)}i0`;
    const mined = snapshot([anchorBody(all, 2), { line: bobsLine, id: bobs, height: 11 }, { line: all[3], id: pair.prepared.inscriptionId, height: 12 }]);
    const chain = node(mined, [pair.prepared.commitTxId, pair.prepared.revealTxId]);
    const writer = OriginalsSDK.create({ store, authors: async (d) => (d === alice.did ? alice.evidence() : d === bob.did ? bob.evidence(bob.entries.slice(0, 1)) : undefined), freshness: "asserted", clock: clock() });
    const view = await readAnchored(writer, did, { provider: chain.provider, clock: blocks(), index: INDEX });
    expect(view.report.anchoring?.ignored).toEqual([
      expect.objectContaining({ inscription: bobs, reason: "later-inscription-unverifiable" }),
      expect.objectContaining({ inscription: pair.prepared.inscriptionId, reason: "waiting-for-earlier-unverifiable", waitingOn: bobs }),
    ]);
    expect(view.report.notices).toEqual(["unverifiable-inscriptions", "publications-waiting"]);
    const plan = await step(writer, did, chain.provider, r);
    expect(plan).toMatchObject({ action: "wait-for-evidence", versionId: idOf(all[3]), inscriptionId: pair.prepared.inscriptionId, waitingOn: bobs, signer: bob.did });
    await expect(pairFor(writer, did, chain.provider, undefined, { recoveryStore: r.store, recoveryIds: r.ids() })).rejects.toMatchObject({ code: "PAIR_IN_FLIGHT" });
    expect(chain.sent).toEqual([]);
  });
});

describe("C12-112: the anchoring inscription is the log through the anchoring entry and the current version, at most 350,000 bytes together (P9.17)", () => {
  test("the SDK refuses to anchor an Original whose log through the anchoring entry would be over the limit", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const store = new MemoryStore();
    const sdk = OriginalsSDK.create({ store, authors: async () => alice.evidence(), freshness: "asserted", clock: clock() });
    const signer = alice.signer("orig", KEY);
    const big = { note: "x".repeat(60_000) };
    const c = await sdk.create({ name: "Large", metadata: big, resource: { mediaType: "image/jpeg", bytes: bytes("one") }, author: alice.ref("orig"), signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    let parent = c.original.checkpoint;
    for (let k = 0; k < 4; k++) parent = (await sdk.edit(c.original.did, { parent, name: `Large ${k}`, author: alice.ref("orig"), signer })).original.checkpoint;
    const before = (await store.get(c.original.did))!.log;
    expect(new TextEncoder().encode(before).length).toBeLessThan(ORIGINALS_INSCRIPTION_MAX_BYTES);
    await expect(sdk.anchor(c.original.did, { parent, author: alice.ref("orig"), signer, sat: btcoAlias("regtest", SAT) }))
      .rejects.toMatchObject({ category: "limit-exceeded", code: "ANCHORING_LOG_TOO_LARGE" });
    expect((await store.get(c.original.did))!.log).toBe(before); // nothing committed: the Original is not anchored
  });

  test("the writer refuses an anchoring inscription whose log and current version pass the limit, before reading Bitcoin or signing", async () => {
    const pad = (n: number) => "y".repeat(n);
    const resource = { mediaType: "image/jpeg", size: 150_000, digest: resourceDigest(bytes("one")) };
    const genesis = JSON.stringify({ versionId: "1-a", state: { asset: { aliases: [], resource } }, pad: pad(200_000) });
    const anchoring = JSON.stringify({ versionId: "2-b", state: { asset: { aliases: [btcoAlias("regtest", SAT)], resource } } });
    const log = `${genesis}\n${anchoring}\n`;
    // The log alone fits; with the version it names as the body, it does not.
    expect(new TextEncoder().encode(log).length).toBeLessThan(ORIGINALS_INSCRIPTION_MAX_BYTES);
    const sdk = { committedLog: () => Promise.resolve(log) } as unknown as OriginalsSDK;
    await expect(prepare(sdk, "did:vh:x", "regtest", provider(SAT))).rejects.toMatchObject({ category: "limit-exceeded", code: "ANCHORING_LOG_TOO_LARGE" });
  });

  test("an explicitly requested entry before the anchoring entry is not inscribed on its own", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT));
    await expect(prepare(sdk, did, "regtest", provider(SAT), idOf((await lines())[0]))).rejects.toMatchObject({ code: "HEAD_NOT_NEXT" });
  });

  test("C12-196: the entries are the metadata, in pushes of at most 520 bytes that a reader concatenates before decoding; the body is the current version (P9.17, P14.12)", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT));
    const all = await lines();
    const pair = await pairFor(sdk, did, node(snapshot([])).provider);
    const script = scriptOf(pair.prepared);
    const pushes: Uint8Array[] = [];
    for (let i = 5; script[i] !== 0 && script[i] !== "ENDIF"; i += 2) {
      const tag = script[i];
      if (tag instanceof Uint8Array && tag.length === 1 && tag[0] === 5) pushes.push(script[i + 1] as Uint8Array);
    }
    expect(pushes.length).toBeGreaterThan(1);
    for (const push of pushes) expect(push.length).toBeLessThanOrEqual(520);
    const joined = rawMetadataPerEnvelope(script, 1)[0]!;
    expect(joined.length).toBe(pushes.reduce((n, p) => n + p.length, 0));
    expect(joined).toEqual(inscriptionMetadata(all));
    expect(inscribed(pair.prepared)).toBe(`${all.join("\n")}\n`);
    expect(bodyOf(pair.prepared)).toEqual({ body: bytes("one"), contentType: "image/jpeg", contentEncoding: undefined });
  });

  test("C12-112: an Original whose log and current version together would pass the limit is not anchored; an entry after the anchor whose inscription would pass it is not signed (P9.17)", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const store = new MemoryStore();
    const sdk = OriginalsSDK.create({ store, authors: async () => alice.evidence(), freshness: "asserted", clock: clock() });
    const signer = alice.signer("orig", KEY);
    // A small log, but a resource that leaves no room for it.
    const c = await sdk.create({ name: "Large", resource: { mediaType: "application/octet-stream", bytes: new Uint8Array(ORIGINALS_INSCRIPTION_MAX_BYTES - 100) }, author: alice.ref("orig"), signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    const before = (await store.get(c.original.did))!.log;
    await expect(sdk.anchor(c.original.did, { parent: c.original.checkpoint, author: alice.ref("orig"), signer, sat: btcoAlias("regtest", SAT) }))
      .rejects.toMatchObject({ category: "limit-exceeded", code: "ANCHORING_LOG_TOO_LARGE" });
    expect((await store.get(c.original.did))!.log).toBe(before);
    // Anchored small, then a version too large to go in an inscription with its entry.
    const small = await original(btcoAlias("regtest", SAT));
    const did = small.did;
    const head = (await small.sdk.get(did)).checkpoint;
    const committed = await small.sdk.committedLog(did);
    // Refused before the signer is asked: a hardware or Turnkey signer never prompts for it.
    let prompts = 0;
    const counting = Object.assign(Object.create(Object.getPrototypeOf(small.signer)), small.signer, {
      sign: (input: Parameters<typeof small.signer.sign>[0]) => { prompts++; return small.signer.sign(input); },
    }) as typeof small.signer;
    await expect(small.sdk.edit(did, { parent: head, resource: { bytes: new Uint8Array(ORIGINALS_INSCRIPTION_MAX_BYTES - 100) }, author: small.alice.ref("orig"), signer: counting }))
      .rejects.toMatchObject({ category: "limit-exceeded", code: "INSCRIPTION_TOO_LARGE" });
    expect(prompts).toBe(0);
    expect(await small.sdk.committedLog(did)).toBe(committed);
  });

  test("C12-193: before inscribing, the author is told the version, name and metadata become public and permanent, and warned about active content (P9.18, P8.3, P9.7)", async () => {
    for (const [mediaType, active] of [["image/jpeg", false], ["text/html", true], ["image/svg+xml", true]] as const) {
      const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
      const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => alice.evidence(), freshness: "asserted", clock: clock() });
      const signer = alice.signer("orig", KEY);
      const content = bytes(active ? "<svg onload=alert(1)>" : "one");
      const c = await sdk.create({ name: "Harbor", metadata: { caption: "dawn" }, resource: { mediaType, bytes: content }, author: alice.ref("orig"), signer });
      if (c.kind !== "original") throw new Error("expected an Original");
      const anchored = await sdk.anchor(c.original.did, { parent: c.original.checkpoint, author: alice.ref("orig"), signer, sat: btcoAlias("regtest", SAT) });
      const pair = await pairFor(sdk, c.original.did, node(snapshot([])).provider);
      expect(pair.notice).toMatchObject({
        version: { digest: resourceDigest(content), mediaType, size: content.length },
        entries: [c.original.checkpoint, anchored.original.checkpoint],
        permanent: true,
        activeContent: active,
      });
      expect(pair.notice.text).toContain("public and permanent");
      expect(pair.notice.text).toContain("name and metadata");
      expect(pair.notice.text.includes("active content")).toBe(active);
      expect(bodyOf(pair.prepared).contentType).toBe(mediaType);
    }
  });

  test("C12-194: after a name-only edit, the next inscription carries the unchanged current version again", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 1);
    const all = await lines();
    const pair = await pairFor(sdk, did, node(snapshot([anchorBody(all)])).provider);
    expect(pair.versionId).toBe(idOf(all[2]));
    expect(inscribed(pair.prepared)).toBe(`${all[2]}\n`);
    expect(bodyOf(pair.prepared)).toEqual({ body: bytes("one"), contentType: "image/jpeg", contentEncoding: undefined });
    // Bitcoin accepts it: the sat's newest accepted inscription shows the current version (P9.17).
    const shown = await readAnchored(sdk, did, { provider: node(snapshot([anchorBody(all), { line: all[2], id: pair.prepared.inscriptionId }])).provider, clock: blocks(), index: INDEX });
    expect(shown.report.anchoring?.accepted.map((a) => a.inscription)).toEqual([pair.prepared.inscriptionId]);
    expect(shown.current).toBe(true);
  });

  test("the writer refuses an inscription whose resource version it does not hold: the body must carry it (RESOURCE_BYTES_MISSING, P9.17)", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const store = new MemoryStore();
    const sdk = OriginalsSDK.create({ store, authors: async () => alice.evidence(), freshness: "asserted", clock: clock() });
    const signer = alice.signer("orig", KEY);
    const c = await sdk.create({ name: "Harbor", resource: { mediaType: "image/jpeg", bytes: bytes("one") }, author: alice.ref("orig"), signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    await sdk.anchor(c.original.did, { parent: c.original.checkpoint, author: alice.ref("orig"), signer, sat: btcoAlias("regtest", SAT) });
    store.deleteResource(resourceDigest(bytes("one")));
    await expect(pairFor(sdk, c.original.did, node(snapshot([])).provider)).rejects.toMatchObject({ category: "incomplete-evidence", code: "RESOURCE_BYTES_MISSING", details: { digest: resourceDigest(bytes("one")) } });
  });

  test("a prepared pair is submitted without a stored copy of its body: the reveal is checked against the descriptor (P9.6, P9.17)", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const store = new MemoryStore();
    const sdk = OriginalsSDK.create({ store, authors: async () => alice.evidence(), freshness: "asserted", clock: clock() });
    const signer = alice.signer("orig", KEY);
    const c = await sdk.create({ name: "Harbor", resource: { mediaType: "image/jpeg", bytes: bytes("one") }, author: alice.ref("orig"), signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    await sdk.anchor(c.original.did, { parent: c.original.checkpoint, author: alice.ref("orig"), signer, sat: btcoAlias("regtest", SAT) });
    const r = recovery();
    const chain = node(snapshot([]));
    const pair = await pairFor(sdk, c.original.did, chain.provider, undefined, { recoveryStore: r.store, recoveryIds: r.ids() });
    store.deleteResource(resourceDigest(bytes("one")));
    const sent = await submitEntryInscription({ sdk, did: c.original.did, pair, provider: chain.provider, clock: blocks(), index: INDEX, recoveryStore: r.store, recoveryIds: r.ids() });
    expect(sent.broadcast).toBe("reveal_broadcast");
  });

  test("a pair whose metadata, body or content type is not the stored entries and the version they name is not sent (PAIR_BODY_MISMATCH, P9.6, P9.17)", async () => {
    const { sdk, did } = await original(btcoAlias("regtest", SAT));
    const all = (await sdk.committedLog(did)).trimEnd().split("\n");
    const r = recovery();
    const chain = node(snapshot([]));
    const good = await pairFor(sdk, did, chain.provider, undefined, { recoveryStore: r.store, recoveryIds: r.ids() });
    const forged = (content: { content: Uint8Array; contentType: string; metadata: Uint8Array }) =>
      prepareInscriptionOnSat({ fundingUtxos: [holder, fee], satSigner: realSigner, changeAddress: wallet.address!, feeRate: 2, network: "regtest", provider: chain.provider, buildContent: () => Promise.resolve(content) });
    const right = { content: bytes("one"), contentType: "image/jpeg", metadata: inscriptionMetadata(all) };
    for (const content of [
      { ...right, metadata: inscriptionMetadata(all.slice(1)) }, // other entries
      { ...right, content: bytes("two") }, // another version
      { ...right, contentType: "image/png" },
    ]) {
      const pair = { ...good, prepared: await forged(content) };
      await expect(submitEntryInscription({ sdk, did, pair, provider: chain.provider, clock: blocks(), index: INDEX, recoveryStore: r.store, recoveryIds: r.ids() }))
        .rejects.toMatchObject({ code: "PAIR_BODY_MISMATCH" });
    }
    expect(chain.sent).toEqual([]);
    // The exact pair is sent.
    expect((await submitEntryInscription({ sdk, did, pair: { ...good, prepared: await forged(right) }, provider: chain.provider, clock: blocks(), index: INDEX, recoveryStore: r.store, recoveryIds: r.ids() })).broadcast).toBe("reveal_broadcast");
  });
});

describe("the review of #1026 (P9.6, P9.17, P9.18)", () => {
  test("a recorded pair with the right entries but another body is not this entry's pair, so it cannot wedge recovery (P9.6, P9.17)", async () => {
    const { sdk, did } = await original(btcoAlias("regtest", SAT));
    const all = (await sdk.committedLog(did)).trimEnd().split("\n");
    const chain = node(snapshot([]));
    const forged = (content: Uint8Array) =>
      prepareInscriptionOnSat({ fundingUtxos: [holder, fee], satSigner: realSigner, changeAddress: wallet.address!, feeRate: 2, network: "regtest", provider: chain.provider, buildContent: () => Promise.resolve({ content, contentType: "image/jpeg", metadata: inscriptionMetadata(all) }) });
    const wrong = recovery();
    wrong.put(await forged(bytes("two")), "commit_broadcast");
    const pair = await pairFor(sdk, did, chain.provider, undefined, { recoveryStore: wrong.store, recoveryIds: wrong.ids() });
    expect(pair.versionId).toBe(idOf(all[all.length - 1]));
    // The control: the same record with the right body is this entry's pair in flight.
    const right = recovery();
    right.put(await forged(bytes("one")), "commit_broadcast");
    await expect(pairFor(sdk, did, chain.provider, undefined, { recoveryStore: right.store, recoveryIds: right.ids() })).rejects.toMatchObject({ code: "PAIR_IN_FLIGHT" });
  });

  test("a handoff through the committed head lists a version Bitcoin does not show as off chain (P9.18)", async () => {
    const { sdk, did, asAlice, anchored, lines } = await edited();
    const all = await lines();
    const local = await sdk.edit(did, { parent: anchored, resource: { bytes: bytes("three") }, ...asAlice });
    const three = resourceDigest(bytes("three"));
    const committed = await transferHandoff(sdk, did, { through: "committed" });
    expect(committed.package.manifest.checkpoint).toBe(local.original.checkpoint);
    // No sat was read, so nothing is assumed inscribed: every version is handed over.
    expect(committed.offChain.resources.map((r) => r.version)).toEqual([1, 2, 3]);
    expect(committed.offChain.resources.find((r) => r.digest === three)?.held).toBe(true);
    // Through the accepted head, version 2 is the anchor's body; only version 1 stays off chain.
    const accepted = await transferHandoff(sdk, did, { provider: provider(SAT, snapshot([anchorBody(all, 2)])), clock: blocks(), index: INDEX });
    expect(accepted.offChain.resources.map((r) => r.version)).toEqual([1]);
  });

  test("C12-198: an Original whose metadata holds non-integer numbers is anchored and inscribed, its floats at the narrowest exact width (P14.12; originals-spec #54)", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => alice.evidence(), freshness: "asserted", clock: clock() });
    const signer = alice.signer("orig", KEY);
    const metadata = { rating: 4.5, place: [51.5072, -0.1276] };
    const c = await sdk.create({ name: "Harbor", metadata, resource: { mediaType: "image/jpeg", bytes: bytes("one") }, author: alice.ref("orig"), signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    await sdk.anchor(c.original.did, { parent: c.original.checkpoint, author: alice.ref("orig"), signer, sat: btcoAlias("regtest", SAT) });
    const pair = await pairFor(sdk, c.original.did, node(snapshot([])).provider);
    const raw = rawMetadataPerEnvelope(scriptOf(pair.prepared), 1)[0]!;
    // 4.5 is a half float, as ord writes it.
    expect([0xf9, 0x44, 0x80].every((b, j, h) => raw.some((_, k) => h.every((x, i) => raw[k + i] === x)))).toBe(true);
    // Decoded, the entries are the stored lines exactly, and Bitcoin shows the Original anchored and current.
    const all = (await sdk.committedLog(c.original.did)).trimEnd().split("\n");
    expect(inscribed(pair.prepared)).toBe(all.map((l) => `${l}\n`).join(""));
    const shown = await readAnchored(sdk, c.original.did, { provider: node(snapshot([anchorBody(all)])).provider, clock: blocks(), index: INDEX });
    expect(shown.publication).toBe("anchored");
    expect(shown.state.metadata).toEqual(metadata);
  });

  test("the notice names the whole log for an anchoring inscription and the one entry for a later one (P9.18)", () => {
    const d = { mediaType: "image/jpeg", size: 3, digest: resourceDigest(bytes("one")) };
    expect(inscriptionNotice(["1-a", "2-b"], d).text).toContain("the log from 1-a through 2-b");
    expect(inscriptionNotice(["3-c"], d).text).toContain("the entry 3-c");
    expect(inscriptionNotice(["3-c"], d).text).not.toContain("the log");
  });
});

describe("C12-100: before inscribing the anchoring entry the SDK verifies it; then it is pending Bitcoin acceptance (P9.18)", () => {
  test("a stored log that does not verify through the signed anchoring entry is not inscribed", async () => {
    const store = new MemoryStore();
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const sdk = OriginalsSDK.create({ store, authors: async () => alice.evidence(), freshness: "asserted", clock: clock() });
    const signer = alice.signer("orig", KEY);
    const c = await sdk.create({ name: "Harbor", resource: { mediaType: "image/jpeg", bytes: bytes("one") }, author: alice.ref("orig"), signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    const anchored = await sdk.anchor(c.original.did, { parent: c.original.checkpoint, author: alice.ref("orig"), signer, sat: btcoAlias("regtest", SAT) });
    // The stored anchoring entry's proof is damaged after it was committed.
    const [genesis, anchoring] = (await store.get(c.original.did))!.log.trimEnd().split("\n");
    const entry = JSON.parse(anchoring) as { proof: Array<{ proofValue: string }> };
    entry.proof[0].proofValue = `z${"1".repeat(entry.proof[0].proofValue.length - 1)}`;
    await store.commit(c.original.did, { expectedHead: anchored.original.checkpoint, log: `${genesis}\n${JSON.stringify(entry)}\n` });
    await expect(pairFor(sdk, c.original.did, node(snapshot([])).provider)).rejects.toMatchObject({ code: "ANCHORING_NOT_VERIFIED" });
  });

  test("an editor whose DID history is missing signed before the anchor: refused as incomplete identity evidence", async () => {
    const { bob, known, sdk, did } = await edited();
    known.delete(bob.did);
    await expect(pairFor(sdk, did, node(snapshot([])).provider)).rejects.toMatchObject({ category: "incomplete-evidence", code: "ANCHORING_NOT_VERIFIED" });
  });

  test("an author key removed from the author DID before inscribing: refused, Bitcoin would not accept it (P9.15)", async () => {
    const { alice, sdk, did } = await edited();
    await alice.rotate([{ fragment: "other", secret: seed(77) }]);
    await expect(pairFor(sdk, did, node(snapshot([])).provider)).rejects.toMatchObject({ code: "ANCHORING_NOT_VERIFIED" });
  });

  test("a verified anchoring entry is prepared, with what Bitcoin will not hold: versions before the anchoring entry's, and did:vh signer histories", async () => {
    const { alice, bob, sdk, did, anchored, lines } = await edited();
    const all = await lines();
    const pair = await pairFor(sdk, did, node(snapshot([])).provider);
    expect(pair.versionId).toBe(anchored);
    expect(inscribed(pair.prepared)).toBe(`${all.join("\n")}\n`);
    expect(pair.offChain.replication).toBe("not-guaranteed");
    expect(pair.offChain.identities).toEqual([{ did: alice.did, role: "author", held: true }, { did: bob.did, role: "editor", held: true }]);
    // Version 2 is the anchoring inscription's body; only version 1 stays off Bitcoin (P9.18).
    expect(pair.offChain.resources.map((r) => [r.version, r.digest, r.held])).toEqual([[1, resourceDigest(bytes("one")), true]]);
    expect(bodyOf(pair.prepared).body).toEqual(bytes("two"));
  });

  test("broadcast, the anchor is labelled pending Bitcoin acceptance until it is confirmed; then it is anchored", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 1);
    const all = await lines();
    const r = recovery();
    const pair = await pairFor(sdk, did, node(snapshot([])).provider);
    const unread = { recoveryStore: r.store, recoveryIds: r.ids() };
    expect((await readAnchored(sdk, did, { provider: node(snapshot([])).provider, clock: blocks(), index: INDEX, ...unread })).publication).toBe("not-anchored");
    r.put(pair.prepared, "reveal_broadcast");
    const recorded = { recoveryStore: r.store, recoveryIds: r.ids() };
    // Pending only while the node shows the pair (here, in its mempool).
    const out = () => seeing(snapshot([]), [], [pair.prepared.commitTxId, pair.prepared.revealTxId]).provider;
    const pending = await readAnchored(sdk, did, { provider: out(), clock: blocks(), index: INDEX, ...recorded });
    expect(pending.publication).toBe("pending-bitcoin-acceptance");
    expect(pending.current).toBe(false);
    expect((await nextPendingEntry(sdk, did, { provider: out(), clock: blocks(), index: INDEX, ...recorded })).publication).toBe("pending-bitcoin-acceptance");
    const waiting = await step(sdk, did, out(), r);
    expect(waiting).toMatchObject({ action: "wait-for-confirmation", versionId: idOf(all[1]), pending: { publication: "pending-bitcoin-acceptance" } });
    // Mined but not yet indexed: still pending.
    const mined = node(snapshot([]), [pair.prepared.commitTxId, pair.prepared.revealTxId]);
    expect((await readAnchored(sdk, did, { provider: mined.provider, clock: blocks(), index: INDEX, ...recorded })).publication).toBe("pending-bitcoin-acceptance");
    const shown = node(snapshot([{ line: anchorBody(all), id: pair.prepared.inscriptionId }]), [pair.prepared.commitTxId, pair.prepared.revealTxId]);
    const view = await readAnchored(sdk, did, { provider: shown.provider, clock: blocks(), index: INDEX, ...recorded });
    expect(view.publication).toBe("anchored");
    expect(view.report.anchoring?.anchor?.inscription).toBe(pair.prepared.inscriptionId);
    expect(view.current).toBe(true);
    expect(await step(sdk, did, shown.provider, r)).toMatchObject({ action: "prepare", versionId: idOf(all[2]), pending: { publication: "anchored" } });
  });
});

describe("C12-123: an editor entry is inscribed by the sat's holder like an author entry (P9.12, P5.16)", () => {
  test("after the anchor, the holder inscribes Bob's entry; Bitcoin accepts it and it is current", async () => {
    const { bob, sdk, did, asBob, anchored, lines } = await edited();
    const after = await sdk.edit(did, { parent: anchored, resource: { bytes: bytes("three") }, ...asBob });
    const all = await lines();
    expect(all).toHaveLength(4);
    const read = snapshot([anchorBody(all, 2)]);
    const r = recovery();
    expect(await step(sdk, did, node(read).provider, r)).toMatchObject({ action: "prepare", versionId: after.original.checkpoint });
    const pair = await pairFor(sdk, did, node(read).provider);
    expect(inscribed(pair.prepared)).toBe(`${all[3]}\n`);
    expect(pair.offChain.identities.map((i) => i.did)).toContain(bob.did);
    const shown = snapshot([anchorBody(all, 2), { line: all[3], id: pair.prepared.inscriptionId }]);
    const done = await step(sdk, did, node(shown, [pair.prepared.commitTxId, pair.prepared.revealTxId]).provider, r);
    expect(done).toMatchObject({ action: "done", pending: { accepted: after.original.checkpoint, publication: "anchored" } });
    if (done.action !== "done") throw new Error("unreachable");
    expect(done.pending.view.current).toBe(true);
    expect(done.pending.view.report.identityEvidence.editors.map((e) => [e.did, e.status])).toEqual([[bob.did, "complete"]]);
    expect(done.pending.view.resources.at(-1)?.digest).toBe(resourceDigest(bytes("three")));
  });
});

describe("transfer handoff: what the sender holds that Bitcoin does not (P9.18)", () => {
  test("the recipient gets the resource bytes and did:vh signer histories, and verifies them against the sat", async () => {
    const { alice, bob, sdk, did, lines } = await edited();
    const all = await lines();
    const sat = { provider: provider(SAT, snapshot([anchorBody(all, 2)])), clock: blocks(), index: INDEX };
    const handoff = await transferHandoff(sdk, did, sat);
    expect(handoff.offChain.identities.map((i) => i.did)).toEqual([alice.did, bob.did]);
    const contents = readZip(handoff.package.bytes);
    expect([...contents.keys()].filter((k) => k.startsWith("resources/"))).toHaveLength(2);
    // A recipient with an empty store and no author list.
    const recipient = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock() });
    const read = await verifyHandoff(recipient, handoff.package.bytes, { ...sat, expectedSat: btcoAlias("regtest", SAT) });
    expect(read.report.anchoring?.status).toBe("anchored");
    expect(read.report.history.status).toBe("valid");
    expect(read.report.authorBinding.status).toBe("valid");
    expect(read.report.identityEvidence.status).toBe("complete");
    expect(read.report.resources.status).toBe("available");
  });
});

describe("recovery review of the writer: retries, liveness and damaged records (P9.4, P9.6, P9.18)", () => {
  test("C12-100: a recorded anchoring pair is verified again before it is resumed; once the author key is removed it is refused and nothing is sent (P9.18)", async () => {
    const { alice, sdk, did } = await edited();
    const r = recovery();
    const pair = await pairFor(sdk, did, node(snapshot([])).provider);
    r.put(pair.prepared, "commit_broadcast_unknown"); // persisted, then the process died before the commit went out
    await alice.rotate([{ fragment: "other", secret: seed(77) }]);
    const chain = seeing(snapshot([]));
    const plan = await step(sdk, did, chain.provider, r);
    expect(plan).toMatchObject({ action: "refused", versionId: pair.versionId, recoveryId: pair.prepared.commitTxId, commit: "not-observed", ifRevealed: "ignored-by-bitcoin", error: { code: "ANCHORING_NOT_VERIFIED" } });
    const resume = () => resumeEntryInscription({ sdk, did, provider: chain.provider, clock: blocks(), index: INDEX, recoveryStore: r.store, recoveryIds: r.ids(), recoveryId: pair.prepared.commitTxId });
    await expect(resume()).rejects.toMatchObject({ code: "NOT_RESUMABLE", details: { step: "refused", cause: "ANCHORING_NOT_VERIFIED", commit: "not-observed" } });
    expect(chain.sent).toEqual([]);
    // The commit is already mined: the sat waits in its output, and the reveal would be ignored by Bitcoin. Said so; still nothing sent.
    const mined = seeing(snapshot([]), [pair.prepared.commitTxId]);
    expect(await step(sdk, did, mined.provider, r)).toMatchObject({ action: "refused", commit: "confirmed", ifRevealed: "ignored-by-bitcoin" });
    expect(mined.sent).toEqual([]);
  });

  test("before the anchor is accepted, a pair whose sat has moved on is neither waited on, resumed, nor labelled pending", async () => {
    const { sdk, did } = await original(btcoAlias("regtest", SAT), 1);
    const pair = await pairFor(sdk, did, node(snapshot([])).provider);
    const moved = snapshot([]);
    moved.ownership = { owner: "bcrt1qsomeoneelse", satpoint: `${"ff".repeat(32)}:0:0` };
    for (const state of ["reveal_broadcast", "commit_broadcast_unknown", "prepared"] as const) {
      const r = recovery();
      r.put(pair.prepared, state);
      expect(await step(sdk, did, node(moved).provider, r)).toMatchObject({ action: "prepare", versionId: pair.versionId, pending: { publication: "not-anchored" } });
    }
  });

  test("among several live pairs for one entry the choice is deterministic: furthest along on the network, then lowest recovery id", async () => {
    const { sdk, did } = await original(btcoAlias("regtest", SAT), 1);
    const pairs = [await pairFor(sdk, did, node(snapshot([])).provider), await pairFor(sdk, did, node(snapshot([])).provider)];
    const [low, high] = pairs.sort((a, b) => (a.prepared.commitTxId < b.prepared.commitTxId ? -1 : 1));
    const r = recovery();
    r.put(high.prepared, "prepared");
    r.put(low.prepared, "prepared");
    const plan = (p: OrdinalsProvider, ids: string[]) => catchUp({ sdk, did, provider: p, clock: blocks(), index: INDEX, recoveryStore: r.store, recoveryIds: ids });
    for (const ids of [r.ids(), [...r.ids()].reverse()]) {
      expect(await plan(seeing(snapshot([])).provider, ids)).toMatchObject({ action: "resume", recoveryId: low.prepared.commitTxId });
      // The pair whose commit the node holds wins over a lower id.
      expect(await plan(seeing(snapshot([]), [], [high.prepared.commitTxId]).provider, ids))
        .toMatchObject({ action: "resume", recoveryId: high.prepared.commitTxId, pending: { publication: "pending-bitcoin-acceptance" } });
    }
  });

  test("C12-100, C12-168, C12-176: a pair whose commit was rejected is submitted-unobserved, not pending Bitcoin acceptance; one never sent is not anchored (P9.4, P9.18)", async () => {
    const { sdk, did } = await original(btcoAlias("regtest", SAT), 1);
    const pair = await pairFor(sdk, did, node(snapshot([])).provider);
    const r = recovery();
    const rejecting = { ...seeing(snapshot([])).provider, broadcastTransaction: () => Promise.reject(new Error("min relay fee not met")) } as unknown as OrdinalsProvider;
    expect((await submitPreparedInscriptionOnSat({ prepared: pair.prepared, provider: rejecting, recoveryStore: r.store })).broadcast).toBe("commit_broadcast_unknown");
    const read = async (p: OrdinalsProvider, rec = r) => (await readAnchored(sdk, did, { provider: p, clock: blocks(), index: INDEX, recoveryStore: rec.store, recoveryIds: rec.ids() })).publication;
    expect(await read(seeing(snapshot([])).provider)).toBe("submitted-unobserved");
    expect(await read(node(snapshot([])).provider)).toBe("submitted-unobserved"); // a node that cannot see its mempool shows nothing either
    expect(await read(seeing(snapshot([]), [], [pair.prepared.commitTxId]).provider)).toBe("pending-bitcoin-acceptance");
    expect(await read(seeing(snapshot([]), [pair.prepared.commitTxId]).provider)).toBe("pending-bitcoin-acceptance");
    expect(await step(sdk, did, seeing(snapshot([])).provider, r)).toMatchObject({ action: "resume", recoveryId: pair.prepared.commitTxId, pending: { publication: "submitted-unobserved" } });
    const never = recovery();
    never.put(pair.prepared, "prepared");
    expect(await read(seeing(snapshot([])).provider, never)).toBe("not-anchored");
  });

  test("malformed records, and records whose declared txids do not match their bytes, are skipped and reported, never a TypeError", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 1);
    const all = await lines();
    const read = snapshot([anchorBody(all)]);
    const pair = await pairFor(sdk, did, node(read).provider);
    const r = recovery();
    const bare = "aa".repeat(32);
    r.records.set(bare, { recoveryId: bare } as unknown as InscriptionRecoveryRecord);
    // Declares a confirmed, unrelated txid as its reveal: it would otherwise be waited on forever.
    r.put({ ...pair.prepared, revealTxId: holder.txid, inscriptionId: `${holder.txid}i0` }, "reveal_broadcast");
    const plan = await step(sdk, did, node(read, [holder.txid]).provider, r);
    expect(plan).toMatchObject({ action: "prepare", versionId: idOf(all[2]) });
    expect([...plan.pending.recoveryIssues].sort((a, b) => (a.recoveryId < b.recoveryId ? -1 : 1))).toEqual(
      [bare, pair.prepared.commitTxId].sort().map((recoveryId) => ({ recoveryId, code: "INVALID_INSCRIPTION_RECOVERY", message: expect.any(String) })),
    );
  });

  test("one damaged record in a shared recovery directory is reported per record and blocks no Original", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 1);
    const all = await lines();
    const read = snapshot([anchorBody(all)]);
    const dir = mkdtempSync(join(tmpdir(), "originals-recovery-"));
    try {
      writeFileSync(join(dir, `${"bb".repeat(32)}.json`), "{garbage");
      const pair = await pairFor(sdk, did, node(read).provider);
      await fileRecoveryStore(dir).save({ recoveryId: pair.prepared.commitTxId, prepared: pair.prepared, broadcast: "commit_broadcast_unknown" });
      const plan = await catchUp({ sdk, did, provider: seeing(read).provider, clock: blocks(), index: INDEX, recoveryStore: fileRecoveryStore(dir) });
      expect(plan).toMatchObject({ action: "resume", recoveryId: pair.prepared.commitTxId });
      const damaged = [{ recoveryId: "bb".repeat(32), code: "RECOVERY_RECORD_DAMAGED", message: expect.any(String) }];
      expect(plan.pending.recoveryIssues).toEqual(damaged);
      const view = await readAnchored(sdk, did, { provider: seeing(read).provider, clock: blocks(), index: INDEX, recoveryStore: fileRecoveryStore(dir) });
      expect(view.recoveryIssues).toEqual(damaged);
      expect(view.publication).toBe("anchored");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a second pair for an entry whose pair can still land is refused unless it names the pair it replaces (P9.6)", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 1);
    const all = await lines();
    const read = snapshot([anchorBody(all)]);
    const r = recovery();
    const first = await pairFor(sdk, did, node(read).provider, undefined, { recoveryStore: r.store, recoveryIds: r.ids() });
    r.put(first.prepared, "reveal_broadcast");
    await expect(pairFor(sdk, did, node(read).provider, undefined, { recoveryStore: r.store, recoveryIds: r.ids() }))
      .rejects.toMatchObject({ category: "stale-parent", code: "PAIR_IN_FLIGHT", details: { recoveryIds: [first.prepared.commitTxId] } });
    const replacement = await pairFor(sdk, did, node(read).provider, undefined, { recoveryStore: r.store, recoveryIds: r.ids(), replaces: [first.prepared.commitTxId] });
    expect(replacement.versionId).toBe(first.versionId);
    expect(replacement.prepared.commitTxId).not.toBe(first.prepared.commitTxId);
    // Once the sat has moved on, the first pair cannot land and no longer blocks.
    const moved = snapshot([anchorBody(all)]);
    moved.ownership = { owner: "bcrt1qholder", satpoint: `${"ff".repeat(32)}:0:0` };
    expect((await pairFor(sdk, did, node(moved).provider, undefined, { recoveryStore: r.store, recoveryIds: r.ids() })).versionId).toBe(first.versionId);
  });

  test("C12-40: an inscription the read shows unconfirmed is waited on, never listed as replaced (P9.13)", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 1);
    const all = await lines();
    const r = recovery();
    const pair = await pairFor(sdk, did, node(snapshot([anchorBody(all)])).provider);
    r.put(pair.prepared, "reveal_broadcast");
    const read = snapshot([anchorBody(all), { line: all[2], id: pair.prepared.inscriptionId, height: 20 }]);
    (read.publications[1] as { confirmed: boolean }).confirmed = false; // the index has not caught up with the node
    const plan = await step(sdk, did, node(read, [pair.prepared.commitTxId, pair.prepared.revealTxId]).provider, r);
    expect(plan.pending.view.report.anchoring?.ignored.map((i) => i.reason)).toEqual(["unconfirmed"]);
    expect(plan).toMatchObject({ action: "wait-for-confirmation", reason: "not-indexed", recoveryId: pair.prepared.commitTxId });
  });

  test("C12-40: a broadcast pair the node no longer holds is resumed as the same pair; without a mempool view it is waited on (P9.6)", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 1);
    const all = await lines();
    const read = snapshot([anchorBody(all)]);
    const r = recovery();
    const pair = await pairFor(sdk, did, node(read).provider);
    r.put(pair.prepared, "reveal_broadcast");
    expect(await step(sdk, did, node(read).provider, r)).toMatchObject({ action: "wait-for-confirmation", reason: "unconfirmed" });
    expect(await step(sdk, did, seeing(read, [], [pair.prepared.commitTxId, pair.prepared.revealTxId]).provider, r)).toMatchObject({ action: "wait-for-confirmation", reason: "unconfirmed" });
    // Evicted: neither transaction in the mempool or the chain. Rebroadcast the same bytes.
    const evicted = seeing(read);
    expect(await step(sdk, did, evicted.provider, r)).toMatchObject({ action: "resume", recoveryId: pair.prepared.commitTxId, broadcast: "reveal_broadcast" });
    const resumed = await resumeEntryInscription({ sdk, did, provider: evicted.provider, clock: blocks(), index: INDEX, recoveryStore: r.store, recoveryIds: r.ids(), recoveryId: pair.prepared.commitTxId });
    expect(resumed.inscriptionId).toBe(pair.prepared.inscriptionId);
    expect(evicted.sent).toEqual([pair.prepared.signedCommitHex, pair.prepared.revealTxHex]);
    expect(await step(sdk, did, evicted.provider, r)).toMatchObject({ action: "wait-for-confirmation", reason: "unconfirmed" });
    // The reveal evicted after its commit was mined: the reveal alone goes again.
    const half = seeing(read, [pair.prepared.commitTxId]);
    expect(await step(sdk, did, half.provider, r)).toMatchObject({ action: "resume", recoveryId: pair.prepared.commitTxId });
  });

  test("indexes that disagree on the sat never lead to a second anchor being prepared (P9.10)", async () => {
    const { sdk, did } = await original(btcoAlias("regtest", SAT), 1);
    const disputed = [`${"d1".repeat(32)}i0`];
    // Two indexes' reads merged: placement of an inscription is disputed, so anchoring is unverified.
    const merged = new Proxy(sdk, {
      get(target, key) {
        if (key === "get") {
          return async (...args: Parameters<OriginalsSDK["get"]>) => {
            const view = await target.get(...args);
            return { ...view, report: { ...view.report, anchoring: { ...view.report.anchoring!, status: "unverified", disputed } } };
          };
        }
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    expect(await step(merged, did, node(snapshot([])).provider, recovery()))
      .toMatchObject({ action: "wait-for-bitcoin", reason: "indexes-disagree", disputed, pending: { publication: "unverified" } });
  });
});

describe("second review of the writer (P9.6, P9.10, P9.18)", () => {
  test("P9.10: reads by two indexes are compared; when they disagree on the anchor, catch-up waits for Bitcoin", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 1);
    const all = await lines();
    const a = snapshot([anchorBody(all)]);
    // The second index places the anchoring inscription at another height.
    const b = snapshot([{ line: anchorBody(all), height: 11 }]);
    const both = { provider: node(a).provider, clock: blocks(), index: "ord-a", indexes: [{ provider: node(b).provider, index: "ord-b" }] };
    const view = await readAnchored(sdk, did, both);
    expect(view.report.anchoring).toMatchObject({ status: "unverified", indexes: ["ord-a", "ord-b"] });
    expect(view.publication).toBe("unverified");
    const plan = await catchUp({ sdk, did, ...both, recoveryStore: recovery().store, recoveryIds: [] });
    expect(plan).toMatchObject({ action: "wait-for-bitcoin", reason: "indexes-disagree", disputed: [`${"1".padStart(64, "e")}i0`] });
    // Two indexes that agree: anchored, both reported (P9.11).
    const agreed = await readAnchored(sdk, did, { ...both, indexes: [{ provider: node(a).provider, index: "ord-b" }] });
    expect(agreed.report.anchoring).toMatchObject({ status: "anchored", indexes: ["ord-a", "ord-b"] });
    expect(agreed.report.ownership?.indexes).toEqual(["ord-a", "ord-b"]);
  });

  test("L2: the recipient names the sat it received; a handoff for another sat is refused", async () => {
    const { sdk, did, lines } = await edited();
    const all = await lines();
    const read = { provider: provider(SAT, snapshot([anchorBody(all, 2)])), clock: blocks(), index: INDEX };
    const handoff = await transferHandoff(sdk, did, read);
    const recipient = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock() });
    await expect(verifyHandoff(recipient, handoff.package.bytes, { ...read, expectedSat: btcoAlias("regtest", "7000000000") }))
      .rejects.toMatchObject({ category: "invalid-evidence", code: "HANDOFF_SAT_MISMATCH" });
    const ok = await verifyHandoff(recipient, handoff.package.bytes, { ...read, expectedSat: btcoAlias("regtest", SAT) });
    expect(ok.report.anchoring?.status).toBe("anchored");
  });

  test("L4: a handoff runs through the head Bitcoin accepts by default; the committed head only when asked", async () => {
    const { sdk, did, asAlice, anchored, lines } = await edited();
    const local = await sdk.edit(did, { parent: anchored, name: "Harbor, not yet inscribed", ...asAlice });
    const all = await lines();
    const read = { provider: provider(SAT, snapshot([anchorBody(all, 2)])), clock: blocks(), index: INDEX };
    const accepted = await transferHandoff(sdk, did, read);
    expect(accepted.package.manifest.checkpoint).toBe(anchored);
    expect(accepted.offChain.through).toBe(anchored);
    const committed = await transferHandoff(sdk, did, { through: "committed" });
    expect(committed.package.manifest.checkpoint).toBe(local.original.checkpoint);
    await expect(transferHandoff(sdk, did, {} as never)).rejects.toMatchObject({ code: "SAT_READ_REQUIRED" });
    // Nothing on Bitcoin yet: there is no accepted head to hand over.
    await expect(transferHandoff(sdk, did, { ...read, provider: provider(SAT, snapshot([])) })).rejects.toMatchObject({ code: "NOT_ANCHORED_ON_BITCOIN" });
  });

  test("L6: submitEntryInscription verifies through the entry again before the first broadcast (P9.18)", async () => {
    const { alice, sdk, did } = await edited();
    const r = recovery();
    const chain = node(snapshot([]));
    const pair = await pairFor(sdk, did, chain.provider, undefined, { recoveryStore: r.store, recoveryIds: r.ids() });
    await alice.rotate([{ fragment: "other", secret: seed(77) }]);
    await expect(submitEntryInscription({ sdk, did, pair, provider: chain.provider, clock: blocks(), index: INDEX, recoveryStore: r.store, recoveryIds: r.ids() }))
      .rejects.toMatchObject({ code: "ANCHORING_NOT_VERIFIED" });
    expect(chain.sent).toEqual([]);
    expect(r.ids()).toEqual([]);
  });

  test("L6: submitEntryInscription sends a pair that still verifies and is still next, and refuses one Bitcoin already shows", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 1);
    const all = await lines();
    const r = recovery();
    const chain = node(snapshot([]));
    const pair = await pairFor(sdk, did, chain.provider, undefined, { recoveryStore: r.store, recoveryIds: r.ids() });
    const sent = await submitEntryInscription({ sdk, did, pair, provider: chain.provider, clock: blocks(), index: INDEX, recoveryStore: r.store, recoveryIds: r.ids() });
    expect(sent.broadcast).toBe("reveal_broadcast");
    expect(chain.sent).toEqual([pair.prepared.signedCommitHex, pair.prepared.revealTxHex]);
    const shown = node(snapshot([anchorBody(all)]));
    await expect(submitEntryInscription({ sdk, did, pair, provider: shown.provider, clock: blocks(), index: INDEX, recoveryStore: r.store, recoveryIds: r.ids() }))
      .rejects.toMatchObject({ code: "HEAD_NOT_NEXT" });
    expect(shown.sent).toEqual([]);
  });

  test("L6: preparing without a recovery store is an explicit choice (recoveryStore: null), never an omission", async () => {
    const { sdk, did } = await original(btcoAlias("regtest", SAT), 1);
    const p = node(snapshot([])).provider;
    await expect(prepareEntryInscription({ sdk, did, fundingUtxos: [holder, fee], satSigner: realSigner, changeAddress: wallet.address!, feeRate: 2, network: "regtest", provider: p, clock: blocks(), index: INDEX } as never))
      .rejects.toMatchObject({ category: "invalid-evidence", code: "RECOVERY_STORE_REQUIRED" });
    const unguarded = await prepareEntryInscription({ sdk, did, fundingUtxos: [holder, fee], satSigner: realSigner, changeAddress: wallet.address!, feeRate: 2, network: "regtest", provider: p, clock: blocks(), index: INDEX, recoveryStore: null });
    expect(unguarded.inFlightGuard).toBe("skipped");
  });
});

describe("one disagreement guard for every step that can broadcast (P9.6, P9.10)", () => {
  const lagging = async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 1);
    const all = await lines();
    // ord-a shows the anchor; ord-b lags and shows nothing yet.
    return { sdk, did, a: node(snapshot([anchorBody(all)])), b: node(snapshot([])), r: recovery() };
  };

  test("C12-109: one index shows the anchor, another does not: preparing is refused (INDEXES_DISAGREE)", async () => {
    const { sdk, did, a, b, r } = await lagging();
    const indexes = [{ provider: b.provider, index: "ord-b" }];
    expect(await catchUp({ sdk, did, provider: a.provider, clock: blocks(), index: "ord-a", indexes, recoveryStore: r.store, recoveryIds: r.ids() }))
      .toMatchObject({ action: "wait-for-bitcoin", reason: "indexes-disagree" });
    for (const recoveryStore of [r.store, null]) {
      await expect(pairFor(sdk, did, a.provider, undefined, { index: "ord-a", indexes, recoveryStore, recoveryIds: r.ids() }))
        .rejects.toMatchObject({ category: "incomplete-evidence", code: "INDEXES_DISAGREE" });
    }
  });

  test("C12-109: a pair prepared before the indexes diverged is not sent while they disagree", async () => {
    const { sdk, did, a, b, r } = await lagging();
    const early = await pairFor(sdk, did, b.provider, undefined, { recoveryStore: r.store, recoveryIds: r.ids() });
    await expect(submitEntryInscription({ sdk, did, pair: early, provider: a.provider, clock: blocks(), index: "ord-a", indexes: [{ provider: b.provider, index: "ord-b" }], recoveryStore: r.store, recoveryIds: r.ids() }))
      .rejects.toMatchObject({ category: "incomplete-evidence", code: "INDEXES_DISAGREE" });
    expect(a.sent).toEqual([]);
    expect(await r.store.load(early.prepared.commitTxId)).toBeUndefined();
  });

  test("C12-109: indexes that disagree on the sat's holder wait; a pair the sat has left is never resumed (C12-40)", async () => {
    const { sdk, did } = await original(btcoAlias("regtest", SAT), 1);
    const r = recovery();
    const s = snapshot([]);
    const pair = await pairFor(sdk, did, node(s).provider, undefined, { recoveryStore: r.store, recoveryIds: r.ids() });
    r.put(pair.prepared, "reveal_broadcast");
    const moved = { ...s, ownership: { owner: "bcrt1qother", satpoint: `${"99".repeat(32)}:0:0` } };
    // One index: the sat left the pair's funding input, so the pair is dead and a new one is prepared.
    expect(await catchUp({ sdk, did, provider: seeing(moved).provider, clock: blocks(), index: "ord-a", recoveryStore: r.store, recoveryIds: r.ids() }))
      .toMatchObject({ action: "prepare" });
    // Two indexes that disagree on the holder: neither resume nor prepare.
    const two = await catchUp({ sdk, did, provider: seeing(moved).provider, clock: blocks(), index: "ord-a", indexes: [{ provider: seeing(s).provider, index: "ord-b" }], recoveryStore: r.store, recoveryIds: r.ids() });
    expect(two).toMatchObject({ action: "wait-for-bitcoin", reason: "indexes-disagree", holders: [`${"99".repeat(32)}:0`, `${"cc".repeat(32)}:0`] });
    await expect(resumeEntryInscription({ sdk, did, provider: seeing(moved).provider, clock: blocks(), index: "ord-a", indexes: [{ provider: seeing(s).provider, index: "ord-b" }], recoveryStore: r.store, recoveryIds: r.ids(), recoveryId: pair.prepared.commitTxId }))
      .rejects.toMatchObject({ code: "NOT_RESUMABLE" });
  });
});

describe("submitting a prepared pair checks it can still land (P9.6)", () => {
  test("the sat has left the pair's funding input: nothing is sent (SAT_MOVED)", async () => {
    const { sdk, did } = await original(btcoAlias("regtest", SAT), 1);
    const r = recovery();
    const s = snapshot([]);
    const pair = await pairFor(sdk, did, node(s).provider, undefined, { recoveryStore: r.store, recoveryIds: r.ids() });
    const moved = node({ ...s, ownership: { owner: "bcrt1qother", satpoint: `${"99".repeat(32)}:0:0` } });
    await expect(submitEntryInscription({ sdk, did, pair, provider: moved.provider, clock: blocks(), index: INDEX, recoveryStore: r.store, recoveryIds: r.ids() }))
      .rejects.toMatchObject({ category: "stale-parent", code: "SAT_MOVED" });
    expect(moved.sent).toEqual([]);
  });

  test("a read that names no holder (ord, before the sat carries an inscription): the funding output is asked", async () => {
    const { sdk, did } = await original(btcoAlias("regtest", SAT), 1);
    const r = recovery();
    const s = { ...snapshot([]), ownership: { owner: null, satpoint: null } };
    const pair = await pairFor(sdk, did, node(snapshot([])).provider, undefined, { recoveryStore: r.store, recoveryIds: r.ids() });
    const asking = (first: () => Promise<string>) => {
      const n = node(s);
      (n.provider as { getFirstSatOfOutput: unknown }).getFirstSatOfOutput = first;
      return n;
    };
    const spent = asking(() => Promise.reject(new Error("Unspent output sat ranges unavailable")));
    await expect(submitEntryInscription({ sdk, did, pair, provider: spent.provider, clock: blocks(), index: INDEX, recoveryStore: r.store, recoveryIds: r.ids() }))
      .rejects.toMatchObject({ category: "incomplete-evidence", code: "SAT_HOLDER_UNKNOWN" });
    const other = asking(() => Promise.resolve("6000000000"));
    await expect(submitEntryInscription({ sdk, did, pair, provider: other.provider, clock: blocks(), index: INDEX, recoveryStore: r.store, recoveryIds: r.ids() }))
      .rejects.toMatchObject({ category: "stale-parent", code: "SAT_MOVED" });
    expect([...spent.sent, ...other.sent]).toEqual([]);
    const holds = asking(() => Promise.resolve(SAT));
    expect((await submitEntryInscription({ sdk, did, pair, provider: holds.provider, clock: blocks(), index: INDEX, recoveryStore: r.store, recoveryIds: r.ids() })).broadcast).toBe("reveal_broadcast");
  });

  test("a replacement named at prepare carries `replaces` to submit (C12-40)", async () => {
    const { sdk, did } = await original(btcoAlias("regtest", SAT), 1);
    const r = recovery();
    const s = snapshot([]);
    const first = await pairFor(sdk, did, node(s).provider, undefined, { recoveryStore: r.store, recoveryIds: r.ids() });
    r.put(first.prepared, "commit_broadcast");
    const second = await pairFor(sdk, did, node(s).provider, undefined, { recoveryStore: r.store, recoveryIds: r.ids(), replaces: [first.prepared.commitTxId], fundingUtxos: [holder, { ...fee, vout: 2 }] });
    expect(second.replaces).toEqual([first.prepared.commitTxId]);
    const chain = node(s);
    const sent = await submitEntryInscription({ sdk, did, pair: second, provider: chain.provider, clock: blocks(), index: INDEX, recoveryStore: r.store, recoveryIds: r.ids() });
    expect(sent.broadcast).toBe("reveal_broadcast");
    expect(chain.sent).toEqual([second.prepared.signedCommitHex, second.prepared.revealTxHex]);
  });
});

describe("transferHandoff options", () => {
  test("called without options from JavaScript: a structured refusal, not a TypeError", async () => {
    const { sdk, did } = await edited();
    for (const options of [undefined, null]) {
      await expect(transferHandoff(sdk, did, options as never)).rejects.toMatchObject({ category: "incomplete-evidence", code: "SAT_READ_REQUIRED" });
    }
    await expect(transferHandoff(sdk, did)).rejects.toMatchObject({ code: "SAT_READ_REQUIRED" });
  });
});
