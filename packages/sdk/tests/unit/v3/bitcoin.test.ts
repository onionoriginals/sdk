import { expect, test, mock } from "bun:test";
import * as btc from "@scure/btc-signer";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { parseWitness } from "micro-ordinals";
import {
  createLocalSigner,
  encodeDocument,
  parseDocument,
  type SatSnapshot,
} from "@originals/cel/v3";
import { OriginalsSDK } from "../../../src/index.js";
import type { PreparedBitcoinPublication } from "../../../src/v3/bitcoin.js";
import { getScureNetwork } from "../../../src/bitcoin/transactions/commit.js";

const signer = createLocalSigner("Ed25519", new Uint8Array(32).fill(7));
const key = new Uint8Array(32).fill(1);
const payment = btc.p2wpkh(
  secp256k1.getPublicKey(key),
  getScureNetwork("regtest"),
);
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
const tx = (hex: string) =>
  btc.Transaction.fromRaw(Buffer.from(hex, "hex"), {
    allowUnknownInputs: true,
    allowUnknownOutputs: true,
  });
const inscription = (p: PreparedBitcoinPublication) =>
  parseWitness(
    tx(p.transactions.revealTxHex).getInput(0).finalScriptWitness!,
  )![0];
async function fixture(
  media = true,
  content = png,
  extraResources: { id: string; mediaType: string; content: Uint8Array }[] = [],
) {
  const fundingUtxos = [
    {
      txid: "12".repeat(32),
      vout: 0,
      value: 100_000,
      scriptPubKey: Buffer.from(payment.script).toString("hex"),
    },
  ];
  const hash = "b".repeat(64);
  const snapshot: SatSnapshot = {
    network: "regtest",
    sat: "1250000000",
    tipBefore: { height: 100, hash },
    tipAfter: { height: 100, hash },
    indexTip: { height: 100, hash },
    indexHealthy: true,
    enumerationComplete: true,
    blocks: [],
    ownership: {
      owner: payment.address!,
      satpoint: fundingUtxos[0].txid + ":0:0",
    },
    publications: [],
  };
  const stored = new Map<
    string,
    { content: Uint8Array; contentType?: string }
  >();
  const provider = {
    getFirstSatOfOutput: mock(async () => snapshot.sat),
    getSatSnapshot: mock(async () => snapshot),
    broadcastTransaction: mock(async (hex: string) => tx(hex).id),
    getTransactionStatus: mock(async () => ({ confirmed: false })),
  } as any;
  const sdk = OriginalsSDK.create({
    network: "regtest",
    signer,
    ordinalsProvider: provider,
    storageAdapter: {
      putObject: async (domain, path, content, options) => {
        stored.set(domain + "/" + path, {
          content: content.slice(),
          contentType: options?.contentType,
        });
        return "https://" + domain + "/" + path;
      },
      getObject: async (domain, path) =>
        stored.get(domain + "/" + path) ?? null,
      exists: async (domain, path) => stored.has(domain + "/" + path),
    },
  });
  const local = await sdk.lifecycle.createAsset(
    media
      ? [{ id: "art", mediaType: "image/png", content }, ...extraResources]
      : extraResources,
  );
  const { asset } = await sdk.lifecycle.publishToWeb(local, {
    domain: "example.com",
  });
  const options = {
    fundingUtxos,
    satSigner: {
      signAndFinalizeCommitPsbt: mock(async (psbt: string) => {
        const transaction = btc.Transaction.fromPSBT(
          Buffer.from(psbt, "base64"),
          { allowUnknownOutputs: true },
        );
        transaction.sign(key);
        transaction.finalize();
        return transaction.hex;
      }),
    },
    changeAddress: payment.address!,
    feeRate: 2,
  };
  let acceptedHeight = 100;
  function accept(prepared: PreparedBitcoinPublication) {
    const body = inscription(prepared);
    const id = prepared.transactions.revealTxId;
    const height = acceptedHeight;
    // The fixture's initial tip is already height 100 / `hash`; a later call (e.g. a
    // second, delta publication accepted after the boundary) advances to a fresh block.
    const blockHash =
      height === 100 ? hash : height.toString(16).padStart(2, "0").repeat(32).slice(0, 64);
    if (height > 100)
      snapshot.tipBefore = snapshot.tipAfter = snapshot.indexTip = {
        height,
        hash: blockHash,
      };
    acceptedHeight += 1;
    snapshot.blocks.push({ height, hash: blockHash, txids: [id] });
    snapshot.publications.push({
      id: id + "i0",
      revealTxid: id,
      network: "regtest",
      sat: snapshot.sat,
      confirmed: true,
      creation: {
        height,
        blockHash,
        transactionIndex: 0,
        inscriptionIndex: 0,
      },
      body: {
        status: "complete",
        mediaType: body.tags.contentType!,
        bytes: body.body,
        metadata:
          body.tags.metadata === undefined
            ? null
            : encodeDocument(body.tags.metadata, "cbor"),
      },
    });
    snapshot.ownership.satpoint = id + ":0:0";
    options.fundingUtxos = [
      {
        txid: id,
        vout: 0,
        value: Number(
          tx(prepared.transactions.revealTxHex).getOutput(0).amount,
        ),
        scriptPubKey: Buffer.from(payment.script).toString("hex"),
      },
      { ...fundingUtxos[0], txid: "34".repeat(32) },
    ];
  }
  return { sdk, asset, snapshot, provider, options, accept };
}

