/**
 * Anchored Originals (plan 012; plan 011 PR 9a). Inscriptions on the anchoring
 * sat, as an adapter reports them, decide the log from the anchor on (P9.10,
 * P9.12-P9.16); each is checked against the author DID at its inscription time.
 */
import { describe, expect, test } from "bun:test";
import { serializeLog, type LogEntry } from "../src/log/index.js";
import {
  ORIGINALS_INSCRIPTION_TYPE,
  createOriginal,
  deactivateOriginal,
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
const T0 = Date.parse("2026-10-18T12:00:00Z");
const NOW = Date.parse("2026-10-19T00:00:00Z");

let counter = 0;
/** An inscription of one entry, as the adapter reports it. */
function inscribe(entry: LogEntry, height: number, extra: Partial<SatInscription> = {}): SatInscription {
  return {
    id: `${(counter++).toString(16).padStart(64, "0")}i0`,
    height,
    transactionIndex: 1,
    inscriptionIndex: 0,
    confirmations: 120 - height,
    inscriptionTime: T0 + height * 600_000,
    mediaType: ORIGINALS_INSCRIPTION_TYPE,
    content: bytes(serializeLog([entry])),
    ...extra,
  };
}

function sat(inscriptions: SatInscription[], did = SAT, owner: SatEvidence["owner"] = { output: "aa".repeat(32) + ":0", confirmations: 3 }): SatEvidence {
  return { sat: did, tip: { height: 119, hash: "bb".repeat(32) }, inscriptions, owner, indexes: 1 };
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
  return { alice, sign, ref, genesis, renamed, anchor, copy: [genesis, renamed, anchor] };
}

const verify = (log: LogEntry[], alice: VhAuthor, bitcoin?: SatEvidence[], extra: Partial<Parameters<typeof verifyOriginal>[0]> = {}): Promise<OriginalsReport> =>
  verifyOriginal({ log, authors: [alice.evidence()], now: NOW, bytes: allBytes, freshness: "asserted", ...(bitcoin ? { bitcoin } : {}), ...extra });

describe("the anchoring entry (P9.10; plan 012 §3.1, S10)", () => {
  test("C12-34: anchoring from the local layer is accepted, with claimed ordering before it and provisional ownership", async () => {
    const { alice, copy, anchor } = await anchored();
    const r = await verify(copy, alice, [sat([inscribe(anchor, 10)])]);
    expect(r.history.status).toBe("valid");
    expect(r.anchoring).toMatchObject({ sat: SAT, status: "anchored", uniqueness: "not-established", anchor: { versionId: anchor.versionId, height: 10 } });
    expect(r.ordering).toBe("anchored");
    expect(r.ownership).toMatchObject({ status: "provisional", sat: SAT, confirmations: 3, indexes: 1 });
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-31: an entry that names a different sat or drops the sat after anchoring is rejected", async () => {
    const { ref, sign, anchor } = await anchored();
    await expect(updateOriginal(anchor, { versionTime: time(11), aliases: [OTHER_SAT], author: ref, sign })).rejects.toMatchObject({ code: "STATE_ANCHOR" });
    await expect(updateOriginal(anchor, { versionTime: time(11), aliases: [], author: ref, sign })).rejects.toMatchObject({ code: "STATE_ANCHOR" });
  });

  test("C12-35: an Original anchored from the local layer never gains a did:webvh alias", async () => {
    const { ref, sign, anchor } = await anchored();
    const web = "did:webvh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ:example.com";
    await expect(updateOriginal(anchor, { versionTime: time(11), aliases: [web, SAT], author: ref, sign })).rejects.toMatchObject({ code: "STATE_ANCHOR" });
  });

  test("an anchored log with no Bitcoin evidence is unverified, not current", async () => {
    const { alice, copy } = await anchored();
    const r = await verify(copy, alice);
    expect(r.anchoring?.status).toBe("unverified");
    expect(r.current).toBe(false);
    expect(r.reasons).toContain("bitcoin-evidence-missing");
  });

  test("C12-38 and C12-33: an anchoring entry inscribed on a sat other than the one it names is not an anchor, and confers nothing", async () => {
    const { alice, copy, anchor } = await anchored();
    const r = await verify(copy, alice, [sat([inscribe(anchor, 10)], OTHER_SAT)]);
    expect(r.anchoring?.status).toBe("not-anchored");
    expect(r.anchoring?.ignored[0]).toMatchObject({ sat: OTHER_SAT, reason: "names-another-sat" });
    expect(r.ownership).toBeNull();
    expect(r.current).toBe(false);
  });
});

describe("after anchoring, the sat decides (P9.12, P9.13)", () => {
  test("C12-30 and C12-27: an author-signed entry inscribed by whoever holds the sat is accepted; the owner is the sat's holder", async () => {
    const { alice, copy, anchor, ref, sign } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Harbor, sold", author: ref, sign });
    const newOwner = { output: "cc".repeat(32) + ":1", confirmations: 2 };
    const r = await verify([...copy, next], alice, [sat([inscribe(anchor, 10), inscribe(next, 20)], SAT, newOwner)]);
    expect(r.head).toBe(next.versionId);
    expect(r.state?.name).toBe("Harbor, sold");
    expect(r.ownership).toMatchObject({ output: newOwner.output, confirmations: 2 });
    expect(r.identityEvidence.author).toBe(alice.did); // authorship never moves (P5.8)
  });

  test("C12-28: an author-signed entry that is not inscribed on the sat is not current", async () => {
    const { alice, copy, anchor, ref, sign } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Only in a copy", author: ref, sign });
    const r = await verify([...copy, next], alice, [sat([inscribe(anchor, 10)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.state?.name).toBe("Harbor at dawn");
    expect(r.anchoring?.superseded).toBe(1);
  });

  test("C12-29: an inscription on the sat not signed by the author, including by the owner, changes nothing", async () => {
    const { alice, copy, anchor, ref } = await anchored();
    const owner = seeded(77);
    const forged = await updateOriginal(anchor, { versionTime: time(20), name: "By the owner", author: ref, sign: alice.signer(owner, "orig") });
    const r = await verify(copy, alice, [sat([inscribe(anchor, 10), inscribe(forged, 20)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored.map((i) => i.reason)).toContain("invalid-entry");
  });

  test("C12-32: a newer inscription that does not extend the head is ignored", async () => {
    const { alice, copy, anchor, renamed, ref, sign } = await anchored();
    const sideways = await updateOriginal(renamed, { versionTime: time(20), name: "Sideways", author: ref, sign });
    const r = await verify(copy, alice, [sat([inscribe(anchor, 10), inscribe(sideways, 20)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored[0]?.reason).toBe("does-not-extend-head");
  });

  test("C12-39: a publication at the same or a lower block height than the previous accepted one is not accepted", async () => {
    const { alice, copy, anchor, ref, sign } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(10), name: "Same block", author: ref, sign });
    const r = await verify(copy, alice, [sat([inscribe(anchor, 10), inscribe(next, 10, { transactionIndex: 2 })])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored[0]?.reason).toBe("not-above-previous-height");
  });

  test("unconfirmed and foreign inscriptions are observed but never accepted", async () => {
    const { alice, copy, anchor, ref, sign } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Pending", author: ref, sign });
    const r = await verify(copy, alice, [sat([inscribe(anchor, 10), inscribe(next, 20, { confirmations: 0 }), inscribe(next, 21, { mediaType: "image/png" })])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored.map((i) => i.reason)).toEqual(["unconfirmed", "not-an-originals-inscription"]);
  });

  test("C12-75: an inscription that does not decode to exactly one strictly parsed entry is rejected", async () => {
    const { alice, copy, anchor, ref, sign } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Next", author: ref, sign });
    const line = serializeLog([next]);
    const dup = line.replace('{"versionId"', '{"versionId":"x","versionId"');
    const bad = [bytes(line + line), bytes(dup), bytes("not json\n"), new Uint8Array([0xff, 0xfe])];
    const r = await verify(copy, alice, [sat([inscribe(anchor, 10), ...bad.map((content, k) => inscribe(next, 20 + k, { content }))])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored.map((i) => i.reason)).toEqual(["undecodable", "undecodable", "undecodable", "undecodable"]);
  });

  test("C12-36: of two anchoring entries on different sats, the first in chain order is the anchor; the other is a conflicting anchor", async () => {
    const { alice, genesis, renamed, anchor, ref, sign } = await anchored();
    const other = await updateOriginal(renamed, { versionTime: time(10), aliases: [OTHER_SAT], author: ref, sign });
    const mine = sat([inscribe(anchor, 12)]);
    const theirs = sat([inscribe(other, 11)], OTHER_SAT);
    for (const evidence of [[mine, theirs], [theirs, mine]]) {
      const r = await verify([genesis, renamed], alice, evidence);
      expect(r.anchoring?.anchor).toMatchObject({ versionId: other.versionId, height: 11 });
      expect(r.anchoring?.sat).toBe(OTHER_SAT);
      expect(r.anchoring?.conflicting).toEqual([expect.objectContaining({ sat: SAT, versionId: anchor.versionId, height: 12 })]);
      expect(r.head).toBe(other.versionId);
      expect(r.ownership?.sat).toBe(OTHER_SAT);
    }
  });

  test("C12-40: when a reorganisation removes an accepted inscription, the change is reported, never applied silently", async () => {
    const { alice, copy, anchor, ref, sign } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Reorged away", author: ref, sign });
    const r = await verify([...copy, next], alice, [sat([inscribe(anchor, 10)])], { retained: { original: next.versionId } });
    expect(r.head).toBe(anchor.versionId);
    expect(r.reasons).toContain("authoritative-source-changed");
    expect(r.current).toBe(false);
  });
});

describe("author checks at inscription time (P9.15)", () => {
  test("C12-41 (anchored): an inscription made after the author removed its key is rejected", async () => {
    const { alice, copy, anchor, ref, sign } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(30), name: "Stolen key", author: ref, sign });
    alice.timeOverride = new Date(T0 + 25 * 600_000).toISOString();
    await alice.rotate([{ fragment: "orig2", signer: seeded(23) }]);
    const r = await verify([...copy, next], alice, [sat([inscribe(anchor, 10), inscribe(next, 30)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored[0]?.reason).toBe("author-key-not-valid-at-inscription-time");
  });

  test("C12-42: an accepted anchored entry whose key the author later removes stays current", async () => {
    const { alice, copy, anchor } = await anchored();
    alice.timeOverride = new Date(T0 + 50 * 600_000).toISOString();
    await alice.rotate([{ fragment: "orig2", signer: seeded(23) }]);
    const r = await verify(copy, alice, [sat([inscribe(anchor, 10)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-43 and C12-48 (anchored): after the author DID is deactivated the accepted state stays current; later inscriptions are rejected", async () => {
    const { alice, copy, anchor, ref, sign } = await anchored();
    const late = await updateOriginal(anchor, { versionTime: time(40), name: "After deactivation", author: ref, sign });
    alice.timeOverride = new Date(T0 + 30 * 600_000).toISOString();
    await alice.deactivate();
    const r = await verify([...copy, late], alice, [sat([inscribe(anchor, 10), inscribe(late, 40)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored[0]?.reason).toBe("author-deactivated-at-inscription-time");
    expect(r.identityEvidence.deactivated).toBe(true);
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-44: an anchored entry naming an author DID version newer than its inscription time is checked against the named version", async () => {
    const { alice, copy, anchor, sign } = await anchored();
    alice.timeOverride = new Date(T0 + 35 * 600_000).toISOString();
    await alice.rotate([{ fragment: "orig", signer: KEY }, { fragment: "spare", signer: seeded(24) }]);
    const next = await updateOriginal(anchor, { versionTime: time(30), name: "Names a later version", author: alice.ref("orig"), sign });
    const r = await verify([...copy, next], alice, [sat([inscribe(anchor, 10), inscribe(next, 30)])]);
    expect(r.head).toBe(next.versionId);
  });

  test("C12-08 (anchored): an entry naming an old author version is checked against the state at its inscription time, whatever time it claims", async () => {
    const { alice, copy, anchor, sign } = await anchored();
    const v1 = alice.versionId;
    alice.timeOverride = new Date(T0 + 25 * 600_000).toISOString();
    await alice.rotate([{ fragment: "orig2", signer: seeded(23) }]);
    const backdated = await updateOriginal(anchor, { versionTime: time(11), name: "Backdated", author: alice.ref("orig", v1), sign });
    const r = await verify([...copy, backdated], alice, [sat([inscribe(anchor, 10), inscribe(backdated, 30)])]);
    expect(r.head).toBe(anchor.versionId);
    expect(r.anchoring?.ignored[0]?.reason).toBe("author-key-not-valid-at-inscription-time");
  });

  test("C12-62 and C12-46: without the author DID's history the anchored Original is incomplete, not current", async () => {
    const { alice, copy, anchor } = await anchored();
    const r = await verifyOriginal({ log: copy, authors: [], now: NOW, bytes: allBytes, freshness: "asserted", bitcoin: [sat([inscribe(anchor, 10)])] });
    expect(r.identityEvidence.status).toBe("incomplete");
    expect(r.current).toBe(false);
    void alice;
  });

  test("C12-47: an author DID version that would retroactively reject an accepted inscription is reported as a conflict", async () => {
    const { alice, copy, anchor, ref, sign } = await anchored();
    const next = await updateOriginal(anchor, { versionTime: time(20), name: "Accepted earlier", author: ref, sign });
    // A removal claiming a versionTime before the inscription, published after it was accepted.
    alice.timeOverride = new Date(T0 + 15 * 600_000).toISOString();
    await alice.rotate([{ fragment: "orig2", signer: seeded(23) }]);
    const r = await verify([...copy, next], alice, [sat([inscribe(anchor, 10), inscribe(next, 20)])], { retained: { original: next.versionId } });
    expect(r.reasons).toContain("retroactive-revocation-conflict");
    expect(r.current).toBe(false);
  });
});

describe("the deactivation of an anchored Original (P9.12)", () => {
  test("a deactivation counts only once inscribed on the sat", async () => {
    const { alice, copy, anchor, ref, sign } = await anchored();
    const off = await deactivateOriginal(anchor, { versionTime: time(20), author: ref, sign });
    const uninscribed = await verify([...copy, off], alice, [sat([inscribe(anchor, 10)])]);
    expect(uninscribed.deactivated).toBe(false);
    const inscribed = await verify([...copy, off], alice, [sat([inscribe(anchor, 10), inscribe(off, 20)])]);
    expect(inscribed.deactivated).toBe(true);
  });
});
