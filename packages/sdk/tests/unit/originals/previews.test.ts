/**
 * Bitcoin previews in the SDK (P9.17, P9.18, P9.30, P14.10, P14.12; owner
 * decision, 18 November 2026; originals-spec PR 64): the writer generates the
 * WebP preview of an image version when it signs the anchoring entry or a new
 * version, takes the author's preview of any other type, and inscribes the
 * preview as the body by default; with none, no body, or the full version when
 * chosen. Real pairs are built and read back as an index would report them.
 * The journey on Bitcoin Core and ord is scripts/regtest/originals-preview.ts.
 */
import { describe, expect, test } from "bun:test";
import * as btc from "@scure/btc-signer";
import { hex } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { parseWitness } from "micro-ordinals";
import { resourceDigest, verifyOriginal, type EditorGrant } from "@originals/vh/originals";
import { envelopeBodiesPresent, rawMetadataPerEnvelope } from "../../../src/bitcoin/ordinals-tags.js";
import type { PreparedInscriptionOnSat } from "../../../src/bitcoin/inscription-recovery.js";
import type { OrdinalsProvider } from "../../../src/adapters/types.js";
import type { SatSnapshot } from "../../../src/bitcoin/sat-snapshot-types.js";
import type { BitcoinSigner } from "../../../src/types/common.js";
import {
  InscriptionClock, MANIFEST, MemoryStore, OriginalsSDK, PREVIEW_MAX_BYTES, btcoAlias, generateImagePreview, readManifest, readZip, satEvidence, describeEntry,
} from "../../../src/originals/index.js";
import { prepareEntryInscription, readAnchored, waitForFeeRate, type EntryInscriptionParams } from "../../../src/originals/bitcoin-writer.js";
import { firstWebpFrame, sniff } from "../../../src/originals/preview.js";
import { Author, bytes, clock, seed } from "./helpers.js";
import { animatedWebp, avif, busy, gif, jpeg, png, svg, webp } from "./preview-fixtures.js";

const KEY = seed(51);
const SAT = "5000000000";
const ALIAS = btcoAlias("regtest", SAT);
const T = Date.parse("2026-10-18T12:00:00Z") / 1000;
const INDEX = "ord-a";
const hashAt = (h: number) => h.toString(16).padStart(64, "0");
const blocks = () => new InscriptionClock(async (h) => ({ time: T + h * 600, hash: hashAt(h) }));

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
const holder = { txid: "cc".repeat(32), vout: 0, value: 10_000, scriptPubKey: hex.encode(wallet.script) };
const fee = { txid: "dd".repeat(32), vout: 1, value: 100_000, scriptPubKey: hex.encode(wallet.script) };
const parse = (raw: string) => btc.Transaction.fromRaw(hex.decode(raw), { allowUnknownInputs: true, allowUnknownOutputs: true });
const scriptOf = (p: PreparedInscriptionOnSat) => btc.Script.decode(parse(p.revealTxHex).getInput(0).finalScriptWitness![1]);

/** What an index reports for a prepared reveal: its own metadata, content type and body, or none (P14.12). */
function asIndexed(p: PreparedInscriptionOnSat) {
  const script = scriptOf(p);
  const [i] = parseWitness(parse(p.revealTxHex).getInput(0).finalScriptWitness!)!;
  const present = envelopeBodiesPresent(script, 1)[0];
  return {
    status: "complete" as const, mediaType: i.tags.contentType ?? "", bytes: present ? i.body : new Uint8Array(), metadata: rawMetadataPerEnvelope(script, 1)[0]!,
    ...(present ? {} : { noBody: true as const }),
  };
}

