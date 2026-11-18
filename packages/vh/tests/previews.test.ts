/**
 * Bitcoin previews (P9.17, P9.30, P14.5, P14.9, P14.12, P14.13; owner
 * decision, 18 November 2026; originals-spec PR 64). By default an
 * inscription's body is a preview of the version its last entry names, of 1
 * to 8,192 bytes, which that entry signs in its asset state's `preview`
 * member; with none named, the body is the full version or absent. Tests cite
 * their section 12 rows by registry id (specs/originals-conformance.json).
 */
import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../src/json/index.js";
import { appendEntry, type EntrySigner, type LogEntry } from "../src/log/index.js";
import {
  ORIGINALS_LIMITS,
  checkEntryState,
  createOriginal,
  deactivateOriginal,
  deriveDocument,
  parseBtcoAlias,
  resourceDigest,
  updateOriginal,
  verifyOriginal,
  writeCarriedFile,
  carriedDisclosure,
  type EditorGrant,
  type EntryState,
  type OriginalsReport,
  type ResourceDescriptor,
  type SatEvidence,
  type SatInscription,
} from "../src/originals/index.js";
import { VhAuthor, bytes, carrying, photo, seeded, thumb } from "./helpers/originals.js";

const B1 = "harbor at dawn";
const B2 = "harbor at dusk";
const KEY = seeded(41);
const KB = seeded(43);
const SAT = "did:btco:reg:5000000000";
const T0 = Date.parse("2026-10-18T12:00:00Z");
const NOW = Date.parse("2026-10-19T00:00:00Z");
const time = (height: number) => new Date(T0 + height * 600_000 - 60_000).toISOString();

type Inscribed = Omit<SatInscription, "sat" | "network">;
let counter = 0;
/** An inscription carrying `entries`, its body set by the last entry (P9.17), unless `extra` overrides it. */
function inscribe(entries: LogEntry | LogEntry[], height: number, extra: Partial<SatInscription> = {}): Inscribed {
  return {
    id: `${(counter++).toString(16).padStart(64, "d")}i0`, height, transactionIndex: 1, inscriptionIndex: 0,
    confirmations: 120 - height, inscriptionTime: T0 + height * 600_000, ...carrying(entries), ...extra,
  };
}
/** No body at all, and no content type (P14.12). */
const NO_BODY: Partial<SatInscription> = { noBody: true, content: new Uint8Array(), mediaType: "" };

function sat(inscriptions: Inscribed[]): SatEvidence {
  const { sat: number, network } = parseBtcoAlias(SAT);
  return { sat: SAT, index: "ord-a", tip: { height: 119, hash: "bb".repeat(32) }, inscriptions: inscriptions.map((i) => ({ sat: number, network, ...i })), owner: { output: "aa".repeat(32) + ":0", confirmations: 3 } };
}

const P1 = thumb("webp preview of dawn");
const P2 = thumb("webp preview of dusk");
const v1 = photo(B1, "image/png");
const v2 = photo(B2, "image/png");

/** An Original with a PNG version, anchored by an entry naming `preview` (P9.30). */
async function anchored(preview: ResourceDescriptor | null = P1, resource = v1, grants?: EditorGrant[]) {
  const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }]);
  const sign = alice.signer(KEY, "orig");
  const ref = alice.ref("orig");
  const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", resource, author: ref, sign, ...(grants ? { editors: grants } : {}) });
  const anchor = await updateOriginal(genesis, { versionTime: time(9), aliases: [SAT], author: ref, sign, ...(preview ? { preview } : {}) });
  return { alice, sign, ref, genesis, anchor, copy: [genesis, anchor], anchoring: (extra: Partial<SatInscription> = {}) => inscribe([genesis, anchor], 10, extra) };
}

const verify = (alice: VhAuthor | VhAuthor[], bitcoin?: SatEvidence[], log?: LogEntry[], held: Record<string, Uint8Array> = {}): Promise<OriginalsReport> =>
  // With no Bitcoin evidence, the log is checked whole, as the writer checks its own (P9.18).
  verifyOriginal({ ...(log ? { log } : {}), authors: (Array.isArray(alice) ? alice : [alice]).map((a) => a.evidence()), now: NOW, bytes: held, ...(bitcoin ? { bitcoin } : { localCopy: true }) });

