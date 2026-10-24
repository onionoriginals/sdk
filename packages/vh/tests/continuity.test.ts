/**
 * Signer identity continuity (P5.14, P5.3): a did:webvh author that moves under
 * did:webvh portability keeps its genesis DID as its identity. A version whose
 * `id` differs from the identity DID counts only when it is in the identity
 * DID's own verified log, with the same SCID, reached through moves the method
 * accepts. Nothing else makes two DIDs one identity.
 */
import { describe, expect, test } from "bun:test";
import { createWitnessProof, type LogEntry } from "../src/log/index.js";
import { createOriginal, describeFreshness, resourceDigest, updateOriginal, verifyAuthorHistory, verifyOriginal, type AuthorRef, type OriginalsReport } from "../src/originals/index.js";
import { didWebvhLogUrl } from "../src/webvh/index.js";
import { NOW, VhAuthor, WebvhAuthor, bytes, clock, photo, seeded } from "./helpers/originals.js";

const B1 = "harbor at dawn, first crop";
const B2 = "harbor at dawn, tighter crop";
const B3 = "harbor at dawn, after the move";
const allBytes = Object.fromEntries([B1, B2, B3].map((t) => [resourceDigest(bytes(t)), bytes(t)]));
const K1 = seeded(21);
const K2 = seeded(22);

/** Alice creates and edits on old.example.com, then moves to new.example.org keeping her key. */
async function moved(moveKeys?: Parameters<WebvhAuthor["move"]>[1]) {
  const alice = await WebvhAuthor.create([{ fragment: "orig-1", signer: K1 }], { domain: "old.example.com" });
  const at = clock();
  const before = alice.ref("orig-1");
  const genesis = await createOriginal({ versionTime: at(), name: "Harbor at dawn", resources: [photo(B1)], author: before, sign: alice.signer(K1, before) });
  const cropped = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], author: before, sign: alice.signer(K1, before) });
  const moveVersion = await alice.move("new.example.org", moveKeys ?? [{ fragment: "orig-1", signer: K1 }]);
  return { alice, at, before, moveVersion, log: [genesis, cropped] };
}

const verify = (log: LogEntry[], authors: Parameters<typeof verifyOriginal>[0]["authors"], extra: Partial<Parameters<typeof verifyOriginal>[0]> = {}): Promise<OriginalsReport> =>
  verifyOriginal({ log, authors, now: NOW, bytes: allBytes, ...extra });

function failedWith(r: OriginalsReport, index: number, code: string, category?: string) {
  expect(r.history.failure?.index, JSON.stringify(r.history.failure)).toBe(index);
  expect(r.history.failure?.code).toBe(code);
  if (category) expect(r.history.failure?.category).toBe(category);
  expect(r.current).toBe(false);
}