/** A read of SAT holding these prepared pairs, one per block from height 10. */
function snapshot(pairs: PreparedInscriptionOnSat[]): SatSnapshot {
  const tip = { height: 30, hash: hashAt(30) };
  return {
    network: "regtest", sat: SAT, tipBefore: tip, tipAfter: tip, indexTip: tip, indexHealthy: true, enumerationComplete: true, blocks: [],
    publications: pairs.map((p, k) => ({
      id: p.inscriptionId, revealTxid: p.revealTxId, network: "regtest", sat: SAT, confirmed: true,
      creation: { height: 10 + k, blockHash: hashAt(10 + k), transactionIndex: 1, inscriptionIndex: 0 }, body: asIndexed(p),
    })),
    ownership: { owner: "bcrt1qholder", satpoint: `${"cc".repeat(32)}:0:0` },
  };
}
const node = (read: SatSnapshot) => ({
  getFirstSatOfOutput: () => Promise.resolve(SAT),
  getSatSnapshot: () => Promise.resolve(read),
  getTransactionStatus: () => Promise.resolve({ confirmed: true, confirmations: 3 }),
}) as unknown as OrdinalsProvider;

const pairFor = (sdk: OriginalsSDK, did: string, inscribed: PreparedInscriptionOnSat[], extra: Partial<EntryInscriptionParams> = {}) =>
  prepareEntryInscription({ sdk, did, fundingUtxos: [holder, fee], satSigner: realSigner, changeAddress: wallet.address!, feeRate: 1, network: "regtest", provider: node(snapshot(inscribed)), clock: blocks(), index: INDEX, recoveryStore: null, ...extra });

async function made(mediaType: string, content: Uint8Array, grants?: EditorGrant[]) {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const bob = await Author.create([{ fragment: "edit", secret: seed(53) }]);
  const known = new Map([[alice.did, alice], [bob.did, bob]]);
  const store = new MemoryStore();
  const sdk = OriginalsSDK.create({ store, authors: async (d) => known.get(d)?.evidence(), freshness: "asserted", clock: clock() });
  const asAlice = { author: alice.ref("orig"), signer: alice.signer("orig", KEY) };
  const asBob = { editor: bob.ref("edit"), signer: bob.signer("edit", seed(53)) };
  const c = await sdk.create({ name: "Harbor", resource: { mediaType, bytes: content }, ...asAlice, ...(grants ? { editors: grants } : {}) });
  if (c.kind !== "original") throw new Error("expected an Original");
  return { sdk, store, did: c.original.did, head: c.original.checkpoint, alice, bob, asAlice, asBob };
}

const isWebp = (b: Uint8Array) => sniff(b, "image/webp") === "webp";

