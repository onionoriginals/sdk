import { expect, mock, test } from "bun:test";
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  CelError,
  createLocalSigner,
  type SatSnapshot,
} from "@originals/cel/v3";
import { OriginalsSDK } from "../../../src/index.js";
import type { OrdinalsProvider } from "../../../src/adapters/types.js";
import { HostedMemoryStorageAdapter } from "../../../src/storage/HostedMemoryStorageAdapter.js";
import { getScureNetwork } from "../../../src/bitcoin/transactions/commit.js";
import type { InscriptionRecoveryRecord } from "../../../src/bitcoin/inscription-recovery.js";

const signer = createLocalSigner("Ed25519", new Uint8Array(32).fill(21));
const domain = "example.com";
const paths = ["publication-errors"];
const methodPath = paths[0] + "/did.jsonl";

async function hostedFixture() {
  const storage = new HostedMemoryStorageAdapter();
  const put = mock(storage.putObject.bind(storage));
  storage.putObject = put;
  const sdk = OriginalsSDK.create({ signer, storageAdapter: storage });
  const asset = await sdk.lifecycle.createAsset([
    {
      id: "art",
      mediaType: "text/plain",
      content: "publication error contract",
    },
  ]);
  const prepared = await sdk.lifecycle.prepareWebPublication(asset, {
    domain,
    paths,
  });
  return { storage, put, sdk, prepared };
}

async function expectCelError(operation: Promise<unknown>, code: string) {
  const caught = await operation.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  expect(caught).toBeInstanceOf(CelError);
  expect(caught).toMatchObject({ status: "invalid", code });
}

test.each([{ didLog: [] }, { didLog: [{}] }])(
  "retained hosted publication rejects corrupt method log %j before writes",
  async ({ didLog }) => {
    const f = await hostedFixture();
    const retained = JSON.parse(JSON.stringify(f.prepared));
    retained.didLog = didLog;
    await expectCelError(
      f.sdk.lifecycle.publishPreparedToWeb(retained),
      "ASSET_WEBVH_BINDING",
    );
    expect(f.put).not.toHaveBeenCalled();
  },
);

for (const content of ["", "{}\n", '{"versionId":', "null\n"]) {
  test(`hosted resolve and republish reject invalid method bytes ${JSON.stringify(content)}`, async () => {
    const f = await hostedFixture();
    const published = await f.sdk.lifecycle.publishPreparedToWeb(f.prepared);
    await f.storage.putObject(domain, methodPath, content);
    f.put.mockClear();
    const fresh = OriginalsSDK.create({ storageAdapter: f.storage });
    await expectCelError(
      fresh.lifecycle.resolveAssetFromWeb(published.did),
      "ASSET_WEBVH_BINDING",
    );
    await expectCelError(
      f.sdk.lifecycle.publishToWeb(published.asset, { domain, paths }),
      "ASSET_WEBVH_BINDING",
    );
    expect(f.put).not.toHaveBeenCalled();
  });
}

test("valid retained hosted publication, cold resolution and republish retain verification", async () => {
  const f = await hostedFixture();
  const result = await f.sdk.lifecycle.publishPreparedToWeb(
    JSON.parse(JSON.stringify(f.prepared)),
  );
  expect(result.status).toBe("published");
  const fresh = OriginalsSDK.create({ storageAdapter: f.storage });
  const loaded = await fresh.lifecycle.resolveAssetFromWeb(result.did);
  expect(loaded.verification.verified).toBe(true);
  expect(loaded.asset.resources[0].content).toEqual(
    new TextEncoder().encode("publication error contract"),
  );
  const republished = await f.sdk.lifecycle.publishToWeb(result.asset, {
    domain,
    paths,
  });
  expect(republished.did).toBe(result.did);
  expect(await republished.asset.verify()).toBe(true);
});

test("hosted storage failures and existing typed validation errors keep their contracts", async () => {
  const f = await hostedFixture();
  const badVersion = { ...f.prepared, version: 2 };
  await expectCelError(
    f.sdk.lifecycle.publishPreparedToWeb(badVersion as typeof f.prepared),
    "ASSET_WEB_PUBLICATION",
  );
  const published = await f.sdk.lifecycle.publishPreparedToWeb(f.prepared);
  const unavailable = new Error("storage disconnected");
  f.storage.getObject = async () => {
    throw unavailable;
  };
  await expect(f.sdk.lifecycle.resolveAssetFromWeb(published.did)).rejects.toBe(
    unavailable,
  );
  await expect(
    f.sdk.lifecycle.publishToWeb(published.asset, { domain, paths }),
  ).rejects.toBe(unavailable);
  f.storage.putObject = async () => {
    throw unavailable;
  };
  await expect(
    f.sdk.lifecycle.publishPreparedToWeb(f.prepared),
  ).rejects.toMatchObject({
    code: "ASSET_WEB_PUBLISH_INCOMPLETE",
    details: { publication: f.prepared },
  });
});