describe("C12-132: a did:webvh author that moved under portability, then rotated", () => {
  test("a new entry signed with the new key, naming a version after the move, is accepted; entries before the move still verify", async () => {
    const { alice, at, log, before } = await moved();
    const rotated = await alice.rotate([{ fragment: "orig-2", signer: K2 }]);
    const after = alice.ref("orig-2", rotated);
    expect(after).toEqual({ did: alice.did, verificationMethod: `${alice.location}#orig-2`, versionId: rotated });
    expect(after.verificationMethod.startsWith(`${alice.did}#`)).toBe(false);
    const next = await updateOriginal(log[1], { versionTime: at(), resources: [photo(B3)], author: after, sign: alice.signer(K2, after) });
    const r = await verify([...log, next], [alice.evidence()], {});
    expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
    expect(r.authorBinding.status).toBe("valid");
    expect(r.identityEvidence).toMatchObject({ status: "complete", author: alice.did, latestVersionId: rotated });
    expect(r.validAsOf?.checkpoint).toBe(next.versionId);
    // The rotation removed the old key: the entries before it are historically authorized only (P7.9).
    expect(r.historicallyAuthorizedOnly.map((h) => h.versionId)).toEqual(log.map((e) => e.versionId));
    expect(r.reasons).toEqual(["not-anchored", "historically-authorized-only"]);
    // The author is the identity DID throughout; entries before the move bind to versions before it.
    expect(r.document?.controller).toBe(alice.did);
    expect(before.verificationMethod).toBe(`${alice.did}#orig-1`);
    const early = await verify([...log, next], [alice.evidence()], { checkpoint: log[1].versionId });
    expect(early.history.status).toBe("valid");
    expect(early.authorBinding.status).toBe("valid");
  });

  test("the pre-move head stays historically valid but is not current once the key is gone from the latest version (P7.9)", async () => {
    const { alice, log } = await moved();
    await alice.rotate([{ fragment: "orig-2", signer: K2 }]);
    const r = await verify(log, [alice.evidence()], {});
    expect(r.history.status).toBe("valid");
    expect(r.reasons).toEqual(["not-anchored", "historically-authorized-only"]);
    // Kept across the move, the key still holds: the same key under the new `id` meets P5.3 there.
    const kept = await moved();
    const still = await verify(kept.log, [kept.alice.evidence()], {});
    expect(still.reasons).toEqual(["not-anchored"]);
  });

  test("after the move the verification method must be in the namespace of that version's `id` (P5.3)", async () => {
    const { alice, at, log } = await moved();
    const rotated = await alice.rotate([{ fragment: "orig-2", signer: K2 }]);
    // The new key, named under the identity DID's old namespace at a version whose id is the new DID.
    const stale: AuthorRef = { did: alice.did, verificationMethod: `${alice.did}#orig-2`, versionId: rotated };
    const next = await updateOriginal(log[1], { versionTime: at(), resources: [photo(B3)], author: stale, sign: alice.signer(K2, stale) });
    failedWith(await verify([...log, next], [alice.evidence()]), 2, "AUTHOR_VM_FOREIGN", "author-binding");
  });
});

describe("C12-135: a verification method after a move whose controller is the old DID", () => {
  test("fails author binding (P5.3, P5.14)", async () => {
    const { alice, at, log } = await moved();
    const oldDid = alice.did;
    // As didwebvh-ts writes a move: the method moves to the new id, its controller does not.
    await alice.rotate([{ fragment: "orig-1", signer: K1, controller: oldDid }]);
    const ref = alice.ref("orig-1");
    const next = await updateOriginal(log[1], { versionTime: at(), resources: [photo(B3)], author: ref, sign: alice.signer(K1, ref) });
    failedWith(await verify([...log, next], [alice.evidence()]), 2, "AUTHOR_VM_CONTROLLER", "author-binding");
    // A method the moved document still lists under the old DID's id is held in another namespace.
    const doc = alice.document(alice.location, [], { alsoKnownAs: [oldDid] });
    doc.verificationMethod = [{ id: `${oldDid}#orig-1`, type: "Multikey", controller: oldDid, publicKeyMultibase: K1.publicKeyMultibase }];
    doc.assertionMethod = [`${oldDid}#orig-1`];
    const v = await alice.appendState(doc);
    const legacy: AuthorRef = { did: oldDid, verificationMethod: `${oldDid}#orig-1`, versionId: v };
    const again = await updateOriginal(log[1], { versionTime: at(), resources: [photo(B3)], author: legacy, sign: alice.signer(K1, legacy) });
    failedWith(await verify([...log, again], [alice.evidence()]), 2, "AUTHOR_VM_FOREIGN", "author-binding");
  });
});