describe("generated previews of image versions (P9.30)", () => {
  test("C12-360: PNG, JPEG, AVIF, animated GIF, animated WebP and SVG get a WebP preview of at most 8,192 bytes", async () => {
    const pic = busy(640, 480, 7);
    const frames = [await webp(busy(200, 120, 1)), await webp(busy(200, 120, 2))];
    const cases: Array<[string, Uint8Array, boolean]> = [
      ["image/png", png(pic), false],
      ["image/jpeg", await jpeg(pic), false],
      ["image/avif", await avif(busy(160, 120, 3)), false],
      ["image/gif", gif(300, 200), true],
      ["image/webp", animatedWebp(frames, 200, 120), true],
      ["image/svg+xml", svg(), false],
      ["Image/PNG", png(busy(40, 30, 9, true)), false],
    ];
    for (const [mediaType, content, animated] of cases) {
      const r = await generateImagePreview(content, mediaType);
      expect(r.status, mediaType).toBe("generated");
      if (r.status !== "generated") continue;
      const p = r.preview;
      expect(p.descriptor).toEqual({ mediaType: "image/webp", size: p.bytes.length, digest: resourceDigest(p.bytes) });
      expect(p.bytes.length, mediaType).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
      expect(p.bytes.length).toBeGreaterThan(0);
      expect(isWebp(p.bytes), mediaType).toBe(true);
      expect(Math.max(p.width, p.height), mediaType).toBeLessThanOrEqual(512);
      expect(p.source.firstFrameOnly, mediaType).toBe(animated);
    }
    expect(firstWebpFrame(frames[0])).toBeUndefined();
  }, 60_000);

  test("the same image gives the same preview: the search and the scalar encoder are deterministic", async () => {
    const content = png(busy(700, 500, 11));
    const [a, b] = [await generateImagePreview(content, "image/png"), await generateImagePreview(content, "image/png")];
    expect(a.status === "generated" && b.status === "generated" && hex.encode(a.preview.bytes) === hex.encode(b.preview.bytes)).toBe(true);
  });

  test("C12-360: the anchoring entry of an image Original names its generated preview, and the inscription carries it as the body", async () => {
    const content = png(busy(640, 480, 5));
    const { sdk, did, head, asAlice, alice } = await made("image/png", content);
    const anchored = await sdk.anchor(did, { parent: head, sat: ALIAS, ...asAlice });
    expect(anchored.preview).toMatchObject({ status: "generated", body: "preview", descriptor: { mediaType: "image/webp" } });
    const named = anchored.original.state.preview!;
    expect(named.size).toBeLessThanOrEqual(PREVIEW_MAX_BYTES);
    const pair = await pairFor(sdk, did, []);
    expect(pair.body).toBe("preview");
    const indexed = asIndexed(pair.prepared);
    expect(indexed.mediaType).toBe("image/webp");
    expect(resourceDigest(indexed.bytes)).toBe(named.digest);
    // C12-356: Bitcoin accepts it; the log verifies; the version is not verified by the preview.
    const view = await readAnchored(sdk, did, { provider: node(snapshot([pair.prepared])), clock: blocks(), index: INDEX });
    expect(view.report.anchoring?.anchor?.body).toBe("preview");
    expect(view.current).toBe(true);
    // This SDK holds the version, so it is verified from its store, never from Bitcoin.
    expect(view.report.resources.versions).toEqual([expect.objectContaining({ digest: resourceDigest(content), bytes: "verified", onBitcoin: false })]);
    // A fresh reader with only Bitcoin: the version is unavailable, not verified (P7.4, P9.30).
    const evidence = await satEvidence(snapshot([pair.prepared]), { clock: blocks(), ownerConfirmations: 3, index: INDEX });
    const fresh = await verifyOriginal({ bitcoin: [evidence], authors: [alice.evidence()], now: Date.parse("2026-10-19T00:00:00Z") });
    expect(fresh.history.status).toBe("valid");
    expect(fresh.resources.versions).toEqual([expect.objectContaining({ digest: resourceDigest(content), bytes: "missing" })]);
  });

  test("C12-361: an image the writer cannot decode, or cannot fit, gets no preview, the author is told, and the body is none or the full version", async () => {
    const { sdk, did, head, asAlice } = await made("image/jpeg", bytes("not really a jpeg"));
    const anchored = await sdk.anchor(did, { parent: head, sat: ALIAS, ...asAlice });
    expect(anchored.preview).toMatchObject({ status: "none", body: "none", reason: "undecodable" });
    expect(anchored.preview?.message).toContain("no preview");
    expect(anchored.original.state.preview).toBeUndefined();
    expect((await pairFor(sdk, did, [])).body).toBe("none");
    expect((await pairFor(sdk, did, [], { body: "full" })).body).toBe("full");
    for (const [mediaType, content] of [["image/bmp", bytes("BM....")], ["image/tiff", bytes("II*\0")]] as const) {
      const r = await generateImagePreview(content, mediaType);
      expect(r).toMatchObject({ status: "failed", failure: { reason: "undecodable" } });
    }
    const tight = await generateImagePreview(png(busy(300, 300, 4)), "image/png", { maxBytes: 16 });
    expect(tight).toMatchObject({ status: "failed", failure: { reason: "too-large" } });
  });

  test("C12-362: a new version whose generated preview would be byte-identical to its parent's gets another one", async () => {
    const pic = busy(400, 300, 21);
    const first = png(pic);
    const second = png(pic, "same pixels, other bytes");
    expect(resourceDigest(first)).not.toBe(resourceDigest(second));
    const { sdk, did, head, asAlice } = await made("image/png", first);
    const anchored = await sdk.anchor(did, { parent: head, sat: ALIAS, ...asAlice });
    const parentPreview = anchored.original.state.preview!;
    // The same pixels make the same preview first time round.
    const again = await generateImagePreview(second, "image/png");
    expect(again.status === "generated" && again.preview.descriptor.digest).toBe(parentPreview.digest);
    const edited = await sdk.edit(did, { parent: anchored.original.checkpoint, resource: { bytes: second }, ...asAlice });
    expect(edited.preview?.status).toBe("generated");
    const next = edited.original.state.preview!;
    expect(next.digest).not.toBe(parentPreview.digest);
    expect(next.mediaType).toBe("image/webp");
  });

  test("C12-363: the author does not supply the preview of an image (P9.30)", async () => {
    const { sdk, did, head, asAlice } = await made("image/png", png(busy(50, 50, 2)));
    await expect(sdk.anchor(did, { parent: head, sat: ALIAS, ...asAlice, preview: { bytes: bytes("x"), mediaType: "image/webp" } })).rejects.toMatchObject({ code: "PREVIEW_OF_IMAGE_SUPPLIED" });
  });
});

