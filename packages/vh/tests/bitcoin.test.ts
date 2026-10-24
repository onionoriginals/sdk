/**
 * Anchored Originals (plan 012; plan 011 PR 9a). Inscriptions on the anchoring
 * sat, as an adapter reports them, decide the log (P9.10, P9.12-P9.17): the
 * anchoring inscription carries the whole log from genesis through the
 * anchoring entry, each later inscription one entry, and each is checked
 * against the author DID at its inscription time (P9.15). Tests cite their
 * section 12 rows by registry id (specs/originals-conformance.json).
 */
import { describe, expect, test } from "bun:test";
import { appendEntry, serializeLog, signWith, type LogEntry } from "../src/log/index.js";
import {
  ORIGINALS_INSCRIPTION_MAX_BYTES,
  ORIGINALS_INSCRIPTION_TYPE,
  createOriginal,
  deactivateOriginal,
  parseBtcoAlias,
  resourceDigest,
  updateOriginal,
  verifyOriginal,
  type OriginalsReport,
  type SatEvidence,
  type SatInscription,
} from "../src/originals/index.js";
import { VhAuthor, bytes, photo, seeded } from "./helpers/originals.js";

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
/** An inscription carrying these entries as JSON Lines, as the adapter reports it. */
function inscribe(entries: LogEntry | LogEntry[], height: number, extra: Partial<SatInscription> = {}): Inscribed {
  return {
    id: `${(counter++).toString(16).padStart(64, "0")}i0`,
    height,
    transactionIndex: 1,
    inscriptionIndex: 0,
    confirmations: 120 - height,
    inscriptionTime: T0 + height * 600_000,
    mediaType: ORIGINALS_INSCRIPTION_TYPE,
    content: bytes(serializeLog(Array.isArray(entries) ? entries : [entries])),
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
  const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", resources: [photo(B1)], author: ref, sign });
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
  test("C12-ANCHORWRONG: the entry is rejected, so the inscription is not an anchor; this is not incomplete identity evidence", async () => {
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
    const r = await verify(copy, alice, [sat([anchoring(10), inscribe(next, 20, { confirmations: 0 }), inscribe(next, 21, { mediaType: "image/png" })])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored.map((i) => i.reason)).toEqual(["unconfirmed", "not-an-originals-inscription"]);
  });

  test("C12-75 and C12-86: an inscription that does not strictly parse is rejected; after the anchor, so is one carrying more than one entry", async () => {
    const { alice, copy, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Next", author: ref, sign });
    const line = serializeLog([next]);
    const dup = line.replace('{"versionId"', '{"versionId":"x","versionId"');
    const bad = [bytes(line + line), bytes(dup), bytes("not json\n"), new Uint8Array([0xff, 0xfe])];
    const r = await verify(copy, alice, [sat([anchoring(10), ...bad.map((content, k) => inscribe(next, 20 + k, { content }))])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored.map((i) => i.reason)).toEqual(["more-than-one-entry", "undecodable", "undecodable", "undecodable"]);
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

  test("C12-WAIT: P9.15: chain order decides: a valid publication after an earlier unverifiable inscription extending the same head waits; the earlier one, once verified, is accepted", async () => {
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

  test("C12-WAIT: an earlier unverifiable inscription that proves invalid once verified is rejected, the next in chain order is considered, and the change of head is reported", async () => {
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
      resolved: [blocking.id],
      unverified: [],
    });
    expect(after.reasons).toContain("unverifiable-inscription-resolved");
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
    });
    expect(second.reasons).toContain("unverifiable-inscription-accepted");
    expect(second.current).toBe(false);
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
    const editors = [{ did: SAT, name: true, metadata: false, resources: [] }];
    const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", resources: [photo(B1)], author: ref, sign, editors });
    await expect(updateOriginal(genesis, { versionTime: time(10), aliases: [SAT], author: ref, sign })).rejects.toMatchObject({ code: "STATE_EDITORS" });
    const plain = await createOriginal({ versionTime: time(1), name: "Harbor", resources: [photo(B1)], author: ref, sign });
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

  test("C12-37: an inscription of the Originals media type carrying metadata is rejected, anchoring or later (P9.17)", async () => {
    const { alice, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "With metadata", author: ref, sign });
    const cbor = new Uint8Array([0xa1, 0x62, 0x69, 0x64, 0x61, 0x78]);
    const withMeta = await verify(undefined, alice, [sat([anchoring(10, { metadata: cbor })])]);
    expect(withMeta.anchoring?.status).toBe("not-anchored");
    expect(withMeta.anchoring?.ignored.map((i) => i.reason)).toEqual(["carries-metadata"]);
    const later = await verify(undefined, alice, [sat([anchoring(10, { metadata: null }), inscribe(next, 20, { metadata: cbor })])]);
    expect(later.head).toBe(anchor.versionId);
    expect(later.anchoring?.ignored.map((i) => i.reason)).toEqual(["carries-metadata"]);
  });

  test("C12-74: an inscription carrying a compact delta is rejected in the baseline, which defines no compact encoding (P9.14, P9.17)", async () => {
    const { alice, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Delta", author: ref, sign });
    const delta = bytes(`${JSON.stringify({ versionId: next.versionId, patch: [{ op: "replace", path: "/state/asset/name", value: "Delta" }] })}\n`);
    const r = await verify(undefined, alice, [sat([
      anchoring(10),
      inscribe(next, 20, { mediaType: "application/vnd.originals.vh-delta+json" }),
      inscribe(next, 21, { content: delta }),
    ])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.accepted).toEqual([]);
    expect(r.anchoring?.ignored.map((i) => i.reason)).toEqual(["not-an-originals-inscription", "invalid-entry"]);
  });

  test("C12-74: an inscription whose own body the reader did not establish is ignored with a reason, never a failed read (M1; P9.12, P9.14)", async () => {
    const { alice, anchor, ref, sign, anchoring } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Encoded", author: ref, sign });
    const r = await verify(undefined, alice, [sat([
      inscribe(next, 5, { mediaType: "image/png", content: new Uint8Array(), unsupported: "delegated" }),
      anchoring(10),
      inscribe(next, 20, { content: new Uint8Array(), unsupported: "content-encoding" }),
      inscribe(next, 21, { mediaType: "text/plain", content: new Uint8Array(), unsupported: "not-read" }),
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

  test("C12-90: an unconfirmed anchoring inscription is observed, not an anchor", async () => {
    const { alice, copy, anchoring } = await anchored();
    const r = await verify(copy, alice, [sat([anchoring(10, { confirmations: 0 })])]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored.map((i) => i.reason)).toEqual(["unconfirmed"]);
    expect(r.current).toBe(false);
  });
});

/** Entries after genesis whose metadata pads the log through the anchoring entry to `target` bytes. */
async function paddedTo(target: number) {
  const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }]);
  const sign = alice.signer(KEY, "orig");
  const ref = alice.ref("orig");
  const build = async (last: number, base: number) => {
    const entries = [await createOriginal({ versionTime: time(1), name: "Large", resources: [photo(B1)], author: ref, sign })];
    for (let k = 0; k < 6; k++) {
      const pad = "x".repeat(k === 5 ? last : base);
      entries.push(await updateOriginal(entries[entries.length - 1], { versionTime: time(2 + k), metadata: { pad }, author: ref, sign }));
    }
    entries.push(await updateOriginal(entries[entries.length - 1], { versionTime: time(9), metadata: null, aliases: [SAT], author: ref, sign }));
    return entries;
  };
  // Proof values vary in length by a byte or two, so when a size is skipped, shift the other pads.
  let last = 1_000;
  let base = 57_000;
  const tried = new Set<string>();
  for (let attempt = 0; attempt < 200; attempt++) {
    const entries = await build(last, base);
    const size = bytes(serializeLog(entries)).length;
    if (size === target) return { alice, entries };
    tried.add(`${base}:${last}`);
    last += target - size;
    if (tried.has(`${base}:${last}`)) base += 1;
  }
  throw new Error(`could not pad a log to ${target} bytes`);
}

describe("an inscription body is compact JSON Lines, each ending in one LF (P14.2)", () => {
  test("C12-173: a missing final LF, CRLF or whitespace between tokens makes the body undecodable", async () => {
    const { alice, copy } = await anchored();
    const text = serializeLog(copy);
    const variants = [text.slice(0, -1), text.replaceAll("\n", "\r\n"), text.replace('"versionTime":', '"versionTime": ')];
    for (const body of variants) {
      const r = await verify(undefined, alice, [sat([inscribe([], 10, { content: bytes(body) })])]);
      expect(r.anchoring?.status).toBe("not-anchored");
      expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ reason: "undecodable" })]);
    }
    const ok = await verify(undefined, alice, [sat([inscribe([], 10, { content: bytes(text) })])]);
    expect(ok.anchoring?.status).toBe("anchored");
  });
});

describe("the inscription body limit (P9.17, P14.12; decided, D6; spec PR #50 (open))", () => {
  test("C12-111: an anchoring inscription of exactly 350,000 bytes is accepted", async () => {
    expect(ORIGINALS_INSCRIPTION_MAX_BYTES).toBe(350_000);
    const { alice, entries } = await paddedTo(350_000);
    const r = await verify(undefined, alice, [sat([inscribe(entries, 10)])]);
    expect(r.anchoring?.status).toBe("anchored");
    expect(r.head).toBe(entries[entries.length - 1].versionId);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-112 (verifier): a larger inscription is rejected", async () => {
    const { alice, entries } = await paddedTo(350_001);
    const r = await verify(undefined, alice, [sat([inscribe(entries, 10)])]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored.map((i) => i.reason)).toEqual(["too-large"]);
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
    const junk = inscribe(copy[0], 5, { mediaType: "text/plain" });
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
    const mixed = await verify(copy, alice, [sat([entry, a]), sat([{ ...entry, mediaType: "text/plain" }, a], SAT, undefined, "ord-b")]);
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
    const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", resources: [photo(B1)], author: alice.ref("orig"), sign: old });
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
  test("C12-97: an anchored Original without its resource bytes, current or historical, verifies with content reported unavailable", async () => {
    const { alice, anchor, anchoring } = await anchored();
    const r = await verify(undefined, alice, [sat([anchoring(10)])], { bytes: {} });
    expect(r.history.status).toBe("valid");
    expect(r.head).toBe(anchor.versionId);
    expect(r.resources.status).toBe("partial");
    expect(r.resources.missing.map((v) => [v.resource, v.version])).toEqual([["photo", 1]]);
    expect(r.reasons).not.toContain("resources-partial");
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    // Bytes that are supplied are still checked (P7.4).
    const wrong = await verify(undefined, alice, [sat([anchoring(10)])], { bytes: { [resourceDigest(bytes(B1))]: bytes("tampered") } });
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

describe("C12-150 on Bitcoin: an inscribed entry's size is its stored line (P14.13)", () => {
  /** An anchored log whose genesis line, as stored, is exactly 65,536 bytes and re-serializes longer. */
  async function storedAtLimit() {
    const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }]);
    const sign = alice.signer(KEY, "orig");
    const ref = alice.ref("orig");
    const nums = Array.from({ length: 200 }, () => 1.5e-6);
    let pad = 0;
    for (let i = 0; i < 40; i++) {
      const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", metadata: { nums, pad: "a".repeat(pad) }, resources: [photo(B1)], author: ref, sign });
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

  test("an anchoring inscription whose stored line is 65,536 bytes is accepted, however long it re-serializes", async () => {
    const { alice, anchor, text } = await storedAtLimit();
    const r = await verify(undefined, alice, [sat([inscribe([], 10, { content: bytes(text) })])]);
    expect(r.anchoring?.status, JSON.stringify(r.anchoring?.ignored)).toBe("anchored");
    expect(r.head).toBe(anchor.versionId);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("an anchored copy given as text is measured as stored too", async () => {
    const { alice, anchor, text } = await storedAtLimit();
    const r = await verifyOriginal({ log: text, authors: [alice.evidence()], now: NOW, bytes: allBytes });
    expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.status).toBe("unverified");
  });
});

describe("one confirmation on every network (P9.5, D6; spec PR #50 (open), owner decision)", () => {
  // Mainnet, signet, testnet and regtest sats: one rule, no per-network policy.
  for (const did of ["did:btco:5000000000", "did:btco:sig:5000000000", "did:btco:test:5000000000", "did:btco:reg:5000000000"]) {
    test(`C12-90: on ${did} an anchoring inscription counts at 1 confirmation and not at 0`, async () => {
      const alice = await VhAuthor.create([{ fragment: "orig", signer: KEY }]);
      const sign = alice.signer(KEY, "orig");
      const ref = alice.ref("orig");
      const genesis = await createOriginal({ versionTime: time(1), name: "Harbor", resources: [photo(B1)], author: ref, sign });
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
