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
  createOriginal,
  decodeCbor,
  encodeCbor,
  parseBtcoAlias,
  resourceDigest,
  updateOriginal,
  verifyAuthorHistory,
  verifyOriginal,
  type AuthorRef,
  type SatEvidence,
  type SatInscription,
} from "../src/originals/index.js";
import { OriginalsError } from "../src/errors.js";
import { bytes, photo, seeded } from "./helpers/originals.js";

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
    const options = { log: [genesis], now: NOW, bytes: allBytes, freshness: "asserted" as const, authors: [{ did: AUTHOR, bitcoin: sat(AUTHOR, [v1]) }] };
    const r = await verifyOriginal({ ...options, retained: { authors: { [AUTHOR]: v1.id } } });
    expect(r.identityEvidence.freshness).toBe("asserted");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    const gone = await verifyOriginal({ ...options, retained: { authors: { [AUTHOR]: id() } } });
    expect(gone.identityEvidence.freshness).toBe("stale");
  });

  test("an inscription whose content starts with a BOM is undecodable", async () => {
    const v1 = version(10, document([{ fragment: "orig", signer: KEY }]));
    const genesis = await createOriginal({ versionTime: time(20), name: "Harbor", resources: [photo(B1)], author: ref(v1.id), sign });
    const anchor = await updateOriginal(genesis, { versionTime: time(30), aliases: [SAT], author: ref(v1.id), sign });
    const content = bytes(`\uFEFF${serializeLog([genesis, anchor])}`);
    const r = await verifyOriginal({
      log: [genesis, anchor], now: NOW, bytes: allBytes, freshness: "asserted",
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
      log: [genesis, anchor], now: NOW, bytes: allBytes, freshness: "asserted",
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
    const evidence = (tx: number) => ({ log: [genesis, anchor], now: NOW, bytes: allBytes, freshness: "asserted" as const, authors: [{ did: AUTHOR, bitcoin: sat(AUTHOR, [v1, removal(tx)]) }], bitcoin: [sat(SAT, [inscribed([genesis, anchor], 31, { transactionIndex: 5 })])] });
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
    const r = await verifyOriginal({ log: [genesis, next], authors, now: NOW, bytes: allBytes, freshness: "asserted" });
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    const back = await updateOriginal(next, { versionTime: time(42), name: "Older version", author: ref(v1.id), sign });
    const regressed = await verifyOriginal({ log: [genesis, next, back], authors, now: NOW, bytes: allBytes, freshness: "asserted" });
    expect(regressed.history.failure?.code).toBe("AUTHOR_VERSION_REGRESSED");
  });
});