describe("previews of other versions, and no preview (P9.30)", () => {
  test("C12-359: a non-image version with no preview supplied names none and inscribes no body, unless the full version is chosen", async () => {
    const { sdk, did, head, asAlice } = await made("text/markdown", bytes("# Harbor\n\nAt dawn."));
    const anchored = await sdk.anchor(did, { parent: head, sat: ALIAS, ...asAlice });
    expect(anchored.preview).toMatchObject({ status: "none", body: "none", reason: "not-an-image" });
    const pair = await pairFor(sdk, did, []);
    expect(pair.body).toBe("none");
    expect(envelopeBodiesPresent(scriptOf(pair.prepared), 1)[0]).toBe(false);
    expect(asIndexed(pair.prepared)).toMatchObject({ mediaType: "", noBody: true });
    // C12-358: Bitcoin accepts it, its entries in the metadata only.
    const view = await readAnchored(sdk, did, { provider: node(snapshot([pair.prepared])), clock: blocks(), index: INDEX });
    expect(view.report.anchoring?.anchor?.body).toBe("none");
    expect(view.current).toBe(true);
    const full = await pairFor(sdk, did, [], { body: "full" });
    expect(asIndexed(full.prepared)).toMatchObject({ mediaType: "text/markdown", bytes: bytes("# Harbor\n\nAt dawn.") });
  });

  test("C12-364: an author-supplied preview of any media type is named and inscribed for a non-image version", async () => {
    const { sdk, did, head, asAlice } = await made("application/pdf", bytes("%PDF-1.7 a long paper"));
    const supplied = { bytes: bytes("Abstract: a short summary"), mediaType: "text/plain" };
    const anchored = await sdk.anchor(did, { parent: head, sat: ALIAS, ...asAlice, preview: supplied });
    expect(anchored.preview).toMatchObject({ status: "supplied", body: "preview", descriptor: { mediaType: "text/plain", size: supplied.bytes.length } });
    const pair = await pairFor(sdk, did, []);
    expect(asIndexed(pair.prepared)).toMatchObject({ mediaType: "text/plain", bytes: supplied.bytes });
    // A preview is never the full version: body "full" is refused for an entry naming one (P9.17).
    await expect(pairFor(sdk, did, [], { body: "full" })).rejects.toMatchObject({ code: "PREVIEW_NAMED" });
  });

  test("C12-365, C12-366: an author-supplied preview of 0 or 8,193 bytes is refused before signing; 8,192 is named", async () => {
    const { sdk, did, head, asAlice } = await made("text/plain", bytes("essay"));
    await expect(sdk.anchor(did, { parent: head, sat: ALIAS, ...asAlice, preview: { bytes: new Uint8Array(), mediaType: "text/plain" } })).rejects.toMatchObject({ code: "PREVIEW_EMPTY" });
    await expect(sdk.anchor(did, { parent: head, sat: ALIAS, ...asAlice, preview: { bytes: new Uint8Array(8_193), mediaType: "text/plain" } })).rejects.toMatchObject({ category: "limit-exceeded", code: "PREVIEW_TOO_LARGE" });
    const max = await sdk.anchor(did, { parent: head, sat: ALIAS, ...asAlice, preview: { bytes: new Uint8Array(8_192).fill(65), mediaType: "text/plain" } });
    expect(max.original.state.preview?.size).toBe(8_192);
  });

  test("C12-368: an Original not prepared for Bitcoin names no preview: a choice for it is refused", async () => {
    const { sdk, did, head, asAlice } = await made("text/plain", bytes("essay"));
    await expect(sdk.edit(did, { parent: head, name: "N", ...asAlice, preview: { bytes: bytes("p"), mediaType: "text/plain" } })).rejects.toMatchObject({ code: "PREVIEW_NOT_FOR_BITCOIN" });
    await expect(sdk.edit(did, { parent: head, name: "N", ...asAlice, body: "full" })).rejects.toMatchObject({ code: "PREVIEW_NOT_FOR_BITCOIN" });
    const plain = await sdk.edit(did, { parent: head, resource: { bytes: png(busy(10, 10)), mediaType: "image/png" }, ...asAlice });
    expect(plain.preview).toBeUndefined();
    expect(plain.original.state.preview).toBeUndefined();
  });
});

