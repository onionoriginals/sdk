/**
 * The Bitcoin writer's refusals (plan 011 PR 10). The full journey, with real
 * transactions, is scripts/regtest/originals-anchor.ts on Bitcoin Core 31.1
 * and ord 0.29.0.
 */
import { describe, expect, test } from "bun:test";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { parseWitness } from "micro-ordinals";
import { ORIGINALS_INSCRIPTION_TYPE } from "@originals/vh/originals";
import type { InscriptionRecoveryRecord, InscriptionRecoveryStore, PreparedInscriptionOnSat } from "../../../src/bitcoin/inscription-recovery.js";
import type { OrdinalsProvider } from "../../../src/adapters/types.js";
import type { BitcoinNetwork, SatSnapshot } from "../../../src/bitcoin/sat-snapshot-types.js";
import type { BitcoinSigner } from "../../../src/types/common.js";
import { InscriptionClock, MemoryStore, OriginalsSDK, btcoAlias, readZip } from "../../../src/originals/index.js";
import { catchUp, nextPendingEntry, prepareEntryInscription, readAnchored, resumeInscriptionOnSat } from "../../../src/originals/bitcoin-writer.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KEY = seed(21);
const SAT = "5000000000";
const T = Date.parse("2026-10-18T12:00:00Z") / 1000;
const utxo = { txid: "ab".repeat(32), vout: 0, value: 100_000, scriptPubKey: "0014" + "11".repeat(20) };
const satSigner: BitcoinSigner = { signAndFinalizeCommitPsbt: () => Promise.reject(new Error("not reached")) };
const hashAt = (h: number) => h.toString(16).padStart(64, "0");
const blocks = () => new InscriptionClock(async (h) => ({ time: T + h * 600, hash: hashAt(h) }));

type Inscribed = string | { line: string; id?: string; height?: number; tx?: number };

/** A complete read of SAT holding these entry lines, one inscription each from height 10 unless placed. */
function snapshot(lines: Inscribed[], network: BitcoinNetwork = "regtest"): SatSnapshot {
  const tip = { height: 20, hash: hashAt(20) };
  return {
    network, sat: SAT, tipBefore: tip, tipAfter: tip, indexTip: tip, indexHealthy: true, enumerationComplete: true, blocks: [],
    publications: lines.map((p, k) => typeof p === "string" ? { line: p } : p).map(({ line, id, height, tx }, k) => ({
      id: id ?? `${(k + 1).toString(16).padStart(64, "e")}i0`, revealTxid: "e".repeat(64), network, sat: SAT, confirmed: true,
      creation: { height: height ?? 10 + k, blockHash: hashAt(height ?? 10 + k), transactionIndex: tx ?? 1, inscriptionIndex: 0 },
      body: { status: "complete" as const, mediaType: ORIGINALS_INSCRIPTION_TYPE, bytes: bytes(`${line}\n`), metadata: null },
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
  const c = await sdk.create({ name: "Harbor", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: bytes("one") }], author: alice.ref("orig"), signer });
  if (c.kind !== "original") throw new Error("expected an Original");
  let parent = c.original.checkpoint;
  if (anchorTo) parent = (await sdk.anchor(c.original.did, { parent, author: alice.ref("orig"), signer, sat: anchorTo })).original.checkpoint;
  for (let k = 0; k < edits; k++) parent = (await sdk.edit(c.original.did, { parent, name: `Harbor ${k}`, author: alice.ref("orig"), signer })).original.checkpoint;
  const lines = async () => new TextDecoder().decode(readZip((await sdk.package(c.original.did)).bytes).get("asset/did.jsonl")!).trimEnd().split("\n");
  return { sdk, did: c.original.did, lines };
}

const prepare = (sdk: OriginalsSDK, did: string, network: "regtest" | "mainnet", p: OrdinalsProvider, versionId?: string) =>
  prepareEntryInscription({ sdk, did, fundingUtxos: [utxo], satSigner, changeAddress: "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080", feeRate: 2, network, provider: p, clock: blocks(), ...(versionId ? { versionId } : {}) });

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

describe("an explicitly requested entry must be the next one Bitcoin can accept (P9.13)", () => {
  test("before the anchor is on Bitcoin, only the anchoring entry can be inscribed", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 1);
    const all = await lines();
    await expect(prepare(sdk, did, "regtest", provider(SAT), idOf(all[2]))).rejects.toMatchObject({ code: "HEAD_NOT_NEXT" });
  });

  test("an entry Bitcoin already shows is not inscribed again", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT));
    const all = await lines();
    await expect(prepare(sdk, did, "regtest", provider(SAT, snapshot([all[1]])), idOf(all[1]))).rejects.toMatchObject({ code: "HEAD_NOT_NEXT" });
    await expect(prepare(sdk, did, "regtest", provider(SAT, snapshot([all[1]])))).rejects.toMatchObject({ code: "NOTHING_TO_INSCRIBE" });
  });

  test("an entry that skips one Bitcoin does not show is refused", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 2);
    const all = await lines();
    await expect(prepare(sdk, did, "regtest", provider(SAT, snapshot([all[1]])), idOf(all[3]))).rejects.toMatchObject({ code: "HEAD_NOT_NEXT" });
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
    await expect(prepare(next.sdk, next.did, "regtest", provider(SAT, snapshot([all[1]])))).rejects.toThrow("not reached");
  });
});