/** Sign a state after `previous`, bypassing the builder's checks, as a writer that breaks the rules would. */
const forge = (previous: LogEntry, asset: JsonObject, sign: EntrySigner, extra: JsonObject = {}) => {
  const before = previous.state as unknown as EntryState;
  const resource = asset.resource as unknown as ResourceDescriptor;
  const transitions = resource.digest === before.asset.resource.digest ? [] : [{ from: before.asset.resource.digest, to: resource.digest }];
  return appendEntry(previous, { versionTime: time(20), parameters: {}, state: { ...previous.state, operation: "update", transitions, asset, ...extra } as JsonObject, sign });
};
const assetOf = (e: LogEntry) => e.state.asset as JsonObject;

describe("the preview member (P9.30, P14.5, P14.6, P14.7, P14.13)", () => {
  test("C12-365, C12-366: a preview of 0 or 8,193 bytes is refused by the writer and rejected by a verifier; 8,192 is accepted", async () => {
    const { alice, sign, ref, genesis, anchor } = await anchored(null);
    const sized = (size: number): ResourceDescriptor => ({ ...P1, size });
    await expect(updateOriginal(genesis, { versionTime: time(9), aliases: [SAT], author: ref, sign, preview: sized(0) })).rejects.toMatchObject({ code: "STATE_PREVIEW" });
    await expect(updateOriginal(genesis, { versionTime: time(9), aliases: [SAT], author: ref, sign, preview: sized(8_193) })).rejects.toMatchObject({ category: "limit-exceeded", code: "STATE_PREVIEW_TOO_LARGE" });
    expect(ORIGINALS_LIMITS.previewBytes).toBe(8_192);
    const max = await updateOriginal(genesis, { versionTime: time(9), aliases: [SAT], author: ref, sign, preview: sized(8_192) });
    expect((max.state.asset as JsonObject).preview).toEqual(sized(8_192));
    // A verifier accepts an inscription whose body is a preview of exactly 8,192 bytes (C12-366).
    const full = new Uint8Array(8_192).fill(7);
    const exact: ResourceDescriptor = { mediaType: "image/webp", size: full.length, digest: resourceDigest(full) };
    const anchorMax = await updateOriginal(genesis, { versionTime: time(9), aliases: [SAT], author: ref, sign, preview: exact });
    const accepted = await verify(alice, [sat([inscribe([genesis, anchorMax], 10, { mediaType: "image/webp", content: full })])]);
    expect(accepted.anchoring?.status).toBe("anchored");
    expect(accepted.anchoring?.anchor?.body).toBe("preview");
    for (const [size, code] of [[0, "STATE_PREVIEW"], [8_193, "STATE_PREVIEW_TOO_LARGE"]] as const) {
      const forged = await forge(genesis, { ...assetOf(anchor), preview: sized(size) as unknown as JsonObject }, sign);
      const r = await verify(alice, undefined, [genesis, forged]);
      expect(r.history.failure?.code, String(size)).toBe(code);
      // An inscription carrying it is rejected with it: its entries do not verify (C12-366).
      const onSat = await verify(alice, [sat([inscribe([genesis, forged], 10, { mediaType: "image/webp", content: new Uint8Array(size) })])]);
      expect(onSat.anchoring?.status).toBe("not-anchored");
    }
  });

  test("C12-375: a preview whose mediaType has a parameter, whose digest is not P14.7's encoding, or with another member, is rejected", async () => {
    const { alice, sign, genesis, anchor } = await anchored(null);
    const bad: unknown[] = [
      { ...P1, mediaType: "image/webp; q=1" },
      { ...P1, digest: P1.digest.slice(1) },
      { ...P1, digest: `u${P1.digest.slice(1)}` },
      { ...P1, width: 64 },
      { mediaType: P1.mediaType, size: P1.size },
    ];
    for (const preview of bad) {
      const forged = await forge(genesis, { ...assetOf(anchor), preview: preview as JsonObject }, sign);
      const r = await verify(alice, undefined, [genesis, forged]);
      expect(r.history.status, JSON.stringify(preview)).toBe("invalid");
      expect(["STATE_PREVIEW", "STATE_DIGEST"], JSON.stringify(preview)).toContain(r.history.failure?.code);
    }
  });

  test("C12-363: an image version's preview is image/webp; any other media type is rejected, svg included, whatever the case of the version's type", async () => {
    for (const [mediaType, previewType] of [["image/png", "image/png"], ["image/svg+xml", "image/svg+xml"], ["Image/PNG", "image/jpeg"], ["IMAGE/gif", "text/plain"]]) {
      const { ref, sign, genesis } = await anchored(null, photo(`${B1} ${mediaType}`, mediaType));
      await expect(updateOriginal(genesis, { versionTime: time(9), aliases: [SAT], author: ref, sign, preview: thumb(`p ${mediaType}`, previewType) }), mediaType).rejects.toMatchObject({ code: "STATE_PREVIEW" });
    }
    // A verifier rejects such an entry, signed by a writer that broke the rule, and the inscription carrying it.
    for (const [mediaType, previewType] of [["image/svg+xml", "image/svg+xml"], ["Image/PNG", "image/png"]]) {
      const { alice, sign, genesis, anchor } = await anchored(null, photo(`${B1} forged ${mediaType}`, mediaType));
      const preview = thumb(`forged ${mediaType}`, previewType);
      const forged = await forge(genesis, { ...assetOf(anchor), preview: preview as unknown as JsonObject }, sign);
      expect((await verify(alice, undefined, [genesis, forged])).history.failure?.code, mediaType).toBe("STATE_PREVIEW");
      const onSat = await verify(alice, [sat([inscribe([genesis, forged], 10)])]);
      expect(onSat.anchoring?.status, mediaType).toBe("not-anchored");
      expect(onSat.anchoring?.ignored, mediaType).toEqual([expect.objectContaining({ reason: "invalid-entry", code: "STATE_PREVIEW" })]);
    }
    const { anchor } = await anchored(P1, photo("svg", "Image/SVG+XML"));
    expect((anchor.state.asset as JsonObject).preview).toEqual(P1);
  });

  test("C12-364: an author-supplied preview of any media type is accepted for a version that is not an image, within 8,192 bytes", async () => {
    for (const previewType of ["image/png", "text/plain", "application/pdf", "image/svg+xml"]) {
      const preview = thumb(`a ${previewType} preview`, previewType);
      const { alice, copy, anchoring } = await anchored(preview, photo(`a long essay ${previewType}`, "text/markdown"));
      const r = await verify(alice, [sat([anchoring()])]);
      expect(r.anchoring?.status, previewType).toBe("anchored");
      expect(r.anchoring?.anchor?.body).toBe("preview");
      expect(r.state?.preview).toEqual(preview);
      expect(copy).toHaveLength(2);
    }
  });

  test("C12-368: preview in an entry whose aliases list no did:btco DID is rejected, not ignored; a writer never writes it", async () => {
    const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }]);
    const sign = alice.signer(KEY, "orig");
    const ref = alice.ref("orig");
    const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", resource: v1, author: ref, sign });
    // The writer refuses, for an Original no anchoring entry has been signed for.
    await expect(updateOriginal(genesis, { versionTime: time(2), name: "Renamed", author: ref, sign, preview: P1 })).rejects.toMatchObject({ code: "STATE_PREVIEW" });
    // A verifier rejects a local entry naming one.
    const local = await forge(genesis, { ...assetOf(genesis), preview: P1 as unknown as JsonObject }, sign);
    expect((await verify(alice, undefined, [genesis, local])).history.failure?.code).toBe("STATE_PREVIEW");
    // And an anchoring inscription whose entry before the anchoring entry names one is not an anchor.
    const anchor = await updateOriginal(local, { versionTime: time(21), aliases: [SAT], author: ref, sign, preview: null });
    const r = await verify(alice, [sat([inscribe([genesis, local, anchor], 22, NO_BODY)])]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ reason: "invalid-entry", code: "STATE_PREVIEW" })]);
  });
});