describe("previews after the anchor (P9.30)", () => {
  test("C12-355, C12-371: a name-only edit keeps the preview and inscribes it again; a new image version names a new preview", async () => {
    const { sdk, did, head, asAlice } = await made("image/png", png(busy(320, 240, 1)));
    const anchored = await sdk.anchor(did, { parent: head, sat: ALIAS, ...asAlice });
    const anchorPair = await pairFor(sdk, did, []);
    const renamed = await sdk.edit(did, { parent: anchored.original.checkpoint, name: "Harbor at dawn", ...asAlice });
    expect(renamed.preview).toMatchObject({ status: "kept", body: "preview" });
    expect(renamed.original.state.preview).toEqual(anchored.original.state.preview);
    const renamePair = await pairFor(sdk, did, [anchorPair.prepared]);
    expect(resourceDigest(asIndexed(renamePair.prepared).bytes)).toBe(anchored.original.state.preview!.digest);
    const recut = await sdk.edit(did, { parent: renamed.original.checkpoint, resource: { bytes: png(busy(320, 240, 2)) }, ...asAlice });
    expect(recut.preview?.status).toBe("generated");
    expect(recut.original.state.preview!.digest).not.toBe(anchored.original.state.preview!.digest);
    const recutPair = await pairFor(sdk, did, [anchorPair.prepared, renamePair.prepared]);
    const view = await readAnchored(sdk, did, { provider: node(snapshot([anchorPair.prepared, renamePair.prepared, recutPair.prepared])), clock: blocks(), index: INDEX });
    expect(view.head).toBe(recut.original.checkpoint);
    expect(view.report.anchoring?.accepted.map((a) => a.body)).toEqual(["preview", "preview"]);
    expect(view.state.preview).toEqual(recut.original.state.preview);
    // The signer is shown the preview it signs (P5.11).
    const draft = await sdk.prepareEdit(did, { parent: recut.original.checkpoint, name: "Later", ...asAlice });
    expect(describeEntry(draft.summary)).toContain("Preview for Bitcoin: unchanged, image/webp");
  });

  test("C12-355: choosing the full version for a name-only edit drops the preview until the version next changes", async () => {
    const { sdk, did, head, asAlice } = await made("image/png", png(busy(100, 100, 3)));
    const anchored = await sdk.anchor(did, { parent: head, sat: ALIAS, ...asAlice });
    const full = await sdk.edit(did, { parent: anchored.original.checkpoint, name: "N", ...asAlice, body: "full" });
    expect(full.preview).toMatchObject({ status: "none", body: "full", reason: "full-version-chosen" });
    expect(full.original.state.preview).toBeUndefined();
    const later = await sdk.edit(did, { parent: full.original.checkpoint, name: "M", ...asAlice });
    expect(later.preview).toMatchObject({ status: "none", reason: "parent-named-none" });
    await expect(sdk.edit(did, { parent: later.original.checkpoint, name: "O", ...asAlice, preview: { bytes: bytes("p"), mediaType: "image/webp" } })).rejects.toMatchObject({ code: "PREVIEW_NEEDS_NEW_VERSION" });
  });

  test("C12-378: a deactivation keeps its parent's preview, or with body full names none", async () => {
    const { sdk, did, head, asAlice } = await made("image/png", png(busy(100, 100, 4)));
    const anchored = await sdk.anchor(did, { parent: head, sat: ALIAS, ...asAlice });
    const draft = await sdk.prepareDeactivate(did, { parent: anchored.original.checkpoint, author: asAlice.author });
    expect((draft.entry.state.asset as { preview?: unknown }).preview).toEqual(anchored.original.state.preview);
    const bare = await sdk.prepareDeactivate(did, { parent: anchored.original.checkpoint, author: asAlice.author, body: "full" });
    expect((bare.entry.state.asset as { preview?: unknown }).preview).toBeUndefined();
    expect(bare.preview).toMatchObject({ status: "none", body: "full" });
  });

  test("C12-374: an editor whose grant allows the resource names the preview of its new version; it cannot drop a preview without one", async () => {
    const grant = (did: string): EditorGrant => ({ did, name: true, metadata: false, resource: true });
    // Author.create is deterministic: this is the editor DID `made` creates.
    const bob = await Author.create([{ fragment: "edit", secret: seed(53) }]);
    const { sdk, did, head, asAlice, asBob } = await made("image/png", png(busy(120, 80, 5)), [grant(bob.did)]);
    const anchored = await sdk.anchor(did, { parent: head, sat: ALIAS, ...asAlice });
    const byBob = await sdk.edit(did, { parent: anchored.original.checkpoint, resource: { bytes: png(busy(120, 80, 6)) }, ...asBob });
    expect(byBob.preview?.status).toBe("generated");
    expect(byBob.original.state.preview!.digest).not.toBe(anchored.original.state.preview!.digest);
    await expect(sdk.edit(did, { parent: byBob.original.checkpoint, name: "N", ...asBob, body: "full" })).rejects.toMatchObject({ category: "outside-grant" });
  });
});