test("prepares raw media plus the complete boundary without broadcasting and roundtrips the saved pair", async () => {
  const f = await fixture();
  const p = await f.sdk.lifecycle.prepareBitcoinPublication(f.asset, f.options);
  expect(p.kind).toBe("boundary");
  expect(p.document.log).toHaveLength(3);
  expect(p.document.log.at(-1)!.event.operation.type).toBe("migrate");
  const body = inscription(p);
  expect(body.body).toEqual(png);
  expect(body.tags.contentType).toBe("image/png");
  expect(body.tags.metadata).toEqual(p.document);
  expect(f.asset.state.layer).toBe("webvh");
  expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
  const records = new Map();
  const saved = JSON.parse(JSON.stringify(p));
  const result = await f.sdk.lifecycle.publishPreparedToBitcoin(saved, {
    recoveryStore: {
      save: async (r) => {
        records.set(r.recoveryId, structuredClone(r));
      },
      load: async (id) => records.get(id),
    },
  });
  expect(result.status).toBe("submitted");
  expect(result.asset.state.layer).toBe("btco");
  expect(await result.asset.verify()).toBe(false);
  expect(records.get(p.transactions.commitTxId).prepared.revealTxHex).toBe(
    p.transactions.revealTxHex,
  );
});

test("no inline media uses application/cel JSON without metadata", async () => {
  const f = await fixture(false);
  const p = await f.sdk.lifecycle.prepareBitcoinPublication(f.asset, f.options);
  const body = inscription(p);
  expect(body.tags.contentType).toBe("application/cel");
  expect(body.tags.metadata).toBeUndefined();
  expect(parseDocument(body.body, "json")).toEqual(p.document);
});

test("explicit inline selection retains unchanged media in a name-only delta", async () => {
  const f = await fixture();
  const boundary = await f.sdk.lifecycle.prepareBitcoinPublication(f.asset, f.options);
  f.accept(boundary);
  const loaded = await f.sdk.lifecycle.resolveAssetFromSat(f.snapshot.sat);
  if (loaded.status !== "accepted") throw new Error(loaded.status);
  await loaded.asset.update({ name: "Retitled PNG" });
  const delta = await f.sdk.lifecycle.prepareBitcoinPublication(loaded.asset, { ...f.options, inlineResourceId: "art" });
  expect(delta.kind).toBe("delta");
  expect(delta.document.log).toHaveLength(1);
  expect(inscription(delta).body).toEqual(png);
  expect(inscription(delta).tags.contentType).toBe("image/png");
  expect(inscription(delta).tags.metadata).toEqual(delta.document);
});