describe("placement of previews from the anchoring entry on (P9.30)", () => {
  test("C12-370, C12-356: an anchoring entry naming a preview, its parent naming none, is accepted with that preview as its body; the version stays unavailable", async () => {
    const { alice, copy, anchor, anchoring } = await anchored(P1);
    const r = await verify(alice, [sat([anchoring()])]);
    expect(r.anchoring?.status).toBe("anchored");
    expect(r.anchoring?.anchor).toMatchObject({ versionId: anchor.versionId, body: "preview" });
    expect(r.history.status).toBe("valid");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    // The preview verifies the preview only: the version is unavailable, never verified because it matched (P9.30, P7.4).
    expect(r.resources.status).toBe("partial");
    expect(r.resources.versions).toEqual([expect.objectContaining({ digest: v1.digest, bytes: "missing" })]);
    // The version's bytes, obtained elsewhere, verify it.
    const held = await verify(alice, [sat([anchoring()])], copy, { [v1.digest]: bytes(B1) });
    expect(held.resources.versions).toEqual([expect.objectContaining({ digest: v1.digest, bytes: "verified", onBitcoin: false })]);
  });

  test("C12-357: with no preview named, the full version as the body is accepted and checked against the descriptor", async () => {
    const { alice, anchoring } = await anchored(null);
    const r = await verify(alice, [sat([anchoring()])]);
    expect(r.anchoring?.anchor?.body).toBe("version");
    expect(r.resources.versions).toEqual([expect.objectContaining({ bytes: "verified", onBitcoin: true })]);
    const wrong = await verify(alice, [sat([anchoring({ content: bytes(B2) })])]);
    expect(wrong.anchoring?.ignored).toEqual([expect.objectContaining({ reason: "body-not-the-resource" })]);
  });

  test("C12-358: with no preview named, no body and no content type is accepted; the entries are in the metadata only and the version unavailable", async () => {
    const { alice, anchoring } = await anchored(null);
    const r = await verify(alice, [sat([anchoring(NO_BODY)])]);
    expect(r.anchoring?.status).toBe("anchored");
    expect(r.anchoring?.anchor?.body).toBe("none");
    expect(r.resources.versions).toEqual([expect.objectContaining({ bytes: "missing" })]);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-192: with no preview named, a content type with no body is rejected", async () => {
    const { alice, anchoring } = await anchored(null);
    const r = await verify(alice, [sat([anchoring({ ...NO_BODY, mediaType: "image/png" })])]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ reason: "content-type-without-body" })]);
  });

  test("C12-379: a 0-byte version with an empty body and its mediaType is accepted: an empty body is a body, not an absent one", async () => {
    const empty = photo("", "application/octet-stream");
    const { alice, anchoring } = await anchored(null, empty);
    const r = await verify(alice, [sat([anchoring({ content: new Uint8Array(), mediaType: "application/octet-stream" })])]);
    expect(r.anchoring?.anchor?.body).toBe("version");
    expect(r.resources.versions).toEqual([expect.objectContaining({ bytes: "verified", onBitcoin: true })]);
    // Absent is a different body: no body, no content type.
    expect((await verify(alice, [sat([anchoring(NO_BODY)])])).anchoring?.anchor?.body).toBe("none");
    // An empty body under no content type is neither (P14.12).
    const untyped = await verify(alice, [sat([anchoring({ content: new Uint8Array(), mediaType: "" })])]);
    expect(untyped.anchoring?.ignored).toEqual([expect.objectContaining({ reason: "content-type-mismatch" })]);
  });

  test("C12-367: a body other than the named preview, the full version or no body included, rejects the inscription as a whole", async () => {
    const { alice, anchor, ref, sign, anchoring } = await anchored(P1);
    const cases: Array<[Partial<SatInscription>, string]> = [
      [{ content: bytes("another preview") }, "body-not-the-preview"],
      [{ content: bytes(B1), mediaType: "image/png" }, "content-type-mismatch"],
      [{ content: bytes(B1), mediaType: "image/webp" }, "body-not-the-preview"],
      [NO_BODY, "body-not-the-preview"],
      [{ mediaType: "image/png" }, "content-type-mismatch"],
      [{ mediaType: "IMAGE/WEBP" }, "content-type-mismatch"],
    ];
    for (const [extra, reason] of cases) {
      const r = await verify(alice, [sat([anchoring(extra)])]);
      expect(r.anchoring?.status, reason).toBe("not-anchored");
      expect(r.anchoring?.ignored, reason).toEqual([expect.objectContaining({ reason, versionId: anchor.versionId })]);
    }
    // After the anchor: not accepted, the state unchanged.
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Renamed", author: ref, sign });
    const r = await verify(alice, [sat([anchoring(), inscribe(next, 20, { content: bytes(B1), mediaType: "image/png" })])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.state?.name).toBe("Harbor");
  });

  test("C12-369: an entry after anchoring that names a preview, signed but never inscribed, is not current; the sat does not show its preview", async () => {
    const { alice, anchor, copy, ref, sign, anchoring } = await anchored(P1);
    const next = await updateOriginal(anchor, { versionTime: time(20), resource: v2, author: ref, sign, preview: P2 });
    const r = await verify(alice, [sat([anchoring()])], [...copy, next]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.state?.preview).toEqual(P1);
    expect(r.anchoring?.superseded).toBe(1);
  });

  test("C12-371: an entry changing the resource and naming a preview of the new version, inscribed with it, is accepted; the sat shows the new preview", async () => {
    const { alice, anchor, ref, sign, anchoring } = await anchored(P1);
    const next = await updateOriginal(anchor, { versionTime: time(20), resource: v2, author: ref, sign, preview: P2 });
    const r = await verify(alice, [sat([anchoring(), inscribe(next, 20)])]);
    expect(r.head).toBe(next.versionId);
    expect(r.anchoring?.accepted).toEqual([expect.objectContaining({ versionId: next.versionId, body: "preview" })]);
    expect(r.state?.preview).toEqual(P2);
    // A preview is not a version (P4.4): two versions, whatever the previews.
    expect(r.resources.versions.map((v) => v.digest)).toEqual([v1.digest, v2.digest]);
  });

  test("C12-372: an entry changing the resource's digest and carrying its parent's preview unchanged is rejected; the builder drops it by default", async () => {
    const { alice, anchor, copy, ref, sign, anchoring } = await anchored(P1);
    await expect(updateOriginal(anchor, { versionTime: time(20), resource: v2, author: ref, sign, preview: P1 })).rejects.toMatchObject({ code: "STATE_PREVIEW" });
    const dropped = await updateOriginal(anchor, { versionTime: time(20), resource: v2, author: ref, sign });
    expect((dropped.state.asset as JsonObject).preview).toBeUndefined();
    const forged = await forge(anchor, { ...assetOf(anchor), resource: v2 as unknown as JsonObject }, sign);
    expect((await verify(alice, undefined, [...copy, forged])).history.failure?.code).toBe("STATE_PREVIEW");
    const r = await verify(alice, [sat([anchoring(), inscribe(forged, 20)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ versionId: forged.versionId, reason: "invalid-entry", code: "STATE_PREVIEW" })]);
  });

  test("C12-373: an entry other than the anchoring entry that keeps the resource and names another preview, or names one when its parent named none, is rejected", async () => {
    const withPreview = await anchored(P1);
    await expect(updateOriginal(withPreview.anchor, { versionTime: time(20), name: "N", author: withPreview.ref, sign: withPreview.sign, preview: P2 })).rejects.toMatchObject({ code: "STATE_PREVIEW" });
    const none = await anchored(null);
    await expect(updateOriginal(none.anchor, { versionTime: time(20), name: "N", author: none.ref, sign: none.sign, preview: P1 })).rejects.toMatchObject({ code: "STATE_PREVIEW" });
    // Dropping a preview lasts until the digest next changes.
    const dropped = await updateOriginal(withPreview.anchor, { versionTime: time(20), name: "N", author: withPreview.ref, sign: withPreview.sign, preview: null });
    await expect(updateOriginal(dropped, { versionTime: time(21), name: "M", author: withPreview.ref, sign: withPreview.sign, preview: P1 })).rejects.toMatchObject({ code: "STATE_PREVIEW" });
    const forged = await forge(none.anchor, { ...assetOf(none.anchor), name: "N", preview: P1 as unknown as JsonObject }, none.sign);
    expect((await verify(none.alice, undefined, [...none.copy, forged])).history.failure?.code).toBe("STATE_PREVIEW");
    // A new version may name one again.
    const later = await updateOriginal(dropped, { versionTime: time(22), resource: v2, author: withPreview.ref, sign: withPreview.sign, preview: P2 });
    expect((later.state.asset as JsonObject).preview).toEqual(P2);
  });

  test("C12-355: an entry changing only the name, its parent naming a preview, carries the same preview with it as the body, or none with the full version or no body", async () => {
    const { alice, anchor, ref, sign, anchoring } = await anchored(P1);
    const same = await updateOriginal(anchor, { versionTime: time(20), name: "Renamed", author: ref, sign });
    expect((same.state.asset as JsonObject).preview).toEqual(P1);
    const kept = await verify(alice, [sat([anchoring(), inscribe(same, 20)])]);
    expect(kept.head).toBe(same.versionId);
    expect(kept.anchoring?.accepted[0]?.body).toBe("preview");
    const none = await updateOriginal(anchor, { versionTime: time(20), name: "Renamed", author: ref, sign, preview: null });
    for (const [extra, body] of [[{}, "version"], [NO_BODY, "none"]] as const) {
      const r = await verify(alice, [sat([anchoring(), inscribe(none, 20, extra)])]);
      expect(r.head, body).toBe(none.versionId);
      expect(r.anchoring?.accepted[0]?.body).toBe(body);
      expect(r.state?.preview).toBeUndefined();
    }
    // With none named, the preview is not the body.
    const r = await verify(alice, [sat([anchoring(), inscribe(none, 20, { content: bytes("webp preview of dawn"), mediaType: "image/webp" })])]);
    expect(r.head).toBe(anchor.versionId);
  });

  test("C12-194: an entry changing only the name, its parent naming no preview, has the full version again or no body", async () => {
    const { alice, anchor, ref, sign, anchoring } = await anchored(null);
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Renamed", author: ref, sign });
    for (const [extra, body] of [[{}, "version"], [NO_BODY, "none"]] as const) {
      const r = await verify(alice, [sat([anchoring(), inscribe(next, 20, extra)])]);
      expect(r.head, body).toBe(next.versionId);
      expect(r.anchoring?.accepted[0]?.body).toBe(body);
    }
  });

  test("C12-378: a deactivation after the anchor, its parent naming a preview, is accepted carrying it with it as the body, or none with the full version or no body", async () => {
    const { alice, anchor, ref, sign, anchoring } = await anchored(P1);
    const keep = await deactivateOriginal(anchor, { versionTime: time(20), author: ref, sign });
    expect((keep.state.asset as JsonObject).preview).toEqual(P1);
    const kept = await verify(alice, [sat([anchoring(), inscribe(keep, 20)])]);
    expect(kept.deactivated).toBe(true);
    expect(kept.anchoring?.accepted[0]?.body).toBe("preview");
    const drop = await deactivateOriginal(anchor, { versionTime: time(20), author: ref, sign, preview: null });
    for (const [extra, body] of [[{}, "version"], [NO_BODY, "none"]] as const) {
      const r = await verify(alice, [sat([anchoring(), inscribe(drop, 20, extra)])]);
      expect(r.deactivated, body).toBe(true);
      expect(r.anchoring?.accepted[0]?.body).toBe(body);
    }
  });

  test("C12-380: an Originals inscription that names a delegate is rejected as a whole, with or without a body", async () => {
    const { alice, anchoring } = await anchored(P1);
    for (const extra of [{ content: new Uint8Array() }, { ...NO_BODY }]) {
      const r = await verify(alice, [sat([anchoring({ ...extra, unsupported: "delegated" })])]);
      expect(r.anchoring?.status).toBe("not-anchored");
      expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ reason: "names-a-delegate" })]);
    }
  });
});