describe("C12-136: a log with another SCID whose alsoKnownAs lists the author DID", () => {
  test("is not the author's identity; entries signed with its keys are rejected (P5.14)", async () => {
    const { alice, at, log } = await moved();
    const mallory = await WebvhAuthor.create([{ fragment: "orig", signer: seeded(66) }], { domain: "new.example.org", alsoKnownAs: [alice.did] });
    const claim: AuthorRef = { did: alice.did, verificationMethod: `${mallory.location}#orig`, versionId: mallory.versionId };
    const next = await updateOriginal(log[1], { versionTime: at(), resources: [photo(B3)], author: claim, sign: mallory.signer(seeded(66), claim) });
    // Mallory's log offered as Alice's history does not verify as hers.
    const history = await verifyAuthorHistory(mallory.evidence(undefined, alice.did), { now: NOW });
    expect(history.versions).toEqual([]);
    expect(history.failure?.error.code).toBe("AUTHOR_LOG_MISMATCH");
    const offered = await verify([...log, next], [mallory.evidence(undefined, alice.did)]);
    expect(offered.identityEvidence.status).toBe("incomplete");
    expect(offered.history.entries).toBe(0);
    expect(offered.current).toBe(false);
    // Mallory's version is not in Alice's history: nothing binds to it.
    const unknown = await verify([...log, next], [alice.evidence(), mallory.evidence()]);
    failedWith(unknown, 2, "AUTHOR_VERSION_UNAVAILABLE", "incomplete-evidence");
    // Naming a version of Alice's own log, Mallory's method is in another DID's namespace.
    const named: AuthorRef = { ...claim, versionId: alice.versionId };
    const bound = await updateOriginal(log[1], { versionTime: at(), resources: [photo(B3)], author: named, sign: mallory.signer(seeded(66), named) });
    failedWith(await verify([...log, bound], [alice.evidence(), mallory.evidence()]), 2, "AUTHOR_VM_FOREIGN", "author-binding");
  });

  test("a log that does not verify from the identity DID's genesis, or is keyed by the moved DID, is not the identity's history", async () => {
    const { alice, log } = await moved();
    // Only the versions after genesis.
    const suffix = await verifyAuthorHistory(alice.evidence(alice.entries.slice(1)), { now: NOW });
    expect(suffix.versions).toEqual([]);
    // Histories are looked up by the identity DID the entries name, never by where it lives now.
    const byLocation = await verify(log, [alice.evidence(undefined, alice.location)]);
    expect(byLocation.history.failure?.code).toBe("AUTHOR_HISTORY_MISSING");
    expect(byLocation.identityEvidence.status).toBe("incomplete");
  });
});

describe("C12-138: an author DID that changes DID method", () => {
  test("is not continuity: entries naming the new DID or its keys are rejected (P5.14)", async () => {
    const { alice, at, log } = await moved();
    const key = seeded(77);
    const asVh = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    // The did:vh claims to be Alice; a later entry naming it as author changes the author DID.
    const renamed = await updateOriginal(log[1], { versionTime: at(), resources: [photo(B3)], author: asVh.ref("orig"), sign: asVh.signer(key, "orig") });
    failedWith(await verify([...log, renamed], [alice.evidence(), asVh.evidence()]), 2, "AUTHOR_DID_CHANGED");
    // Naming Alice but a key of the did:vh: not in any version of Alice's own log.
    const claim: AuthorRef = { did: alice.did, verificationMethod: `${asVh.did}#orig`, versionId: alice.versionId };
    const borrowed = await updateOriginal(log[1], { versionTime: at(), resources: [photo(B3)], author: claim, sign: asVh.signer(key, "orig") });
    failedWith(await verify([...log, borrowed], [alice.evidence(), asVh.evidence()]), 2, "AUTHOR_VM_FOREIGN", "author-binding");
    // And the did:vh's log offered as Alice's history is not hers.
    const offered = await verifyAuthorHistory({ did: alice.did, log: asVh.evidence().log }, { now: NOW });
    expect(offered.versions).toEqual([]);
  });
});

