/**
 * Anchored Originals (plan 012; plan 011 PR 9a). Inscriptions on the anchoring
 * sat, as an adapter reports them, decide the log (P9.10, P9.12-P9.17): the
 * anchoring inscription carries the whole log from genesis through the
 * anchoring entry, each later inscription one entry, in its metadata as CBOR,
 * with the resource version its last entry names as its body (P14.12;
 * originals-spec #53), and each is checked
 * against the author DID at its inscription time (P9.15). Tests cite their
 * section 12 rows by registry id (specs/originals-conformance.json).
 */
import { describe, expect, test } from "bun:test";
import { appendEntry, serializeLog, signWith, type LogEntry } from "../src/log/index.js";
import {
  ORIGINALS_INSCRIPTION_MAX_BYTES,
  createOriginal,
  encodeCbor,
  deactivateOriginal,
  parseBtcoAlias,
  resourceDigest,
  updateOriginal,
  verifyOriginal,
  type OriginalsReport,
  type SatEvidence,
  type SatInscription,
} from "../src/originals/index.js";
import { versionNumberOf } from "../src/originals/author.js";
import { canonicalize, type JsonValue } from "../src/json/index.js";
import { VhAuthor, bytes, carrying, photo, seeded } from "./helpers/originals.js";

const B0 = "harbor at dawn, uncropped";
const B1 = "harbor at dawn";
const allBytes = { [resourceDigest(bytes(B1))]: bytes(B1) };
const KEY = seeded(21);
const SAT = "did:btco:reg:5000000000";
const OTHER_SAT = "did:btco:reg:7000000000";
const WEB = "did:webvh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ:example.com";
const T0 = Date.parse("2026-10-18T12:00:00Z");
const NOW = Date.parse("2026-10-19T00:00:00Z");

type Inscribed = Omit<SatInscription, "sat" | "network"> & Partial<Pick<SatInscription, "sat" | "network">>;

let counter = 0;
/** An inscription carrying these entries in its metadata, its body the last entry's resource version (P9.17, P14.12). */
function inscribe(entries: LogEntry | LogEntry[], height: number, extra: Partial<SatInscription> = {}): Inscribed {
  return {
    id: `${(counter++).toString(16).padStart(64, "0")}i0`,
    height,
    transactionIndex: 1,
    inscriptionIndex: 0,
    confirmations: 120 - height,
    inscriptionTime: T0 + height * 600_000,
    ...carrying(entries),
    ...extra,
  };
}

/** One index's read of a sat. Each inscription is placed on that sat unless it says otherwise (P9.10). */
function sat(inscriptions: Inscribed[], did = SAT, owner: SatEvidence["owner"] = { output: "aa".repeat(32) + ":0", confirmations: 3 }, index = "ord-a"): SatEvidence {
  const { sat: number, network } = parseBtcoAlias(did);
  return { sat: did, index, tip: { height: 119, hash: "bb".repeat(32) }, inscriptions: inscriptions.map((i) => ({ sat: number, network, ...i })), owner };
}

const time = (height: number) => new Date(T0 + height * 600_000 - 60_000).toISOString();

/** An Original with two local entries, then an anchoring entry naming SAT. */
async function anchored(opts: { aliases?: string[] } = {}) {
  const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }]);
  const sign = alice.signer(KEY, "orig");
  const ref = alice.ref("orig");
  const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", resource: photo(B1), author: ref, sign });
  const renamed = await updateOriginal(genesis, { versionTime: time(2), name: "Harbor at dawn", author: ref, sign });
  const anchor = await updateOriginal(renamed, { versionTime: time(10), aliases: [...(opts.aliases ?? []), SAT], author: ref, sign });
  const copy = [genesis, renamed, anchor];
  /** The anchoring inscription: the whole log through the anchoring entry (P9.17). */
  const anchoring = (height: number, extra: Partial<SatInscription> = {}) => inscribe(copy, height, extra);
  return { alice, sign, ref, genesis, renamed, anchor, copy, anchoring };
}

const verify = (log: LogEntry[] | undefined, alice: VhAuthor, bitcoin?: SatEvidence[], extra: Partial<Parameters<typeof verifyOriginal>[0]> = {}): Promise<OriginalsReport> =>
  verifyOriginal({ ...(log ? { log } : {}), authors: [alice.evidence()], now: NOW, bytes: allBytes, ...(bitcoin ? { bitcoin } : {}), ...extra });

describe("an entry in the anchoring inscription naming a version the verifier holds under another versionId (P9.15)", () => {
  test("C12-184: the entry is rejected, so the inscription is not an anchor; this is not incomplete identity evidence", async () => {
    const { alice, sign, ref, genesis, renamed } = await anchored();
    const known = alice.versionId;
    const fake = `${known.split("-")[0]}-QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DzA3a1Y`;
    expect(fake).not.toBe(known);
    const anchor = await updateOriginal(renamed, { versionTime: time(10), aliases: [SAT], author: { ...ref, versionId: fake }, sign });
    const log = [genesis, renamed, anchor];
    const r = await verify(log, alice, [sat([inscribe(log, 10)])]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ versionId: anchor.versionId, reason: "invalid-entry", code: "AUTHOR_VERSION_NOT_IN_HISTORY" })]);
    expect(r.current).toBe(false);
  });
});

describe("the anchoring entry (P9.10; plan 012 §3.1, S10)", () => {
  test("C12-34: anchoring from the local layer is accepted, with claimed ordering before it and provisional ownership", async () => {
    const { alice, copy, anchor, anchoring } = await anchored();
    const r = await verify(copy, alice, [sat([anchoring(10)])]);
    expect(r.history.status).toBe("valid");
    expect(r.anchoring).toMatchObject({ sat: SAT, status: "anchored", uniqueness: "not-established", anchor: { versionId: anchor.versionId, height: 10 } });
    expect(r.ordering).toBe("anchored");
    expect(r.ownership).toMatchObject({ status: "provisional", sat: SAT, confirmations: 3, indexes: ["ord-a"] });
    expect(r.anchoring?.indexes).toEqual(["ord-a"]);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-31: an entry that names a different sat or drops the sat after anchoring is rejected", async () => {
    const { ref, sign, anchor, anchoring } = await anchored();
    await expect(updateOriginal(anchor, { versionTime: time(11), aliases: [OTHER_SAT], author: ref, sign })).rejects.toMatchObject({ code: "STATE_ANCHOR" });
    await expect(updateOriginal(anchor, { versionTime: time(11), aliases: [], author: ref, sign })).rejects.toMatchObject({ code: "STATE_ANCHOR" });
  });

  test("C12-35: an Original anchored from the local layer never gains a did:webvh alias", async () => {
    const { ref, sign, anchor, anchoring } = await anchored();
    const web = "did:webvh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ:example.com";
    await expect(updateOriginal(anchor, { versionTime: time(11), aliases: [web, SAT], author: ref, sign })).rejects.toMatchObject({ code: "STATE_ANCHOR" });
  });

  test("C12-89: an anchored log with no Bitcoin evidence is unverified: missing evidence, not current", async () => {
    const { alice, copy, anchoring } = await anchored();
    const r = await verify(copy, alice);
    expect(r.anchoring?.status).toBe("unverified");
    expect(r.current).toBe(false);
    expect(r.reasons).toContain("bitcoin-evidence-missing");
  });

  test("C12-38, C12-25 and C12-33: an anchoring entry inscribed on a sat other than the one it names is not an anchor, is reported, and confers nothing", async () => {
    const { alice, copy, anchor, anchoring } = await anchored();
    const r = await verify(copy, alice, [sat([anchoring(10)], OTHER_SAT)]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored[0]).toMatchObject({ sat: OTHER_SAT, reason: "names-another-sat" });
    expect(r.ownership).toBeNull();
    expect(r.current).toBe(false);
  });
});

