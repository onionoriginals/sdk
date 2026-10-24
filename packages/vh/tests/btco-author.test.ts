/**
 * did:btco author DIDs (plan 011 PR 9b; P5.13; did:btco method v0.2.0, owner
 * decision Q15): versions are inscriptions on the DID's sat whose CBOR
 * metadata is the DID document, ordered by chain order; deactivation is
 * terminal; an anchored Original by such an author verifies from Bitcoin alone.
 */
import { describe, expect, test } from "bun:test";
import type { ProofSigner } from "../src/crypto/index.js";
import type { JsonObject } from "../src/json/index.js";
import { serializeLog, signWith, type LogEntry } from "../src/log/index.js";
import {
  ORIGINALS_INSCRIPTION_TYPE,
  checkBeforeAnchor,
  createOriginal,
  decodeCbor,
  encodeCbor,
  parseBtcoAlias,
  resourceDigest,
  updateOriginal,
  verifyAuthorHistory,
  verifyOriginal,
  type AuthorRef,
  type OriginalsReport,
  type SatEvidence,
  type SatInscription,
} from "../src/originals/index.js";
import { OriginalsError } from "../src/errors.js";
import { VhAuthor, bytes, photo, seeded } from "./helpers/originals.js";

const B1 = "harbor at dawn";
const allBytes = { [resourceDigest(bytes(B1))]: bytes(B1) };
const AUTHOR = "did:btco:reg:9000000000";
const SAT = "did:btco:reg:5000000000";
const T0 = Date.parse("2026-10-18T12:00:00Z");
const NOW = Date.parse("2026-10-19T00:00:00Z");
const time = (height: number) => new Date(T0 + height * 600_000 - 60_000).toISOString();

let n = 0;
const id = () => `${(n++).toString(16).padStart(64, "0")}i0`;
type Inscribed = Omit<SatInscription, "sat" | "network"> & Partial<Pick<SatInscription, "sat" | "network">>;
function at(height: number, extra: Partial<SatInscription> = {}): Inscribed {
  return { id: id(), height, transactionIndex: 1, inscriptionIndex: 0, confirmations: 200 - height, inscriptionTime: T0 + height * 600_000, mediaType: "text/plain", content: bytes("x"), ...extra };
}
/** One index's read of a sat. Each inscription is placed on that sat unless it says otherwise (P9.10). */
function sat(did: string, inscriptions: Inscribed[], index = "ord-a"): SatEvidence {
  const { sat: number, network } = parseBtcoAlias(did);
  return { sat: did, index, tip: { height: 199, hash: "bb".repeat(32) }, inscriptions: inscriptions.map((i) => ({ sat: number, network, ...i })), owner: { output: "aa".repeat(32) + ":0", confirmations: 5 } };
}

/** A did:btco DID document listing these keys under assertionMethod. */
function document(keys: Array<{ fragment: string; signer: ProofSigner }>, extra: JsonObject = {}): JsonObject {
  return {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
    id: AUTHOR,
    verificationMethod: keys.map((k) => ({ id: `${AUTHOR}#${k.fragment}`, type: "Multikey", controller: AUTHOR, publicKeyMultibase: k.signer.publicKeyMultibase })),
    assertionMethod: keys.map((k) => `${AUTHOR}#${k.fragment}`),
    ...extra,
  };
}
const version = (height: number, doc: JsonObject, extra: Partial<SatInscription> = {}) => at(height, { metadata: encodeCbor(doc), ...extra });

const KEY = seeded(21);
const sign = signWith(KEY, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `${AUTHOR}#orig` });
const ref = (versionId: string): AuthorRef => ({ did: AUTHOR, verificationMethod: `${AUTHOR}#orig`, versionId });

describe("strict CBOR for DID documents", () => {
  test("round-trips a DID document and rejects what JSON cannot say or what decodes more than one way", () => {
    const doc = document([{ fragment: "orig", signer: KEY }], { n: -3, big: 70_000, ok: true, none: null });
    expect(decodeCbor(encodeCbor(doc))).toEqual(doc);
    const code = (b: number[]) => (() => decodeCbor(new Uint8Array(b))) as () => unknown;
    expect(code([0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02])).toThrow(OriginalsError); // duplicate key
    expect(code([0x9f, 0x01, 0xff])).toThrow(/additional information/); // indefinite length
    expect(code([0xc0, 0x01])).toThrow(/tags/);
    expect(code([0xfb, 0, 0, 0, 0, 0, 0, 0, 0])).toThrow(/floats/);
    expect(code([0x18, 0x05])).toThrow(/shortest/);
    expect(code([0x01, 0x02])).toThrow(/trailing/);
    expect(code([0x42, 0x01, 0x02])).toThrow(/byte strings/);
  });
});