describe("C12-134: author freshness after a move (P5.14, P7.8)", () => {
  const OBTAINED = "2026-10-18T13:00:00.000Z";
  const W = seeded(61);
  const witnessList = { witness: { threshold: 1, witnesses: [{ id: `did:key:${W.publicKeyMultibase}` }] } };
  const approve = async (versionId: string) => [{ versionId, proof: [await createWitnessProof(W, versionId)] }];

  test("C12-166: a log retrieved from the latest entry's location, not approved by the DID's own witnesses, does not establish freshness; the report says where, when and which version (owner decision, 23 Oct 2026)", async () => {
    const { alice, at, log } = await moved();
    const rotated = await alice.rotate([{ fragment: "orig-2", signer: K2 }]);
    const after = alice.ref("orig-2", rotated);
    const next = await updateOriginal(log[1], { versionTime: at(), resources: [photo(B3)], author: after, sign: alice.signer(K2, after) });
    const entries = [...log, next];
    // No retrieval: freshness is not established, and the Original is not currently authorized.
    const plain = await verify(entries, [alice.evidence()]);
    expect(plain.identityEvidence.freshness).toBe("not-established");
    expect(plain.current).toBe(false);
    // Retrieved from where the latest entry's verification method says the DID is: still not established.
    const url = didWebvhLogUrl(alice.location);
    const found = await verify(entries, [{ ...alice.evidence(), retrievedFrom: url, obtainedAt: OBTAINED, source: "fetched" }]);
    expect(found.identityEvidence.freshness).toBe("not-established");
    expect(found.identityEvidence.obtained).toEqual({ location: url, obtainedAt: OBTAINED, source: "fetched", latestVersionId: rotated, witnessed: false });
    expect(found.validAsOf?.signers[0]).toMatchObject({ did: alice.did, location: url, obtainedAt: OBTAINED, versionId: rotated });
    const text = describeFreshness(alice.did, found.identityEvidence);
    expect(text).toContain(`obtained from ${url} at ${OBTAINED}`);
    expect(text).toContain(rotated);
    expect(text).toContain("may have a newer version");
    expect(text).toContain("removes a key");
    expect(text).toContain("not seen");
    expect(found.current).toBe(false);
    expect(found.validAsOf?.checkpoint).toBe(next.versionId);
  });

  test("C12-177: a witnessed log found where its own latest version's id points establishes freshness, though every asset entry was signed before the move (P7.8, P5.14)", async () => {
    const { alice, log } = await moved();
    const rotated = await alice.rotate([{ fragment: "orig-1", signer: K1 }], witnessList);
    const url = didWebvhLogUrl(alice.location);
    const r = await verify(log, [{ ...alice.evidence(), witness: await approve(rotated), retrievedFrom: url, obtainedAt: OBTAINED, source: "fetched" as const }]);
    expect(r.identityEvidence.freshness).toBe("established");
    // The same log fetched from the old host, whose latest version names the new one, is not.
    const old = await verify(log, [{ ...alice.evidence(), witness: await approve(rotated), retrievedFrom: didWebvhLogUrl(alice.did), obtainedAt: OBTAINED, source: "fetched" as const }]);
    expect(old.identityEvidence.freshness).toBe("not-established");
  });

  test("approved by the DID's own witnesses at its latest version, and retrieved where that version's id says, the log establishes freshness", async () => {
    const { alice, at, log } = await moved();
    const rotated = await alice.rotate([{ fragment: "orig-2", signer: K2 }], witnessList);
    const after = alice.ref("orig-2", rotated);
    const next = await updateOriginal(log[1], { versionTime: at(), resources: [photo(B3)], author: after, sign: alice.signer(K2, after) });
    const entries = [...log, next];
    const url = didWebvhLogUrl(alice.location);
    const witnessed = { ...alice.evidence(), witness: await approve(rotated), retrievedFrom: url, obtainedAt: OBTAINED, source: "fetched" as const };
    const r = await verify(entries, [witnessed]);
    expect(r.identityEvidence.freshness).toBe("established");
    expect(r.identityEvidence.obtained).toEqual({ location: url, obtainedAt: OBTAINED, source: "fetched", latestVersionId: rotated, witnessed: true });
    expect(describeFreshness(alice.did, r.identityEvidence)).toContain("approved by the DID's own witnesses");
    // Established freshness still makes an unanchored Original only valid as of its checkpoint (P7.10).
    expect(r.current).toBe(false);
    // P7.8: the location rule is for a did:webvh log fetched from a location; the same
    // witnessed log from an evidence package establishes freshness (P7.8).
    const packaged = await verify(entries, [{ ...witnessed, retrievedFrom: undefined, source: "package" }]);
    expect(packaged.identityEvidence.freshness).toBe("established");
    // Unwitnessed, it does not.
    const bare = await verify(entries, [{ ...alice.evidence(), source: "package" }]);
    expect(bare.identityEvidence.freshness).toBe("not-established");
    expect(describeFreshness(alice.did, packaged.identityEvidence)).toContain(`obtained from the evidence package at ${OBTAINED}`);
    // Retrieved anywhere else (the old location, which redirects or keeps a copy): not established.
    const elsewhere = await verify(entries, [{ ...witnessed, retrievedFrom: didWebvhLogUrl(alice.did) }]);
    expect(elsewhere.identityEvidence.freshness).toBe("not-established");
  });

  test("C12-167: a log whose latest version's id names another location is not the identity's latest where it was obtained, witnessed or not", async () => {
    // The latest asset entry was signed before the move, at the old location; the log there says the DID has moved.
    const { alice, log } = await moved();
    const atOld = await verify(log, [{ ...alice.evidence(), retrievedFrom: didWebvhLogUrl(alice.did) }]);
    expect(atOld.identityEvidence.freshness).toBe("not-established");
    const atNew = await verify(log, [{ ...alice.evidence(), retrievedFrom: didWebvhLogUrl(alice.location) }]);
    expect(atNew.identityEvidence.freshness).toBe("not-established");
  });

  test("C12-177: a log from the old host whose latest version moves the DID and removes a key: the removal is applied, and freshness is not established (P7.8)", async () => {
    // The move version drops orig-1 for orig-2; the asset entries were signed with orig-1 before it.
    const { alice, log } = await moved([{ fragment: "orig-2", signer: K2 }]);
    const r = await verify(log, [{ ...alice.evidence(), retrievedFrom: didWebvhLogUrl(alice.did) }]);
    // Every verified version is used, including the one that removes the key (P7.8, P7.9).
    expect(r.historicallyAuthorizedOnly.map((h) => h.versionId)).toEqual(log.map((e) => e.versionId));
    expect(r.reasons).toContain("historically-authorized-only");
    expect(r.identityEvidence.latestVersionId).toBe(alice.versionId);
    expect(r.identityEvidence.freshness).toBe("not-established");
    // P5.14: the move is reported, and that the log where it points was not obtained.
    expect(r.identityEvidence.obtained).toMatchObject({ movedTo: alice.location, movedLog: "not-obtained" });
    expect(describeFreshness(alice.did, r.identityEvidence)).toContain(`now at ${alice.location}`);
    // A package has no fetch location: the moved-identity rule does not apply to its log (P7.8).
    const packaged = await verify(log, [{ ...alice.evidence(), source: "package" }]);
    expect(packaged.identityEvidence.obtained.movedTo).toBeUndefined();
  });

  test("a retrieved log shorter than the retained versionId is stale, whatever its source", async () => {
    const { alice, log } = await moved();
    const r = await verify(log, [{ ...alice.evidence(alice.entries.slice(0, 1)), retrievedFrom: didWebvhLogUrl(alice.did) }], { retained: { authors: { [alice.did]: alice.versionId } } });
    expect(r.identityEvidence.freshness).toBe("stale");
    expect(r.current).toBe(false);
  });
});