test("cold accepted head produces only a new delta, refusing absent evidence, stale proposals, and misaligned funding", async () => {
  const f = await fixture();
  const p = await f.sdk.lifecycle.prepareBitcoinPublication(f.asset, f.options);
  f.accept(p);
  const loaded = await f.sdk.lifecycle.resolveAssetFromSat(f.snapshot.sat);
  if (loaded.status !== "accepted") throw new Error(loaded.status);
  await loaded.asset.update({ name: "fresh delta" });
  const delta = await f.sdk.lifecycle.prepareBitcoinPublication(
    loaded.asset,
    f.options,
  );
  expect(delta.kind).toBe("delta");
  expect(delta.baseHead).toBe(
    loaded.asset.celLog.log.at(-1)!.event.previousEvent,
  );
  expect(delta.document.log).toHaveLength(1);
  expect(inscription(delta).tags.metadata).toBeUndefined();
  expect(inscription(delta).tags.contentType).toBe("application/cel");
  f.snapshot.enumerationComplete = false;
  await expect(
    f.sdk.lifecycle.prepareBitcoinPublication(loaded.asset, f.options),
  ).rejects.toThrow("accepted");
  f.snapshot.enumerationComplete = true;
  const current = await f.sdk.lifecycle.resolveAssetFromSat(f.snapshot.sat);
  if (current.status !== "accepted") throw new Error(current.status);
  await expect(
    f.sdk.lifecycle.prepareBitcoinPublication(current.asset, f.options),
  ).rejects.toThrow("extend");
  f.snapshot.ownership.satpoint = p.transactions.revealTxId + ":0:1";
  await expect(
    f.sdk.lifecycle.prepareBitcoinPublication(loaded.asset, f.options),
  ).rejects.toThrow("first sat");
});

test("rejects substituted prepared claims before broadcast and keeps ambiguous submissions explicit", async () => {
  const f = await fixture();
  const p = await f.sdk.lifecycle.prepareBitcoinPublication(f.asset, f.options);
  const changed = structuredClone(p);
  changed.document.log = [];
  await expect(
    f.sdk.lifecycle.publishPreparedToBitcoin(changed),
  ).rejects.toThrow();
  expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
  f.provider.submitInscription = async () => {
    throw new Error("accepted pair; response lost");
  };
  const result = await f.sdk.lifecycle.publishPreparedToBitcoin(p);
  expect(result.status).toBe("broadcast-unknown");
  expect(result.submission.broadcast).toBe("commit_broadcast_unknown");
  expect(result.submission.prepared).toEqual(p.transactions);
});

test("changed bytes are raw delta media and a retired controller cannot restore authority by holding the sat", async () => {
  const f = await fixture();
  const p = await f.sdk.lifecycle.prepareBitcoinPublication(f.asset, f.options);
  f.accept(p);
  const result = await f.sdk.lifecycle.resolveAssetFromSat(f.snapshot.sat);
  if (result.status !== "accepted") throw new Error(result.status);
  const next = createLocalSigner("Ed25519", new Uint8Array(32).fill(8));
  await result.asset.rotateKey(next.controller);
  await result.asset.addResourceVersion(
    "art",
    new Uint8Array([0, 255, 128]),
    "application/octet-stream",
    { signer: next },
  );
  const prepared = await f.sdk.lifecycle.prepareBitcoinPublication(
    result.asset,
    f.options,
  );
  expect(
    prepared.document.log.map((entry) => entry.event.operation.type),
  ).toEqual(["rotateKey", "update"]);
  expect(inscription(prepared).body).toEqual(new Uint8Array([0, 255, 128]));
  expect(inscription(prepared).tags.metadata).toEqual(prepared.document);
  await expect(
    result.asset.update({ name: "retired controller" }, { signer }),
  ).rejects.toThrow("current controller");
});

