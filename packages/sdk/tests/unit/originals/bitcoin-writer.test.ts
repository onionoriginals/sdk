/**
 * The Bitcoin writer's refusals (plan 011 PR 10). The full journey, with real
 * transactions, is scripts/regtest/originals-anchor.ts on Bitcoin Core 31.1
 * and ord 0.29.0.
 */
import { describe, expect, test } from "bun:test";
import type { OrdinalsProvider } from "../../../src/adapters/types.js";
import type { BitcoinSigner } from "../../../src/types/common.js";
import { MemoryStore, OriginalsSDK, btcoAlias } from "../../../src/originals/index.js";
import { prepareEntryInscription } from "../../../src/originals/bitcoin-writer.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KEY = seed(21);
const SAT = "5000000000";
const utxo = { txid: "ab".repeat(32), vout: 0, value: 100_000, scriptPubKey: "0014" + "11".repeat(20) };
const satSigner: BitcoinSigner = { signAndFinalizeCommitPsbt: () => Promise.reject(new Error("not reached")) };
const provider = (sat: string) => ({ getFirstSatOfOutput: () => Promise.resolve(sat) }) as unknown as OrdinalsProvider;

async function original(anchorTo?: string) {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: async () => alice.evidence(), freshness: "asserted", clock: clock() });
  const signer = alice.signer("orig", KEY);
  const c = await sdk.create({ name: "Harbor", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: bytes("one") }], author: alice.ref("orig"), signer });
  if (c.kind !== "original") throw new Error("expected an Original");
  if (anchorTo) await sdk.anchor(c.original.did, { parent: c.original.checkpoint, author: alice.ref("orig"), signer, sat: anchorTo });
  return { sdk, did: c.original.did };
}

const prepare = (sdk: OriginalsSDK, did: string, network: "regtest" | "mainnet", sat: string) =>
  prepareEntryInscription({ sdk, did, fundingUtxos: [utxo], satSigner, changeAddress: "bcrt1qchange", feeRate: 2, network, provider: provider(sat) });

describe("inscribing an Original's head entry (P9.10, P9.12)", () => {
  test("an Original that is not anchored has nothing to inscribe yet", async () => {
    const { sdk, did } = await original();
    await expect(prepare(sdk, did, "regtest", SAT)).rejects.toMatchObject({ code: "NOT_ANCHORED" });
  });

  test("the writer's network must be the anchoring sat's", async () => {
    const { sdk, did } = await original(btcoAlias("regtest", SAT));
    await expect(prepare(sdk, did, "mainnet", SAT)).rejects.toMatchObject({ code: "NETWORK_MISMATCH" });
  });

  test("the first funding UTXO must hold the anchoring sat, so only its holder can extend the Original", async () => {
    const { sdk, did } = await original(btcoAlias("regtest", SAT));
    await expect(prepare(sdk, did, "regtest", "6000000000")).rejects.toMatchObject({ code: "WRONG_SAT" });
  });
});
