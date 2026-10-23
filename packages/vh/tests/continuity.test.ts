/**
 * Signer identity continuity (P5.14, P5.3): a did:webvh author that moves under
 * did:webvh portability keeps its genesis DID as its identity. A version whose
 * `id` differs from the identity DID counts only when it is in the identity
 * DID's own verified log, with the same SCID, reached through moves the method
 * accepts. Nothing else makes two DIDs one identity.
 */
import { describe, expect, test } from "bun:test";
import type { LogEntry } from "../src/log/index.js";
import { createOriginal, resourceDigest, updateOriginal, verifyAuthorHistory, verifyOriginal, type AuthorRef, type OriginalsReport } from "../src/originals/index.js";
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
  test("a log retrieved from the location in the latest entry's verification method establishes the author's freshness", async () => {
    const { alice, at, log } = await moved();
    const rotated = await alice.rotate([{ fragment: "orig-2", signer: K2 }]);
    const after = alice.ref("orig-2", rotated);
    const next = await updateOriginal(log[1], { versionTime: at(), resources: [photo(B3)], author: after, sign: alice.signer(K2, after) });
    const entries = [...log, next];
    // No retrieval and no assertion: freshness is not established, and the Original is not currently authorized.
    const plain = await verify(entries, [alice.evidence()]);
    expect(plain.identityEvidence.freshness).toBe("not-established");
    expect(plain.current).toBe(false);
    // Retrieved from where the latest entry's verification method says the DID is.
    const found = await verify(entries, [{ ...alice.evidence(), retrievedFrom: didWebvhLogUrl(alice.location) }]);
    expect(found.identityEvidence.freshness).toBe("retrieved");
    // Established freshness still makes an unanchored Original only valid as of its checkpoint (P7.10).
    expect(found.current).toBe(false);
    expect(found.validAsOf?.checkpoint).toBe(next.versionId);
    // Retrieved anywhere else (the old location, which redirects or keeps a copy): not established.
    const elsewhere = await verify(entries, [{ ...alice.evidence(), retrievedFrom: didWebvhLogUrl(alice.did) }]);
    expect(elsewhere.identityEvidence.freshness).toBe("not-established");
  });

  test("when the latest entry was signed before the move, its location is the old one", async () => {
    const { alice, log } = await moved();
    const atOld = await verify(log, [{ ...alice.evidence(), retrievedFrom: didWebvhLogUrl(alice.did) }]);
    expect(atOld.identityEvidence.freshness).toBe("retrieved");
    const atNew = await verify(log, [{ ...alice.evidence(), retrievedFrom: didWebvhLogUrl(alice.location) }]);
    expect(atNew.identityEvidence.freshness).toBe("not-established");
  });

  test("a retrieved log shorter than the retained versionId is stale, whatever its source", async () => {
    const { alice, log } = await moved();
    const r = await verify(log, [{ ...alice.evidence(alice.entries.slice(0, 1)), retrievedFrom: didWebvhLogUrl(alice.did) }], { retained: { authors: { [alice.did]: alice.versionId } } });
    expect(r.identityEvidence.freshness).toBe("stale");
    expect(r.current).toBe(false);
  });
});