test("exact metadata envelope funds reveal fees and oversized inscriptions fail before Bitcoin signing", async () => {
  const f = await fixture();
  await f.asset.update({ metadata: { description: "x".repeat(30000) } });
  const hosted = await f.sdk.lifecycle.publishToWeb(f.asset, {
    domain: "example.com",
  });
  const p = await f.sdk.lifecycle.prepareBitcoinPublication(
    hosted.asset,
    f.options,
  );
  const commit = tx(p.transactions.signedCommitHex),
    reveal = tx(p.transactions.revealTxHex);
  const revealFee = Number(
    commit.getOutput(0).amount! - reveal.getOutput(0).amount!,
  );
  expect(revealFee).toBeGreaterThanOrEqual(reveal.vsize * f.options.feeRate);
  const large = await fixture(true, new Uint8Array(400000));
  await expect(
    large.sdk.lifecycle.prepareBitcoinPublication(large.asset, large.options),
  ).rejects.toThrow("envelope");
  expect(
    large.options.satSigner.signAndFinalizeCommitPsbt,
  ).not.toHaveBeenCalled();
});

test("valid signed wrapper substituted around a different signed reveal is rejected before submission", async () => {
  const f = await fixture();
  const first = await f.sdk.lifecycle.prepareBitcoinPublication(
    f.asset,
    f.options,
  );
  const second = await f.sdk.lifecycle.prepareBitcoinPublication(
    f.asset,
    f.options,
  );
  expect(first.document).not.toEqual(second.document);
  await expect(
    f.sdk.lifecycle.publishPreparedToBitcoin({
      ...first,
      transactions: second.transactions,
    }),
  ).rejects.toThrow("differs");
  expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
});

test("profile strings and own prototype-like metadata members survive the real CBOR inscription encoder", async () => {
  const f = await fixture();
  const metadata = JSON.parse(
    '{"__proto__":{"constructor":"literal"},"1":"numeric member","9007199254740993":"decimal string","unicode":"𐀀 é"}',
  );
  await f.asset.update({ metadata });
  const web = await f.sdk.lifecycle.publishToWeb(f.asset, {
    domain: "example.com",
  });
  const prepared = await f.sdk.lifecycle.prepareBitcoinPublication(
    web.asset,
    f.options,
  );
  expect(inscription(prepared).tags.metadata).toEqual(prepared.document);
  const data =
    inscription(prepared).tags.metadata.log[2].event.operation.data.metadata;
  expect(Object.hasOwn(data, "__proto__")).toBe(true);
  expect(data.__proto__).toEqual({ constructor: "literal" });
});