describe("review fixes (PR 9b)", () => {
  test("CBOR refuses a __proto__ key and keeps a leading BOM in text, so neither decodes two ways", () => {
    const proto = [0xa1, 0x69, ...new TextEncoder().encode("__proto__"), 0xa0];
    expect(() => decodeCbor(new Uint8Array(proto))).toThrow(/__proto__/);
    expect(decodeCbor(new Uint8Array([0x64, 0xef, 0xbb, 0xbf, 0x61]))).toBe("\uFEFFa");
  });

  test("C12-61: a deactivation inscribed as the first document is terminal", async () => {
    const off = version(10, { "@context": ["https://www.w3.org/ns/did/v1"], id: AUTHOR, deactivated: true });
    const after = version(11, document([{ fragment: "orig", signer: KEY }]));
    const h = await verifyAuthorHistory({ did: AUTHOR, bitcoin: sat(AUTHOR, [off, after]) });
    expect(h.versions.map((v) => [v.versionId, v.deactivated])).toEqual([[off.id, true]]);
  });

  test("a retained did:btco author version is found by its inscription id", async () => {
    const v1 = version(10, document([{ fragment: "orig", signer: KEY }]));
    const genesis = await createOriginal({ versionTime: time(20), name: "Harbor", resources: [photo(B1)], author: ref(v1.id), sign });
    const options = { log: [genesis], now: NOW, bytes: allBytes, authors: [{ did: AUTHOR, bitcoin: sat(AUTHOR, [v1]) }] };
    const r = await verifyOriginal({ ...options, retained: { authors: { [AUTHOR]: v1.id } } });
    expect(r.identityEvidence.freshness).toBe("not-established");
    expect(r.reasons).toEqual(["not-anchored"]); // found, not stale; unanchored, so valid as of its checkpoint (P7.10)
    const gone = await verifyOriginal({ ...options, retained: { authors: { [AUTHOR]: id() } } });
    expect(gone.identityEvidence.freshness).toBe("stale");
  });

  test("an inscription whose content starts with a BOM is undecodable", async () => {
    const v1 = version(10, document([{ fragment: "orig", signer: KEY }]));
    const genesis = await createOriginal({ versionTime: time(20), name: "Harbor", resources: [photo(B1)], author: ref(v1.id), sign });
    const anchor = await updateOriginal(genesis, { versionTime: time(30), aliases: [SAT], author: ref(v1.id), sign });
    const content = bytes(`\uFEFF${serializeLog([genesis, anchor])}`);
    const r = await verifyOriginal({
      log: [genesis, anchor], now: NOW, bytes: allBytes,
      authors: [{ did: AUTHOR, bitcoin: sat(AUTHOR, [v1]) }],
      bitcoin: [sat(SAT, [at(31, { mediaType: ORIGINALS_INSCRIPTION_TYPE, content })])],
    });
    expect(r.anchoring?.ignored[0]?.reason).toBe("undecodable");
  });
});