describe("editors and previews (P5.16, P9.30)", () => {
  async function withBob(resource: boolean) {
    const bob = await VhAuthor.create([{ fragment: "edit", signer: KB }]);
    const o = await anchored(P1, v1, [{ did: bob.did, name: true, metadata: true, resource }]);
    return { ...o, bob, asBob: { editor: bob.ref("edit"), sign: bob.signer(KB, "edit") } };
  }

  test("C12-374: an editor whose grant allows the resource adds a version and names its preview", async () => {
    const { alice, bob, anchor, anchoring, asBob } = await withBob(true);
    const byBob = await updateOriginal(anchor, { versionTime: time(20), resource: v2, preview: P2, ...asBob });
    const r = await verify([alice, bob], [sat([anchoring(), inscribe(byBob, 20)])]);
    expect(r.head).toBe(byBob.versionId);
    expect(r.state?.preview).toEqual(P2);
    // Or names none with it.
    expect((await updateOriginal(anchor, { versionTime: time(20), resource: v2, ...asBob })).state.asset).not.toHaveProperty("preview");
  });

  test("C12-374: an editor entry that changes or removes the preview without changing the resource, or without a resource grant, is rejected", async () => {
    const granted = await withBob(true);
    await expect(updateOriginal(granted.anchor, { versionTime: time(20), name: "N", preview: null, ...granted.asBob })).rejects.toMatchObject({ category: "outside-grant", code: "EDITOR_OUTSIDE_GRANT" });
    await expect(updateOriginal(granted.anchor, { versionTime: time(20), name: "N", preview: P2, ...granted.asBob })).rejects.toMatchObject({ category: "outside-grant" });
    // Its name-only edit carries the parent's preview unchanged.
    expect((await updateOriginal(granted.anchor, { versionTime: time(20), name: "N", ...granted.asBob })).state.asset).toMatchObject({ preview: P1 });
    const ungranted = await withBob(false);
    await expect(updateOriginal(ungranted.anchor, { versionTime: time(20), name: "N", preview: null, ...ungranted.asBob })).rejects.toMatchObject({ category: "outside-grant" });
    // A verifier rejects a forged one, signed by the editor.
    const { preview: _dropped, ...withoutPreview } = assetOf(granted.anchor);
    expect(_dropped).toEqual(P1);
    const forged = await forge(granted.anchor, { ...withoutPreview, name: "N" }, granted.asBob.sign, { editor: granted.bob.ref("edit") as unknown as JsonObject });
    const r = await verify([granted.alice, granted.bob], undefined, [...granted.copy, forged]);
    expect(r.history.failure?.code).toBe("EDITOR_OUTSIDE_GRANT");
    // And one by an editor without a resource grant that names the preview of a new version.
    const outside = await forge(ungranted.anchor, { ...assetOf(ungranted.anchor), resource: v2 as unknown as JsonObject, preview: P2 as unknown as JsonObject }, ungranted.asBob.sign, { editor: ungranted.bob.ref("edit") as unknown as JsonObject });
    const rejected = await verify([ungranted.alice, ungranted.bob], undefined, [...ungranted.copy, outside]);
    expect(rejected.history.status).toBe("invalid");
    expect(rejected.history.failure?.category).toBe("outside-grant");
  });

  test("checkEntryState applies the same rules to an editor entry outside the engine", async () => {
    const { bob, anchor, asBob } = await withBob(true);
    const next = await updateOriginal(anchor, { versionTime: time(20), resource: v2, preview: P2, ...asBob });
    const scid = (anchor.state.id as string).slice("did:vh:".length);
    expect(() => checkEntryState(next.state, { scid, index: 2, previous: anchor.state as unknown as EntryState, deactivatedParameter: false })).not.toThrow();
    expect(bob.did).toMatch(/^did:vh:/);
  });
});

