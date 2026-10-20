/**
 * The Bitcoin writer's refusals (plan 011 PR 10). The full journey, with real
 * transactions, is scripts/regtest/originals-anchor.ts on Bitcoin Core 31.1
 * and ord 0.29.0.
 */
import { describe, expect, test } from "bun:test";
import { ORIGINALS_INSCRIPTION_TYPE } from "@originals/vh/originals";
import type { OrdinalsProvider } from "../../../src/adapters/types.js";
import type { BitcoinNetwork, SatSnapshot } from "../../../src/bitcoin/sat-snapshot-types.js";
import type { BitcoinSigner } from "../../../src/types/common.js";
import { InscriptionClock, MemoryStore, OriginalsSDK, btcoAlias, readZip } from "../../../src/originals/index.js";
import { prepareEntryInscription, readAnchored } from "../../../src/originals/bitcoin-writer.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KEY = seed(21);
const SAT = "5000000000";
const T = Date.parse("2026-10-18T12:00:00Z") / 1000;
const utxo = { txid: "ab".repeat(32), vout: 0, value: 100_000, scriptPubKey: "0014" + "11".repeat(20) };
const satSigner: BitcoinSigner = { signAndFinalizeCommitPsbt: () => Promise.reject(new Error("not reached")) };
const hashAt = (h: number) => h.toString(16).padStart(64, "0");
const blocks = () => new InscriptionClock(async (h) => ({ time: T + h * 600, hash: hashAt(h) }));

/** A complete read of SAT holding these entry lines, one inscription each from height 10. */
function snapshot(lines: string[], network: BitcoinNetwork = "regtest"): SatSnapshot {
  const tip = { height: 20, hash: hashAt(20) };
  return {
    network, sat: SAT, tipBefore: tip, tipAfter: tip, indexTip: tip, indexHealthy: true, enumerationComplete: true, blocks: [],
    publications: lines.map((line, k) => ({
      id: `${(k + 1).toString(16).padStart(64, "e")}i0`, revealTxid: "e".repeat(64), network, sat: SAT, confirmed: true,
      creation: { height: 10 + k, blockHash: hashAt(10 + k), transactionIndex: 1, inscriptionIndex: 0 },
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

const prepare = (sdk: OriginalsSDK, did: string, network: "regtest" | "mainnet", p: OrdinalsProvider) =>
  prepareEntryInscription({ sdk, did, fundingUtxos: [utxo], satSigner, changeAddress: "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080", feeRate: 2, network, provider: p, clock: blocks() });

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

describe("the head must be the next entry Bitcoin can accept (P9.13)", () => {
  test("before the anchor is on Bitcoin, only the anchoring entry can be inscribed", async () => {
    const { sdk, did } = await original(btcoAlias("regtest", SAT), 1);
    await expect(prepare(sdk, did, "regtest", provider(SAT))).rejects.toMatchObject({ code: "HEAD_NOT_NEXT" });
  });

  test("an entry Bitcoin already shows is not inscribed again", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT));
    const all = await lines();
    await expect(prepare(sdk, did, "regtest", provider(SAT, snapshot([all[1]])))).rejects.toMatchObject({ code: "HEAD_NOT_NEXT" });
  });

  test("an entry that skips one Bitcoin does not show is refused", async () => {
    const { sdk, did, lines } = await original(btcoAlias("regtest", SAT), 2);
    const all = await lines();
    await expect(prepare(sdk, did, "regtest", provider(SAT, snapshot([all[1]])))).rejects.toMatchObject({ code: "HEAD_NOT_NEXT" });
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