describe("did:btco author histories (P5.13)", () => {
  test("versions are DID documents in metadata, in chain order; other inscriptions are not versions", async () => {
    const v1 = version(10, document([{ fragment: "orig", signer: KEY }]));
    const art = at(11); // ordinary content, no metadata
    const foreign = version(12, { ...document([]), id: "did:btco:reg:1" });
    const v2 = version(13, document([{ fragment: "orig", signer: KEY }, { fragment: "spare", signer: seeded(24) }]));
    const h = await verifyAuthorHistory({ did: AUTHOR, bitcoin: sat(AUTHOR, [v2, foreign, art, v1]) });
    expect(h.failure).toBeUndefined();
    expect(h.versions.map((v) => v.versionId)).toEqual([v1.id, v2.id]);
    expect(h.versions.map((v) => v.updateKeys)).toEqual([[], []]);
  });

  test("C12-61: an inscription on the DID's sat after its deactivation is not a version; the DID stays deactivated", async () => {
    const v1 = version(10, document([{ fragment: "orig", signer: KEY }]));
    const off = version(11, { "@context": ["https://www.w3.org/ns/did/v1"], id: AUTHOR, deactivated: true });
    const after = version(12, document([{ fragment: "orig", signer: KEY }]));
    const h = await verifyAuthorHistory({ did: AUTHOR, bitcoin: sat(AUTHOR, [v1, off, after]) });
    expect(h.versions.map((v) => [v.versionId, v.deactivated])).toEqual([[v1.id, false], [off.id, true]]);
  });

  test("no Bitcoin read, a read of another sat, or no DID document is incomplete or invalid evidence", async () => {
    expect((await verifyAuthorHistory({ did: AUTHOR })).failure?.error.code).toBe("AUTHOR_BITCOIN_EVIDENCE_MISSING");
    expect((await verifyAuthorHistory({ did: AUTHOR, bitcoin: sat(SAT, []) })).failure?.error.code).toBe("AUTHOR_LOG_MISMATCH");
    expect((await verifyAuthorHistory({ did: AUTHOR, bitcoin: sat(AUTHOR, [at(10)]) })).failure?.error.code).toBe("AUTHOR_DID_NOT_FOUND");
  });
});

describe("Originals by a did:btco author", () => {
  async function setup() {
    const v1 = version(10, document([{ fragment: "orig", signer: KEY }]));
    const genesis = await createOriginal({ versionTime: time(20), name: "Harbor", resources: [photo(B1)], author: ref(v1.id), sign });
    const anchor = await updateOriginal(genesis, { versionTime: time(30), aliases: [SAT], author: ref(v1.id), sign });
    return { v1, genesis, anchor };
  }
  /** An Originals inscription; the anchoring one carries the whole log through the anchoring entry (P9.17). */
  const inscribed = (entries: LogEntry[], height: number, extra: Partial<SatInscription> = {}) =>
    at(height, { mediaType: ORIGINALS_INSCRIPTION_TYPE, content: bytes(serializeLog(entries)), ...extra });

  test("C12-58: an anchored Original with a did:btco author verifies from Bitcoin alone", async () => {
    const { v1, genesis, anchor } = await setup();
    const r = await verifyOriginal({
      log: [genesis, anchor], now: NOW, bytes: allBytes,
      authors: [{ did: AUTHOR, bitcoin: sat(AUTHOR, [v1]) }],
      bitcoin: [sat(SAT, [inscribed([genesis, anchor], 31)])],
    });
    expect(r.authorBinding.status).toBe("valid");
    expect(r.anchoring?.status).toBe("anchored");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-59: an author DID version inscribed after an Originals inscription in the same block is not in effect for it", async () => {
    const { v1, genesis, anchor } = await setup();
    const removal = (transactionIndex: number) => version(31, document([{ fragment: "orig2", signer: seeded(23) }]), { transactionIndex });
    const evidence = (tx: number) => ({ log: [genesis, anchor], now: NOW, bytes: allBytes, authors: [{ did: AUTHOR, bitcoin: sat(AUTHOR, [v1, removal(tx)]) }], bitcoin: [sat(SAT, [inscribed([genesis, anchor], 31, { transactionIndex: 5 })])] });
    // The removal comes later in the same block: the anchor stands.
    expect((await verifyOriginal(evidence(9))).anchoring?.status).toBe("anchored");
    // The removal comes earlier in the same block: the anchor's key is gone.
    const earlier = await verifyOriginal(evidence(2));
    expect(earlier.anchoring?.status).toBe("not-anchored");
    expect(earlier.anchoring?.ignored[0]?.reason).toBe("author-key-not-valid-at-inscription-time");
  });

  test("C12-60: an anchoring entry naming the author DID's own sat is rejected", async () => {
    const { v1, genesis } = await setup();
    await expect(updateOriginal(genesis, { versionTime: time(30), aliases: [AUTHOR], author: ref(v1.id), sign })).rejects.toMatchObject({ code: "STATE_ANCHOR" });
  });

  test("an unanchored Original by a did:btco author verifies, and an entry may not name an older version in chain order (P5.8)", async () => {
    const { v1, genesis } = await setup();
    const v2 = version(40, document([{ fragment: "orig", signer: KEY }, { fragment: "spare", signer: seeded(24) }]));
    const authors = [{ did: AUTHOR, bitcoin: sat(AUTHOR, [v1, v2]) }];
    const next = await updateOriginal(genesis, { versionTime: time(41), name: "Harbor, later", author: ref(v2.id), sign });
    const r = await verifyOriginal({ log: [genesis, next], authors, now: NOW, bytes: allBytes });
    expect(r.reasons).toEqual(["not-anchored"]);
    expect(r.validAsOf?.checkpoint).toBe(next.versionId);
    const back = await updateOriginal(next, { versionTime: time(42), name: "Older version", author: ref(v1.id), sign });
    const regressed = await verifyOriginal({ log: [genesis, next, back], authors, now: NOW, bytes: allBytes });
    expect(regressed.history.failure?.code).toBe("AUTHOR_VERSION_REGRESSED");
  });
});