describe("a preview is not a version (P4.4, P7.16, P14.9)", () => {
  test("C12-376: the derived DID document of an entry naming a preview is the same as without it, and the version does not advance", async () => {
    const withPreview = await anchored(P1);
    const without = await anchored(null);
    const docOf = async (o: Awaited<ReturnType<typeof anchored>>) => (await verify(o.alice, undefined, o.copy)).document;
    const a = await docOf(withPreview);
    const b = await docOf(without);
    expect(JSON.stringify(a)).not.toContain(P1.digest);
    expect((a as { service: unknown[] }).service).toEqual((b as { service: unknown[] }).service.map((s) => ({ ...(s as object), id: (a as { service: Array<{ id: string }> }).service[0].id })));
    expect(deriveDocument([{ entry: withPreview.anchor } as never])).not.toHaveProperty("preview");
    const r = await verify(withPreview.alice, undefined, withPreview.copy);
    expect(r.resources.versions).toHaveLength(1);
  });

  test("C12-377: a writer refuses to make a carried file from a preview", async () => {
    const { alice, copy, anchoring } = await anchored(P1);
    const r = await verify(alice, [sat([anchoring()])]);
    expect(r.current).toBe(true);
    const disclosed = carriedDisclosure(copy);
    await expect(writeCarriedFile(bytes("webp preview of dawn"), copy, { disclosed })).rejects.toMatchObject({ code: "CARRIER_PREVIEW" });
    // The version itself can be carried (PNG has a trailer carrier).
    expect((await writeCarriedFile(bytes(B1), copy, { disclosed })).length).toBeGreaterThan(B1.length);
    expect(resourceDigest(bytes("webp preview of dawn"))).toBe(P1.digest);
  });
});