describe("after anchoring, the sat decides (P9.12, P9.13)", () => {
  test("C12-30 and C12-27: an author-signed entry inscribed by whoever holds the sat is accepted; the owner is the sat's holder", async () => {
    const { alice, copy, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Harbor, sold", author: ref, sign });
    const newOwner = { output: "cc".repeat(32) + ":1", confirmations: 2 };
    const r = await verify([...copy, next], alice, [sat([anchoring(10), inscribe(next, 20)], SAT, newOwner)]);
    expect(r.head).toBe(next.versionId);
    expect(r.state?.name).toBe("Harbor, sold");
    expect(r.ownership).toMatchObject({ output: newOwner.output, confirmations: 2 });
    expect(r.identityEvidence.author).toBe(alice.did); // authorship never moves (P5.8)
  });

  test("C12-28: an author-signed entry that is not inscribed on the sat is not current", async () => {
    const { alice, copy, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Only in a copy", author: ref, sign });
    const r = await verify([...copy, next], alice, [sat([anchoring(10)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.state?.name).toBe("Harbor at dawn");
    expect(r.anchoring?.superseded).toBe(1);
  });

  test("C12-29: an inscription on the sat not signed by the author, including by the owner, changes nothing", async () => {
    const { alice, copy, anchor, ref, anchoring } = await anchored();
    const owner = seeded(77);
    const forged = await updateOriginal(anchor, { versionTime: time(20), name: "By the owner", author: ref, sign: alice.signer(owner, "orig") });
    const r = await verify(copy, alice, [sat([anchoring(10), inscribe(forged, 20)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored.map((i) => i.reason)).toContain("invalid-entry");
  });

  test("C12-32: a newer inscription that does not extend the head is ignored", async () => {
    const { alice, copy, anchor, renamed, ref, sign, anchoring } = await anchored();
    const sideways = await updateOriginal(renamed, { versionTime: time(20), name: "Sideways", author: ref, sign });
    const r = await verify(copy, alice, [sat([anchoring(10), inscribe(sideways, 20)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored[0]?.reason).toBe("does-not-extend-head");
  });

  test("C12-39: a publication at the same or a lower block height than the previous accepted one is not accepted", async () => {
    const { alice, copy, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(10), name: "Same block", author: ref, sign });
    const r = await verify(copy, alice, [sat([anchoring(10), inscribe(next, 10, { transactionIndex: 2 })])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored[0]?.reason).toBe("not-above-previous-height");
  });

  test("C12-90: unconfirmed and foreign inscriptions are observed but never accepted", async () => {
    const { alice, copy, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Pending", author: ref, sign });
    const r = await verify(copy, alice, [sat([anchoring(10), inscribe(next, 20, { confirmations: 0 }), inscribe(next, 21, { mediaType: "image/png", metadata: null })])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored.map((i) => i.reason)).toEqual(["unconfirmed", "not-an-originals-inscription"]);
  });

  test("C12-75 and C12-86: an inscription that does not strictly parse is rejected; after the anchor, so is one carrying more than one entry", async () => {
    const { alice, copy, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Next", author: ref, sign });
    const one = encodeCbor([next as unknown as JsonValue]);
    // The entry's map with a second `versionId` key in front of the first (P14.12).
    const dup = new Uint8Array([one[0], one[1] + 1, ...encodeCbor("versionId"), ...encodeCbor("x"), ...one.slice(2)]);
    const bad = [encodeCbor([next, next] as unknown as JsonValue), dup, bytes("not cbor\n"), new Uint8Array([0xff, 0xfe]), new Uint8Array([...one, 0x00])];
    const r = await verify(copy, alice, [sat([anchoring(10), ...bad.map((metadata, k) => inscribe(next, 20 + k, { metadata }))])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored.map((i) => i.reason)).toEqual(["more-than-one-entry", "undecodable", "undecodable", "undecodable", "undecodable"]);
  });

  test("C12-36: of two anchoring entries on different sats, the first in chain order is the anchor; the other is a conflicting anchor", async () => {
    const { alice, genesis, renamed, anchor, ref, sign, anchoring } = await anchored();
    const other = await updateOriginal(renamed, { versionTime: time(10), aliases: [OTHER_SAT], author: ref, sign });
    const mine = sat([anchoring(12)]);
    const theirs = sat([inscribe([genesis, renamed, other], 11)], OTHER_SAT);
    for (const evidence of [[mine, theirs], [theirs, mine]]) {
      const r = await verify([genesis, renamed], alice, evidence);
      expect(r.anchoring?.anchor).toMatchObject({ versionId: other.versionId, height: 11 });
      expect(r.anchoring?.sat).toBe(OTHER_SAT);
      expect(r.anchoring?.conflicting).toEqual([expect.objectContaining({ sat: SAT, versionId: anchor.versionId, height: 12 })]);
      expect(r.head).toBe(other.versionId);
      expect(r.ownership?.sat).toBe(OTHER_SAT);
    }
  });

  test("C12-40 and C12-91: when a reorganisation removes an accepted inscription, the change is reported, never applied silently", async () => {
    const { alice, copy, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Reorged away", author: ref, sign });
    const r = await verify([...copy, next], alice, [sat([anchoring(10)])], { retained: { original: next.versionId } });
    expect(r.head).toBe(anchor.versionId);
    expect(r.reasons).toContain("authoritative-source-changed");
    expect(r.current).toBe(false);
  });
});

describe("review fixes (PR 9a)", () => {
  test("a copy holding entries past the Bitcoin head neither replaces it, forks it nor makes it stale", async () => {
    const { alice, copy, anchor, ref, sign, anchoring } = await anchored();
    const ahead = await updateOriginal(anchor, { versionTime: time(20), name: "Only in a copy", author: ref, sign });
    const sideways = await updateOriginal(anchor, { versionTime: time(21), name: "Another copy", author: ref, sign });
    const copies = [{ source: "a", log: serializeLog([...copy, ahead]) }, { source: "b", log: serializeLog([...copy, sideways]) }];
    const r = await verify(copy, alice, [sat([anchoring(10)])], { copies });
    expect(r.head).toBe(anchor.versionId);
    expect(r.fork).toBeNull();
    expect(r.assetFreshness.status).toBe("anchored");
    expect(r.ordering).toBe("anchored");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("an entry after the anchor is anchored only when Bitcoin accepted it", async () => {
    const { alice, copy, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Inscribed", author: ref, sign });
    const r = await verify([...copy, next], alice, [sat([anchoring(10), inscribe(next, 20)])], { checkpoint: copy[1].versionId });
    expect(r.ordering).toBe("claimed"); // before the anchor
    const at = await verify([...copy, next], alice, [sat([anchoring(10), inscribe(next, 20)])], { checkpoint: next.versionId });
    expect(at.ordering).toBe("anchored");
  });

  test("an anchored log read without Bitcoin evidence, or with no anchor on it, never advances the retained version", async () => {
    const { alice, copy, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Not inscribed", author: ref, sign });
    const unverified = await verify([...copy, next], alice, undefined, { retained: { original: copy[1].versionId } });
    expect(unverified.retain.original).toBe(copy[1].versionId);
    const none = await verify([...copy, next], alice, [sat([])]);
    expect(none.retain.original).toBeNull();
    const inscribed = await verify([...copy, next], alice, [sat([anchoring(10)])]);
    expect(inscribed.retain.original).toBe(anchor.versionId);
  });

  test("every anchoring inscription checks itself: an earlier one with another history is the anchor, whatever the copy holds (P9.16, P9.17; C12-88)", async () => {
    const { alice, copy, genesis, ref, sign, anchoring } = await anchored();
    const branch = await updateOriginal(genesis, { versionTime: time(3), name: "Another history", author: ref, sign });
    const earlier = await updateOriginal(branch, { versionTime: time(9), aliases: [SAT], author: ref, sign });
    const elsewhere = await updateOriginal(branch, { versionTime: time(9), aliases: [OTHER_SAT], author: ref, sign });
    for (const [evidence, winner, winnerSat] of [
      [[sat([inscribe([genesis, branch, earlier], 9), anchoring(10)])], earlier, SAT],
      [[sat([anchoring(10)]), sat([inscribe([genesis, branch, elsewhere], 9)], OTHER_SAT)], elsewhere, OTHER_SAT],
    ] as const) {
      const r = await verify(copy, alice, [...evidence]);
      expect(r.anchoring?.anchor).toMatchObject({ versionId: winner.versionId, sat: winnerSat, height: 9 });
      expect(r.anchoring?.conflicting).toEqual([expect.objectContaining({ versionId: copy[2].versionId, height: 10 })]);
      expect(r.anchoring?.copy).toBe("differs");
      expect(r.head).toBe(winner.versionId);
      expect(r.state?.name).toBe("Another history");
      expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    }
    // A later one changes nothing: it is a conflicting anchor.
    const later = await verify(copy, alice, [sat([anchoring(10), inscribe([genesis, branch, earlier], 11)])]);
    expect(later.head).toBe(copy[2].versionId);
    expect(later.anchoring?.conflicting).toEqual([expect.objectContaining({ versionId: earlier.versionId, height: 11 })]);
  });

  test("C12-36: a second anchoring entry on the same sat is a conflicting anchor", async () => {
    const { alice, copy, renamed, anchor, ref, sign, anchoring } = await anchored();
    const second = await updateOriginal(renamed, { versionTime: time(11), name: "Second anchor", aliases: [SAT], author: ref, sign });
    const r = await verify(copy, alice, [sat([anchoring(10), inscribe([copy[0], renamed, second], 12)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.conflicting).toEqual([expect.objectContaining({ sat: SAT, versionId: second.versionId, height: 12 })]);
    expect(r.anchoring?.ignored).toEqual([]);
  });

  test("a copy that does not parse is ignored: the sat carries the log (P9.17; C12-88)", async () => {
    const { alice, anchor, anchoring } = await anchored();
    const r = await verifyOriginal({ log: "not a log\n", authors: [alice.evidence()], now: NOW, bytes: allBytes, bitcoin: [sat([anchoring(10)])] });
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.copy).toBe("differs");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });
});

describe("author checks at inscription time (P9.15)", () => {
  test("C12-41 (anchored): an inscription made after the author removed its key is rejected", async () => {
    const { alice, copy, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(30), name: "Stolen key", author: ref, sign });
    alice.timeOverride = new Date(T0 + 25 * 600_000).toISOString();
    await alice.rotate([{ fragment: "orig2", signer: seeded(23) }]);
    const r = await verify([...copy, next], alice, [sat([anchoring(10), inscribe(next, 30)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored[0]?.reason).toBe("author-key-not-valid-at-inscription-time");
  });

  test("C12-42: an accepted anchored entry whose key the author later removes stays current", async () => {
    const { alice, copy, anchor, anchoring } = await anchored();
    alice.timeOverride = new Date(T0 + 50 * 600_000).toISOString();
    await alice.rotate([{ fragment: "orig2", signer: seeded(23) }]);
    const r = await verify(copy, alice, [sat([anchoring(10)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-43 and C12-48 (anchored): after the author DID is deactivated the accepted state stays current; later inscriptions are rejected", async () => {
    const { alice, copy, anchor, ref, sign, anchoring } = await anchored();
    const late = await updateOriginal(anchor, { versionTime: time(40), name: "After deactivation", author: ref, sign });
    alice.timeOverride = new Date(T0 + 30 * 600_000).toISOString();
    await alice.deactivate();
    const r = await verify([...copy, late], alice, [sat([anchoring(10), inscribe(late, 40)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored[0]?.reason).toBe("author-deactivated-at-inscription-time");
    expect(r.identityEvidence.deactivated).toBe(true);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-44: an anchored entry naming an author DID version newer than its inscription time is checked against the named version", async () => {
    const { alice, copy, anchor, sign, anchoring } = await anchored();
    alice.timeOverride = new Date(T0 + 35 * 600_000).toISOString();
    await alice.rotate([{ fragment: "orig", signer: KEY }, { fragment: "spare", signer: seeded(24) }]);
    const next = await updateOriginal(anchor, { versionTime: time(30), name: "Names a later version", author: alice.ref("orig"), sign });
    const r = await verify([...copy, next], alice, [sat([anchoring(10), inscribe(next, 30)])]);
    expect(r.head).toBe(next.versionId);
  });

  test("C12-08 (anchored): an entry naming an old author version is checked against the state at its inscription time, whatever time it claims", async () => {
    const { alice, copy, anchor, sign, anchoring } = await anchored();
    const v1 = alice.versionId;
    alice.timeOverride = new Date(T0 + 25 * 600_000).toISOString();
    await alice.rotate([{ fragment: "orig2", signer: seeded(23) }]);
    const backdated = await updateOriginal(anchor, { versionTime: time(11), name: "Backdated", author: alice.ref("orig", v1), sign });
    const r = await verify([...copy, backdated], alice, [sat([anchoring(10), inscribe(backdated, 30)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored[0]?.reason).toBe("author-key-not-valid-at-inscription-time");
  });

  test("C12-62 and C12-46: without the author DID's history the anchored Original is incomplete, not current", async () => {
    const { alice, copy, anchor, anchoring } = await anchored();
    const r = await verifyOriginal({ log: copy, authors: [], now: NOW, bytes: allBytes, bitcoin: [sat([anchoring(10)])] });
    expect(r.identityEvidence.status).toBe("incomplete");
    expect(r.current).toBe(false);
    void alice;
  });

  test("C12-47: an author DID version that would retroactively reject an accepted inscription is reported as a conflict", async () => {
    const { alice, copy, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Accepted earlier", author: ref, sign });
    // A removal claiming a versionTime before the inscription, published after it was accepted.
    alice.timeOverride = new Date(T0 + 15 * 600_000).toISOString();
    await alice.rotate([{ fragment: "orig2", signer: seeded(23) }]);
    const r = await verify([...copy, next], alice, [sat([anchoring(10), inscribe(next, 20)])], { retained: { original: next.versionId } });
    expect(r.reasons).toContain("retroactive-revocation-conflict");
    expect(r.current).toBe(false);
  });
});

describe("the newest known signer DID version (P7.8, P9.15; originals-spec #47)", () => {
  const OBTAINED = new Date(NOW - 3_600_000).toISOString();

  test("C12-46: an entry inscribed after the newest version the verifier knows is checked against that version, and the report states it and when it was obtained", async () => {
    const { alice, copy, anchor, ref, sign, anchoring } = await anchored();
    const known = alice.versionId; // the author's DID log ends here: nothing about later times is known
    const next = await updateOriginal(anchor, { versionTime: time(30), name: "Long after the last known version", author: ref, sign });
    const r = await verifyOriginal({
      log: [...copy, next], authors: [{ ...alice.evidence(), obtainedAt: OBTAINED, source: "fetched" , location: null }], now: NOW, bytes: allBytes, bitcoin: [sat([anchoring(10), inscribe(next, 30)])],
    });
    expect(r.head).toBe(next.versionId);
    expect(r.identityEvidence.status).toBe("complete");
    expect(r.assetFreshness.status).toBe("anchored");
    expect(r.validAsOf?.signers).toEqual([{ did: alice.did, role: "author", versionId: known, obtainedAt: OBTAINED, source: "fetched" , location: null }]);
    expect(r.reasons).toEqual([]);
    expect(r.current).toBe(true);
  });

  test("C12-161: a later inscription naming a version newer than any the verifier holds is reported unverifiable; the accepted head keeps its identity evidence (P9.12, P9.15, P5.6)", async () => {
    const { alice, copy, anchor, anchoring } = await anchored();
    const older = alice.entries.slice();
    await alice.rotate([{ fragment: "orig", signer: KEY }, { fragment: "spare", signer: seeded(24) }]);
    const next = await updateOriginal(anchor, { versionTime: time(30), name: "Names a version the reader lacks", author: alice.ref("orig"), sign: alice.signer(KEY, "orig") });
    const later = inscribe(next, 30);
    const r = await verifyOriginal({ log: [...copy, next], authors: [alice.evidence(older)], now: NOW, bytes: allBytes, bitcoin: [sat([anchoring(10), later])] });
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ reason: "later-inscription-unverifiable", versionId: next.versionId })]);
    expect(r.anchoring?.unverifiable).toEqual([{ sat: SAT, inscription: later.id, versionId: next.versionId, signer: alice.did, signerVersionId: alice.versionId }]);
    expect(r.identityEvidence.status).toBe("complete");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    // With the newer version it verifies and is the head.
    const fresh = await verifyOriginal({ log: [...copy, next], authors: [alice.evidence()], now: NOW, bytes: allBytes, bitcoin: [sat([anchoring(10), later])] });
    expect(fresh.head).toBe(next.versionId);
    expect(fresh.anchoring?.unverifiable).toEqual([]);
  });

  test("C12-181: P9.15: chain order decides: a valid publication after an earlier unverifiable inscription extending the same head waits; the earlier one, once verified, is accepted", async () => {
    const { alice, copy, anchor, anchoring, ref, sign } = await anchored();
    const older = alice.entries.slice();
    await alice.rotate([{ fragment: "orig", signer: KEY }, { fragment: "spare", signer: seeded(24) }]);
    const first = await updateOriginal(anchor, { versionTime: time(30), name: "Names a version the reader lacks", author: alice.ref("orig"), sign: alice.signer(KEY, "orig") });
    const second = await updateOriginal(anchor, { versionTime: time(40), name: "Valid, but later in chain order", author: ref, sign });
    const blocking = inscribe(first, 30);
    const waiting = inscribe(second, 40);
    const r = await verifyOriginal({ log: copy, authors: [alice.evidence(older)], now: NOW, bytes: allBytes, bitcoin: [sat([anchoring(10), blocking, waiting])] });
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.unverifiable.map((u) => u.inscription)).toEqual([blocking.id]);
    expect(r.anchoring?.ignored).toEqual([
      expect.objectContaining({ inscription: blocking.id, reason: "later-inscription-unverifiable" }),
      expect.objectContaining({ inscription: waiting.id, versionId: second.versionId, reason: "waiting-for-earlier-unverifiable", waitingOn: blocking.id }),
    ]);
    // Once the earlier one verifies it is accepted, and the later one no longer extends the head.
    const fresh = await verifyOriginal({ log: copy, authors: [alice.evidence()], now: NOW, bytes: allBytes, bitcoin: [sat([anchoring(10), blocking, waiting])] });
    expect(fresh.head).toBe(first.versionId);
    expect(fresh.anchoring?.ignored).toEqual([expect.objectContaining({ inscription: waiting.id, reason: "does-not-extend-head" })]);
  });

  test("C12-182: an earlier unverifiable inscription that proves invalid once verified is rejected, the next in chain order is considered, and the change of head is reported", async () => {
    const { alice, copy, anchor, anchoring } = await anchored();
    const older = alice.entries.slice();
    // The newer version, after the anchoring inscription, replaces orig with spare: an entry
    // signed with orig naming it is invalid.
    alice.timeOverride = new Date(T0 + 20 * 600_000).toISOString();
    await alice.rotate([{ fragment: "spare", signer: seeded(24) }]);
    const bad = await updateOriginal(anchor, { versionTime: time(30), name: "Signed with a key the named version lacks", author: { ...alice.ref("spare"), verificationMethod: `${alice.did}#orig` }, sign: signWith(KEY, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `${alice.did}#orig` }) });
    const good = await updateOriginal(anchor, { versionTime: time(40), name: "Signed with spare", author: alice.ref("spare"), sign: alice.signer(seeded(24), "spare") });
    const blocking = inscribe(bad, 30);
    const waiting = inscribe(good, 40);
    const bitcoin = [sat([anchoring(10), blocking, waiting])];
    const before = await verifyOriginal({ log: copy, authors: [alice.evidence(older)], now: NOW, bytes: allBytes, bitcoin });
    expect(before.head).toBe(anchor.versionId);
    expect(before.anchoring?.ignored.map((i) => i.reason)).toEqual(["later-inscription-unverifiable", "waiting-for-earlier-unverifiable"]);
    const after = await verifyOriginal({ log: copy, authors: [alice.evidence()], now: NOW, bytes: allBytes, bitcoin, retained: before.retain });
    expect(after.head).toBe(good.versionId);
    expect(after.anchoring?.ignored).toEqual([expect.objectContaining({ inscription: blocking.id, reason: "invalid-entry" })]);
    expect(after.anchoring?.headChange).toEqual({
      previous: anchor.versionId,
      current: good.versionId,
      verified: [expect.objectContaining({ inscription: waiting.id })],
      // Both were unverifiable to the first reader: the waiting one named the newer version too.
      resolved: [blocking.id, waiting.id],
      unverified: [],
      vanished: [],
    });
    // The change is a notice; the state reached is current (owner decision on #993's review).
    expect(after.notices).toContain("head-changed");
    expect(after.current, JSON.stringify(after.reasons)).toBe(true);
  });

  test("C12-181, C12-35: a publication that would be rejected on its own is rejected while another blocks, not listed as waiting", async () => {
    const { alice, copy, anchor, anchoring, ref, sign } = await anchored();
    const older = alice.entries.slice();
    await alice.rotate([{ fragment: "orig", signer: KEY }, { fragment: "spare", signer: seeded(24) }]);
    const first = await updateOriginal(anchor, { versionTime: time(30), name: "Names a version the reader lacks", author: alice.ref("orig"), sign: alice.signer(KEY, "orig") });
    const valid = await updateOriginal(anchor, { versionTime: time(40), name: "Signature forged", author: ref, sign });
    const forged = { ...valid, proof: [{ ...valid.proof[0], proofValue: valid.proof[0].proofValue.slice(0, -2) + (valid.proof[0].proofValue.endsWith("1") ? "22" : "11") }] } as LogEntry;
    const r = await verifyOriginal({ log: copy, authors: [alice.evidence(older)], now: NOW, bytes: allBytes, bitcoin: [sat([anchoring(10), inscribe(first, 30), inscribe(forged, 40)])] });
    expect(r.anchoring?.ignored).toEqual([
      expect.objectContaining({ versionId: first.versionId, reason: "later-inscription-unverifiable" }),
      expect.objectContaining({ versionId: forged.versionId, reason: "invalid-entry", code: "PROOF_SIGNATURE" }),
    ]);
  });

  test("C12-181, C12-161: a second unverifiable inscription extending the same head is listed as unverifiable and as waiting on the first", async () => {
    const { alice, copy, anchor, anchoring } = await anchored();
    const older = alice.entries.slice();
    await alice.rotate([{ fragment: "orig", signer: KEY }, { fragment: "spare", signer: seeded(24) }]);
    const asNew = { author: alice.ref("orig"), sign: alice.signer(KEY, "orig") };
    const a = inscribe(await updateOriginal(anchor, { versionTime: time(30), name: "A", ...asNew }), 30);
    const b = inscribe(await updateOriginal(anchor, { versionTime: time(40), name: "B", ...asNew }), 40);
    const r = await verifyOriginal({ log: copy, authors: [alice.evidence(older)], now: NOW, bytes: allBytes, bitcoin: [sat([anchoring(10), a, b])] });
    expect(r.anchoring?.unverifiable.map((u) => u.inscription)).toEqual([a.id, b.id]);
    expect(r.anchoring?.ignored).toEqual([
      expect.objectContaining({ inscription: a.id, reason: "later-inscription-unverifiable" }),
      expect.objectContaining({ inscription: b.id, reason: "waiting-for-earlier-unverifiable", waitingOn: a.id }),
    ]);
    expect(r.retain.anchor?.unverifiable).toEqual([a.id, b.id]);
  });

  test("C12-164, P9.5: a blocking inscription that a reorganization removed is reported as vanished, not resolved", async () => {
    const { alice, copy, anchor, anchoring, ref, sign } = await anchored();
    const older = alice.entries.slice();
    await alice.rotate([{ fragment: "orig", signer: KEY }, { fragment: "spare", signer: seeded(24) }]);
    const blocking = inscribe(await updateOriginal(anchor, { versionTime: time(30), name: "Names a version the reader lacks", author: alice.ref("orig"), sign: alice.signer(KEY, "orig") }), 30);
    const good = await updateOriginal(anchor, { versionTime: time(40), name: "Valid, later", author: ref, sign });
    const waiting = inscribe(good, 40);
    const anchorAt = anchoring(10);
    const before = await verifyOriginal({ log: copy, authors: [alice.evidence(older)], now: NOW, bytes: allBytes, bitcoin: [sat([anchorAt, blocking, waiting])] });
    expect(before.head).toBe(anchor.versionId);
    // A reorganization drops the blocking inscription: the waiting one is accepted.
    const after = await verifyOriginal({ log: copy, authors: [alice.evidence(older)], now: NOW, bytes: allBytes, bitcoin: [sat([anchorAt, waiting])], retained: before.retain });
    expect(after.head).toBe(good.versionId);
    expect(after.anchoring?.headChange).toEqual({
      previous: anchor.versionId, current: good.versionId, verified: [expect.objectContaining({ inscription: waiting.id })], resolved: [], unverified: [], vanished: [blocking.id],
    });
    expect(after.notices).toContain("head-changed");
  });

  test("C12-164, P9.5: an accepted inscription a reorganization removed is vanished and reported as authoritative-source-changed, even with an unverifiable one after it", async () => {
    const { alice, copy, anchor, anchoring, ref, sign } = await anchored();
    const older = alice.entries.slice();
    await alice.rotate([{ fragment: "orig", signer: KEY }, { fragment: "spare", signer: seeded(24) }]);
    const x = await updateOriginal(anchor, { versionTime: time(20), name: "X, accepted", author: ref, sign });
    const u = await updateOriginal(x, { versionTime: time(30), name: "U, unverifiable", author: alice.ref("orig"), sign: alice.signer(KEY, "orig") });
    const anchorAt = anchoring(10);
    const xAt = inscribe(x, 20);
    const uAt = inscribe(u, 30);
    const before = await verifyOriginal({ log: copy, authors: [alice.evidence(older)], now: NOW, bytes: allBytes, bitcoin: [sat([anchorAt, xAt, uAt])] });
    expect(before.head).toBe(x.versionId);
    const after = await verifyOriginal({ log: copy, authors: [alice.evidence(older)], now: NOW, bytes: allBytes, bitcoin: [sat([anchorAt, uAt])], retained: before.retain });
    expect(after.head).toBe(anchor.versionId);
    expect(after.anchoring?.headChange?.vanished).toContain(xAt.id);
    expect(after.reasons).toContain("authoritative-source-changed");
    expect(after.current).toBe(false);
  });

  test("C12-187: a publication in the same block as the waiting one it extends is rejected; one extending a waiting sibling waits through it (P9.13, P9.15)", async () => {
    const { alice, copy, anchor, anchoring, ref, sign } = await anchored();
    const older = alice.entries.slice();
    await alice.rotate([{ fragment: "orig", signer: KEY }, { fragment: "spare", signer: seeded(24) }]);
    const blocker = inscribe(await updateOriginal(anchor, { versionTime: time(30), name: "U", author: alice.ref("orig"), sign: alice.signer(KEY, "orig") }), 30);
    // W1 extends the head too, after U: a waiting sibling. W2 extends W1.
    const w1 = await updateOriginal(anchor, { versionTime: time(40), name: "W1", author: ref, sign });
    const w2 = await updateOriginal(w1, { versionTime: time(50), name: "W2", author: ref, sign });
    const sameBlock = await updateOriginal(w1, { versionTime: time(41), name: "W1's child, same block", author: ref, sign });
    const w1At = inscribe(w1, 40);
    const sameAt = inscribe(sameBlock, 40, { inscriptionIndex: 1 });
    const w2At = inscribe(w2, 50);
    const r = await verifyOriginal({ log: copy, authors: [alice.evidence(older)], now: NOW, bytes: allBytes, bitcoin: [sat([anchoring(10), blocker, w1At, sameAt, w2At])] });
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored).toEqual([
      expect.objectContaining({ inscription: blocker.id, reason: "later-inscription-unverifiable" }),
      expect.objectContaining({ inscription: w1At.id, reason: "waiting-for-earlier-unverifiable", waitingOn: blocker.id }),
      expect.objectContaining({ inscription: sameAt.id, reason: "not-above-previous-height" }),
      expect.objectContaining({ inscription: w2At.id, reason: "waiting-for-earlier-unverifiable", waitingOn: blocker.id }),
    ]);
  });

  test("C12-187: publications that extend an unverifiable inscription wait on it, and are followed once it is accepted (P9.15, P9.13)", async () => {
    const { alice, copy, anchor, anchoring } = await anchored();
    const older = alice.entries.slice();
    await alice.rotate([{ fragment: "orig", signer: KEY }, { fragment: "spare", signer: seeded(24) }]);
    const asNew = { author: alice.ref("orig"), sign: alice.signer(KEY, "orig") };
    const first = await updateOriginal(anchor, { versionTime: time(30), name: "Names a version the reader lacks", ...asNew });
    const onTop = await updateOriginal(first, { versionTime: time(40), name: "Extends it", ...asNew });
    const blocking = inscribe(first, 30);
    const follower = inscribe(onTop, 40);
    const r = await verifyOriginal({ log: copy, authors: [alice.evidence(older)], now: NOW, bytes: allBytes, bitcoin: [sat([anchoring(10), blocking, follower])] });
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored).toEqual([
      expect.objectContaining({ inscription: blocking.id, reason: "later-inscription-unverifiable" }),
      expect.objectContaining({ inscription: follower.id, reason: "waiting-for-earlier-unverifiable", waitingOn: blocking.id }),
    ]);
    const fresh = await verifyOriginal({ log: copy, authors: [alice.evidence()], now: NOW, bytes: allBytes, bitcoin: [sat([anchoring(10), blocking, follower])] });
    expect(fresh.head).toBe(onTop.versionId);
  });

  test("C12-187: an unverifiable-looking inscription that does not chain to the head neither waits nor blocks", async () => {
    const { alice, copy, anchor, anchoring, ref, sign } = await anchored();
    const older = alice.entries.slice();
    await alice.rotate([{ fragment: "orig", signer: KEY }, { fragment: "spare", signer: seeded(24) }]);
    const first = await updateOriginal(anchor, { versionTime: time(30), name: "Names a version the reader lacks", author: alice.ref("orig"), sign: alice.signer(KEY, "orig") });
    // The same entry with its versionId's hash replaced: numbered to extend the head, but not chained to it.
    const junk = { ...first, versionId: `${first.versionId.split("-")[0]}-QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DzA3a1Y` };
    const good = await updateOriginal(anchor, { versionTime: time(40), name: "Valid, later", author: ref, sign });
    const r = await verifyOriginal({ log: copy, authors: [alice.evidence(older)], now: NOW, bytes: allBytes, bitcoin: [sat([anchoring(10), inscribe(junk, 30), inscribe(good, 40)])] });
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ versionId: junk.versionId, reason: "does-not-extend-head", code: "ENTRY_HASH_MISMATCH" })]);
    expect(r.head).toBe(good.versionId);
  });

  test("C12-189: P9.15: a later inscription naming a did:vh or did:webvh version past the 1,000-version limit, or after a deactivated version the verifier holds, is rejected, not unverifiable", async () => {
    const { alice, copy, anchor, anchoring, ref, sign } = await anchored();
    const named = (versionId: string) => updateOriginal(anchor, { versionTime: time(30), name: "Names an impossible version", author: { ...ref, versionId }, sign });
    const past = await named("1001-QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DzA3a1Y");
    const good = await updateOriginal(anchor, { versionTime: time(40), name: "Valid, later", author: ref, sign });
    const r = await verify(copy, alice, [sat([anchoring(10), inscribe(past, 30), inscribe(good, 40)])]);
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ versionId: past.versionId, reason: "invalid-entry", code: "AUTHOR_VERSION_IMPOSSIBLE" })]);
    expect(r.anchoring?.unverifiable).toEqual([]);
    expect(r.head).toBe(good.versionId);

    // After a deactivated version the verifier holds, no later version can exist.
    alice.timeOverride = new Date(T0 + 50 * 600_000).toISOString();
    await alice.deactivate();
    const after = await named(`${versionNumberOf(alice.versionId) + 1}-QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DzA3a1Y`);
    const d = await verify(copy, alice, [sat([anchoring(10), inscribe(after, 30)])]);
    expect(d.anchoring?.ignored).toEqual([expect.objectContaining({ versionId: after.versionId, reason: "invalid-entry", code: "AUTHOR_VERSION_IMPOSSIBLE" })]);
    expect(d.anchoring?.unverifiable).toEqual([]);
  });

  test("C12-189: a malformed did:vh or did:webvh versionId, or one numbered below 1, is impossible: rejected, never blocking", async () => {
    const { alice, copy, anchor, anchoring, ref, sign } = await anchored();
    const good = await updateOriginal(anchor, { versionTime: time(40), name: "Valid, later", author: ref, sign });
    for (const versionId of ["not-a-version", "0-QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DzA3a1Y", "-1-QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DzA3a1Y", "2-not base58!"]) {
      const odd = await updateOriginal(anchor, { versionTime: time(30), name: "Odd version", author: { ...ref, versionId }, sign });
      const r = await verify(copy, alice, [sat([anchoring(10), inscribe(odd, 30), inscribe(good, 40)])]);
      // `0-…` is also older than the anchor's version, which P5.8 rejects first.
      expect(r.anchoring?.ignored, versionId).toEqual([expect.objectContaining({ versionId: odd.versionId, reason: "invalid-entry" })]);
      expect(["AUTHOR_VERSION_IMPOSSIBLE", "AUTHOR_VERSION_REGRESSED"], versionId).toContain(r.anchoring?.ignored[0]?.code);
      expect(r.anchoring?.unverifiable, versionId).toEqual([]);
      expect(r.head, versionId).toBe(good.versionId);
    }
  });

  test("C12-189, C12-184: an entry in the anchoring inscription naming an impossible version is rejected there too, not missing evidence", async () => {
    const { alice, sign, ref, genesis, renamed } = await anchored();
    const anchor = await updateOriginal(renamed, { versionTime: time(10), aliases: [SAT], author: { ...ref, versionId: "1001-QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DzA3a1Y" }, sign });
    const log = [genesis, renamed, anchor];
    const r = await verify(log, alice, [sat([inscribe(log, 10)])]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ versionId: anchor.versionId, reason: "invalid-entry", code: "AUTHOR_VERSION_IMPOSSIBLE" })]);
  });

  test("C12-186: P9.15: an inscription naming a version the reader lacks that fails a check not depending on that version is rejected, not unverifiable, and holds nothing back", async () => {
    const { alice, copy, anchor, anchoring, ref, sign } = await anchored();
    const older = alice.entries.slice();
    await alice.rotate([{ fragment: "orig", signer: KEY }, { fragment: "spare", signer: seeded(24) }]);
    const bad = await appendEntry(anchor, { versionTime: time(30), parameters: {}, state: { ...anchor.state, author: alice.ref("orig"), operation: "migrate", transitions: [] }, sign: alice.signer(KEY, "orig") });
    const good = await updateOriginal(anchor, { versionTime: time(40), name: "Valid, later", author: ref, sign });
    const r = await verifyOriginal({ log: copy, authors: [alice.evidence(older)], now: NOW, bytes: allBytes, bitcoin: [sat([anchoring(10), inscribe(bad, 30), inscribe(good, 40)])] });
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ versionId: bad.versionId, reason: "invalid-entry", code: "STATE_OPERATION" })]);
    expect(r.anchoring?.unverifiable).toEqual([]);
    expect(r.head).toBe(good.versionId);
  });

  test("C12-164: P9.15: a verifier that later verifies and accepts an inscription it reported unverifiable reports the change of head, never silently", async () => {
    const { alice, copy, anchor, anchoring } = await anchored();
    const older = alice.entries.slice();
    await alice.rotate([{ fragment: "orig", signer: KEY }, { fragment: "spare", signer: seeded(24) }]);
    const next = await updateOriginal(anchor, { versionTime: time(30), name: "Names a version the reader lacks", author: alice.ref("orig"), sign: alice.signer(KEY, "orig") });
    const later = inscribe(next, 30);
    const evidence = { log: [...copy, next], now: NOW, bytes: allBytes, bitcoin: [sat([anchoring(10), later])] };
    const first = await verifyOriginal({ ...evidence, authors: [alice.evidence(older)] });
    expect(first.head).toBe(anchor.versionId);
    // The verifier retains what it reported unverifiable with the anchor.
    expect(first.retain.anchor?.unverifiable).toEqual([later.id]);
    expect(first.anchoring?.headChange).toBeNull();

    const second = await verifyOriginal({ ...evidence, authors: [alice.evidence()], retained: first.retain });
    expect(second.head).toBe(next.versionId);
    expect(second.anchoring?.headChange).toEqual({
      previous: anchor.versionId,
      current: next.versionId,
      verified: [expect.objectContaining({ inscription: later.id, versionId: next.versionId })],
      resolved: [later.id],
      unverified: [],
      vanished: [],
    });
    expect(second.notices).toEqual(["head-changed"]);
    expect(second.current, JSON.stringify(second.reasons)).toBe(true);
    expect(second.retain.anchor?.unverifiable).toBeUndefined();

    // Reported once: the next verification with the same evidence is current.
    const third = await verifyOriginal({ ...evidence, authors: [alice.evidence()], retained: second.retain });
    expect(third.anchoring?.headChange).toBeNull();
    expect(third.current, JSON.stringify(third.reasons)).toBe(true);
  });

  test("C12-64: when the verifier has retained a newer version than the evidence it is given, it cannot use the older one: stale, not current", async () => {
    const { alice, copy, anchoring } = await anchored();
    const older = alice.entries.slice();
    alice.timeOverride = new Date(T0 + 50 * 600_000).toISOString();
    const newer = await alice.rotate([{ fragment: "orig", signer: KEY }, { fragment: "spare", signer: seeded(24) }]);
    const r = await verifyOriginal({ log: copy, authors: [alice.evidence(older)], now: NOW, bytes: allBytes, bitcoin: [sat([anchoring(10)])], retained: { authors: { [alice.did]: newer } } });
    expect(r.identityEvidence.freshness).toBe("stale");
    expect(r.current).toBe(false);
    // With the newer version supplied it is used.
    const fresh = await verifyOriginal({ log: copy, authors: [alice.evidence()], now: NOW, bytes: allBytes, bitcoin: [sat([anchoring(10)])], retained: { authors: { [alice.did]: newer } } });
    expect(fresh.validAsOf?.signers[0].versionId).toBe(newer);
    expect(fresh.current, JSON.stringify(fresh.reasons)).toBe(true);
  });
});

describe("C12-144: no grant names the anchoring sat's did:btco, before or after anchoring (P5.15, P9.12)", () => {
  test("a grant made before anchoring to the sat later anchored on refuses the anchoring entry; after anchoring it is refused outright", async () => {
    const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }]);
    const sign = alice.signer(KEY, "orig");
    const ref = alice.ref("orig");
    const editors = [{ did: SAT, name: true, metadata: false, resource: false }];
    const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", resource: photo(B1), author: ref, sign, editors });
    await expect(updateOriginal(genesis, { versionTime: time(10), aliases: [SAT], author: ref, sign })).rejects.toMatchObject({ code: "STATE_EDITORS" });
    const plain = await createOriginal({ versionTime: time(1), name: "Harbor", resource: photo(B1), author: ref, sign });
    const anchor = await updateOriginal(plain, { versionTime: time(10), aliases: [SAT], author: ref, sign });
    await expect(updateOriginal(anchor, { versionTime: time(11), editors, author: ref, sign })).rejects.toMatchObject({ code: "STATE_EDITORS" });
  });
});

describe("the deactivation of an anchored Original (P9.12)", () => {
  test("a deactivation counts only once inscribed on the sat", async () => {
    const { alice, copy, anchor, ref, sign, anchoring } = await anchored();
    const off = await deactivateOriginal(anchor, { versionTime: time(20), author: ref, sign });
    const uninscribed = await verify([...copy, off], alice, [sat([anchoring(10)])]);
    expect(uninscribed.deactivated).toBe(false);
    const inscribed = await verify([...copy, off], alice, [sat([anchoring(10), inscribe(off, 20)])]);
    expect(inscribed.deactivated).toBe(true);
  });
});

describe("the anchoring inscription carries the whole log (P9.17)", () => {
  test("C12-87: an anchored Original verifies from Bitcoin alone, with no copy of the log", async () => {
    const { alice, anchor, ref, sign, anchoring, genesis } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Harbor, from the sat", author: ref, sign });
    const r = await verify(undefined, alice, [sat([anchoring(10), inscribe(next, 20)])]);
    expect(r.original).toBe(genesis.state.id as string);
    expect(r.history).toMatchObject({ status: "valid", entries: 4 });
    expect(r.head).toBe(next.versionId);
    expect(r.state?.name).toBe("Harbor, from the sat");
    expect(r.anchoring).toMatchObject({ status: "anchored", copy: "absent", anchor: { versionId: anchor.versionId } });
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-88: a copy whose history differs from the sat's is ignored; the sat's entries are the log", async () => {
    const { alice, genesis, anchor, ref, sign, anchoring } = await anchored();
    const other = await updateOriginal(genesis, { versionTime: time(2), name: "A rewritten history", author: ref, sign });
    const r = await verify([genesis, other], alice, [sat([anchoring(10)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.state?.name).toBe("Harbor at dawn");
    expect(r.anchoring?.copy).toBe("differs");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-101: an anchoring inscription that does not start at genesis, or whose entries are not one log, is not an anchor", async () => {
    const { alice, genesis, renamed, anchor, copy, ref, sign } = await anchored();
    const sideways = await updateOriginal(genesis, { versionTime: time(3), name: "Sideways", author: ref, sign });
    const cases = [inscribe(anchor, 10), inscribe([renamed, anchor], 11), inscribe([genesis, sideways, anchor], 12)];
    const r = await verify(copy, alice, [sat(cases)]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored.map((i) => i.reason)).toEqual(["does-not-start-at-genesis", "does-not-start-at-genesis", "not-one-log"]);
    expect(r.current).toBe(false);
  });

  test("C12-102: an anchoring inscription whose last entry is not an anchoring entry naming that sat is not an anchor", async () => {
    const { alice, genesis, renamed, anchor, copy, ref, sign } = await anchored();
    const after = await updateOriginal(anchor, { versionTime: time(11), name: "After the anchor", author: ref, sign });
    const r = await verify(copy, alice, [sat([inscribe([genesis, renamed], 10), inscribe([...copy, after], 11)])]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored.map((i) => i.reason)).toEqual(["last-entry-not-anchoring", "last-entry-not-anchoring"]);
    const elsewhere = await verify(copy, alice, [sat([inscribe(copy, 10)], OTHER_SAT)]);
    expect(elsewhere.anchoring?.ignored.map((i) => i.reason)).toEqual(["names-another-sat"]);
  });

  test("C12-86: after the anchor, an inscription carrying more than one entry is rejected, even if each would extend the head", async () => {
    const { alice, anchor, ref, sign, anchoring } = await anchored();
    const one = await updateOriginal(anchor, { versionTime: time(20), name: "One", author: ref, sign });
    const two = await updateOriginal(one, { versionTime: time(21), name: "Two", author: ref, sign });
    const r = await verify(undefined, alice, [sat([anchoring(10), inscribe([one, two], 20)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ reason: "more-than-one-entry" })]);
  });

  test("C12-37: an inscription on the anchoring sat whose metadata is a did:btco DID document is not an Originals inscription, and is ignored (P14.12)", async () => {
    const { alice, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "With a DID document", author: ref, sign });
    const document = encodeCbor({ "@context": ["https://www.w3.org/ns/did/v1"], id: SAT });
    const instead = await verify(undefined, alice, [sat([anchoring(10, { metadata: document })])]);
    expect(instead.anchoring?.status).toBe("not-anchored");
    expect(instead.anchoring?.ignored.map((i) => i.reason)).toEqual(["not-an-originals-inscription"]);
    const later = await verify(undefined, alice, [sat([anchoring(10), inscribe(next, 20, { metadata: document })])]);
    expect(later.head).toBe(anchor.versionId);
    expect(later.anchoring?.ignored.map((i) => i.reason)).toEqual(["not-an-originals-inscription"]);
    expect(later.current, JSON.stringify(later.reasons)).toBe(true);
  });

  test("C12-74: an inscription carrying a compact delta is rejected in the baseline, which defines no compact encoding (P9.14, P9.17)", async () => {
    const { alice, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Delta", author: ref, sign });
    const delta = encodeCbor([{ versionId: next.versionId, patch: [{ op: "replace", path: "/state/asset/name", value: "Delta" }] }]);
    const r = await verify(undefined, alice, [sat([anchoring(10), inscribe(next, 21, { metadata: delta })])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.accepted).toEqual([]);
    // A delta names no resource version, so no body can be the one it names (P9.17).
    expect(r.anchoring?.ignored.map((i) => i.reason)).toEqual(["body-not-the-resource"]);
  });

  test("C12-74: an inscription whose own body the reader did not establish is ignored with a reason, never a failed read (M1; P9.12, P9.14)", async () => {
    const { alice, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Encoded", author: ref, sign });
    const r = await verify(undefined, alice, [sat([
      inscribe(next, 5, { mediaType: "image/png", content: new Uint8Array(), metadata: null, unsupported: "delegated" }),
      anchoring(10),
      inscribe(next, 20, { content: new Uint8Array(), unsupported: "content-encoding" }),
      inscribe(next, 21, { mediaType: "text/plain", content: new Uint8Array(), unsupported: "not-read", metadataPresent: false }),
    ])]);
    expect(r.anchoring?.status).toBe("anchored");
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored.map((i) => i.reason)).toEqual(["not-an-originals-inscription", "unsupported-encoding", "not-an-originals-inscription"]);
  });

  test("C12-89: an Originals inscription the reader did not read is missing evidence, not an ignored one (M1; P9.17)", async () => {
    const { alice, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Unread", author: ref, sign });
    await expect(verify(undefined, alice, [sat([anchoring(10), inscribe(next, 20, { content: new Uint8Array(), unsupported: "not-read" })])]))
      .rejects.toMatchObject({ category: "incomplete-evidence", code: "SAT_READ_INCOMPLETE" });
  });

  test("C12-89: a body not read is no missing evidence when the metadata read shows it is no Originals inscription, or malformed (P14.12, P9.12)", async () => {
    const { alice, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Unread", author: ref, sign });
    const unread = (metadata: Uint8Array) => inscribe([], 20, { mediaType: "image/png", content: new Uint8Array(), unsupported: "not-read", contentLength: 300_000, metadata });
    const r = await verify(undefined, alice, [sat([anchoring(10), unread(new Uint8Array([0xa0])), unread(new Uint8Array([0xff]))])]);
    expect(r.anchoring?.status).toBe("anchored");
    expect(r.anchoring?.ignored.map((i) => i.reason)).toEqual(["not-an-originals-inscription", "undecodable"]);
    // Metadata that is entries still needs its body: missing evidence (P9.17).
    await expect(verify(undefined, alice, [sat([anchoring(10), inscribe(next, 20, { content: new Uint8Array(), unsupported: "not-read", metadata: carrying(next).metadata })])]))
      .rejects.toMatchObject({ code: "SAT_READ_INCOMPLETE" });
  });

  test("C12-90: an unconfirmed anchoring inscription is observed, not an anchor", async () => {
    const { alice, copy, anchoring } = await anchored();
    const r = await verify(copy, alice, [sat([anchoring(10, { confirmations: 0 })])]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored.map((i) => i.reason)).toEqual(["unconfirmed"]);
    expect(r.current).toBe(false);
  });
});

/**
 * An anchored Original of two entries whose anchoring inscription, metadata and
 * body together, is `target` bytes: the resource takes up the room (P9.17,
 * P14.12; originals-spec #53).
 */
async function sizedTo(target: number) {
  const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }]);
  const sign = alice.signer(KEY, "orig");
  const ref = alice.ref("orig");
  let length = 340_000;
  // Proof values vary in length by a byte, so when a size repeats, lengthen the name instead.
  let name = "Large";
  const tried = new Set<string>();
  for (let attempt = 0; attempt < 100; attempt++) {
    if (tried.has(`${name}:${length}`)) name += "!";
    tried.add(`${name}:${length}`);
    const genesis = await createOriginal({ versionTime: time(1), name, resource: photo("x".repeat(length)), author: ref, sign });
    const anchor = await updateOriginal(genesis, { versionTime: time(9), aliases: [SAT], author: ref, sign });
    const entries = [genesis, anchor];
    const size = encodeCbor(entries as unknown as JsonValue).length + length;
    if (size === target) return { alice, entries };
    length += target - size;
  }
  throw new Error(`could not size an inscription to ${target} bytes`);
}

describe("the inscription limit covers metadata and body together (P9.17, P14.12; decided, D6; originals-spec #50, #53)", () => {
  test("C12-111: an anchoring inscription whose metadata and body are exactly 350,000 bytes together is accepted", async () => {
    expect(ORIGINALS_INSCRIPTION_MAX_BYTES).toBe(350_000);
    const { alice, entries } = await sizedTo(350_000);
    const i = inscribe(entries, 10);
    expect(i.metadata!.length + i.content.length).toBe(350_000);
    const r = await verify(undefined, alice, [sat([i])], { bytes: {} });
    expect(r.anchoring?.status, JSON.stringify(r.anchoring?.ignored)).toBe("anchored");
    expect(r.head).toBe(entries[entries.length - 1].versionId);
    expect(r.resources.versions.map((v) => [v.bytes, v.onBitcoin])).toEqual([["verified", true]]);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-112 (verifier): one byte more, metadata and body together, is rejected", async () => {
    const { alice, entries } = await sizedTo(350_001);
    const i = inscribe(entries, 10);
    expect(i.metadata!.length + i.content.length).toBe(350_001);
    const r = await verify(undefined, alice, [sat([i])]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored.map((x) => x.reason)).toEqual(["too-large"]);
  });
});

describe("placement rests on the index (P9.10, P9.11)", () => {
  test("C12-103: an inscription the index reports on another sat is not on the anchoring sat, whatever the read is labelled", async () => {
    const { alice, copy, anchoring } = await anchored();
    const r = await verify(copy, alice, [sat([anchoring(10, { sat: "7000000000" })])]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ sat: SAT, reason: "not-on-sat" })]);
    expect(r.ownership).toBeNull();
  });

  test("C12-104: inscriptions read from another network are not on the anchoring sat", async () => {
    const { alice, copy, anchoring } = await anchored();
    const r = await verify(copy, alice, [sat([anchoring(10, { network: "testnet" })])]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored.map((i) => i.reason)).toEqual(["other-network"]);
  });

  test("C12-109, L3: a disputed inscription neither index reports as an Originals inscription does not hold back later ones", async () => {
    const { alice, copy, anchor, anchoring } = await anchored();
    const junk = inscribe(copy[0], 5, { mediaType: "text/plain", metadata: null });
    const a = anchoring(10);
    // Only the first index lists the junk; both place the anchoring inscription.
    const r = await verify(copy, alice, [sat([junk, a]), sat([a], SAT, undefined, "ord-b")]);
    expect(r.anchoring?.status).toBe("anchored");
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.disputed).toEqual([]);
    expect(r.anchoring?.ignored).toEqual([{ sat: SAT, inscription: junk.id, reason: "placement-disputed" }]);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    // A disputed Originals inscription still holds back everything after it (P9.10).
    const entry = inscribe(copy[0], 5);
    const blocked = await verify(copy, alice, [sat([entry, a]), sat([a], SAT, undefined, "ord-b")]);
    expect(blocked.anchoring?.status).toBe("unverified");
    expect(blocked.anchoring?.disputed).toEqual([entry.id]);
    expect(blocked.anchoring?.ignored.map((i) => i.reason)).toEqual(["placement-disputed", "after-disputed-placement"]);
    // So does one index's Originals report of it, whatever the other says it is.
    const mixed = await verify(copy, alice, [sat([entry, a]), sat([{ ...entry, mediaType: "text/plain", metadata: null }, a], SAT, undefined, "ord-b")]);
    expect(mixed.anchoring?.status).toBe("unverified");
  });

  test("L3: an unverified anchoring reports no head from the local copy past the anchor's parent", async () => {
    const { alice, copy, renamed, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Local only", author: ref, sign });
    const a = anchoring(10);
    const r = await verify([...copy, next], alice, [sat([a]), sat([{ ...a, sat: "7000000000" }], SAT, undefined, "ord-b")]);
    expect(r.anchoring?.status).toBe("unverified");
    expect(r.head).toBe(renamed.versionId);
    expect(r.current).toBe(false);
    expect(r.reasons).toContain("bitcoin-evidence-missing");
  });

  test("C12-109: two indexes that disagree on placement are not accepted; missing evidence is reported until they agree", async () => {
    const { alice, copy, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Disputed", author: ref, sign });
    const a = anchoring(10);
    const n = inscribe(next, 20);
    // The second index places the anchoring inscription on another sat.
    const disputedAnchor = await verify(copy, alice, [sat([a, n]), sat([{ ...a, sat: "7000000000" }, n], SAT, undefined, "ord-b")]);
    expect(disputedAnchor.anchoring?.status).toBe("unverified");
    expect(disputedAnchor.anchoring?.disputed).toEqual([a.id]);
    expect(disputedAnchor.reasons).toContain("bitcoin-placement-disputed");
    expect(disputedAnchor.ownership).toBeNull();
    expect(disputedAnchor.current).toBe(false);
    // The second index does not report the later inscription at all.
    const disputedLater = await verify(copy, alice, [sat([a, n]), sat([a], SAT, undefined, "ord-b")]);
    expect(disputedLater.anchoring?.status).toBe("anchored");
    expect(disputedLater.head).toBe(anchor.versionId);
    expect(disputedLater.anchoring?.disputed).toEqual([n.id]);
    expect(disputedLater.current).toBe(false);
    // Once they agree, both are reported (P9.11).
    const agreed = await verify(copy, alice, [sat([a, n]), sat([a, n], SAT, undefined, "ord-b")]);
    expect(agreed.head).toBe(next.versionId);
    expect(agreed.anchoring?.indexes).toEqual(["ord-a", "ord-b"]);
    expect(agreed.ownership?.indexes).toEqual(["ord-a", "ord-b"]);
    expect(agreed.current, JSON.stringify(agreed.reasons)).toBe(true);
  });

  test("two indexes that disagree on the sat's holder report no owner", async () => {
    const { alice, copy, anchoring } = await anchored();
    const a = anchoring(10);
    const r = await verify(copy, alice, [sat([a]), sat([a], SAT, { output: "dd".repeat(32) + ":0", confirmations: 1 }, "ord-b")]);
    expect(r.anchoring?.status).toBe("anchored");
    expect(r.ownership).toBeNull();
    expect(r.reasons).toContain("ownership-indexes-disagree");
  });

  test("C12-108: did:btco aliases follow the strict grammar", () => {
    for (const ok of ["did:btco:0", "did:btco:1", "did:btco:sig:1", "did:btco:test:1", "did:btco:reg:5000000000", "did:btco:2099999997689999"]) {
      expect(parseBtcoAlias(ok).did).toBe(ok);
    }
    expect(parseBtcoAlias("did:btco:sig:42")).toEqual({ did: "did:btco:sig:42", network: "signet", sat: "42" });
    for (const bad of [
      "did:btco:foo:1", "did:btco:main:1", "did:btco:REG:1", "did:btco:+1", "did:btco:-1", "did:btco:01", "did:btco:reg:00",
      "did:btco:2099999997690000", "did:btco:99999999999999999", "did:btco:1.0", "did:btco:1e3", "did:btco:", "did:btco:reg:", "did:btco:1 ", " did:btco:1", "did:btco:0x10",
    ]) {
      expect(() => parseBtcoAlias(bad), bad).toThrow();
    }
  });
});

describe("aliases after anchoring (P9.10, D7)", () => {
  const MOVED = WEB.replace(":example.com", ":moved.example");
  const OTHER_WEB = "did:webvh:QmZbbDDaBzk5mdtDNAJnxAZ1BhGBbu3ZYkZmF4BkbbMiTT:example.org";

  test("C12-106 and C12-139 (anchored): an entry after anchoring may not add or replace a did:webvh alias, even within its SCID", async () => {
    const { ref, sign, anchor } = await anchored({ aliases: [WEB] });
    for (const aliases of [[OTHER_WEB, SAT], [MOVED, SAT]]) {
      await expect(updateOriginal(anchor, { versionTime: time(11), aliases, author: ref, sign })).rejects.toMatchObject({ code: "STATE_ANCHOR" });
    }
    const kept = await updateOriginal(anchor, { versionTime: time(11), name: "Kept", author: ref, sign });
    expect(kept.state.asset).toMatchObject({ aliases: [WEB, SAT] });
  });

  test("C12-110: a did:webvh alias the anchoring state lists may be removed, but never added again", async () => {
    const { alice, ref, sign, anchor, anchoring } = await anchored({ aliases: [WEB] });
    const removed = await updateOriginal(anchor, { versionTime: time(20), aliases: [SAT], author: ref, sign });
    await expect(updateOriginal(removed, { versionTime: time(21), aliases: [WEB, SAT], author: ref, sign })).rejects.toMatchObject({ code: "STATE_ANCHOR" });
    const r = await verify(undefined, alice, [sat([anchoring(10), inscribe(removed, 20)])]);
    expect(r.head).toBe(removed.versionId);
    expect(r.state?.aliases).toEqual([SAT]);
  });

  test("C12-35 still holds: an Original anchored without a did:webvh alias never gains one", async () => {
    const { ref, sign, anchor } = await anchored();
    await expect(updateOriginal(anchor, { versionTime: time(11), aliases: [WEB, SAT], author: ref, sign })).rejects.toMatchObject({ code: "STATE_ANCHOR" });
  });
});

describe("entries before the anchor (P9.15)", () => {
  test("C12-107: an entry before the anchoring entry, signed by a key removed before the inscription, is accepted against the version it names, with claimed ordering", async () => {
    const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }]);
    const old = alice.signer(KEY, "orig");
    const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", resource: photo(B1), author: alice.ref("orig"), sign: old });
    const renamed = await updateOriginal(genesis, { versionTime: time(2), name: "Harbor at dawn", author: alice.ref("orig"), sign: old });
    alice.timeOverride = new Date(T0 + 5 * 600_000).toISOString();
    const NEW = seeded(31);
    await alice.rotate([{ fragment: "orig2", signer: NEW }]);
    const anchor = await updateOriginal(renamed, { versionTime: time(10), aliases: [SAT], author: alice.ref("orig2"), sign: alice.signer(NEW, "orig2") });
    const r = await verify(undefined, alice, [sat([inscribe([genesis, renamed, anchor], 10)])]);
    expect(r.anchoring?.status).toBe("anchored");
    expect(r.head).toBe(anchor.versionId);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    const before = await verify(undefined, alice, [sat([inscribe([genesis, renamed, anchor], 10)])], { checkpoint: renamed.versionId });
    expect(before.ordering).toBe("claimed");
    // The anchoring entry itself must hold at its inscription time: signed with the removed key, it is not an anchor.
    const stale = await updateOriginal(renamed, { versionTime: time(10), aliases: [SAT], author: alice.ref("orig", alice.entries[0].versionId), sign: old });
    const refused = await verify(undefined, alice, [sat([inscribe([genesis, renamed, stale], 10)])]);
    expect(refused.anchoring?.ignored.map((i) => i.reason)).toEqual(["author-key-not-valid-at-inscription-time"]);
  });
});

describe("a change of anchor is reported (P9.16)", () => {
  test("C12-99: learning of an earlier anchoring entry reports it as the anchor, the previous one as conflicting, and the owner change", async () => {
    const { alice, genesis, renamed, ref, sign, anchoring, anchor } = await anchored();
    const other = await updateOriginal(renamed, { versionTime: time(10), aliases: [OTHER_SAT], author: ref, sign });
    const mine = sat([anchoring(12)]);
    const first = await verify(undefined, alice, [mine]);
    expect(first.current, JSON.stringify(first.reasons)).toBe(true);
    expect(first.retain.anchor).toEqual({ inscription: first.anchoring!.anchor!.inscription, sat: SAT, owner: "aa".repeat(32) + ":0" });

    const theirs = sat([inscribe([genesis, renamed, other], 11)], OTHER_SAT, { output: "ee".repeat(32) + ":0", confirmations: 4 });
    const second = await verify(undefined, alice, [mine, theirs], { retained: { anchor: first.retain.anchor! } });
    expect(second.anchoring?.anchor).toMatchObject({ versionId: other.versionId, sat: OTHER_SAT });
    expect(second.anchoring?.conflicting).toEqual([expect.objectContaining({ versionId: anchor.versionId, sat: SAT })]);
    expect(second.anchoring?.change).toEqual({
      previous: first.retain.anchor,
      current: { inscription: second.anchoring!.anchor!.inscription, sat: OTHER_SAT, owner: "ee".repeat(32) + ":0" },
    });
    expect(second.reasons).toContain("anchor-changed");
    expect(second.current).toBe(false);
    expect(second.retain.anchor?.sat).toBe(OTHER_SAT);

    const third = await verify(undefined, alice, [mine, theirs], { retained: { anchor: second.retain.anchor! } });
    expect(third.anchoring?.change).toBeNull();
    expect(third.current, JSON.stringify(third.reasons)).toBe(true);
  });
});

describe("resource bytes are not needed for the log to verify (P7.3, P7.4, P9.18)", () => {
  test("C12-97: an anchored Original whose uninscribed versions are unavailable verifies, with those versions reported unavailable", async () => {
    const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }]);
    const sign = alice.signer(KEY, "orig");
    const ref = alice.ref("orig");
    const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", resource: photo(B0), author: ref, sign });
    const cropped = await updateOriginal(genesis, { versionTime: time(2), resource: photo(B1), author: ref, sign });
    const anchor = await updateOriginal(cropped, { versionTime: time(10), aliases: [SAT], author: ref, sign });
    const evidence = [sat([inscribe([genesis, cropped, anchor], 10)])];
    const r = await verify(undefined, alice, evidence, { bytes: {} });
    expect(r.history.status).toBe("valid");
    expect(r.head).toBe(anchor.versionId);
    expect(r.resources.status).toBe("partial");
    // Version 1 was never inscribed; version 2 is the anchoring inscription's body (P9.17, P9.18).
    expect(r.resources.missing.map((v) => [v.version, v.digest])).toEqual([[1, resourceDigest(bytes(B0))]]);
    expect(r.resources.versions.map((v) => [v.version, v.bytes, v.onBitcoin])).toEqual([[1, "missing", false], [2, "verified", true]]);
    expect(r.reasons).not.toContain("resources-partial");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    // Bytes that are supplied are still checked (P7.4).
    const wrong = await verify(undefined, alice, evidence, { bytes: { [resourceDigest(bytes(B0))]: bytes("tampered") } });
    expect(wrong.resources.status).toBe("digest-failure");
    expect(wrong.current).toBe(false);
  });
});

describe("the sat's holder cannot make an anchored Original incomplete (P9.12, P9.15)", () => {
  const HOLDER = seeded(77);

  test("C12-161: a hash-chained later inscription naming an author version that does not exist is reported unverifiable; the accepted head stays complete and current", async () => {
    const { alice, copy, anchor, anchoring } = await anchored();
    // The holder has no author key: it names a version the author DID never had and signs with its own key.
    const fake = { ...alice.ref("orig"), versionId: "9-QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DzA3a1Y" };
    const junk = await updateOriginal(anchor, { versionTime: time(30), name: "The holder's junk", author: fake, sign: alice.signer(HOLDER, "orig") });
    const later = inscribe(junk, 30);
    const r = await verify(copy, alice, [sat([anchoring(10), later])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ inscription: later.id, reason: "later-inscription-unverifiable" })]);
    expect(r.anchoring?.unverifiable).toEqual([{ sat: SAT, inscription: later.id, versionId: junk.versionId, signer: alice.did, signerVersionId: fake.versionId }]);
    expect(r.identityEvidence.status).toBe("complete");
    expect(r.validAsOf?.checkpoint).toBe(anchor.versionId);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-162: a later inscription naming a version number the verifier holds under another id is invalid, not unverifiable", async () => {
    const { alice, copy, anchor, anchoring } = await anchored();
    const fake = { ...alice.ref("orig"), versionId: "1-QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DzA3a1Y" };
    const junk = await updateOriginal(anchor, { versionTime: time(30), name: "Names version 1 under another id", author: fake, sign: alice.signer(HOLDER, "orig") });
    const r = await verify(copy, alice, [sat([anchoring(10), inscribe(junk, 30)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ reason: "invalid-entry", code: "AUTHOR_VERSION_NOT_IN_HISTORY", versionId: junk.versionId })]);
    expect(r.anchoring?.unverifiable).toEqual([]);
    expect(r.identityEvidence.status).toBe("complete");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("a later inscription whose operation is migrate is an invalid entry, not an unsupported profile (P14.4)", async () => {
    const { alice, copy, anchor, sign, anchoring } = await anchored();
    const migrate = await appendEntry(anchor, { versionTime: time(30), parameters: {}, state: { ...anchor.state, operation: "migrate", transitions: [] }, sign });
    const r = await verify(copy, alice, [sat([anchoring(10), inscribe(migrate, 30)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ versionId: migrate.versionId, reason: "invalid-entry", code: "STATE_OPERATION" })]);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("a later inscription naming another author DID is invalid, and changes nothing", async () => {
    const { alice, copy, anchor, anchoring } = await anchored();
    const stranger = { did: "did:vh:QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DzA3a1Y", verificationMethod: "did:vh:QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DzA3a1Y#k", versionId: "1-QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DzA3a1Y" };
    const junk = await updateOriginal(anchor, { versionTime: time(30), name: "Signed by a stranger", author: stranger, sign: alice.signer(HOLDER, "orig") });
    const later = inscribe(junk, 30);
    const r = await verify(copy, alice, [sat([anchoring(10), later])]);
    expect(r.head).toBe(anchor.versionId);
    // The author DID is fixed at genesis (P5.8): this is invalid whatever the verifier holds.
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ inscription: later.id, reason: "invalid-entry" })]);
    expect(r.anchoring?.unverifiable).toEqual([]);
    expect(r.identityEvidence.status).toBe("complete");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });
});

describe("C12-150 on Bitcoin: \"Entry whose JCS form is 65,536 / 65,537 UTF-8 bytes, in `did.jsonl`, an inscription, a publication or any carrier\" (P14.13)", () => {
  /** An anchored log whose genesis line, as stored, is exactly 65,536 bytes and whose JCS form is longer. */
  async function storedAtLimit() {
    const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }]);
    const sign = alice.signer(KEY, "orig");
    const ref = alice.ref("orig");
    const nums = Array.from({ length: 200 }, () => 1.5e-6);
    let pad = 0;
    for (let i = 0; i < 40; i++) {
      const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", metadata: { nums, pad: "a".repeat(pad) }, resource: photo(B1), author: ref, sign });
      const line = serializeLog([genesis]).slice(0, -1).replaceAll("0.0000015", "1.5e-6");
      const size = bytes(line).length;
      if (size !== 65_536) {
        pad += 65_536 - size;
        continue;
      }
      const anchor = await updateOriginal(genesis, { versionTime: time(10), metadata: null, aliases: [SAT], author: ref, sign });
      return { alice, genesis, anchor, text: `${line}\n${serializeLog([anchor])}` };
    }
    throw new Error("no entry of 65,536 bytes");
  }

  test("an entry carried in inscription metadata is measured as its JCS form in UTF-8: 65,536 bytes accepted, 65,537 rejected (P14.12, P14.13)", async () => {
    const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }]);
    const sign = alice.signer(KEY, "orig");
    const ref = alice.ref("orig");
    const atSize = async (target: number) => {
      let pad = 65_000;
      for (let i = 0; i < 40; i++) {
        const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", metadata: { pad: "a".repeat(pad) }, resource: photo(B1), author: ref, sign });
        const size = bytes(canonicalize(genesis as unknown as JsonValue)).length;
        if (size === target) return [genesis, await updateOriginal(genesis, { versionTime: time(10), metadata: null, aliases: [SAT], author: ref, sign })];
        pad += target - size;
      }
      throw new Error(`no entry of ${target} bytes`);
    };
    const fits = await atSize(65_536);
    const ok = await verify(undefined, alice, [sat([inscribe(fits, 10)])]);
    expect(ok.anchoring?.status, JSON.stringify(ok.anchoring?.ignored)).toBe("anchored");
    expect(ok.current, JSON.stringify(ok.reasons)).toBe(true);
    const over = await atSize(65_537);
    const r = await verify(undefined, alice, [sat([inscribe(over, 10)])]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ reason: "invalid-entry", code: "ENTRY_TOO_LARGE" })]);
  });

  test("an anchored copy given as text is measured as its JCS form too, not as stored (P14.13 at a3ffdc1)", async () => {
    const { alice, text } = await storedAtLimit();
    const r = await verifyOriginal({ log: text, authors: [alice.evidence()], now: NOW, bytes: allBytes });
    expect(r.history.failure).toMatchObject({ index: 0, category: "limit-exceeded", code: "ENTRY_TOO_LARGE" });
    expect(r.head).toBeNull();
  });
});

