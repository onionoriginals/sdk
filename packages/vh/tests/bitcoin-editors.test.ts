/**
 * Editors on Bitcoin (P5.16-P5.18, P9.12, P9.13, P9.15; plan 012). An editor
 * entry inscribed on the anchoring sat is checked against the editor DID's
 * state at its inscription time, as an author entry is against the author
 * DID's: versionTime for did:vh and did:webvh, with the exception for a named
 * later version that lists a removed key again, and chain order for did:btco
 * (P5.13). It is also refused once the author DID's state at its inscription
 * time is deactivated (P5.18). Only author entries anchor (P5.16), and after
 * anchoring chain order on the sat decides between an editor entry and the
 * author entry revoking its grant (P5.17).
 */
import { describe, expect, test } from "bun:test";
import type { ProofSigner } from "../src/crypto/index.js";
import type { JsonObject } from "../src/json/index.js";
import { appendEntry, serializeLog, signWith, type LogEntry } from "../src/log/index.js";
import {
  ORIGINALS_INSCRIPTION_TYPE,
  createOriginal,
  encodeCbor,
  parseBtcoAlias,
  resourceDigest,
  updateOriginal,
  verifyOriginal,
  type AuthorDidEvidence,
  type AuthorRef,
  type EditorGrant,
  type OriginalsReport,
  type SatEvidence,
  type SatInscription,
} from "../src/originals/index.js";
import { VhAuthor, bytes, photo, seeded } from "./helpers/originals.js";

const B1 = "harbor at dawn";
const B2 = "harbor at dawn, Bob's crop";
const B3 = "harbor at dawn, Bob's second crop";
const allBytes = Object.fromEntries([B1, B2, B3].map((t) => [resourceDigest(bytes(t)), bytes(t)]));
const KA = seeded(21);
const KB = seeded(31);
const KB2 = seeded(33);
const SAT = "did:btco:reg:5000000000";
const EDITOR_SAT = "did:btco:reg:9100000000";
const AUTHOR_SAT = "did:btco:reg:9000000000";
const OWNER = `${"cc".repeat(32)}:1`;
const T0 = Date.parse("2026-10-18T12:00:00Z");
const NOW = Date.parse("2026-10-19T00:00:00Z");
const time = (height: number) => new Date(T0 + height * 600_000 - 60_000).toISOString();
const at = (height: number) => new Date(T0 + height * 600_000).toISOString();

type Inscribed = Omit<SatInscription, "sat" | "network"> & Partial<Pick<SatInscription, "sat" | "network">>;
let counter = 0;
const nextId = () => `${(counter++).toString(16).padStart(64, "e")}i0`;
/** An inscription as the adapter reports it: entries as JSON Lines, or a did:btco DID document as CBOR metadata. */
function inscribe(entries: LogEntry | LogEntry[], height: number, extra: Partial<SatInscription> = {}): Inscribed {
  return {
    id: nextId(), height, transactionIndex: 1, inscriptionIndex: 0, confirmations: 120 - height, inscriptionTime: T0 + height * 600_000,
    mediaType: ORIGINALS_INSCRIPTION_TYPE, content: bytes(serializeLog(Array.isArray(entries) ? entries : [entries])), ...extra,
  };
}
const didVersion = (height: number, doc: JsonObject, extra: Partial<SatInscription> = {}): Inscribed =>
  inscribe([], height, { mediaType: "text/plain", content: bytes("x"), metadata: encodeCbor(doc), ...extra });
function sat(inscriptions: Inscribed[], did = SAT): SatEvidence {
  const { sat: number, network } = parseBtcoAlias(did);
  return { sat: did, index: "ord-a", tip: { height: 119, hash: "bb".repeat(32) }, inscriptions: inscriptions.map((i) => ({ sat: number, network, ...i })), owner: { output: OWNER, confirmations: 3 } };
}

/** A did:btco DID document listing these keys under assertionMethod. */
function btcoDocument(did: string, keys: Array<{ fragment: string; signer: ProofSigner }>): JsonObject {
  return {
    "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
    id: did,
    verificationMethod: keys.map((k) => ({ id: `${did}#${k.fragment}`, type: "Multikey", controller: did, publicKeyMultibase: k.signer.publicKeyMultibase })),
    assertionMethod: keys.map((k) => `${did}#${k.fragment}`),
  };
}

const grant = (did: string, g: Partial<Omit<EditorGrant, "did">> = {}): EditorGrant => ({ did, name: true, metadata: false, resources: ["photo"], ...g });

