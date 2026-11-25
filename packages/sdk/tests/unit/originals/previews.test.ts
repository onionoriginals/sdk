/**
 * Bitcoin previews in the SDK (P9.17, P9.18, P9.30, P14.10, P14.12; owner
 * decision, 18 November 2026; originals-spec PR 64): the writer generates the
 * WebP preview of an image version when it signs the anchoring entry or a new
 * version, takes the author's preview of any other type, and inscribes the
 * preview as the body by default; with none, no body, or the full version when
 * chosen. Real pairs are built and read back as an index would report them.
 * The journey on Bitcoin Core and ord is scripts/regtest/originals-preview.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
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
import { PREVIEW_CODEC_ATTEMPTS, PREVIEW_CODEC_RETRY_DELAYS_MS, configurePreviewCodecs, firstWebpFrame, setPreviewCodecFault, sniff } from "../../../src/originals/preview.js";
import { Author, bytes, clock, seed } from "./helpers.js";
import { animatedWebp, avif, busy, gif, grayPng, jpeg, png, svg, webp } from "./preview-fixtures.js";

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
      expect(r.status, `${mediaType}: ${r.status === "failed" ? r.failure.message : ""}`).toBe("generated");
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
    // Unless the author chooses the full version: then no preview is named, and the body is the image.
    const small = png(busy(64, 48, 5));
    const chosen = await made("image/png", small);
    const full = await chosen.sdk.anchor(chosen.did, { parent: chosen.head, sat: ALIAS, ...chosen.asAlice, body: "full" });
    expect(full.preview).toMatchObject({ status: "none", body: "full" });
    expect(full.original.state.preview).toBeUndefined();
    expect(asIndexed((await pairFor(chosen.sdk, chosen.did, [])).prepared)).toMatchObject({ mediaType: "image/png", bytes: small });
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

  test("C12-361: an image too large to decode safely gets no preview, whatever its header hides, before it is decoded", async () => {
    const tooLarge = { status: "failed", failure: { reason: "undecodable", message: expect.stringMatching(/too large to decode|cannot be sized/) } };
    // A JPEG whose SOF is preceded by a fill byte (allowed by JPEG) and claims 10,000 × 10,000 pixels:
    // a few kilobytes that mozjpeg would decode into 400 MB.
    const small = await jpeg(busy(64, 48));
    let sof = 2;
    while (!(small[sof] === 0xff && small[sof + 1] >= 0xc0 && small[sof + 1] <= 0xc2)) sof++;
    const filled = Uint8Array.from([...small.subarray(0, sof), 0xff, ...small.subarray(sof)]);
    filled.set([0x27, 0x10, 0x27, 0x10], sof + 1 + 5);
    expect(await generateImagePreview(filled, "image/jpeg")).toMatchObject(tooLarge);
    // A JPEG that is still sized through its fill byte is previewed as before.
    const fine = Uint8Array.from([...small.subarray(0, sof), 0xff, ...small.subarray(sof)]);
    expect((await generateImagePreview(fine, "image/jpeg")).status).toBe("generated");
    // A GIF whose 2 × 2 screen hides a 10,000 × 10,000 first frame.
    const g = gif(2, 2);
    const descriptor = g.indexOf(0x2c, 13);
    g.set([0x10, 0x27, 0x10, 0x27], descriptor + 5);
    expect(await generateImagePreview(g, "image/gif")).toMatchObject(tooLarge);
    // An animated WebP whose 16 × 16 canvas hides a 10,000 × 10,000 first frame.
    const frame = await webp(busy(16, 16, 1));
    const anim = animatedWebp([frame], 16, 16);
    const anmf = Buffer.from(anim).indexOf("ANMF");
    anim.set([0x0f, 0x27, 0x00, 0x0f, 0x27, 0x00], anmf + 8 + 6);
    expect(await generateImagePreview(anim, "image/webp")).toMatchObject(tooLarge);
    // An AVIF is sized by its ispe property; one claiming 10,000 × 10,000, or with none, is not decoded.
    const a = await avif(busy(32, 32, 3));
    const ispe = Buffer.from(a).indexOf("ispe");
    const huge = new Uint8Array(a);
    huge.set([0, 0, 0x27, 0x10, 0, 0, 0x27, 0x10], ispe + 8);
    expect(await generateImagePreview(huge, "image/avif")).toMatchObject(tooLarge);
    const unsized = new Uint8Array(a);
    unsized.set([0x78], ispe);
    expect(await generateImagePreview(unsized, "image/avif")).toMatchObject(tooLarge);
    // An SVG embedding a PNG of 8,000 × 7,000 pixels, directly or in a nested SVG, is not rasterised.
    const bomb = grayPng(8000, 7000);
    const embed = (href: string) => svg(`<image width="300" height="200" href="${href}"/>`);
    const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
    expect(await generateImagePreview(embed(`data:image/png;base64,${b64(bomb)}`), "image/svg+xml")).toMatchObject(tooLarge);
    expect(await generateImagePreview(embed(`data:image/svg+xml;base64,${b64(embed(`data:image/png;base64,${b64(bomb)}`))}`), "image/svg+xml")).toMatchObject(tooLarge);
    // A small embedded image is still drawn.
    expect((await generateImagePreview(embed(`data:image/png;base64,${b64(png(busy(30, 20, 4)))}`), "image/svg+xml")).status).toBe("generated");
  }, 60_000);

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
    const { sdk, did, head, asAlice, alice } = await made("image/png", png(busy(500, 400, 8)));
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
    expect(n.text).toContain("not the version itself");
    expect(n.text).toContain(`${n.cost!.total} sats`);
    expect(n.text).toContain("public and permanent");
    // The version stays off Bitcoin (P9.18).
    expect(pair.offChain.resources.map((r) => r.version)).toEqual([1]);
    // The statement itself says what Bitcoin will not hold: the versions not inscribed in full and the
    // off-chain signer DID histories, whose replication is not guaranteed (P9.18).
    expect(n.text).toContain("Bitcoin will not hold version 1");
    expect(n.text).toContain(`the DID history of ${alice.did}`);
    expect(n.text).toContain("not guaranteed");
    // With no body the notice says so; an SVG preview is WebP, never active content (P9.7).
    const doc = await made("image/svg+xml", svg());
    await doc.sdk.anchor(doc.did, { parent: doc.head, sat: ALIAS, ...doc.asAlice });
    expect((await pairFor(doc.sdk, doc.did, [])).notice).toMatchObject({ body: { kind: "preview", mediaType: "image/webp" }, activeContent: false });
    const text = await made("text/plain", bytes("note"));
    await text.sdk.anchor(text.did, { parent: text.head, sat: ALIAS, ...text.asAlice });
    const bare = (await pairFor(text.sdk, text.did, [])).notice;
    expect(bare.body).toEqual({ kind: "none" });
    expect(bare.text).toContain("no body");
    expect(bare.text).toMatch(/^This inscription has no body: it puts only the log from \S+ through \S+, with the Original's name and metadata, on Bitcoin\./);
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

describe("the body chosen when an entry is committed is the body inscribed (P9.18, P9.30)", () => {
  test("an entry committed with body full is inscribed in full by default, on any later prepare, and an explicit other body is refused", async () => {
    const { sdk, did, head, asAlice } = await made("text/plain", bytes("note"));
    const anchored = await sdk.anchor(did, { parent: head, sat: ALIAS, ...asAlice, body: "full" });
    expect(anchored.preview).toMatchObject({ body: "full" });
    // A writer resuming, catching up or replacing the pair passes no body: the author's choice holds.
    const pair = await pairFor(sdk, did, []);
    expect(pair.body).toBe("full");
    expect(pair.notice.body).toMatchObject({ kind: "full" });
    expect(asIndexed(pair.prepared)).toMatchObject({ mediaType: "text/plain", bytes: bytes("note") });
    await expect(pairFor(sdk, did, [], { body: "preview" })).rejects.toMatchObject({ code: "BODY_CHOICE_CONFLICT" });
    // An entry committed without the choice still defaults to no body, and may be inscribed in full when asked.
    const renamed = await sdk.edit(did, { parent: anchored.original.checkpoint, name: "Renamed", ...asAlice });
    expect(renamed.preview).toMatchObject({ body: "none" });
    expect((await pairFor(sdk, did, [pair.prepared])).body).toBe("none");
    expect((await pairFor(sdk, did, [pair.prepared], { body: "full" })).body).toBe("full");
  });

  test("the choice is durable: a FileStore reopened by another SDK instance keeps it", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { FileStore } = await import("../../../src/originals/fs-store.js");
    const dir = await mkdtemp(join(tmpdir(), "body-choice-"));
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const asAlice = { author: alice.ref("orig"), signer: alice.signer("orig", KEY) };
    const first = await FileStore.open(dir);
    const sdk = OriginalsSDK.create({ store: first, authors: async () => alice.evidence(), freshness: "asserted", clock: clock() });
    const c = await sdk.create({ name: "Harbor", resource: { mediaType: "text/plain", bytes: bytes("note") }, ...asAlice });
    if (c.kind !== "original") throw new Error("expected an Original");
    const anchored = await sdk.anchor(c.original.did, { parent: c.original.checkpoint, sat: ALIAS, ...asAlice, body: "full" });
    await first.close();
    const second = await FileStore.open(dir);
    const again = OriginalsSDK.create({ store: second, authors: async () => alice.evidence(), freshness: "asserted", clock: clock() });
    expect(await again.chosenBody(c.original.did, anchored.original.checkpoint)).toBe("full");
    expect((await pairFor(again, c.original.did, [])).body).toBe("full");
    await second.close();
  });

  test("a pair with no body is not sent for an entry committed with body full (PAIR_BODY_MISMATCH)", async () => {
    const { sdk, did, head, asAlice, alice } = await made("text/plain", bytes("note"));
    await sdk.anchor(did, { parent: head, sat: ALIAS, ...asAlice, body: "full" });
    // Another writer holding the same log, imported without the author's choice, builds a pair with no body.
    const other = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], freshness: "asserted", clock: clock() });
    await other.import((await sdk.package(did)).bytes);
    const bare = await pairFor(other, did, []);
    expect(bare.body).toBe("none");
    const { submitEntryInscription } = await import("../../../src/originals/bitcoin-writer.js");
    const recoveryStore = { save: () => Promise.resolve(), load: () => Promise.resolve(undefined) };
    await expect(submitEntryInscription({ sdk, did, pair: bare, provider: node(snapshot([])), clock: blocks(), index: INDEX, recoveryStore, recoveryIds: [] }))
      .rejects.toMatchObject({ code: "PAIR_BODY_MISMATCH" });
  });
});

describe("C12-360: an AVIF gets the same preview however the process is loaded (P9.30)", () => {
  afterEach(() => {
    setPreviewCodecFault(undefined);
    configurePreviewCodecs({ retryDelaysMs: undefined });
  });
  // CI saw image/avif come back `failed` at random: the WASM runtime had no memory left for the
  // decoder's instance, and that was reported as an undecodable image. The generator has no time
  // budget; these tests pin what it does instead.
  // The fault tests inject immediate retries; the default waits are what a loaded machine gets.
  const immediate = PREVIEW_CODEC_RETRY_DELAYS_MS.map(() => 0);
  const withFaults = async (fault: (key: string) => void, run: () => Promise<void>) => {
    configurePreviewCodecs({ retryDelaysMs: immediate });
    setPreviewCodecFault(fault);
    try {
      await run();
    } finally {
      setPreviewCodecFault(undefined);
      configurePreviewCodecs({ retryDelaysMs: undefined });
    }
  };
  const digestOf = (r: Awaited<ReturnType<typeof generateImagePreview>>) => (r.status === "generated" ? r.preview.descriptor.digest : `failed: ${r.failure.message}`);

  test("ten times in a row and sixteen at once, the same preview", async () => {
    const a = await avif(busy(160, 120, 3));
    const first = digestOf(await generateImagePreview(a, "image/avif"));
    expect(first).toStartWith("z");
    for (let i = 0; i < 10; i++) expect(digestOf(await generateImagePreview(a, "image/avif"))).toBe(first);
    const all = await Promise.all(Array.from({ length: 16 }, () => generateImagePreview(a, "image/avif")));
    expect(new Set(all.map(digestOf))).toEqual(new Set([first]));
  });

  test("WASM memory running out is retried with a fresh codec instance, and gives the same preview", async () => {
    const a = await avif(busy(160, 120, 3));
    const expected = digestOf(await generateImagePreview(a, "image/avif"));
    let faults = PREVIEW_CODEC_ATTEMPTS - 1;
    const seen: string[] = [];
    await withFaults((key) => { seen.push(key); if (key === "avif" && faults-- > 0) throw new RangeError("Out of memory"); }, async () => {
      expect(digestOf(await generateImagePreview(a, "image/avif"))).toBe(expected);
      expect(seen.filter((k) => k === "avif")).toHaveLength(PREVIEW_CODEC_ATTEMPTS);
    });
    // The encoder too: an Emscripten OOM abort while encoding.
    let encodeFaults = 2;
    await withFaults((key) => { if (key === "webp-enc" && encodeFaults-- > 0) throw new Error("Aborted(OOM)"); }, async () => {
      expect(digestOf(await generateImagePreview(a, "image/avif"))).toBe(expected);
    });
  });

  test("memory that stays short is an error, never a failed preview", async () => {
    const a = await avif(busy(160, 120, 3));
    await withFaults((key) => { if (key === "avif") throw new RangeError("Out of memory"); }, async () => {
      await expect(generateImagePreview(a, "image/avif")).rejects.toMatchObject({ category: "limit-exceeded", code: "PREVIEW_RUNTIME_EXHAUSTED" });
    });
    expect((await generateImagePreview(a, "image/avif")).status).toBe("generated");
  });

  test("the default retry waits are explicit and add up to about 5 seconds", () => {
    expect(PREVIEW_CODEC_RETRY_DELAYS_MS).toEqual([250, 1000, 4000]);
    expect(PREVIEW_CODEC_ATTEMPTS).toBe(4);
  });

  test("a WASM trap is retried on a fresh instance and gives the same preview (CI: unreachable in the AVIF decoder)", async () => {
    const a = await avif(busy(160, 120, 3));
    const expected = digestOf(await generateImagePreview(a, "image/avif"));
    const Trap = (WebAssembly as unknown as { RuntimeError: new (m: string) => Error }).RuntimeError;
    let traps = 1;
    const seen: string[] = [];
    await withFaults((key) => { if (key === "avif") { seen.push(key); if (traps-- > 0) throw new Trap("Unreachable code should not be executed (evaluating 'getWasmTableEntry(index)(a1, a2, a3, a4)')"); } }, async () => {
      expect(digestOf(await generateImagePreview(a, "image/avif"))).toBe(expected);
      expect(seen).toHaveLength(2);
    });
    // The instance after it is fresh and works: nothing leaks into the next call.
    expect(digestOf(await generateImagePreview(a, "image/avif"))).toBe(expected);
  });

  test("an error is the image's only when it recurs identically on a fresh instance", async () => {
    const a = await avif(busy(160, 120, 3));
    const expected = digestOf(await generateImagePreview(a, "image/avif"));
    // Once: retried, and the preview is made.
    let first = true;
    await withFaults((key) => { if (key === "avif" && first) { first = false; throw new Error("Aborted(corrupt input)"); } }, async () => {
      expect(digestOf(await generateImagePreview(a, "image/avif"))).toBe(expected);
    });
    // Every time, identically: confirmed on a fresh instance, so the image is undecodable.
    const seen: string[] = [];
    await withFaults((key) => { if (key === "avif") { seen.push(key); throw new Error("Aborted(corrupt input)"); } }, async () => {
      expect(await generateImagePreview(a, "image/avif")).toMatchObject({ status: "failed", failure: { reason: "undecodable" } });
      expect(seen).toHaveLength(2);
    });
    // Differently on every fresh instance: never taken as the image's; an error, not a failed preview.
    let n = 0;
    await withFaults((key) => { if (key === "avif") throw new Error(`Aborted(fault ${n++})`); }, async () => {
      await expect(generateImagePreview(a, "image/avif")).rejects.toMatchObject({ code: "PREVIEW_RUNTIME_FAULT" });
    });
    expect(digestOf(await generateImagePreview(a, "image/avif"))).toBe(expected);
  });

  test("a real undecodable AVIF is still failed, identically each time", async () => {
    const a = await avif(busy(32, 32, 3));
    const broken = new Uint8Array(a);
    // Keep the header (so it is sized) and garble the coded data.
    for (let i = broken.length - 40; i < broken.length; i++) broken[i] ^= 0x5a;
    const results = [];
    for (let i = 0; i < 3; i++) results.push(await generateImagePreview(broken, "image/avif").then((r) => r.status === "generated" ? "generated" : `failed:${r.failure.reason}`, (e: { code?: string }) => `threw:${e.code}`));
    expect(new Set(results).size).toBe(1);
    expect(results[0]).not.toStartWith("threw:");
  });

  test("an AVIF is sized by its ipco ispe properties only, not by bytes that look like one elsewhere", async () => {
    const a = await avif(busy(160, 120, 3));
    // A trailing free box holding what a byte scan would take for an ispe of 100,000 × 100,000.
    const fake = Uint8Array.from([0, 0, 0, 28, ...Buffer.from("free"), 0, 0, 0, 20, ...Buffer.from("ispe"), 0, 0, 0, 0, 0, 1, 0x86, 0xa0, 0, 1, 0x86, 0xa0]);
    const withFake = new Uint8Array([...a, ...fake]);
    expect(Buffer.from(withFake).lastIndexOf("ispe")).toBeGreaterThan(a.length);
    const r = await generateImagePreview(withFake, "image/avif");
    expect(r.status, r.status === "failed" ? r.failure.message : "").toBe("generated");
    if (r.status === "generated") expect(r.preview.source).toMatchObject({ format: "avif", width: 160, height: 120 });
  });
});

