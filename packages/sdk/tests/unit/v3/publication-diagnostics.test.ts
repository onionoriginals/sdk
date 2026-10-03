import { expect, mock, test } from "bun:test";
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { parseWitness } from "micro-ordinals";
import {
  CelError,
  createLocalSigner,
  type SatSnapshot,
} from "@originals/cel/v3";
import { OriginalsSDK } from "../../../src/index.js";
import type { OrdinalsProvider } from "../../../src/adapters/types.js";
import { HostedMemoryStorageAdapter } from "../../../src/storage/HostedMemoryStorageAdapter.js";
import { getScureNetwork } from "../../../src/bitcoin/transactions/commit.js";

const key = new Uint8Array(32).fill(1);
const payment = btc.p2wpkh(
  secp256k1.getPublicKey(key),
  getScureNetwork("regtest"),
);

async function fixture() {
  const localSigner = createLocalSigner("Ed25519", new Uint8Array(32).fill(7));
  const signer = {
    ...localSigner,
    sign: mock(localSigner.sign.bind(localSigner)),
  };
  const hash = "b".repeat(64);
  const fundingUtxos = [
    {
      txid: "12".repeat(32),
      vout: 0,
      value: 100_000,
      scriptPubKey: Buffer.from(payment.script).toString("hex"),
    },
  ];
  const snapshot: SatSnapshot = {
    network: "regtest",
    sat: "1250000000",
    tipBefore: { height: 100, hash },
    tipAfter: { height: 100, hash },
    indexTip: { height: 100, hash },
    indexHealthy: true,
    enumerationComplete: true,
    blocks: [],
    publications: [],
    ownership: {
      owner: payment.address!,
      satpoint: fundingUtxos[0].txid + ":0:0",
    },
  };
  const provider = {
    getFirstSatOfOutput: mock(async () => snapshot.sat),
    getSatSnapshot: mock(async () => snapshot),
    broadcastTransaction: mock(async () => {
      throw new Error("Unexpected broadcast");
    }),
  };
  const sdk = OriginalsSDK.create({
    network: "regtest",
    signer,
    // Only the publication preparation provider capabilities are exercised here.
    ordinalsProvider: provider as unknown as OrdinalsProvider,
    storageAdapter: new HostedMemoryStorageAdapter(),
  });
  async function hosted(name: string) {
    const asset = await sdk.lifecycle.createAsset([], { name });
    return (await sdk.lifecycle.publishToWeb(asset, { domain: "example.com" }))
      .asset;
  }
  const asset = await hosted("First Original");
  const options = {
    fundingUtxos,
    changeAddress: payment.address!,
    feeRate: 2,
    inlineResourceId: null,
    satSigner: {
      signAndFinalizeCommitPsbt: mock(async (psbt: string) => {
        const transaction = btc.Transaction.fromPSBT(
          Buffer.from(psbt, "base64"),
          {
            allowUnknownOutputs: true,
          },
        );
        transaction.sign(key);
        transaction.finalize();
        return transaction.hex;
      }),
    },
  };
  async function acceptBoundary() {
    const prepared = await sdk.lifecycle.prepareBitcoinPublication(
      asset,
      options,
    );
    const reveal = btc.Transaction.fromRaw(
      Buffer.from(prepared.transactions.revealTxHex, "hex"),
      {
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
      },
    );
    const body = parseWitness(reveal.getInput(0).finalScriptWitness!)![0];
    const id = prepared.transactions.revealTxId;
    snapshot.blocks.push({ height: 100, hash, txids: [id] });
    snapshot.publications.push({
      id: id + "i0",
      revealTxid: id,
      network: "regtest",
      sat: snapshot.sat,
      confirmed: true,
      creation: {
        height: 100,
        blockHash: hash,
        transactionIndex: 0,
        inscriptionIndex: 0,
      },
      body: {
        status: "complete",
        mediaType: body.tags.contentType!,
        bytes: body.body,
        metadata: null,
      },
    });
    snapshot.ownership.satpoint = id + ":0:0";
    options.fundingUtxos = [
      {
        ...fundingUtxos[0],
        txid: id,
        value: Number(reveal.getOutput(0).amount),
      },
      { ...fundingUtxos[0], txid: "34".repeat(32) },
    ];
    const resolved = await sdk.lifecycle.resolveAssetFromSat(snapshot.sat);
    expect(resolved.status).toBe("accepted");
    if (resolved.status === "accepted")
      expect(resolved.asset.id).toBe(asset.id);
  }
  function resetSigners() {
    signer.sign.mockClear();
    options.satSigner.signAndFinalizeCommitPsbt.mockClear();
  }
  function expectNoSigningOrBroadcast() {
    expect(signer.sign).not.toHaveBeenCalled();
    expect(options.satSigner.signAndFinalizeCommitPsbt).not.toHaveBeenCalled();
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
  }
  return {
    sdk,
    asset,
    hosted,
    snapshot,
    provider,
    options,
    acceptBoundary,
    resetSigners,
    expectNoSigningOrBroadcast,
  };
}

test("a different Original occupying the sat has a precise diagnostic before either signer runs", async () => {
  const f = await fixture();
  await f.acceptBoundary();
  const other = await f.hosted("Different Original");
  expect(other.id).not.toBe(f.asset.id);
  const before = other.serialize();
  f.resetSigners();
  const failure = await f.sdk.lifecycle
    .prepareBitcoinPublication(other, f.options)
    .catch((error) => error);
  expect(failure).toBeInstanceOf(CelError);
  expect(failure.code).toBe("ASSET_SAT_OCCUPIED");
  expect(failure.message).toContain("different Original");
  expect(failure.message).not.toContain("observation is required");
  expect(other.serialize()).toEqual(before);
  f.expectNoSigningOrBroadcast();
});

for (const evidence of [
  "incomplete",
  "unavailable",
  "changed-chain",
] as const) {
  test(`${evidence} evidence retains the accepted-head-required diagnostic before signing`, async () => {
    const f = await fixture();
    // Even an otherwise valid accepted boundary cannot establish occupation
    // when enumeration, provider availability, or snapshot stability is missing.
    await f.acceptBoundary();
    const other = await f.hosted("Different Original");
    if (evidence === "incomplete") f.snapshot.enumerationComplete = false;
    if (evidence === "unavailable")
      f.provider.getSatSnapshot.mockImplementation(async () => {
        throw new Error("offline");
      });
    if (evidence === "changed-chain")
      f.snapshot.tipAfter = { height: 101, hash: "c".repeat(64) };
    f.resetSigners();
    const failure = await f.sdk.lifecycle
      .prepareBitcoinPublication(other, f.options)
      .catch((error) => error);
    expect(failure).toBeInstanceOf(CelError);
    expect(failure.code).toBe("ASSET_ACCEPTED_HEAD_REQUIRED");
    expect(failure.message).toContain(
      "complete fresh accepted sat observation",
    );
    f.expectNoSigningOrBroadcast();
  });
}

test("complete unoccupied evidence still permits a boundary", async () => {
  const f = await fixture();
  f.resetSigners();
  const prepared = await f.sdk.lifecycle.prepareBitcoinPublication(
    f.asset,
    f.options,
  );
  expect(prepared.kind).toBe("boundary");
  expect(f.options.satSigner.signAndFinalizeCommitPsbt).toHaveBeenCalledTimes(
    1,
  );
  expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
});