describe("one confirmation on every network (P9.5, D6; originals-spec #50, merged, owner decision)", () => {
  // Mainnet, signet, testnet and regtest sats: one rule, no per-network policy.
  for (const did of ["did:btco:5000000000", "did:btco:sig:5000000000", "did:btco:test:5000000000", "did:btco:reg:5000000000"]) {
    test(`C12-90: on ${did} an anchoring inscription counts at 1 confirmation and not at 0`, async () => {
      const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }]);
      const sign = alice.signer(KEY, "orig");
      const ref = alice.ref("orig");
      const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", resource: photo(B1), author: ref, sign });
      const anchor = await updateOriginal(genesis, { versionTime: time(10), aliases: [did], author: ref, sign });
      const one = await verify([genesis, anchor], alice, [sat([inscribe([genesis, anchor], 10, { confirmations: 1 })], did)]);
      expect(one.anchoring, JSON.stringify(one.anchoring?.ignored)).toMatchObject({ sat: did, status: "anchored", anchor: { versionId: anchor.versionId, confirmations: 1 } });
      expect(one.ordering).toBe("anchored");
      const none = await verify([genesis, anchor], alice, [sat([inscribe([genesis, anchor], 10, { confirmations: 0 })], did)]);
      expect(none.anchoring?.status).toBe("not-anchored");
      expect(none.anchoring?.ignored.map((i) => i.reason)).toEqual(["unconfirmed"]);
      expect(none.current).toBe(false);
    });
  }
});