/** Alice grants Bob the name and the photo, then anchors; genesis and the anchoring entry are inscribed together at height 10. */
async function harbor(editor?: { did: string; ref: () => AuthorRef; sign: ReturnType<typeof signWith> }) {
  const alice = await VhAuthor.create([{ fragment: "orig", signer: KA }]);
  const bob = await VhAuthor.create([{ fragment: "edit", signer: KB }]);
  const ref = alice.ref("orig");
  const sign = alice.signer(KA, "orig");
  const editorDid = editor?.did ?? bob.did;
  const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", resources: [photo(B1)], author: ref, sign, editors: [grant(editorDid)] });
  const anchor = await updateOriginal(genesis, { versionTime: time(9), aliases: [SAT], author: ref, sign });
  const asBob = (versionId = bob.versionId) => ({ editor: bob.ref("edit", versionId), sign: bob.signer(KB, "edit") });
  return { alice, bob, ref, sign, genesis, anchor, copy: [genesis, anchor], anchoring: () => inscribe([genesis, anchor], 10), asBob };
}

const verify = (signers: Array<VhAuthor | AuthorDidEvidence>, bitcoin: SatEvidence[], log?: LogEntry[]): Promise<OriginalsReport> =>
  verifyOriginal({
    ...(log ? { log } : {}), now: NOW, bytes: allBytes, freshness: "asserted", bitcoin,
    authors: signers.map((s) => (s instanceof VhAuthor ? s.evidence() : s)),
  });

/** Sign a state after `previous`, bypassing the builder's checks. */
const forge = (previous: LogEntry, state: JsonObject, sign: Parameters<typeof appendEntry>[1]["sign"]) =>
  appendEntry(previous, { versionTime: time(20), parameters: {}, state, sign });