describe("reading an anchored Original back", () => {
  test("a read of another network than the anchoring sat's is refused", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT));
    const all = await lines();
    await expect(readAnchored(sdk, did, { provider: provider(SAT, snapshot([all[1]], "mainnet")), clock: blocks() })).rejects.toMatchObject({ code: "NETWORK_MISMATCH" });
    const view = await readAnchored(sdk, did, { provider: provider(SAT, snapshot([all[1]])), clock: blocks() });
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
const inscribed = (p: PreparedInscriptionOnSat) => new TextDecoder().decode(parseWitness(parse(p.revealTxHex).getInput(0).finalScriptWitness!)![0].body);

/** A node: reads SAT as `read`, confirms the holder and the txids in `confirmed`, records broadcasts. */
function node(read: SatSnapshot, confirmed: string[] = []) {
  const sent: string[] = [];
  const known = new Set([holder.txid, ...confirmed]);
  const p = {
    getFirstSatOfOutput: () => Promise.resolve(SAT),
    getSatSnapshot: () => Promise.resolve(read),
    getTransactionStatus: (txid: string) => Promise.resolve(known.has(txid) ? { confirmed: true, confirmations: 3 } : { confirmed: false }),
    broadcastTransaction: (raw: string) => (sent.push(raw), Promise.resolve(parse(raw).id)),
  } as unknown as OrdinalsProvider;
  return { provider: p, sent };
}

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

const pairFor = (sdk: OriginalsSDK, did: string, p: OrdinalsProvider, versionId?: string) =>
  prepareEntryInscription({ sdk, did, fundingUtxos: [holder, fee], satSigner: realSigner, changeAddress: wallet.address!, feeRate: 2, network: "regtest", provider: p, clock: blocks(), ...(versionId ? { versionId } : {}) });

const step = (sdk: OriginalsSDK, did: string, p: OrdinalsProvider, r: ReturnType<typeof recovery>) =>
  catchUp({ sdk, did, provider: p, clock: blocks(), recoveryStore: r.store, recoveryIds: r.ids() });

describe("catching up entries committed but not yet inscribed (P9.4, P9.13)", () => {
  test("edits committed before the anchor is published: the anchoring entry goes first, its exact signed bytes", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 2);
    const all = await lines();
    const before = await nextPendingEntry(sdk, did, { provider: provider(SAT), clock: blocks() });
    expect(before).toMatchObject({ committed: idOf(all[3]), accepted: null, next: idOf(all[1]), queue: all.slice(1).map(idOf), remaining: 3 });
    const anchorPair = await pairFor(sdk, did, node(snapshot([])).provider);
    expect(anchorPair.versionId).toBe(idOf(all[1]));
    expect(inscribed(anchorPair.prepared)).toBe(`${all[1]}\n`);
    expect(anchorPair.remaining).toBe(2);
    // Once Bitcoin shows the anchor, the first edit is next.
    const after = await nextPendingEntry(sdk, did, { provider: provider(SAT, snapshot([all[1]])), clock: blocks() });
    expect(after).toMatchObject({ committed: idOf(all[3]), accepted: idOf(all[1]), acceptedHeight: 10, next: idOf(all[2]), remaining: 2 });
    expect(inscribed((await pairFor(sdk, did, node(snapshot([all[1]])).provider)).prepared)).toBe(`${all[2]}\n`);
    expect(await lines()).toEqual(all); // nothing re-signed or rebased
  });

  test("several edits after anchoring are published one at a time, each after the head Bitcoin shows (C12-28, C12-30)", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 3);
    const all = await lines();
    const r = recovery();
    for (let k = 1; k <= 3; k++) {
      const read = snapshot(all.slice(1, k + 1));
      const pending = await nextPendingEntry(sdk, did, { provider: provider(SAT, read), clock: blocks() });
      expect(pending).toMatchObject({ accepted: idOf(all[k]), acceptedHeight: 9 + k, next: idOf(all[k + 1]), remaining: 4 - k });
      expect(pending.view.current).toBe(true);
      const plan = await step(sdk, did, node(read).provider, r);
      expect(plan).toMatchObject({ action: "prepare", versionId: idOf(all[k + 1]) });
      expect(inscribed((await pairFor(sdk, did, node(read).provider)).prepared)).toBe(`${all[k + 1]}\n`);
    }
    const caughtUp = snapshot(all.slice(1));
    expect(await step(sdk, did, node(caughtUp).provider, r)).toMatchObject({ action: "done", pending: { next: null, remaining: 0, accepted: idOf(all[4]) } });
    await expect(pairFor(sdk, did, node(caughtUp).provider)).rejects.toMatchObject({ code: "NOTHING_TO_INSCRIBE" });
    expect(await lines()).toEqual(all);
  });

  test("a reveal already broadcast is waited on, never prepared again (C12-40)", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 2);
    const all = await lines();
    const read = snapshot([all[1]]);
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
    const read = snapshot([all[1]]);
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
    const mined = node(snapshot([all[1], { line: all[2], id: pair.prepared.inscriptionId }]), [pair.prepared.commitTxId, pair.prepared.revealTxId]);
    expect(await step(sdk, did, mined.provider, r)).toMatchObject({ action: "prepare", versionId: idOf(all[3]), replaces: [] });
    expect(mined.sent).toEqual([]);
  });

  test("a pair whose input has moved on is not resumed", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 1);
    const all = await lines();
    const r = recovery();
    const pair = await pairFor(sdk, did, node(snapshot([all[1]])).provider);
    r.put(pair.prepared, "prepared");
    const moved = snapshot([all[1]]);
    moved.ownership = { owner: "bcrt1qholder", satpoint: `${"ff".repeat(32)}:0:0` };
    expect(await step(sdk, did, node(moved).provider, r)).toMatchObject({ action: "prepare", versionId: idOf(all[2]) });
  });

  test("a reorganisation during catch-up re-derives the queue from the head Bitcoin shows (C12-40)", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 3);
    const all = await lines();
    const r = recovery();
    const second = await pairFor(sdk, did, node(snapshot([all[1], all[2]])).provider);
    expect(second.versionId).toBe(idOf(all[3]));
    r.put(second.prepared, "reveal_broadcast");
    const shown = snapshot([all[1], all[2], { line: all[3], id: second.prepared.inscriptionId }]);
    expect(await nextPendingEntry(sdk, did, { provider: node(shown, [second.prepared.revealTxId]).provider, clock: blocks() })).toMatchObject({ next: idOf(all[4]), remaining: 1 });
    // The block holding the second edit is replaced: its reveal is back in the mempool.
    const reorged = snapshot([all[1], all[2]]);
    const pending = await nextPendingEntry(sdk, did, { provider: node(reorged).provider, clock: blocks() });
    expect(pending).toMatchObject({ accepted: idOf(all[2]), next: idOf(all[3]), queue: [idOf(all[3]), idOf(all[4])], remaining: 2 });
    expect(await step(sdk, did, node(reorged).provider, r)).toMatchObject({ action: "wait-for-confirmation", reason: "unconfirmed", recoveryId: second.prepared.commitTxId });
    // The new chain mines it in the same block as its parent: Bitcoin ignores it (P9.13), so a replacement is prepared.
    const sameBlock = snapshot([all[1], { line: all[2], height: 11 }, { line: all[3], id: second.prepared.inscriptionId, height: 11, tx: 2 }]);
    const plan = await step(sdk, did, node(sameBlock, [second.prepared.commitTxId, second.prepared.revealTxId]).provider, r);
    expect(plan).toMatchObject({ action: "prepare", versionId: idOf(all[3]), replaces: [second.prepared.inscriptionId] });
  });

  test("a confirmed reveal the sat read does not show yet is waited on, not paid for twice", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 1);
    const all = await lines();
    const r = recovery();
    const read = snapshot([all[1]]);
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
    await expect(nextPendingEntry(behind.sdk, behind.did, { provider: provider(SAT, snapshot([all[1], all[2]])), clock: blocks() }))
      .rejects.toMatchObject({ code: "BITCOIN_HEAD_NOT_STORED" });
  });
});