async function bitcoinFixture() {
  const f = await hostedFixture();
  const key = new Uint8Array(32).fill(1);
  const payment = btc.p2wpkh(
    secp256k1.getPublicKey(key),
    getScureNetwork("regtest"),
  );
  const funding = {
    txid: "12".repeat(32),
    vout: 0,
    value: 100_000,
    scriptPubKey: Buffer.from(payment.script).toString("hex"),
  };
  const tip = { height: 100, hash: "b".repeat(64) };
  const snapshot: SatSnapshot = {
    network: "regtest",
    sat: "1250000000",
    tipBefore: tip,
    tipAfter: tip,
    indexTip: tip,
    indexHealthy: true,
    enumerationComplete: true,
    blocks: [],
    publications: [],
    ownership: { owner: payment.address!, satpoint: funding.txid + ":0:0" },
  };
  const broadcastTransaction = mock(
    async (hex: string) =>
      btc.Transaction.fromRaw(Buffer.from(hex, "hex"), {
        allowUnknownInputs: true,
        allowUnknownOutputs: true,
      }).id,
  );
  // Only the provider capabilities exercised by preparation/submission are supplied.
  const provider = {
    getFirstSatOfOutput: async () => snapshot.sat,
    getSatSnapshot: async () => snapshot,
    broadcastTransaction,
    getTransactionStatus: async () => ({ confirmed: false }),
  } as unknown as OrdinalsProvider;
  const sdk = OriginalsSDK.create({
    signer,
    network: "regtest",
    storageAdapter: f.storage,
    ordinalsProvider: provider,
  });
  const { asset } = await sdk.lifecycle.publishPreparedToWeb(f.prepared);
  const prepared = await sdk.lifecycle.prepareBitcoinPublication(asset, {
    fundingUtxos: [funding],
    changeAddress: payment.address!,
    feeRate: 2,
    satSigner: {
      signAndFinalizeCommitPsbt: async (psbt: string) => {
        const transaction = btc.Transaction.fromPSBT(
          Buffer.from(psbt, "base64"),
          { allowUnknownOutputs: true },
        );
        transaction.sign(key);
        transaction.finalize();
        return transaction.hex;
      },
    },
  });
  const records = new Map<string, InscriptionRecoveryRecord>();
  const save = mock(async (record: InscriptionRecoveryRecord) => {
    records.set(record.recoveryId, structuredClone(record));
  });
  const recoveryStore = {
    save,
    load: async (id: string) => records.get(id) ?? null,
  };
  return { sdk, prepared, broadcastTransaction, save, recoveryStore };
}

test.each(["", "00", "not-hex", "02000000000000000000"])(
  "corrupt retained reveal %j fails before persistence or broadcasts",
  async (revealTxHex) => {
    const f = await bitcoinFixture();
    const retained = JSON.parse(JSON.stringify(f.prepared));
    retained.transactions.revealTxHex = revealTxHex;
    await expectCelError(
      f.sdk.lifecycle.publishPreparedToBitcoin(retained, {
        recoveryStore: f.recoveryStore,
      }),
      "ASSET_BITCOIN_PUBLICATION",
    );
    expect(f.save).not.toHaveBeenCalled();
    expect(f.broadcastTransaction).not.toHaveBeenCalled();
  },
);

test("valid retained Bitcoin pair still persists and submits both transactions", async () => {
  const f = await bitcoinFixture();
  const result = await f.sdk.lifecycle.publishPreparedToBitcoin(
    JSON.parse(JSON.stringify(f.prepared)),
    { recoveryStore: f.recoveryStore },
  );
  expect(result.status).toBe("submitted");
  expect(result.asset.state.layer).toBe("btco");
  expect(f.save).toHaveBeenCalled();
  expect(f.broadcastTransaction.mock.calls.map(([hex]) => hex)).toEqual([
    f.prepared.transactions.signedCommitHex,
    f.prepared.transactions.revealTxHex,
  ]);
});

test("hosted method JSON decoding preserves CEL_LIMIT instead of labeling it invalid", async () => {
  const f = await hostedFixture();
  const published = await f.sdk.lifecycle.publishPreparedToWeb(f.prepared);
  await f.storage.putObject(
    domain,
    methodPath,
    "[".repeat(100) + "0" + "]".repeat(100),
  );
  for (const operation of [
    f.sdk.lifecycle.resolveAssetFromWeb(published.did),
    f.sdk.lifecycle.publishToWeb(published.asset, { domain, paths }),
  ]) {
    const caught = await operation.then(
      () => undefined,
      (cause: unknown) => cause,
    );
    expect(caught).toBeInstanceOf(CelError);
    expect(caught).toMatchObject({ status: "limit", code: "CEL_LIMIT" });
  }
  const corruptCel = structuredClone(f.prepared);
  corruptCel.asset.eventLog.log[0].proof[0].proofValue = "zbad";
  await expectCelError(
    f.sdk.lifecycle.publishPreparedToWeb(corruptCel),
    "CEL_SIGNATURE",
  );
});