describe("what the author is told, and what the package carries (P9.18, P14.10)", () => {
  test("C12-193: the notice says the preview, not the full version, is inscribed, that the version stays off Bitcoin, and the cost", async () => {
    const { sdk, did, head, asAlice } = await made("image/png", png(busy(500, 400, 8)));
    const anchored = await sdk.anchor(did, { parent: head, sat: ALIAS, ...asAlice });
    const pair = await pairFor(sdk, did, []);
    const n = pair.notice;
    expect(n.body).toMatchObject({ kind: "preview", mediaType: "image/webp", digest: anchored.original.state.preview!.digest });
    expect(n.activeContent).toBe(false);
    expect(n.cost).toMatchObject({ feeRate: 1 });
    expect(n.cost!.total).toBe(n.cost!.commitFee + n.cost!.revealFee);
    expect(n.cost!.total).toBeGreaterThan(0);
    expect(pair.cost).toEqual(n.cost!);
    expect(n.text).toContain("a preview (image/webp");
    expect(n.text).toContain("not on Bitcoin");
    expect(n.text).toContain(`${n.cost!.total} sats`);
    expect(n.text).toContain("public and permanent");
    // The version stays off Bitcoin (P9.18).
    expect(pair.offChain.resources.map((r) => r.version)).toEqual([1]);
    // With no body the notice says so; an SVG preview is WebP, never active content (P9.7).
    const doc = await made("image/svg+xml", svg());
    await doc.sdk.anchor(doc.did, { parent: doc.head, sat: ALIAS, ...doc.asAlice });
    expect((await pairFor(doc.sdk, doc.did, [])).notice).toMatchObject({ body: { kind: "preview", mediaType: "image/webp" }, activeContent: false });
    const text = await made("text/plain", bytes("note"));
    await text.sdk.anchor(text.did, { parent: text.head, sat: ALIAS, ...text.asAlice });
    const bare = (await pairFor(text.sdk, text.did, [])).notice;
    expect(bare.body).toEqual({ kind: "none" });
    expect(bare.text).toContain("no body");
  });

  test("C12-381: an evidence package of an anchored Original naming previews is complete without them", async () => {
    const { sdk, did, head, asAlice } = await made("image/png", png(busy(200, 150, 9)));
    const anchored = await sdk.anchor(did, { parent: head, sat: ALIAS, ...asAlice });
    const preview = anchored.original.state.preview!;
    const pkg = await sdk.package(did);
    const files = [...readZip(pkg.bytes).keys()];
    expect(files.filter((f) => f.startsWith("resources/"))).toEqual([`resources/${anchored.original.state.resource.digest}`]);
    expect(files.some((f) => f.includes(preview.digest))).toBe(false);
    const manifest = pkg.manifest;
    expect(readManifest(readZip(pkg.bytes).get(MANIFEST)!)).toEqual(manifest);
    expect(manifest.completeness).toBe("complete");
    expect(JSON.stringify(manifest.missing)).not.toContain(preview.digest);
  });

  test("waitForFeeRate waits, without blocking, until the rate is at most the ceiling; by default nothing waits", async () => {
    const rates = [12, 9, 4];
    const got = await waitForFeeRate({ currentFeeRate: () => Promise.resolve(rates.shift()!), maxFeeRate: 5, intervalMs: 1 });
    expect(got).toBe(4);
    const controller = new AbortController();
    const waiting = waitForFeeRate({ currentFeeRate: () => Promise.resolve(50), maxFeeRate: 5, intervalMs: 5, signal: controller.signal });
    controller.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow("stopped");
  });
});