test("a competing accepted branch blocks the previously prepared local proposal", async () => {
  const f = await fixture();
  const boundary = await f.sdk.lifecycle.prepareBitcoinPublication(
    f.asset,
    f.options,
  );
  f.accept(boundary);
  const a = await f.sdk.lifecycle.resolveAssetFromSat(f.snapshot.sat),
    b = await f.sdk.lifecycle.resolveAssetFromSat(f.snapshot.sat);
  if (a.status !== "accepted" || b.status !== "accepted")
    throw new Error("fixture boundary rejected");
  await a.asset.update({ name: "stale fork" });
  await b.asset.update({ name: "accepted fork" });
  const accepted = await f.sdk.lifecycle.prepareBitcoinPublication(
    b.asset,
    f.options,
  );
  const body = inscription(accepted),
    id = accepted.transactions.revealTxId,
    hash = "c".repeat(64);
  f.snapshot.tipBefore =
    f.snapshot.tipAfter =
    f.snapshot.indexTip =
      { height: 101, hash };
  f.snapshot.blocks.push({ height: 101, hash, txids: [id] });
  f.snapshot.publications.push({
    id: id + "i0",
    revealTxid: id,
    network: "regtest",
    sat: f.snapshot.sat,
    confirmed: true,
    creation: {
      height: 101,
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
  f.snapshot.ownership.satpoint = id + ":0:0";
  f.options.fundingUtxos[0] = { ...f.options.fundingUtxos[0], txid: id };
  const before =
    f.options.satSigner.signAndFinalizeCommitPsbt.mock.calls.length;
  await expect(
    f.sdk.lifecycle.prepareBitcoinPublication(a.asset, f.options),
  ).rejects.toThrow("extend");
  expect(f.options.satSigner.signAndFinalizeCommitPsbt).toHaveBeenCalledTimes(
    before,
  );
});


test("a two-resource boundary marks only the inlined resource as chain-recoverable; the other stays referenced", async () => {
  const doc = new TextEncoder().encode("hello world");
  const f = await fixture(true, png, [
    { id: "doc", mediaType: "text/plain", content: doc },
  ]);
  const boundary = await f.sdk.lifecycle.prepareBitcoinPublication(f.asset, f.options);
  // Default selection inlines the first current resource ("art"); "doc" is never inlined here.
  expect(inscription(boundary).body).toEqual(png);
  f.accept(boundary);
  const resolved = await f.sdk.lifecycle.resolveAssetFromSat(f.snapshot.sat);
  if (resolved.status !== "accepted") throw new Error(resolved.status);
  expect(resolved.resourceAvailability).toEqual([
    { id: "art", version: 1, availability: "bitcoin-inline" },
    { id: "doc", version: 1, availability: "referenced" },
  ]);
  const byId = new Map(resolved.asset.resources.map((r) => [r.id, r]));
  expect(byId.get("art")!.content).toEqual(png);
  expect(byId.get("doc")!.content).toBeUndefined();
  expect(resolved.verification.missingResources).toEqual([
    { id: "doc", version: 1 },
  ]);
  expect(resolved.verification.resources).toBe("incomplete");
});

test("a two-resource delta only extends chain-recoverability for the selected resource; the unselected one stays referenced across versions", async () => {
  const doc = new TextEncoder().encode("hello world");
  const f = await fixture(true, png, [
    { id: "doc", mediaType: "text/plain", content: doc },
  ]);
  const boundary = await f.sdk.lifecycle.prepareBitcoinPublication(f.asset, f.options);
  f.accept(boundary);
  const loaded = await f.sdk.lifecycle.resolveAssetFromSat(f.snapshot.sat);
  if (loaded.status !== "accepted") throw new Error(loaded.status);
  // Change both resources in the same delta; default selection still inlines only one.
  await loaded.asset.addResourceVersion("art", new Uint8Array([1, 2, 3]), "image/png");
  await loaded.asset.addResourceVersion("doc", new TextEncoder().encode("v2"), "text/plain");
  const delta = await f.sdk.lifecycle.prepareBitcoinPublication(loaded.asset, f.options);
  expect(inscription(delta).body).toEqual(new Uint8Array([1, 2, 3]));
  f.accept(delta);
  const resolved = await f.sdk.lifecycle.resolveAssetFromSat(f.snapshot.sat);
  if (resolved.status !== "accepted") throw new Error(resolved.status);
  expect(resolved.resourceAvailability).toEqual([
    { id: "art", version: 1, availability: "bitcoin-inline" },
    { id: "doc", version: 1, availability: "referenced" },
    { id: "art", version: 2, availability: "bitcoin-inline" },
    { id: "doc", version: 2, availability: "referenced" },
  ]);
  const byId = new Map(resolved.asset.resources.map((r) => [r.id, r]));
  expect(byId.get("art")!.content).toEqual(new Uint8Array([1, 2, 3]));
  expect(byId.get("doc")!.content).toBeUndefined();
  expect(resolved.verification.missingResources).toEqual([
    { id: "doc", version: 1 },
    { id: "doc", version: 2 },
  ]);
});

test("uninscribed common sat uses the output sat-range proof when ord has no owner location", async () => {
  const f = await fixture();
  f.snapshot.ownership = { owner: null, satpoint: null };
  const prepared = await f.sdk.lifecycle.prepareBitcoinPublication(f.asset, f.options);
  expect(prepared.transactions.satoshi).toBe(f.snapshot.sat);
  expect(f.provider.getFirstSatOfOutput).toHaveBeenCalledTimes(1);
  expect(f.provider.broadcastTransaction).not.toHaveBeenCalled();
});