describe("C12-123: an editor entry inscribed on the anchoring sat by the owner (P9.12)", () => {
  test("is accepted: the editor's signature authorizes it, the owner's inscription places it, and holding the sat grants nothing", async () => {
    const { alice, bob, anchor, anchoring, asBob } = await harbor();
    const byBob = await updateOriginal(anchor, { versionTime: time(20), resources: [photo(B2)], ...asBob() });
    const r = await verify([alice, bob], [sat([anchoring(), inscribe(byBob, 20)])]);
    expect(r.head).toBe(byBob.versionId);
    expect(r.anchoring?.accepted.map((p) => p.versionId)).toEqual([byBob.versionId]);
    expect(r.ordering).toBe("anchored");
    expect(r.ownership).toMatchObject({ status: "provisional", output: OWNER });
    expect(r.identityEvidence.author).toBe(alice.did);
    expect(r.identityEvidence.editors.map((e) => [e.did, e.status])).toEqual([[bob.did, "complete"]]);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("an editor entry the sat does not carry is not current; the head stays (P9.12)", async () => {
    const { alice, bob, anchor, copy, anchoring, asBob } = await harbor();
    const byBob = await updateOriginal(anchor, { versionTime: time(20), resources: [photo(B2)], ...asBob() });
    const r = await verify([alice, bob], [sat([anchoring()])], [...copy, byBob]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.superseded).toBe(1);
  });
});

describe("C12-115 (anchoring): only an author entry anchors (P5.16, P9.10)", () => {
  test("an editor entry adding a did:btco alias is rejected, by the builder, in a log and on the sat", async () => {
    const { alice, bob, genesis, asBob } = await harbor();
    await expect(updateOriginal(genesis, { versionTime: time(9), aliases: [SAT], ...asBob() })).rejects.toMatchObject({ code: "EDITOR_AUTHOR_ONLY" });
    const asset = genesis.state.asset as JsonObject;
    const forged = await forge(genesis, { ...genesis.state, operation: "update", transitions: [], editor: bob.ref("edit") as unknown as JsonObject, asset: { ...asset, aliases: [SAT] } }, asBob().sign);
    const inLog = await verifyOriginal({ log: [genesis, forged], authors: [alice.evidence(), bob.evidence()], now: NOW, bytes: allBytes, freshness: "asserted" });
    expect(inLog.history.failure?.code).toBe("EDITOR_AUTHOR_ONLY");
    const r = await verify([alice, bob], [sat([inscribe([genesis, forged], 10)])]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored).toMatchObject([{ reason: "invalid-entry", code: "EDITOR_AUTHOR_ONLY", versionId: forged.versionId }]);
    expect(r.current).toBe(false);
  });

  test("after anchoring, an editor entry that drops or changes the did:btco alias is rejected", async () => {
    const { alice, bob, anchor, anchoring, asBob } = await harbor();
    const asset = anchor.state.asset as JsonObject;
    for (const aliases of [[], ["did:btco:reg:7000000000"]]) {
      const forged = await forge(anchor, { ...anchor.state, operation: "update", transitions: [], editor: bob.ref("edit") as unknown as JsonObject, asset: { ...asset, aliases } }, asBob().sign);
      const r = await verify([alice, bob], [sat([anchoring(), inscribe(forged, 20)])]);
      expect(r.head).toBe(anchor.versionId);
      expect(r.anchoring?.ignored).toMatchObject([{ reason: "invalid-entry", code: "EDITOR_AUTHOR_ONLY" }]);
    }
  });
});

describe("C12-121 (anchored): an editor entry signed with a key removed from the editor DID (P5.18, P9.15)", () => {
  test("inscribed at or after the removal's versionTime, it is rejected; the accepted head stays current", async () => {
    const { alice, bob, anchor, anchoring, asBob } = await harbor();
    const v1 = bob.versionId;
    bob.timeOverride = at(20);
    await bob.rotate([{ fragment: "edit2", signer: KB2 }]);
    const late = await updateOriginal(anchor, { versionTime: time(30), name: "Too late", ...asBob(v1) });
    const r = await verify([alice, bob], [sat([anchoring(), inscribe(late, 30)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored).toMatchObject([{ versionId: late.versionId, reason: "author-key-not-valid-at-inscription-time" }]);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("inscribed before the removal, it is accepted and stays current after it (P9.15)", async () => {
    const { alice, bob, anchor, anchoring, asBob } = await harbor();
    const early = await updateOriginal(anchor, { versionTime: time(15), name: "In time", ...asBob() });
    bob.timeOverride = at(20);
    await bob.rotate([{ fragment: "edit2", signer: KB2 }]);
    const r = await verify([alice, bob], [sat([anchoring(), inscribe(early, 15)])]);
    expect(r.head).toBe(early.versionId);
    expect(r.reasons).not.toContain("head-key-not-in-latest-signer-document");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("naming a later did:vh editor version that lists the key again, it is accepted (P9.15 exception, P5.18)", async () => {
    const { alice, bob, anchor, anchoring, asBob } = await harbor();
    bob.timeOverride = at(20);
    await bob.rotate([{ fragment: "edit2", signer: KB2 }]);
    bob.timeOverride = at(35);
    await bob.rotate([{ fragment: "edit", signer: KB }]);
    const named = await updateOriginal(anchor, { versionTime: time(30), name: "Names the re-grant", ...asBob() });
    const r = await verify([alice, bob], [sat([anchoring(), inscribe(named, 30)])]);
    expect(r.head).toBe(named.versionId);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-107 (editor): an editor entry before the anchoring entry, signed by a key removed before the inscription, is accepted against the version it names", async () => {
    const alice = await VhAuthor.create([{ fragment: "orig", signer: KA }]);
    const bob = await VhAuthor.create([{ fragment: "edit", signer: KB }]);
    const ref = alice.ref("orig");
    const sign = alice.signer(KA, "orig");
    const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", resources: [photo(B1)], author: ref, sign, editors: [grant(bob.did)] });
    const byBob = await updateOriginal(genesis, { versionTime: time(2), resources: [photo(B2)], editor: bob.ref("edit"), sign: bob.signer(KB, "edit") });
    const anchor = await updateOriginal(byBob, { versionTime: time(9), aliases: [SAT], author: ref, sign });
    bob.timeOverride = at(5);
    await bob.rotate([{ fragment: "edit2", signer: KB2 }]);
    const r = await verify([alice, bob], [sat([inscribe([genesis, byBob, anchor], 10)])]);
    expect(r.anchoring?.status).toBe("anchored");
    expect(r.head).toBe(anchor.versionId);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  describe("a did:btco editor DID: chain order, not versionTime (P5.13, P5.18)", () => {
    const KE = seeded(41);
    const KE2 = seeded(42);
    const signE = signWith(KE, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `${EDITOR_SAT}#edit` });
    const refE = (versionId: string): AuthorRef => ({ did: EDITOR_SAT, verificationMethod: `${EDITOR_SAT}#edit`, versionId });
    const withKey = () => btcoDocument(EDITOR_SAT, [{ fragment: "edit", signer: KE }]);
    const without = () => btcoDocument(EDITOR_SAT, [{ fragment: "edit2", signer: KE2 }]);

    async function setup() {
      const alice = await VhAuthor.create([{ fragment: "orig", signer: KA }]);
      const ref = alice.ref("orig");
      const sign = alice.signer(KA, "orig");
      const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", resources: [photo(B1)], author: ref, sign, editors: [grant(EDITOR_SAT)] });
      const anchor = await updateOriginal(genesis, { versionTime: time(9), aliases: [SAT], author: ref, sign });
      return { alice, genesis, anchor, anchoring: inscribe([genesis, anchor], 10) };
    }
    const editorEvidence = (versions: Inscribed[]): AuthorDidEvidence => ({ did: EDITOR_SAT, bitcoin: sat(versions, EDITOR_SAT) });

    test("an entry naming a version whose key a later version preceding the inscription removed is rejected", async () => {
      const { alice, anchor, anchoring } = await setup();
      const v1 = didVersion(5, withKey());
      const v2 = didVersion(15, without());
      const edit = await updateOriginal(anchor, { versionTime: time(20), name: "Signed after removal", editor: refE(v1.id), sign: signE });
      const r = await verify([alice, editorEvidence([v1, v2])], [sat([anchoring, inscribe(edit, 20)])]);
      expect(r.head).toBe(anchor.versionId);
      expect(r.anchoring?.ignored).toMatchObject([{ versionId: edit.versionId, reason: "author-key-not-valid-at-inscription-time" }]);
      expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    });

    test("an entry naming a version inscribed after it is rejected; one naming a preceding version that holds the key is accepted", async () => {
      const { alice, anchor, anchoring } = await setup();
      const v1 = didVersion(5, withKey());
      const v2 = didVersion(25, withKey());
      const early = await updateOriginal(anchor, { versionTime: time(20), name: "Names a later version", editor: refE(v2.id), sign: signE });
      const tooSoon = await verify([alice, editorEvidence([v1, v2])], [sat([anchoring, inscribe(early, 20)])]);
      expect(tooSoon.anchoring?.ignored).toMatchObject([{ versionId: early.versionId, reason: "author-version-not-yet-in-effect" }]);
      const ok = await updateOriginal(anchor, { versionTime: time(20), name: "Names a preceding version", editor: refE(v1.id), sign: signE });
      const r = await verify([alice, editorEvidence([v1, v2])], [sat([anchoring, inscribe(ok, 20)])]);
      expect(r.head).toBe(ok.versionId);
      expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    });
  });
});

describe("C12-122 (anchored): an editor entry after the author DID is deactivated (P5.18, P9.15)", () => {
  test("inscribed after the author DID's deactivation, it is rejected; the accepted state stays current", async () => {
    const { alice, bob, anchor, anchoring, asBob } = await harbor();
    const late = await updateOriginal(anchor, { versionTime: time(30), name: "After the author's deactivation", ...asBob() });
    alice.timeOverride = at(20);
    await alice.deactivate();
    const r = await verify([alice, bob], [sat([anchoring(), inscribe(late, 30)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored).toMatchObject([{ versionId: late.versionId, reason: "author-deactivated-at-inscription-time" }]);
    expect(r.identityEvidence.deactivated).toBe(true);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("inscribed before it, it is accepted and stays current", async () => {
    const { alice, bob, anchor, anchoring, asBob } = await harbor();
    const early = await updateOriginal(anchor, { versionTime: time(15), name: "Before the author's deactivation", ...asBob() });
    alice.timeOverride = at(20);
    await alice.deactivate();
    const r = await verify([alice, bob], [sat([anchoring(), inscribe(early, 15)])]);
    expect(r.head).toBe(early.versionId);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("a did:btco author DID: a deactivation preceding the inscription in chain order rejects the editor entry", async () => {
    const KAB = seeded(43);
    const signA = signWith(KAB, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `${AUTHOR_SAT}#orig` });
    const v1 = didVersion(5, btcoDocument(AUTHOR_SAT, [{ fragment: "orig", signer: KAB }]));
    const refA: AuthorRef = { did: AUTHOR_SAT, verificationMethod: `${AUTHOR_SAT}#orig`, versionId: v1.id };
    const bob = await VhAuthor.create([{ fragment: "edit", signer: KB }]);
    const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", resources: [photo(B1)], author: refA, sign: signA, editors: [grant(bob.did)] });
    const anchor = await updateOriginal(genesis, { versionTime: time(9), aliases: [SAT], author: refA, sign: signA });
    const edit = await updateOriginal(anchor, { versionTime: time(20), name: "After the author's deactivation", editor: bob.ref("edit"), sign: bob.signer(KB, "edit") });
    // Deactivated in the same block, earlier in chain order than the editor's inscription.
    const off = didVersion(20, { "@context": ["https://www.w3.org/ns/did/v1"], id: AUTHOR_SAT, deactivated: true }, { transactionIndex: 0 });
    const author: AuthorDidEvidence = { did: AUTHOR_SAT, bitcoin: sat([v1, off], AUTHOR_SAT) };
    const r = await verify([author, bob], [sat([inscribe([genesis, anchor], 10), inscribe(edit, 20, { transactionIndex: 1 })])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored).toMatchObject([{ versionId: edit.versionId, reason: "author-deactivated-at-inscription-time" }]);
    // Deactivated later in the block: the editor entry stands.
    const offLater = didVersion(20, { "@context": ["https://www.w3.org/ns/did/v1"], id: AUTHOR_SAT, deactivated: true }, { transactionIndex: 2 });
    const later = await verify([{ did: AUTHOR_SAT, bitcoin: sat([v1, offLater], AUTHOR_SAT) }, bob], [sat([inscribe([genesis, anchor], 10), inscribe(edit, 20, { transactionIndex: 1 })])]);
    expect(later.head).toBe(edit.versionId);
    expect(later.current, JSON.stringify(later.reasons)).toBe(true);
  });
});

describe("C12-118 (anchored): an editor entry and the revocation of its grant with the same parent (P5.17, P9.13)", () => {
  async function siblings() {
    const h = await harbor();
    const edit = await updateOriginal(h.anchor, { versionTime: time(19), resources: [photo(B2)], ...h.asBob() });
    const revoke = await updateOriginal(h.anchor, { versionTime: time(19), editors: null, author: h.ref, sign: h.sign });
    return { ...h, edit, revoke };
  }

  test("off-chain they are a fork, unresolved: neither is current", async () => {
    const { alice, bob, copy, edit, revoke } = await siblings();
    const r = await verifyOriginal({
      log: [...copy, edit], copies: [{ source: "other", log: serializeLog([...copy, revoke]) }],
      authors: [alice.evidence(), bob.evidence()], now: NOW, bytes: allBytes, freshness: "asserted",
    });
    expect(r.fork).not.toBeNull();
    expect(r.current).toBe(false);
  });

  test("on the sat, chain order decides: the editor entry inscribed first is accepted, the revocation does not extend the head", async () => {
    const { alice, bob, anchoring, edit, revoke } = await siblings();
    const r = await verify([alice, bob], [sat([anchoring(), inscribe(edit, 20), inscribe(revoke, 21)])]);
    expect(r.head).toBe(edit.versionId);
    expect(r.fork).toBeNull();
    expect(r.anchoring?.ignored).toMatchObject([{ versionId: revoke.versionId, reason: "does-not-extend-head" }]);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("the revocation inscribed first is accepted; the editor entry, and any later one by that editor, is not", async () => {
    const { alice, bob, anchoring, edit, revoke, asBob } = await siblings();
    const after = await forge(revoke, { ...revoke.state, operation: "update", editor: bob.ref("edit") as unknown as JsonObject, asset: { ...(revoke.state.asset as JsonObject), name: "Revoked" }, transitions: [] }, asBob().sign);
    const r = await verify([alice, bob], [sat([anchoring(), inscribe(revoke, 20), inscribe(edit, 21), inscribe(after, 22)])]);
    expect(r.head).toBe(revoke.versionId);
    expect(r.anchoring?.ignored).toMatchObject([
      { versionId: edit.versionId, reason: "does-not-extend-head" },
      { versionId: after.versionId, reason: "invalid-entry", code: "EDITOR_NOT_GRANTED" },
    ]);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("within one block the earlier in chain order wins; the other is not above the accepted height", async () => {
    const { alice, bob, anchoring, edit, revoke } = await siblings();
    const r = await verify([alice, bob], [sat([anchoring(), inscribe(revoke, 20, { transactionIndex: 3 }), inscribe(edit, 20, { transactionIndex: 2 })])]);
    expect(r.head).toBe(edit.versionId);
    expect(r.anchoring?.ignored).toMatchObject([{ versionId: revoke.versionId, reason: "not-above-previous-height" }]);
  });
});