describe("an evidence package of an anchored Original read without its anchor (P7.1, P7.14)", () => {
  test("C12-297: missing evidence, at most the entries before the anchoring entry, and the package not preferred to the anchor", async () => {
    const { sdk, did, head, asAlice, alice } = await made("text/plain", bytes("note"));
    const anchored = await sdk.anchor(did, { parent: head, sat: ALIAS, ...asAlice });
    const anchorPair = await pairFor(sdk, did, []);
    const renamed = await sdk.edit(did, { parent: anchored.original.checkpoint, name: "Renamed", ...asAlice });
    const pkg = await sdk.package(did);
    expect(pkg.manifest.completeness).toBe("complete");
    // A reader with the package and no Bitcoin evidence.
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], freshness: "asserted", clock: clock() });
    const received = await reader.load(new Uint8Array(pkg.bytes));
    expect(received.report.head).toBe(head);
    expect(received.report.anchoring?.status).toBe("unverified");
    expect(received.reasons).toContain("bitcoin-evidence-missing");
    expect(received.report.current).toBe(false);
    // With the anchor read, the anchor decides: the package's later entry is not on the sat, so not current.
    const read = await reader.load(new Uint8Array(pkg.bytes), { bitcoin: [await satEvidence(snapshot([anchorPair.prepared]), { clock: blocks(), ownerConfirmations: 3, index: INDEX })] });
    expect(read.report.head).toBe(anchored.original.checkpoint);
    expect(read.report.anchoring?.superseded).toBe(1);
    // The writer's own package, checked by the writer before inscribing, is verified whole as a local copy (P9.18).
    const own = await sdk.load(pkg.bytes);
    expect(own.report.head).toBe(renamed.original.checkpoint);
    expect(own.report.current).toBe(false);
  });
});