/**
 * Encode a JSON value as CBOR with every map's keys in reverse order and every
 * integer and length in its 8-byte form: well-formed, not shortest (C12-197).
 */
function looseCbor(value: JsonValue): Uint8Array {
  const out: number[] = [];
  const head = (major: number, n: number) => {
    out.push((major << 5) | 27);
    const big = BigInt(n);
    for (let k = 7; k >= 0; k--) out.push(Number((big >> BigInt(k * 8)) & 0xffn));
  };
  const write = (v: JsonValue) => {
    if (v === null) out.push(0xf6);
    else if (v === true) out.push(0xf5);
    else if (v === false) out.push(0xf4);
    else if (typeof v === "number") v >= 0 ? head(0, v) : head(1, -1 - v);
    else if (typeof v === "string") {
      const b = new TextEncoder().encode(v);
      head(3, b.length);
      out.push(...b);
    } else if (Array.isArray(v)) {
      head(4, v.length);
      v.forEach(write);
    } else {
      const entries = Object.entries(v).reverse();
      head(5, entries.length);
      for (const [k, x] of entries) {
        write(k);
        write(x);
      }
    }
  };
  write(value);
  return new Uint8Array(out);
}

describe("an inscription's body is the resource version its last entry names (P9.17, P14.12; originals-spec #53)", () => {
  const B2 = "harbor at dusk";

  test("C12-190: an anchored Original read from Bitcoin alone takes the current version's bytes from the newest accepted inscription's body", async () => {
    const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }]);
    const sign = alice.signer(KEY, "orig");
    const ref = alice.ref("orig");
    const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", resource: photo(B0), author: ref, sign });
    const cropped = await updateOriginal(genesis, { versionTime: time(2), resource: photo(B1), author: ref, sign });
    const anchor = await updateOriginal(cropped, { versionTime: time(10), aliases: [SAT], author: ref, sign });
    const dusk = await updateOriginal(anchor, { versionTime: time(20), resource: photo(B2), author: ref, sign });
    const later = inscribe(dusk, 20);
    expect(later.content).toEqual(bytes(B2));
    expect(later.mediaType).toBe("image/jpeg");
    // No log and no resource bytes: only Bitcoin (P9.18).
    const r = await verifyOriginal({ authors: [alice.evidence()], now: NOW, bitcoin: [sat([inscribe([genesis, cropped, anchor], 10), later])] });
    expect(r.head).toBe(dusk.versionId);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    expect(r.resources.versions.map((v) => [v.version, v.digest, v.bytes, v.onBitcoin])).toEqual([
      [1, resourceDigest(bytes(B0)), "missing", false],
      [2, resourceDigest(bytes(B1)), "verified", true],
      [3, resourceDigest(bytes(B2)), "verified", true],
    ]);
    expect(r.state?.resource.digest).toBe(resourceDigest(bytes(B2)));
    // An inscription Bitcoin does not accept supplies no bytes: an unconfirmed one is only observed.
    const pending = await verifyOriginal({ authors: [alice.evidence()], now: NOW, bitcoin: [sat([inscribe([genesis, cropped, anchor], 10), inscribe(dusk, 20, { confirmations: 0 })])] });
    expect(pending.head).toBe(anchor.versionId);
    expect(pending.resources.versions.map((v) => v.onBitcoin)).toEqual([false, true]);
  });

  test("C12-191: an inscription whose body's digest or size differs from its last entry's descriptor is rejected, anchoring or later", async () => {
    const { alice, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), resource: photo(B2), author: ref, sign });
    for (const content of [bytes("tampered"), bytes(`${B1}!`), bytes(B1).slice(1)]) {
      const first = await verify(undefined, alice, [sat([anchoring(10, { content })])]);
      expect(first.anchoring?.status).toBe("not-anchored");
      expect(first.anchoring?.ignored.map((i) => i.reason)).toEqual(["body-not-the-resource"]);
    }
    // After the anchor: the previous version's bytes are not the new version.
    const later = await verify(undefined, alice, [sat([anchoring(10), inscribe(next, 20, { content: bytes(B1) })])]);
    expect(later.head).toBe(anchor.versionId);
    expect(later.anchoring?.ignored).toEqual([expect.objectContaining({ reason: "body-not-the-resource", versionId: next.versionId })]);
  });

  test("C12-192: an inscription whose content type differs from the resource's mediaType, or whose body has a content encoding, is rejected", async () => {
    const { alice, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Renamed", author: ref, sign });
    for (const mediaType of ["image/png", "image/jpeg; charset=binary", "IMAGE/JPEG", "application/vnd.originals.vh+jsonl"]) {
      const r = await verify(undefined, alice, [sat([anchoring(10, { mediaType })])]);
      expect(r.anchoring?.status, mediaType).toBe("not-anchored");
      expect(r.anchoring?.ignored.map((i) => i.reason), mediaType).toEqual(["content-type-mismatch"]);
    }
    const r = await verify(undefined, alice, [sat([
      anchoring(10),
      inscribe(next, 20, { content: new Uint8Array(), unsupported: "content-encoding" }),
      inscribe(next, 21, { content: new Uint8Array(), unsupported: "delegated" }),
    ])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored.map((i) => i.reason)).toEqual(["unsupported-encoding", "unsupported-encoding"]);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-194: an inscription after the anchor whose entry changes only the name or metadata carries the unchanged current version again", async () => {
    const { alice, anchor, ref, sign, anchoring } = await anchored();
    const renamed = await updateOriginal(anchor, { versionTime: time(20), name: "Harbor, renamed", author: ref, sign });
    const captioned = await updateOriginal(renamed, { versionTime: time(30), metadata: { caption: "Morning" }, author: ref, sign });
    const a = inscribe(renamed, 20);
    const b = inscribe(captioned, 30);
    expect(a.content).toEqual(bytes(B1));
    expect(b.content).toEqual(bytes(B1));
    const r = await verifyOriginal({ authors: [alice.evidence()], now: NOW, bitcoin: [sat([anchoring(10), a, b])] });
    expect(r.head).toBe(captioned.versionId);
    expect(r.anchoring?.accepted.map((x) => x.versionId)).toEqual([renamed.versionId, captioned.versionId]);
    // Still one version, on Bitcoin (P4.4).
    expect(r.resources.versions.map((v) => [v.version, v.bytes, v.onBitcoin])).toEqual([[1, "verified", true]]);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    // Without the version again, the inscription is not the Original's (P9.17).
    const bare = await verify(undefined, alice, [sat([anchoring(10), inscribe(renamed, 20, { content: new Uint8Array() })])]);
    expect(bare.head).toBe(anchor.versionId);
    expect(bare.anchoring?.ignored.map((i) => i.reason)).toEqual(["body-not-the-resource"]);
  });

  test("C12-195, C12-199: inscription metadata holding a tag, byte string, indefinite-length item, non-text or duplicate key, an integer beyond 2^53 - 1, or a NaN, infinite, negative-zero or out-of-bound float is rejected", async () => {
    const { alice, copy, anchoring } = await anchored();
    const meta = encodeCbor(copy as unknown as JsonValue);
    // Each bad item stands in for the anchoring entry's `versionTime` value, so the metadata would otherwise decode to entries.
    const key = encodeCbor("versionTime");
    const at = (item: number[]) => {
      // The last `versionTime` key is the anchoring entry's; its value is a short text string.
      for (let i = meta.length - key.length; i >= 0; i--) {
        if (!key.every((b, k) => meta[i + k] === b)) continue;
        const start = i + key.length;
        const head = meta[start];
        const skip = head === 0x78 ? 2 + meta[start + 1] : 1 + (head & 0x1f);
        return new Uint8Array([...meta.slice(0, start), ...item, ...meta.slice(start + skip)]);
      }
      throw new Error("no versionTime");
    };
    const bad: Record<string, number[]> = {
      tag: [0xc0, ...encodeCbor("2026-10-18T13:29:00.000Z")],
      "byte string": [0x41, 0x00],
      NaN: [0xf9, 0x7e, 0x00],
      Infinity: [0xf9, 0x7c, 0x00],
      "negative zero": [0xf9, 0x80, 0x00],
      "float 2^53": [0xfa, 0x5a, 0x00, 0x00, 0x00],
      "indefinite-length": [0x7f, 0x61, 0x61, 0xff],
      "non-text key": [0xa1, 0x01, 0x02],
      "duplicate key": [0xa2, 0x61, 0x61, 0x01, 0x61, 0x61, 0x02],
      "2^53": [0x1b, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      "-2^53": [0x3b, 0x00, 0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
      // Not well-formed: a text string whose bytes are not UTF-8. The holder cannot make every read throw (P9.12).
      "invalid UTF-8": [0x62, 0xff, 0xfe],
    };
    for (const [what, item] of Object.entries(bad)) {
      const r = await verify(undefined, alice, [sat([anchoring(10, { metadata: at(item) })])]);
      expect(r.anchoring?.status, what).toBe("not-anchored");
      expect(r.anchoring?.ignored.map((i) => i.reason), what).toEqual(["undecodable"]);
    }
    // The same bytes on their own, and disputed between indexes, are ignored too, never a thrown error.
    const alone = await verify(undefined, alice, [sat([anchoring(10), inscribe([], 20, { metadata: new Uint8Array([0x62, 0xff, 0xfe]) })])]);
    expect(alone.anchoring?.status).toBe("anchored");
    expect(alone.anchoring?.ignored.map((i) => i.reason)).toEqual(["undecodable"]);
    const disputedBad = inscribe([], 20, { metadata: new Uint8Array([0x62, 0xff, 0xfe]) });
    const disputed = await verify(undefined, alice, [sat([anchoring(10), disputedBad]), sat([anchoring(10), { ...disputedBad, sat: "1" }], SAT, undefined, "ord-b")]);
    expect(disputed.history.status).not.toBe("invalid");
    // The control: a well-formed text there decodes, and the entry then fails its own checks.
    const control = await verify(undefined, alice, [sat([anchoring(10, { metadata: at([...encodeCbor("x")]) })])]);
    expect(control.anchoring?.ignored.map((i) => i.reason)).not.toContain("undecodable");
  });

  test("C12-198: an entry whose metadata holds non-integer numbers is inscribed as floats of any width and verifies over its JCS form (P14.3, P14.12)", async () => {
    const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }]);
    const sign = alice.signer(KEY, "orig");
    const ref = alice.ref("orig");
    const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", metadata: { rating: 4.5, place: [51.5072, -0.1276], tiny: 1.5e-6 }, resource: photo(B1), author: ref, sign });
    const anchor = await updateOriginal(genesis, { versionTime: time(10), aliases: [SAT], author: ref, sign });
    const narrow = carrying([genesis, anchor]);
    // 4.5 as ord writes it (a half float), and the same number widened to a double.
    const half = [0xf9, 0x44, 0x80];
    const at = narrow.metadata!.findIndex((_, k) => half.every((b, j) => narrow.metadata![k + j] === b));
    expect(at).toBeGreaterThan(0);
    const wide = new Uint8Array([...narrow.metadata!.slice(0, at), 0xfb, 0x40, 0x12, 0, 0, 0, 0, 0, 0, ...narrow.metadata!.slice(at + 3)]);
    for (const metadata of [narrow.metadata!, wide]) {
      const r = await verify(undefined, alice, [sat([inscribe([], 10, { ...narrow, metadata })])]);
      expect(r.anchoring?.status, JSON.stringify(r.anchoring?.ignored)).toBe("anchored");
      expect(r.head).toBe(anchor.versionId);
      expect(r.current).toBe(true);
      expect(r.state?.metadata).toEqual({ rating: 4.5, place: [51.5072, -0.1276], tiny: 1.5e-6 });
    }
  });

  test("C12-197: an entry carried in metadata is checked over its JCS form; key order and integer encoding in the CBOR do not matter", async () => {
    const { alice, copy, anchor, anchoring } = await anchored();
    const loose = looseCbor(copy as unknown as JsonValue);
    expect(loose).not.toEqual(encodeCbor(copy as unknown as JsonValue));
    const r = await verify(undefined, alice, [sat([anchoring(10, { metadata: loose })])]);
    expect(r.anchoring?.status, JSON.stringify(r.anchoring?.ignored)).toBe("anchored");
    expect(r.head).toBe(anchor.versionId);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });
});