/**
 * P5.13 (spec a432; issue #972): for an anchored Original, the did:btco version
 * an entry names must precede, in chain order, the inscription that carries the
 * entry (or, before the anchor, the anchoring inscription). The author DID's
 * state at an inscription is the latest version preceding it, and the key must
 * hold at both. A version's id can be known before it is mined, so naming one
 * proves nothing about when it took effect.
 */
describe("did:btco author versions in chain order (P5.13; #972)", () => {
  const KEY_B = seeded(23);
  const signB = signWith(KEY_B, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `${AUTHOR}#b` });
  const refB = (versionId: string): AuthorRef => ({ did: AUTHOR, verificationMethod: `${AUTHOR}#b`, versionId });
  const onlyA = () => document([{ fragment: "orig", signer: KEY }]);
  const both = () => document([{ fragment: "orig", signer: KEY }, { fragment: "b", signer: KEY_B }]);
  const onlyB = () => document([{ fragment: "b", signer: KEY_B }]);
  const off = () => ({ "@context": ["https://www.w3.org/ns/did/v1"], id: AUTHOR, deactivated: true });
  const inscribed = (entries: LogEntry[], height: number, extra: Partial<SatInscription> = {}) =>
    at(height, { mediaType: ORIGINALS_INSCRIPTION_TYPE, content: bytes(serializeLog(entries)), ...extra });
  /** Verify from Bitcoin alone: the author's sat and the anchoring sat, no copy of the log (P9.18). */
  const fromBitcoin = (author: Inscribed[] | SatEvidence[], anchoring: Inscribed[], retained?: OriginalsReport["retain"]) =>
    verifyOriginal({
      now: NOW, bytes: allBytes,
      authors: [{ did: AUTHOR, bitcoin: "index" in (author[0] ?? {}) ? (author as SatEvidence[]) : sat(AUTHOR, author as Inscribed[]) }],
      bitcoin: [sat(SAT, anchoring)],
      ...(retained ? { retained } : {}),
    });

  /** The issue's repro: V1 lists key A; the anchoring entry is signed with B and names V2, the grant of B. */
  async function grant(v2: Inscribed) {
    const v1 = version(10, onlyA());
    const genesis = await createOriginal({ versionTime: time(20), name: "Harbor", resources: [photo(B1)], author: ref(v1.id), sign });
    const anchor = await updateOriginal(genesis, { versionTime: time(30), aliases: [SAT], author: refB(v2.id), sign: signB });
    return { v1, v2, genesis, anchor };
  }
  /** Genesis and anchoring entry by V1 and key A. */
  async function byA() {
    const v1 = version(10, onlyA());
    const genesis = await createOriginal({ versionTime: time(20), name: "Harbor", resources: [photo(B1)], author: ref(v1.id), sign });
    const anchor = await updateOriginal(genesis, { versionTime: time(30), aliases: [SAT], author: ref(v1.id), sign });
    return { v1, genesis, anchor };
  }

  test("a grant inscribed before the anchoring inscription authorizes it", async () => {
    const { v1, v2, genesis, anchor } = await grant(version(25, both()));
    const r = await fromBitcoin([v1, v2], [inscribed([genesis, anchor], 31)]);
    expect(r.anchoring?.status).toBe("anchored");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-92: an inscribed entry naming a did:btco author version inscribed in a later block is rejected", async () => {
    const { v1, v2, genesis, anchor } = await grant(version(32, both()));
    const r = await fromBitcoin([v1, v2], [inscribed([genesis, anchor], 31)]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored).toMatchObject([{ sat: SAT, versionId: anchor.versionId, reason: "author-version-not-yet-in-effect" }]);
    expect(r.current).toBe(false);
  });

  test("C12-92, after the anchor: a later inscribed entry naming a version mined after it is rejected; the head stays", async () => {
    const { v1, genesis, anchor } = await byA();
    const v2 = version(41, both());
    const next = await updateOriginal(anchor, { versionTime: time(40), name: "Signed with B", author: refB(v2.id), sign: signB });
    const r = await fromBitcoin([v1, v2], [inscribed([genesis, anchor], 31), inscribed([next], 40)]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored).toMatchObject([{ versionId: next.versionId, reason: "author-version-not-yet-in-effect" }]);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-163: P9.15, P5.13: after the anchor, an entry naming a versionId that a fully read did:btco history does not hold is invalid, not unverifiable", async () => {
    const { v1, genesis, anchor } = await byA();
    const fake = id(); // no inscription on the author's sat
    const next = await updateOriginal(anchor, { versionTime: time(40), name: "Names a version the sat never had", author: ref(fake), sign });
    const later = inscribed([next], 40);
    const r = await fromBitcoin([v1], [inscribed([genesis, anchor], 31), later]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ inscription: later.id, versionId: next.versionId, reason: "invalid-entry", code: "AUTHOR_VERSION_NOT_IN_HISTORY" })]);
    expect(r.anchoring?.unverifiable).toEqual([]);
    expect(r.identityEvidence.status).toBe("complete");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("P9.15: the same entry is unverifiable when the author's sat was not read in full through its inscription", async () => {
    const { v1, genesis, anchor } = await byA();
    const fake = id();
    const next = await updateOriginal(anchor, { versionTime: time(40), name: "Names a version past what was read", author: ref(fake), sign });
    const later = inscribed([next], 40);
    // An unread inscription after the anchor, before the later one: the history stops there (M1).
    const unread = at(35, { content: new Uint8Array(), unsupported: "not-read" });
    const cut = await fromBitcoin([v1, unread], [inscribed([genesis, anchor], 31), later]);
    expect(cut.anchoring?.ignored).toEqual([expect.objectContaining({ inscription: later.id, reason: "later-inscription-unverifiable" })]);
    expect(cut.anchoring?.unverifiable).toEqual([{ sat: SAT, inscription: later.id, versionId: next.versionId, signer: AUTHOR, signerVersionId: fake }]);
    // A read whose tip is below the later inscription establishes nothing there either.
    const short = { ...sat(AUTHOR, [v1]), tip: { height: 35, hash: "cc".repeat(32) } };
    const low = await fromBitcoin([short], [inscribed([genesis, anchor], 31), later]);
    expect(low.anchoring?.ignored).toEqual([expect.objectContaining({ inscription: later.id, reason: "later-inscription-unverifiable" })]);
  });

  test("C12-178, C12-188: P9.15: a later inscription naming a known did:btco version, with an unread inscription on the author's sat before it, is unverifiable, not accepted against the older state", async () => {
    const { v1, genesis, anchor } = await byA();
    const next = await updateOriginal(anchor, { versionTime: time(40), name: "Names a known version", author: ref(v1.id), sign });
    const later = inscribed([next], 40);
    // The unread inscription could be a version that removes key A.
    const unread = at(35, { content: new Uint8Array(), unsupported: "not-read" });
    const r = await fromBitcoin([v1, unread], [inscribed([genesis, anchor], 31), later]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ inscription: later.id, reason: "later-inscription-unverifiable" })]);
    expect(r.anchoring?.unverifiable).toEqual([{ sat: SAT, inscription: later.id, versionId: next.versionId, signer: AUTHOR, signerVersionId: v1.id }]);
    // P5.13: only an entry whose check depends on the history past the unread inscription is
    // affected; the accepted state's entries precede it, so its identity evidence is complete.
    expect(r.identityEvidence.status).toBe("complete");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    expect(r.notices).toEqual(["unverifiable-inscriptions"]);
  });

  test("C12-170: P5.13: an unread inscription on a did:btco author's sat before the anchoring inscription leaves the anchored state's identity evidence incomplete", async () => {
    const { v1, genesis, anchor } = await byA();
    const unread = at(25, { content: new Uint8Array(), unsupported: "not-read" });
    const r = await fromBitcoin([v1, unread], [inscribed([genesis, anchor], 31)]);
    expect(r.identityEvidence.status).toBe("incomplete");
    expect(r.current).toBe(false);
  });

  test("C12-183: a gap in a did:btco signer's history found after an entry was accepted makes it unverifiable; the head is recomputed and the change reported", async () => {
    const { v1, genesis, anchor } = await byA();
    const next = await updateOriginal(anchor, { versionTime: time(40), name: "Accepted before the gap was seen", author: ref(v1.id), sign });
    const later = inscribed([next], 40);
    const anchoring = inscribed([genesis, anchor], 31);
    const first = await fromBitcoin([v1], [anchoring, later]);
    expect(first.head).toBe(next.versionId);
    const unread = at(35, { content: new Uint8Array(), unsupported: "not-read" });
    const again = await fromBitcoin([v1, unread], [anchoring, later], first.retain);
    expect(again.head).toBe(anchor.versionId);
    expect(again.anchoring?.unverifiable.map((u) => u.inscription)).toEqual([later.id]);
    expect(again.anchoring?.headChange).toEqual({ previous: next.versionId, current: anchor.versionId, verified: [], resolved: [], unverified: [later.id], vanished: [] });
    expect(again.notices).toContain("head-changed");
    expect(again.notices).toContain("unverifiable-inscriptions");
    expect(again.current, JSON.stringify(again.reasons)).toBe(true);
  });

  test("C12-93: an inscribed entry naming a did:btco author version inscribed later in the same block is rejected", async () => {
    const { v1, v2, genesis, anchor } = await grant(version(31, both(), { transactionIndex: 9 }));
    const r = await fromBitcoin([v1, v2], [inscribed([genesis, anchor], 31, { transactionIndex: 5 })]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored[0]?.reason).toBe("author-version-not-yet-in-effect");
  });

  test("C12-94: an inscribed entry naming a did:btco author version inscribed earlier in the same block, whose key it holds, is accepted", async () => {
    const { v1, v2, genesis, anchor } = await grant(version(31, both(), { transactionIndex: 2 }));
    const r = await fromBitcoin([v1, v2], [inscribed([genesis, anchor], 31, { transactionIndex: 5 })]);
    expect(r.anchoring?.status).toBe("anchored");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-95: an entry before the anchor naming a did:btco author version inscribed after the anchoring inscription is rejected", async () => {
    const v1 = version(10, onlyA());
    const v2 = version(35, both());
    const genesis = await createOriginal({ versionTime: time(20), name: "Harbor", resources: [photo(B1)], author: ref(v1.id), sign });
    const renamed = await updateOriginal(genesis, { versionTime: time(21), name: "Signed with B", author: refB(v2.id), sign: signB });
    const anchor = await updateOriginal(renamed, { versionTime: time(30), aliases: [SAT], author: refB(v2.id), sign: signB });
    const anchoring = inscribed([genesis, renamed, anchor], 31);
    const r = await fromBitcoin([v1, v2], [anchoring]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored[0]?.reason).toBe("author-version-not-yet-in-effect");
    // The pre-anchor check on its own: claimed ordering, but never a version mined after the anchoring inscription.
    const history = await verifyAuthorHistory({ did: AUTHOR, bitcoin: sat(AUTHOR, [v1, v2]) });
    const placed = { ...anchoring, sat: "5000000000", network: "regtest" as const };
    expect(checkBeforeAnchor(renamed, placed, [history])).toBe("author-version-not-yet-in-effect");
    expect(checkBeforeAnchor(genesis, placed, [history])).toBeNull();
  });

  test("C12-95's complement: an entry before the anchor is checked against the version it names, with claimed ordering (P9.15)", async () => {
    // V2 removes key A before the anchoring inscription; genesis, signed with A under V1, still stands.
    const v1 = version(10, onlyA());
    const v2 = version(25, onlyB());
    const genesis = await createOriginal({ versionTime: time(20), name: "Harbor", resources: [photo(B1)], author: ref(v1.id), sign });
    const anchor = await updateOriginal(genesis, { versionTime: time(30), aliases: [SAT], author: refB(v2.id), sign: signB });
    const r = await fromBitcoin([v1, v2], [inscribed([genesis, anchor], 31)]);
    expect(r.anchoring?.status).toBe("anchored");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-96: an inscribed entry naming a preceding did:btco version whose key a later preceding version removed is rejected", async () => {
    const { v1, genesis, anchor } = await byA();
    const v2 = version(20, onlyB());
    const r = await fromBitcoin([v1, v2], [inscribed([genesis, anchor], 31)]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored[0]?.reason).toBe("author-key-not-valid-at-inscription-time");
  });

  test("C12-59 still: a removal inscribed after the anchoring inscription does not affect it", async () => {
    const { v1, genesis, anchor } = await byA();
    const r = await fromBitcoin([v1, version(32, onlyB())], [inscribed([genesis, anchor], 31)]);
    expect(r.anchoring?.status).toBe("anchored");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-61 and P5.13: a deactivation before an inscription rejects it; one after leaves the accepted state current", async () => {
    const before = await byA();
    const early = await fromBitcoin([before.v1, version(25, off())], [inscribed([before.genesis, before.anchor], 31)]);
    expect(early.anchoring?.ignored[0]?.reason).toBe("author-deactivated-at-inscription-time");
    const { v1, genesis, anchor } = await byA();
    const late = await updateOriginal(anchor, { versionTime: time(50), name: "After deactivation", author: ref(v1.id), sign });
    // Versions after the deactivation are not versions (C12-61), so a re-grant cannot revive the key.
    const r = await fromBitcoin([v1, version(45, off()), version(46, onlyA())], [inscribed([genesis, anchor], 31), inscribed([late], 50)]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored).toMatchObject([{ versionId: late.versionId, reason: "author-deactivated-at-inscription-time" }]);
    expect(r.identityEvidence.deactivated).toBe(true);
  });

  test("C12-105: a did:btco author inscription the index reports on another sat, or another network, is not a version", async () => {
    const v1 = version(10, onlyA());
    const elsewhere = version(25, both(), { sat: "1234" });
    const otherNetwork = version(26, both(), { network: "testnet" });
    const h = await verifyAuthorHistory({ did: AUTHOR, bitcoin: sat(AUTHOR, [v1, elsewhere, otherNetwork]) });
    expect(h.versions.map((v) => v.versionId)).toEqual([v1.id]);
    const { genesis, anchor } = await grant(elsewhere);
    const r = await fromBitcoin([v1, elsewhere], [inscribed([genesis, anchor], 31)]);
    // The anchoring entry names a version the fully read history does not hold: rejected (P9.15, P5.13).
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored[0]).toMatchObject({ reason: "invalid-entry", code: "AUTHOR_VERSION_NOT_IN_HISTORY" });
  });

  test("P9.10: a did:btco version whose placement two indexes disagree on is not accepted; missing evidence is reported", async () => {
    const { v1, genesis, anchor } = await byA();
    const v2 = version(25, both());
    const reads = [sat(AUTHOR, [v1, v2], "ord-a"), sat(AUTHOR, [v1, { ...v2, sat: "1234" }], "ord-b")];
    const h = await verifyAuthorHistory({ did: AUTHOR, bitcoin: reads });
    expect(h.versions.map((v) => v.versionId)).toEqual([v1.id]);
    expect(h.failure?.error).toMatchObject({ category: "incomplete-evidence", code: "AUTHOR_PLACEMENT_DISPUTED" });
    // V2 is undecided, and so is everything after it: the anchor naming V1 cannot be checked at its inscription either.
    const r = await fromBitcoin(reads, [inscribed([genesis, anchor], 31)]);
    expect(r.anchoring?.ignored[0]?.reason).toBe("author-version-unavailable");
    expect(r.identityEvidence.status).toBe("incomplete");
    expect(r.current).toBe(false);
    // Two indexes that agree are accepted.
    const agreed = await fromBitcoin([sat(AUTHOR, [v1, v2], "ord-a"), sat(AUTHOR, [v1, v2], "ord-b")], [inscribed([genesis, anchor], 31)]);
    expect(agreed.anchoring?.status).toBe("anchored");
    expect(agreed.current, JSON.stringify(agreed.reasons)).toBe(true);
  });

  test("C12-170: M1, P5.13: a delegated or encoded inscription without metadata is not a version; an unread one leaves the history incomplete from there", async () => {
    const { v1, genesis, anchor } = await byA();
    const delegated = at(20, { content: new Uint8Array(), unsupported: "delegated", metadata: null });
    const later = version(22, both());
    const h = await verifyAuthorHistory({ did: AUTHOR, bitcoin: sat(AUTHOR, [v1, delegated, later]) });
    expect(h.versions.map((v) => v.versionId)).toEqual([v1.id, later.id]);
    expect(h.failure).toBeUndefined();
    // An inscription whose metadata was not read could be a version: the history stops before it.
    const unread = at(20, { content: new Uint8Array(), unsupported: "not-read" });
    const cut = await verifyAuthorHistory({ did: AUTHOR, bitcoin: sat(AUTHOR, [v1, unread, later]) });
    expect(cut.versions.map((v) => v.versionId)).toEqual([v1.id]);
    expect(cut.failure?.error).toMatchObject({ category: "incomplete-evidence", code: "AUTHOR_SAT_READ_INCOMPLETE" });
    const r = await fromBitcoin([sat(AUTHOR, [v1, unread])], [inscribed([genesis, anchor], 31)]);
    expect(r.anchoring?.ignored[0]?.reason).toBe("author-version-unavailable");
    expect(r.current).toBe(false);
  });

  test("C12-169: finding 9, P5.13 (originals-spec #51): a delegated or encoded inscription whose metadata is a version is a version; unread metadata fails closed", async () => {
    const { v1 } = await byA();
    // Metadata is the inscription's own, whatever its body's delegation or encoding.
    for (const unsupported of ["delegated", "content-encoding"] as const) {
      const v2 = version(20, both(), { content: new Uint8Array(), unsupported });
      const h = await verifyAuthorHistory({ did: AUTHOR, bitcoin: sat(AUTHOR, [v1, v2]) });
      expect(h.failure).toBeUndefined();
      expect(h.versions.map((v) => v.versionId)).toEqual([v1.id, v2.id]);
      // Its metadata was not read (absent, not null): it could be a version, so the history stops.
      const unreadMeta = at(20, { content: new Uint8Array(), unsupported });
      const cut = await verifyAuthorHistory({ did: AUTHOR, bitcoin: sat(AUTHOR, [v1, unreadMeta, version(22, both())]) });
      expect(cut.versions.map((v) => v.versionId)).toEqual([v1.id]);
      expect(cut.failure?.error).toMatchObject({ category: "incomplete-evidence", code: "AUTHOR_SAT_READ_INCOMPLETE" });
    }
  });

  test("P9.15: an author read whose tip is below the inscription cannot establish the state there", async () => {
    const { v1, genesis, anchor } = await byA();
    const short = { ...sat(AUTHOR, [v1]), tip: { height: 20, hash: "cc".repeat(32) } };
    const r = await fromBitcoin([short], [inscribed([genesis, anchor], 31)]);
    expect(r.anchoring?.ignored[0]?.reason).toBe("author-version-unavailable");
    expect(r.current).toBe(false);
  });

  test("C12-98 and C12-44 unchanged: a did:vh author's named later version that lists a removed key again is accepted", async () => {
    const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }]);
    const vhSign = alice.signer(KEY, "orig");
    const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", resources: [photo(B1)], author: alice.ref("orig"), sign: vhSign });
    const anchor = await updateOriginal(genesis, { versionTime: time(10), aliases: [SAT], author: alice.ref("orig"), sign: vhSign });
    // Removed at versionTime 20, listed again at versionTime 35; the entry is inscribed at 30 and names the later version.
    alice.timeOverride = new Date(T0 + 20 * 600_000).toISOString();
    await alice.rotate([{ fragment: "orig2", signer: seeded(25) }]);
    alice.timeOverride = new Date(T0 + 35 * 600_000).toISOString();
    await alice.rotate([{ fragment: "orig", signer: KEY }]);
    const next = await updateOriginal(anchor, { versionTime: time(30), name: "Names the re-grant", author: alice.ref("orig"), sign: vhSign });
    const r = await verifyOriginal({
      now: NOW, bytes: allBytes, authors: [alice.evidence()],
      bitcoin: [sat(SAT, [inscribed([genesis, anchor], 11), inscribed([next], 30)])],
    });
    expect(r.head).toBe(next.versionId);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });
});
