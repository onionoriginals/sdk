import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { base58btcEncode, createProof, multibaseEncode, sha256 } from "../src/crypto/index.js";
import { OriginalsError } from "../src/errors.js";
import { parseJson, type JsonObject } from "../src/json/index.js";
import { appendEntry, createLog, parseLog, serializeLog, signWith, verifyLog, type LogEntry, type Specialisation } from "../src/log/index.js";
import { resolveDidVh } from "../src/didvh/index.js";
import {
  ORIGINALS_METHOD,
  createOriginal,
  deactivateOriginal,
  originalsExtension,
  resourceDigest,
  updateOriginal,
  verifyAuthorHistory,
  verifyOriginal,
  type AuthorRef,
  type OriginalsReport,
} from "../src/originals/index.js";
import { NOW, VhAuthor, bytes, clock, photo, seeded } from "./helpers/originals.js";

const B1 = "harbor at dawn, first crop";
const B2 = "harbor at dawn, tighter crop";
const allBytes = (...texts: string[]) => Object.fromEntries(texts.map((t) => [resourceDigest(bytes(t)), bytes(t)]));

/** Alice's did:vh with one Originals key, and the photo example from spec section 4. */
async function harbor() {
  const key = seeded(21);
  const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
  const at = clock();
  const sign = alice.signer(key, "orig");
  const ref = alice.ref("orig");
  const genesis = await createOriginal({ versionTime: at(), name: "Harbor at dawn", resources: [photo(B1)], author: ref, sign });
  const cropped = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], author: ref, sign });
  const renamed = await updateOriginal(cropped, { versionTime: at(), metadata: { caption: "Corrected caption" }, author: ref, sign });
  return { alice, key, sign, ref, at, log: [genesis, cropped, renamed] };
}

async function report(log: unknown[] | string, authors: VhAuthor[], extra: Partial<Parameters<typeof verifyOriginal>[0]> = {}): Promise<OriginalsReport> {
  return verifyOriginal({ log, authors: authors.map((a) => a.evidence()), now: NOW, bytes: allBytes(B1, B2), ...extra });
}

function failedWith(r: OriginalsReport, index: number, code: string, category?: string) {
  expect(r.history.failure?.index, JSON.stringify(r.history.failure)).toBe(index);
  expect(r.history.failure?.code).toBe(code);
  if (category) expect(r.history.failure?.category).toBe(category);
  expect(r.current).toBe(false);
}

/** Re-sign an entry after editing its state, keeping the chain valid. */
async function resign(previous: LogEntry, state: JsonObject, sign: Parameters<typeof appendEntry>[1]["sign"], parameters: JsonObject = {}, versionTime = "2026-10-18T12:30:00.000Z") {
  return appendEntry(previous, { versionTime, parameters, state, sign });
}

describe("C12-01: create, edit and verify in a fresh reader", () => {
  test("the photo example: versions derived from history, no private key in the reader", async () => {
    const { alice, log } = await harbor();
    const r = await verifyOriginal({ log: serializeLog(log), authors: [alice.evidence()], now: NOW, bytes: allBytes(B1, B2) });
    expect(r.history.status).toBe("valid");
    expect(r.authorBinding.status).toBe("valid");
    expect(r.identityEvidence).toMatchObject({ status: "complete", author: alice.did, latestVersionId: alice.versionId });
    expect(r.checkpoint).toBe(log[2].versionId);
    expect(r.original).toBe(`did:vh:${log[0].parameters.scid as string}`);
    expect(r.state?.name).toBe("Harbor at dawn");
    expect(r.state?.metadata).toEqual({ caption: "Corrected caption" });
    // The metadata-only correction leaves photo at version 2 (P4.4).
    expect(r.resources.versions.map((v) => [v.resource, v.version, v.versionId, v.bytes])).toEqual([
      ["photo", 1, log[0].versionId, "verified"],
      ["photo", 2, log[1].versionId, "verified"],
    ]);
    expect(r.resources.status).toBe("available");
    expect(r.ordering).toBe("claimed");
    expect(r.reasons).toEqual(["not-anchored"]);
  });

  test("C12-145: a verified result is valid as of its checkpoint, never current (P7.8, P7.10)", async () => {
    const { alice, log } = await harbor();
    const r = await report(log, [alice]);
    expect(r.history.status).toBe("valid");
    expect(r.identityEvidence.freshness).toBe("not-established");
    expect(r.current).toBe(false);
    expect(r.validAsOf).toEqual({ checkpoint: r.head, signers: [{ did: alice.did, role: "author", versionId: alice.versionId, obtainedAt: null, source: null , location: null }] });
    expect(r.reasons).toEqual(["not-anchored"]);
  });

  test("an exact checkpoint returns that checkpoint, or says why it cannot (P3.2)", async () => {
    const { alice, log } = await harbor();
    const r = await report(log, [alice], { checkpoint: log[1].versionId });
    expect(r.checkpoint).toBe(log[1].versionId);
    expect(r.state?.metadata).toBeUndefined();
    expect(r.current).toBe(false);
    const missing = await report(log, [alice], { checkpoint: "9-QmMissing" });
    expect(missing.checkpoint).toBeNull();
    expect(missing.reasons).toContain("checkpoint-not-found");
  });
});

describe("resources", () => {
  test("C12-02: bytes changed at the same location fail the digest check", async () => {
    const { alice, log } = await harbor();
    const tampered = allBytes(B1, B2);
    tampered[resourceDigest(bytes(B2))] = bytes("harbor at dawn, tighter crop!");
    const r = await report(log, [alice], { bytes: tampered });
    expect(r.resources.status).toBe("digest-failure");
    expect(r.resources.failures.map((v) => [v.version, v.bytes])).toEqual([[2, "mismatch"]]);
    expect(r.current).toBe(false);
  });

  test("C12-10: missing historical bytes give explicit partial availability; supplied bytes are still checked", async () => {
    const { alice, log } = await harbor();
    const r = await report(log, [alice], { bytes: allBytes(B2) });
    expect(r.resources.status).toBe("partial");
    expect(r.resources.missing.map((v) => [v.resource, v.version, v.versionId])).toEqual([["photo", 1, log[0].versionId]]);
    expect(r.resources.versions[1].bytes).toBe("verified");
    expect(r.history.status).toBe("valid");
    // P7.3, P7.4, P9.18: the log verifies without its bytes. Unavailable content is reported
    // beside the result, never as a verification failure, and `current` leaves it out.
    expect(r.reasons).toEqual(["not-anchored"]);
    expect(r.validAsOf).not.toBeNull();
  });

  test("P7.3, P7.4: current bytes missing too leave the log verified and current; a supplied mismatch still fails", async () => {
    const { alice, log } = await harbor();
    const none = await report(log, [alice], { bytes: {} });
    expect(none.resources.status).toBe("partial");
    expect(none.resources.missing.map((v) => v.version)).toEqual([1, 2]);
    expect(none.history.status).toBe("valid");
    expect(none.authorBinding.status).toBe("valid");
    expect(none.reasons).toEqual(["not-anchored"]);
    const tampered = { [resourceDigest(bytes(B2))]: bytes("not the crop") };
    const bad = await report(log, [alice], { bytes: tampered });
    expect(bad.resources.status).toBe("digest-failure");
    expect(bad.reasons).toContain("resources-digest-failure");
    expect(bad.current).toBe(false);
  });

  test("C12-19: an update that leaves a digest unchanged does not advance that resource", async () => {
    const { alice, log, ref, sign, at } = await harbor();
    const same = await updateOriginal(log[2], { versionTime: at(), resources: [photo(B2)], author: ref, sign });
    expect(same.state.transitions).toEqual([]);
    const r = await report([...log, same], [alice]);
    expect(r.resources.versions.length).toBe(2);
    // A transition that claims an unchanged digest is rejected.
    const forged = await resign(log[2], { ...log[2].state, transitions: [{ resource: "photo", from: photo(B2).digest, to: photo(B2).digest }] }, sign);
    failedWith(await report([...log, forged], [alice]), 3, "STATE_TRANSITIONS");
  });

  test("C12-11: there is no version counter to supply; a descriptor with one is rejected", async () => {
    const { alice, log, sign } = await harbor();
    const asset = log[2].state.asset as JsonObject;
    const counted = await resign(log[2], { ...log[2].state, transitions: [], asset: { ...asset, resources: [{ ...photo(B2), version: 7 }] } }, sign);
    failedWith(await report([...log, counted], [alice]), 3, "STATE_MEMBERS");
  });

  test("C12-80: a digest outside the SHA-256 set is an unsupported profile", async () => {
    const key = seeded(21);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const sha512ish = multibaseEncode(new Uint8Array([0x13, 0x40, ...new Uint8Array(64)]));
    const entry = await createOriginal({
      versionTime: "2026-10-18T12:00:00.000Z", name: "x", author: alice.ref("orig"), sign: alice.signer(key, "orig"),
      resources: [{ id: "photo", mediaType: "image/jpeg", size: 1, digest: sha512ish }],
    }).catch((e: unknown) => e);
    expect(entry).toBeInstanceOf(OriginalsError);
    expect((entry as OriginalsError).category).toBe("unsupported-profile");
  });
});

describe("name and metadata (P4.6)", () => {
  test("C12-17: metadata supplied replaces, omitted keeps, null removes", async () => {
    const { log, ref, sign, at } = await harbor();
    const kept = await updateOriginal(log[2], { versionTime: at(), name: "Harbor", author: ref, sign });
    expect((kept.state.asset as JsonObject).metadata).toEqual({ caption: "Corrected caption" });
    const replaced = await updateOriginal(kept, { versionTime: at(), metadata: { place: "Brest" }, author: ref, sign });
    expect((replaced.state.asset as JsonObject).metadata).toEqual({ place: "Brest" });
    const removed = await updateOriginal(replaced, { versionTime: at(), metadata: null, author: ref, sign });
    expect("metadata" in (removed.state.asset as JsonObject)).toBe(false);
  });

  test("C12-18: a null name is rejected", async () => {
    const { log, ref, sign, at } = await harbor();
    await expect(updateOriginal(log[2], { versionTime: at(), name: null as never, author: ref, sign })).rejects.toThrow(OriginalsError);
  });
});

describe("history and identity", () => {
  test("C12-03: a different Original identifier in the state is rejected", async () => {
    const { alice, log, sign } = await harbor();
    const other = await resign(log[2], { ...log[2].state, id: "did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ" }, sign);
    failedWith(await report([...log, other], [alice]), 3, "STATE_ID");
    const scid = log[0].parameters.scid as string;
    const swapped = await resolveDidVh(`did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ`, { didLog: log, extensions: [originalsExtension([await verifyAuthorHistory(alice.evidence(), { now: NOW })])], now: NOW });
    expect(swapped.didResolutionMetadata.error).toBe("invalidDid");
    expect(scid.length).toBe(46);
  });

  test("C12-04: a changed entry ends the verified prefix", async () => {
    const { alice, log } = await harbor();
    const changed = structuredClone(log);
    (changed[1].state.asset as JsonObject).name = "Harbour at dawn";
    const r = await report(changed, [alice]);
    expect(r.history.status).toBe("invalid");
    expect(r.history.entries).toBe(1);
    expect(r.checkpoint).toBe(log[0].versionId);
  });

  test("C12-73: a delta instead of the full asset state is rejected", async () => {
    const { alice, log, sign } = await harbor();
    const delta = await resign(log[2], { ...log[2].state, asset: { metadata: { caption: "x" } } }, sign);
    failedWith(await report([...log, delta], [alice]), 3, "STATE_MEMBERS");
  });

  test("C12-79: an undefined state member or duplicate JSON keys are rejected", async () => {
    const { alice, log, sign } = await harbor();
    const extra = await resign(log[2], { ...log[2].state, note: "unsigned-looking" }, sign);
    failedWith(await report([...log, extra], [alice]), 3, "STATE_MEMBERS");
    const text = serializeLog(log).replace('"operation":"create"', '"operation":"create","operation":"create"');
    const r = await report(text, [alice]);
    expect(r.history.failure?.code).toBe("JSON_DUPLICATE_KEY");
    expect(r.history.entries).toBe(0);
  });

  test("C12-76: lifecycle status and VH deactivated must agree", async () => {
    const { alice, log, sign } = await harbor();
    const asset = log[2].state.asset as JsonObject;
    const statusOnly = await resign(log[2], { ...log[2].state, operation: "deactivate", transitions: [], asset: { ...asset, status: "deactivated" } }, sign);
    failedWith(await report([...log, statusOnly], [alice]), 3, "STATE_DEACTIVATION");
    const paramOnly = await resign(log[2], { ...log[2].state, transitions: [] }, sign, { deactivated: true });
    failedWith(await report([...log, paramOnly], [alice]), 3, "STATE_DEACTIVATION");
  });

  test("C12-21: an update after deactivation is rejected; the history stays readable", async () => {
    const { alice, log, ref, sign, at } = await harbor();
    const end = await deactivateOriginal(log[2], { versionTime: at(), author: ref, sign });
    const r = await report([...log, end], [alice], {});
    expect(r.deactivated).toBe(true);
    expect(r.state?.status).toBe("deactivated");
    expect(r.history.status).toBe("valid");
    const after = await resign(end, { ...log[2].state }, sign);
    failedWith(await report([...log, end, after], [alice]), 4, "ENTRY_AFTER_DEACTIVATION");
    expect((await report([...log, end], [alice], { checkpoint: log[1].versionId })).state?.status).toBe("active");
  });

  test("C12-49: an entry that sets updateKeys or nextKeyHashes is rejected", async () => {
    const { alice, log, sign } = await harbor();
    for (const parameters of [{ updateKeys: [seeded(3).publicKeyMultibase] }, { nextKeyHashes: [] }]) {
      const keyed = await resign(log[2], { ...log[2].state, transitions: [] }, sign, parameters);
      failedWith(await report([...log, keyed], [alice]), 3, "PARAMETER_FORBIDDEN");
    }
  });

  test("C12-63: two proofs are rejected", async () => {
    const { alice, log } = await harbor();
    const doubled = structuredClone(log);
    doubled[1].proof = [doubled[1].proof[0], doubled[1].proof[0]];
    failedWith(await report(doubled, [alice]), 1, "PROOF_COUNT");
  });

  test("C12-72: bip340-jcs-2025 author keys work; any other cryptosuite is rejected", async () => {
    const schnorr = seeded(22, "secp256k1");
    const bob = await VhAuthor.create([{ fragment: "btc", signer: schnorr }]);
    const genesis = await createOriginal({ versionTime: "2026-10-18T12:00:00.000Z", name: "Map", resources: [photo(B1)], author: bob.ref("btc"), sign: bob.signer(schnorr, "btc") });
    const r = await verifyOriginal({ log: [genesis], authors: [bob.evidence()], now: NOW, bytes: allBytes(B1) });
    expect(r.reasons).toEqual(["not-anchored"]);
    const other = structuredClone(genesis);
    other.proof[0].cryptosuite = "ecdsa-jcs-2019";
    failedWith(await verifyOriginal({ log: [other], authors: [bob.evidence()], now: NOW }), 0, "CRYPTOSUITE_NOT_PERMITTED");
  });

  test("versionTime carries milliseconds and no more (D5, owner decision Q8)", async () => {
    const { alice, log, sign } = await harbor();
    const fine = await resign(log[2], { ...log[2].state, transitions: [] }, sign, {}, "2026-10-18T12:30:00.001Z");
    expect((await report([...log, fine], [alice])).history.status).toBe("valid");
    const tooFine = await resign(log[2], { ...log[2].state, transitions: [] }, sign, {}, "2026-10-18T12:30:00.0001Z");
    failedWith(await report([...log, tooFine], [alice]), 3, "VERSION_TIME_FORMAT");
  });

  test("C12-82: histories beyond the profile limits report the last valid prefix as limit-exceeded", async () => {
    const { alice, log } = await harbor();
    const r = await report(log, [alice], { limits: { maxEntries: 2 } });
    expect(r.history.status).toBe("limit-exceeded");
    expect(r.history.entries).toBe(2);
    expect(r.current).toBe(false);
    const longAuthor = await report(log, [alice], { limits: { maxAuthorVersions: 0 } });
    expect(longAuthor.identityEvidence.status).toBe("incomplete");
    expect(longAuthor.current).toBe(false);
  });
});

describe("author binding (P5.2, P5.3, P5.8, P5.11)", () => {
  test("C12-05: a valid key of another identity cannot change the Original", async () => {
    const { alice, log } = await harbor();
    const mallory = await VhAuthor.create([{ fragment: "orig", signer: seeded(66) }]);
    const asMallory = await resign(log[2], { ...log[2].state, transitions: [], author: mallory.ref("orig") }, mallory.signer(seeded(66), "orig"));
    failedWith(await report([...log, asMallory], [alice, mallory]), 3, "AUTHOR_DID_CHANGED");
    // Naming Alice but proving with Mallory's key.
    const claiming = await resign(log[2], { ...log[2].state, transitions: [] }, mallory.signer(seeded(66), "orig"));
    failedWith(await report([...log, claiming], [alice, mallory]), 3, "AUTHOR_VM_MISMATCH", "author-binding");
  });

  test("C12-06: a key that is not a method of the named author DID fails author binding", async () => {
    const { alice, log } = await harbor();
    const loose = seeded(67);
    const entry = await resign(log[2], { ...log[2].state, transitions: [], author: alice.ref("loose") }, alice.signer(loose, "loose"));
    failedWith(await report([...log, entry], [alice]), 3, "AUTHOR_VM_NOT_IN_DOCUMENT", "author-binding");
  });

  test("C12-07, C12-52, C12-54: wrong relationship, controller or document", async () => {
    const key = seeded(21);
    const auth = seeded(68);
    const ctl = seeded(69);
    const alice = await VhAuthor.create([
      { fragment: "orig", signer: key },
      { fragment: "login", signer: auth, relationship: "authentication" },
      { fragment: "other", signer: ctl, controller: "did:example:someone-else" },
    ]);
    const at = clock();
    const genesis = (fragment: string, signer = key) => createOriginal({ versionTime: at(), name: "x", resources: [photo(B1)], author: alice.ref(fragment), sign: alice.signer(signer, fragment) });
    failedWith(await report([await genesis("login", auth)], [alice]), 0, "AUTHOR_VM_RELATIONSHIP", "author-binding");
    failedWith(await report([await genesis("other", ctl)], [alice]), 0, "AUTHOR_VM_CONTROLLER", "author-binding");
    const foreign = await createOriginal({
      versionTime: at(), name: "x", resources: [photo(B1)], sign: signWith(key, { cryptosuite: "eddsa-jcs-2022", verificationMethod: "did:example:elsewhere#orig" }),
      author: { did: alice.did, verificationMethod: "did:example:elsewhere#orig", versionId: alice.versionId },
    });
    failedWith(await report([foreign], [alice]), 0, "AUTHOR_VM_FOREIGN", "author-binding");
  });

  test("C12-55: a key expressed as JWK fails author binding", async () => {
    const key = seeded(21);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const doc = alice.document(alice.did, [{ fragment: "orig", signer: key }]);
    (doc.verificationMethod as JsonObject[])[0] = { id: `${alice.did}#orig`, type: "JsonWebKey", controller: alice.did, publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "AAAA" } };
    const v = await appendEntry(alice.entries[0], { versionTime: "2026-10-18T09:30:00Z", parameters: {}, state: doc, sign: signWith(alice.update, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${alice.update.publicKeyMultibase}#${alice.update.publicKeyMultibase}` }) });
    alice.entries.push(v);
    const genesis = await createOriginal({ versionTime: "2026-10-18T12:00:00.000Z", name: "x", resources: [photo(B1)], author: alice.ref("orig"), sign: alice.signer(key, "orig") });
    failedWith(await report([genesis], [alice]), 0, "AUTHOR_VM_TYPE", "author-binding");
  });

  test("C12-24: an update key of the author DID's own log cannot sign Originals (P5.3, P5.11)", async () => {
    const alice = await VhAuthor.create([]);
    await alice.rotate([{ fragment: "update", signer: alice.update }]);
    const genesis = await createOriginal({ versionTime: "2026-10-18T12:00:00.000Z", name: "x", resources: [photo(B1)], author: alice.ref("update"), sign: alice.signer(alice.update, "update") });
    failedWith(await report([genesis], [alice]), 0, "AUTHOR_KEY_IS_UPDATE_KEY", "author-binding");
  });

  test("C12-53: an entry without the author DID versionId is rejected", async () => {
    const { alice, log, sign } = await harbor();
    const { versionId: _v, ...noVersion } = log[2].state.author as JsonObject;
    const entry = await resign(log[2], { ...log[2].state, transitions: [], author: noVersion }, sign);
    failedWith(await report([...log, entry], [alice]), 3, "STATE_AUTHOR");
  });

  test("C12-56: the author DID is fixed and its version never goes backwards", async () => {
    const key = seeded(21);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const v1 = alice.versionId;
    const v2 = await alice.rotate([{ fragment: "orig", signer: key }]);
    const at = clock();
    const sign = alice.signer(key, "orig");
    const genesis = await createOriginal({ versionTime: at(), name: "x", resources: [photo(B1)], author: alice.ref("orig", v2), sign });
    const older = await updateOriginal(genesis, { versionTime: at(), name: "y", author: alice.ref("orig", v1), sign });
    failedWith(await report([genesis, older], [alice]), 1, "AUTHOR_VERSION_REGRESSED");
  });

  test("C12-57: an author DID method the profile does not list is rejected", async () => {
    const key = seeded(21);
    const mk = key.publicKeyMultibase;
    const genesis = await createOriginal({
      versionTime: "2026-10-18T12:00:00.000Z", name: "x", resources: [photo(B1)],
      author: { did: `did:key:${mk}`, verificationMethod: `did:key:${mk}#${mk}`, versionId: "1" },
      sign: signWith(key, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${mk}#${mk}` }),
    });
    const r = await verifyOriginal({ log: [genesis], authors: [], now: NOW });
    failedWith(r, 0, "AUTHOR_METHOD_NOT_LISTED", "unsupported-profile");
  });

  test("C12-09: missing author DID history is incomplete identity evidence, never a pass", async () => {
    const { log } = await harbor();
    const r = await verifyOriginal({ log, authors: [], now: NOW });
    expect(r.history.status).toBe("incomplete");
    expect(r.history.failure?.category).toBe("incomplete-evidence");
    expect(r.authorBinding.status).toBe("incomplete");
    expect(r.identityEvidence.status).toBe("incomplete");
    expect(r.current).toBe(false);
  });

  test("C12-41 (local): a key removed from the latest author DID leaves the history valid but not current (P7.9)", async () => {
    const { alice, log } = await harbor();
    await alice.rotate([{ fragment: "orig2", signer: seeded(23) }]);
    const r = await report(log, [alice], {});
    expect(r.history.status).toBe("valid");
    expect(r.current).toBe(false);
    expect(r.reasons).toContain("historically-authorized-only");
  });

  test("a key embedded under assertionMethod binds, and stays current while listed", async () => {
    const key = seeded(24);
    const alice = await VhAuthor.create([]);
    const doc = alice.document(alice.did, []);
    doc.assertionMethod = [{ id: `${alice.did}#emb`, type: "Multikey", controller: alice.did, publicKeyMultibase: key.publicKeyMultibase }];
    alice.entries.push(await appendEntry(alice.entries[0], {
      versionTime: "2026-10-18T09:30:00Z", parameters: {}, state: doc,
      sign: signWith(alice.update, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${alice.update.publicKeyMultibase}#${alice.update.publicKeyMultibase}` }),
    }));
    const genesis = await createOriginal({ versionTime: "2026-10-18T12:00:00.000Z", name: "x", resources: [photo(B1)], author: alice.ref("emb"), sign: alice.signer(key, "emb") });
    const r = await report([genesis], [alice], {});
    expect(r.reasons).toEqual(["not-anchored"]);
  });

  test("C12-48 (local): a deactivated author DID makes an unanchored Original non-current (P6.5)", async () => {
    const { alice, log } = await harbor();
    await alice.deactivate();
    const r = await report(log, [alice], {});
    expect(r.identityEvidence.deactivated).toBe(true);
    expect(r.current).toBe(false);
    expect(r.reasons).toContain("author-did-deactivated");
  });

  test("a did:webvh author from didwebvh-ts signs Originals with its assertionMethod key", async () => {
    const fx = parseJson(readFileSync(new URL("./fixtures/didwebvh-ts-2.8.0.json", import.meta.url), "utf8")) as unknown as { did: string; logA: LogEntry[]; witnessA: unknown[] };
    const key = seeded(21); // the fixture's assertionMethod key
    const vm = ((fx.logA[3].state.verificationMethod as JsonObject[])[0].id) as string;
    const ref: AuthorRef = { did: fx.did, verificationMethod: vm, versionId: fx.logA[3].versionId };
    const genesis = await createOriginal({ versionTime: "2026-10-18T12:00:00.000Z", name: "Harbor", resources: [photo(B1)], author: ref, sign: signWith(key, { cryptosuite: "eddsa-jcs-2022", verificationMethod: vm }) });
    const evidence = { did: fx.did, log: serializeLog(fx.logA), witness: fx.witnessA };
    const r = await verifyOriginal({ log: [genesis], authors: [evidence], now: NOW, bytes: allBytes(B1) });
    expect(r.reasons).toEqual(["not-anchored"]);
    // The rotated-away update key k1 is not an author key.
    const unwitnessed = await verifyOriginal({ log: [genesis], authors: [{ did: fx.did, log: serializeLog(fx.logA) }], now: NOW });
    expect(unwitnessed.identityEvidence.status).toBe("incomplete");
  });
});

describe("the derived DID document and generic resolvers (P3.5, P3.8)", () => {
  test("C12-69 and C12-68: every resolver derives the same document from the log; no stored document is used", async () => {
    const { alice, log } = await harbor();
    const r = await report(log, [alice]);
    const did = r.original!;
    expect(r.document).toEqual({
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: did,
      controller: alice.did,
      service: [{ id: `${did}#files`, type: "OriginalsFiles", serviceEndpoint: { photo: { mediaType: "image/jpeg", size: bytes(B2).length, digest: resourceDigest(bytes(B2)) } } }],
    });
    const history = await verifyAuthorHistory(alice.evidence(), { now: NOW });
    const resolved = await resolveDidVh(did, { didLog: serializeLog(log), extensions: [originalsExtension([history])], now: NOW });
    expect(resolved.didDocument).toEqual(r.document);
    // The state is not a DID document, so there is nothing stored to prefer.
    expect(log[2].state.verificationMethod).toBeUndefined();
  });

  test("C12-70: a plain did:vh resolver rejects an Originals log by its method value", async () => {
    const { log } = await harbor();
    const r = await resolveDidVh(`did:vh:${log[0].parameters.scid as string}`, { didLog: log, now: NOW });
    expect(r.didResolutionMetadata.error).toBe("invalidDid");
    expect(r.didResolutionMetadata.problemDetails?.code).toBe("VERSION_UNSUPPORTED");
    expect(ORIGINALS_METHOD).toBe("originals:1.0");
  });

  test("C12-71: a later entry cannot move the log to plain did:vh", async () => {
    const { alice, log, sign } = await harbor();
    const moved = await resign(log[2], { ...log[2].state, transitions: [] }, sign, { method: "did:vh:1.0" });
    failedWith(await report([...log, moved], [alice]), 3, "VERSION_UNSUPPORTED");
  });

  test("C12-65: a VH-valid log that breaks Originals rules is not Originals-verified", async () => {
    const { alice, log, sign } = await harbor();
    const bad = await resign(log[2], { ...log[2].state, transitions: [], asset: { name: "x" } }, sign);
    // A permissive specialisation that only checks the log mechanism accepts it.
    const history = await verifyAuthorHistory(alice.evidence(), { now: NOW });
    const ext = originalsExtension([history]);
    const permissive: Specialisation = { name: "mechanism only", versionParameter: "method", versions: ext.methods, keys: ext.keys, versionTime: ext.versionTime };
    expect((await verifyLog([...log, bad], { specialisation: permissive, now: NOW })).failure).toBeUndefined();
    expect((await report([...log, bad], [alice])).history.status).toBe("invalid");
  });

  test("the genesis must be a create; later entries must not be", async () => {
    const { alice, log, sign } = await harbor();
    const recreate = await resign(log[2], { ...log[2].state, transitions: [], operation: "create" }, sign);
    failedWith(await report([...log, recreate], [alice]), 3, "STATE_OPERATION");
    // There are no publish or migrate operations: publication and anchoring are updates that add an
    // alias (P9.10, P14.4), so any other operation is invalid evidence, never an unsupported profile.
    for (const operation of ["migrate", "publish"]) {
      const other = await resign(log[2], { ...log[2].state, transitions: [], operation }, sign);
      failedWith(await report([...log, other], [alice]), 3, "STATE_OPERATION", "invalid-evidence");
      const asDeactivation = await resign(log[2], { ...log[2].state, transitions: [], operation }, sign, { deactivated: true });
      failedWith(await report([...log, asDeactivation], [alice]), 3, "STATE_OPERATION", "invalid-evidence");
      const genesis = await createLog({ versionTime: "2026-10-18T12:00:00.000Z", parameters: { method: ORIGINALS_METHOD, scid: "{SCID}" }, state: { ...log[0].state, id: "did:vh:{SCID}", operation }, sign });
      failedWith(await report([genesis], [alice]), 0, "STATE_OPERATION", "invalid-evidence");
    }
  });

  test("C12-50: an asset log entry that sets a non-empty witness parameter is rejected; so is {} (P9.8, P9.9, P14.1)", async () => {
    const { alice, log, sign } = await harbor();
    const witnesses = { threshold: 2, witnesses: [5, 6, 7].map((n) => ({ id: `did:key:${seeded(n).publicKeyMultibase}` })) };
    const witnessed = await resign(log[2], { ...log[2].state, transitions: [] }, sign, { witness: witnesses });
    failedWith(await report([...log, witnessed], [alice]), 3, "WITNESS_NOT_PERMITTED", "invalid-evidence");
    // P14.1: an author entry's parameters are exactly {}, so even `witness: {}` is rejected.
    const empty = await resign(log[2], { ...log[2].state, transitions: [] }, sign, { witness: {} });
    failedWith(await report([...log, empty], [alice]), 3, "PARAMETER_MEMBERS", "invalid-evidence");
  });

  test("digests are multibase base58btc sha2-256 multihashes (PROVISIONAL, D4)", () => {
    const d = resourceDigest(bytes("abc"));
    expect(d).toBe(`z${base58btcEncode(new Uint8Array([0x12, 0x20, ...sha256(bytes("abc"))]))}`);
    expect(d.startsWith("zQm")).toBe(true);
  });
});

describe("section 14: exact members (P14.1, P14.4, P14.8)", () => {
  test("P14.1: genesis parameters are exactly method and scid", async () => {
    const { alice, key, sign, ref } = await harbor();
    const genesisWith = async (extra: JsonObject) => {
      const base = await createOriginal({ versionTime: "2026-10-18T12:00:00.000Z", name: "Harbor", resources: [photo(B1)], author: ref, sign });
      const state = { ...base.state, id: "did:vh:{SCID}" };
      return createLog({ versionTime: "2026-10-18T12:00:00.000Z", parameters: { method: ORIGINALS_METHOD, scid: "{SCID}", ...extra }, state, sign });
    };
    expect((await report([await genesisWith({})], [alice])).history.status).toBe("valid");
    for (const extra of [{ ttl: 60 }, { watchers: ["https://w.example.com"] }, { witness: {} }, { deactivated: false }]) {
      failedWith(await report([await genesisWith(extra)], [alice]), 0, "PARAMETER_MEMBERS", "invalid-evidence");
    }
    // Keys come from the author DID, and nothing is null (VH-Log; already rejected by the engine).
    failedWith(await report([await genesisWith({ updateKeys: [key.publicKeyMultibase] })], [alice]), 0, "PARAMETER_FORBIDDEN", "invalid-evidence");
    failedWith(await report([await genesisWith({ ttl: null })], [alice]), 0, "PARAMETER_NULL", "invalid-evidence");
  });

  test("P14.1: every later author entry has {} parameters; a deactivation exactly {\"deactivated\": true}", async () => {
    const { alice, log, sign } = await harbor();
    const same = { ...log[2].state, transitions: [] };
    for (const parameters of [{ ttl: 60 }, { method: ORIGINALS_METHOD }, { deactivated: false }, { watchers: [] }]) {
      failedWith(await report([...log, await resign(log[2], same, sign, parameters)], [alice]), 3, "PARAMETER_MEMBERS", "invalid-evidence");
    }
    const off = { ...log[2].state, operation: "deactivate", asset: { ...(log[2].state.asset as JsonObject), status: "deactivated" }, transitions: [] };
    const deactivated = await report([...log, await resign(log[2], off, sign, { deactivated: true })], [alice]);
    expect(deactivated.history.status, JSON.stringify(deactivated.history.failure)).toBe("valid");
    failedWith(await report([...log, await resign(log[2], off, sign, { deactivated: true, ttl: 60 })], [alice]), 3, "PARAMETER_MEMBERS", "invalid-evidence");
  });

  test("C12-174: P14.4, P14.8: a proof has exactly type, cryptosuite, verificationMethod, proofPurpose and proofValue", async () => {
    const { alice, key, log, ref } = await harbor();
    const same = { ...log[2].state, transitions: [] };
    const base = { type: "DataIntegrityProof", cryptosuite: "eddsa-jcs-2022", verificationMethod: ref.verificationMethod, proofPurpose: "assertionMethod" } as const;
    const signedWith = (extra: JsonObject) => async (unsigned: JsonObject) => [await createProof(unsigned, { ...base, ...extra } as never, key)];
    expect((await report([...log, await appendEntry(log[2], { versionTime: "2026-10-18T12:30:00.000Z", parameters: {}, state: same, sign: signedWith({}) })], [alice])).history.status).toBe("valid");
    // A proof @context changes what is verified, so that proof already fails its signature.
    const withContext = await appendEntry(log[2], { versionTime: "2026-10-18T12:30:00.000Z", parameters: {}, state: same, sign: signedWith({ "@context": ["https://w3id.org/security/data-integrity/v2"] }) });
    expect((await report([...log, withContext], [alice])).history.status).toBe("invalid");
    const extras: JsonObject[] = [
      { id: "urn:uuid:1" }, { created: "2026-10-18T12:30:00Z" }, { expires: "2027-10-18T12:30:00Z" },
      { domain: "example.com" }, { challenge: "c" }, { nonce: "n" }, { previousProof: "urn:uuid:0" },
    ];
    for (const extra of extras) {
      const entry = await appendEntry(log[2], { versionTime: "2026-10-18T12:30:00.000Z", parameters: {}, state: same, sign: signedWith(extra) });
      failedWith(await report([...log, entry], [alice]), 3, "PROOF_MEMBERS", "invalid-evidence");
    }
  });
});

describe("section 14: the asset log's form (P14.2)", () => {
  test("versionTime ends in Z, with at most three fractional digits", async () => {
    const { alice, log, sign } = await harbor();
    const same = { ...log[2].state, transitions: [] };
    for (const versionTime of ["2026-10-18T12:30:00.000+00:00", "2026-10-18T12:30:00+00:00", "2026-10-18T12:30:00.0001Z"]) {
      failedWith(await report([...log, await resign(log[2], same, sign, {}, versionTime)], [alice]), 3, "VERSION_TIME_FORMAT", "invalid-evidence");
    }
    for (const versionTime of ["2026-10-18T12:30:00Z", "2026-10-18T12:30:00.5Z", "2026-10-18T12:30:00.123Z"]) {
      expect((await report([...log, await resign(log[2], same, sign, {}, versionTime)], [alice])).history.status).toBe("valid");
    }
  });

  test("C12-173, C12-179: each line of an asset log is compact JSON ending in one LF: a missing final LF, CRLF or whitespace between tokens is rejected", async () => {
    const { alice, log } = await harbor();
    const text = serializeLog(log);
    expect((await report(text, [alice])).history.status).toBe("valid");
    failedWith(await report(text.slice(0, -1), [alice]), 2, "LOG_LINE_FORMAT", "invalid-evidence");
    failedWith(await report(text.replaceAll("\n", "\r\n"), [alice]), 0, "LOG_LINE_FORMAT", "invalid-evidence");
    // The same entry with a space after a colon: valid JSON, the same versionId and proof, not compact.
    const lines = text.split("\n");
    lines[1] = lines[1].replace('"versionTime":', '"versionTime": ');
    failedWith(await report(lines.join("\n"), [alice]), 1, "LOG_LINE_FORMAT", "invalid-evidence");
    lines[1] = `${lines[1].replace('"versionTime": ', '"versionTime":')}\t`;
    failedWith(await report(lines.join("\n"), [alice]), 1, "LOG_LINE_FORMAT", "invalid-evidence");
    // Spaces inside strings are content, not whitespace.
    expect(text).toContain("Harbor at dawn");
  });

  test("C12-179: P14.2: key order and string escapes in a line are not constrained, because hashes and proofs are over the JCS form", async () => {
    const { alice, log } = await harbor();
    const lines = serializeLog(log).split("\n");
    // The same entry with its top-level members reversed, and a name escaped differently.
    const entry = JSON.parse(lines[1]) as Record<string, unknown>;
    lines[1] = JSON.stringify(Object.fromEntries(Object.entries(entry).reverse())).replace("Harbor", "\\u0048arbor");
    expect(lines[1].startsWith('{"proof"')).toBe(true);
    const r = await report(lines.join("\n"), [alice]);
    expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
    expect(r.head).toBe(log[log.length - 1].versionId);
  });

  test("C12-185: P14.5: a name of 1,024 UTF-16 code units is accepted and one of 1,025 rejected, a non-BMP character counting as two", async () => {
    const { alice, log, sign } = await harbor();
    const named = (name: string) => resign(log[2], { ...log[2].state, transitions: [], asset: { ...(log[2].state.asset as JsonObject), name } }, sign);
    const clef = "\u{1D11E}"; // two UTF-16 code units
    expect(clef.length).toBe(2);
    const fits = await report([...log, await named(clef + "a".repeat(1022))], [alice]);
    expect(fits.history.status, JSON.stringify(fits.history.failure)).toBe("valid");
    failedWith(await report([...log, await named(clef + "a".repeat(1023))], [alice]), 3, "STATE_NAME", "invalid-evidence");
  });

  test("C12-172: P14.3: a number whose magnitude is greater than 2^53 - 1 is rejected however it is written; other numbers are kept", async () => {
    const { alice, log, sign } = await harbor();
    // Re-signed with the number as the parser reads it, so only its value is judged.
    const signedWith = async (value: number, written: string) => {
      const entry = await resign(log[2], { ...log[2].state, transitions: [], asset: { ...(log[2].state.asset as JsonObject), metadata: { n: value } } }, sign);
      return serializeLog([...log, entry]).replace(`"metadata":{"n":${JSON.stringify(value)}}`, `"metadata":{"n":${written}}`);
    };
    for (const [value, written] of [[1e16, "1e16"], [-1e16, "-1e16"], [9007199254740992, "9007199254740993.0"], [9007199254740992, "9007199254740991.5"], [9007199254740991, "9007199254740991.4"], [9007199254740991, "9007199254740991.0000001"], [1.5e300, "1.5e300"]] as const) {
      failedWith(await report(await signedWith(value, written), [alice]), 3, "JSON_UNSAFE_NUMBER", "invalid-evidence");
    }
    // Given already parsed, too.
    const parsed = await resign(log[2], { ...log[2].state, transitions: [], asset: { ...(log[2].state.asset as JsonObject), metadata: { n: 1e16 } } }, sign);
    failedWith(await report([...log, parsed], [alice]), 3, "JSON_UNSAFE_NUMBER", "invalid-evidence");
    // Any negative zero, however written, including a negative number that underflows to it.
    for (const written of ["-0", "-0.0", "-0e0", "-1e-400"]) {
      failedWith(await report(await signedWith(0, written), [alice]), 3, "JSON_UNSAFE_NUMBER", "invalid-evidence");
    }
    for (const [value, written] of [[1e15, "1e15"], [9007199254740991, "9007199254740991.0"], [-9007199254740991, "-9.007199254740991e15"], [1.5, "1.5"], [1e-7, "1e-7"]] as const) {
      const r = await report(await signedWith(value, written), [alice]);
      expect(r.history.status, `${written}: ${JSON.stringify(r.history.failure)}`).toBe("valid");
    }
  });

  test("a did:vh or did:webvh signer log keeps its own method's line rules", async () => {
    const { alice, log } = await harbor();
    const signerLog = alice.evidence().log as string;
    const r = await verifyOriginal({ log, authors: [{ did: alice.did, log: signerLog.replaceAll("\n", "\r\n").slice(0, -2) }], now: NOW, bytes: allBytes(B1, B2) });
    expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
    expect(r.identityEvidence.status).toBe("complete");
  });
});

describe("creating needs a well-formed entry", () => {
  test("a create with an invalid genesis is refused by the builder", async () => {
    const key = seeded(21);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const base = { versionTime: "2026-10-18T12:00:00.000Z", author: alice.ref("orig"), sign: alice.signer(key, "orig") };
    await expect(createOriginal({ ...base, name: "", resources: [photo(B1)] })).rejects.toThrow(OriginalsError);
    await expect(createOriginal({ ...base, name: "x", resources: [photo(B1), photo(B2)] })).rejects.toThrow(OriginalsError);
    await expect(createOriginal({ ...base, name: "x", resources: [{ ...photo(B1), mediaType: "not a type" }] })).rejects.toThrow(OriginalsError);
    await expect(createLog({ versionTime: base.versionTime, parameters: { method: ORIGINALS_METHOD, scid: "{SCID}" }, state: {}, sign: base.sign })).resolves.toBeDefined();
  });
});

describe("C12-150: entry size is the UTF-8 byte length of its stored line (P7.7; P14.13)", () => {
  /** A genesis entry whose stored line, without its line feed, is exactly `target` UTF-8 bytes, mostly two-byte characters. */
  async function genesisOf(target: number) {
    const key = seeded(21);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const ref = alice.ref("orig");
    const wide = "é".repeat(30_000); // 60,000 UTF-8 bytes, 30,000 UTF-16 code units
    let pad = 0;
    for (let i = 0; i < 40; i++) {
      const entry = await createOriginal({ versionTime: "2026-10-18T12:00:00.000Z", name: "Harbor", metadata: { wide, pad: "a".repeat(pad) }, resources: [photo(B1)], author: ref, sign: alice.signer(key, "orig") });
      const line = serializeLog([entry]).slice(0, -1);
      const size = new TextEncoder().encode(line).length;
      if (size === target) return { alice, line, codeUnits: line.length };
      pad += target - size;
    }
    throw new Error(`no entry of ${target} bytes`);
  }

  test("a line of 65,536 bytes is accepted and one of 65,537 bytes is rejected, however few UTF-16 code units it has", async () => {
    const atLimit = await genesisOf(65_536);
    expect(atLimit.codeUnits).toBeLessThan(40_000);
    const ok = await verifyOriginal({ log: `${atLimit.line}\n`, authors: [atLimit.alice.evidence()], now: NOW, bytes: allBytes(B1) });
    expect(ok.history.status, JSON.stringify(ok.history.failure)).toBe("valid");
    const over = await genesisOf(65_537);
    const r = await verifyOriginal({ log: `${over.line}\n`, authors: [over.alice.evidence()], now: NOW, bytes: allBytes(B1) });
    failedWith(r, 0, "ENTRY_TOO_LARGE", "limit-exceeded");
    expect(r.history.status).toBe("limit-exceeded");
    // Parsed entries are measured as the line they serialize to.
    const parsed = await verifyOriginal({ log: [JSON.parse(over.line)], authors: [over.alice.evidence()], now: NOW, bytes: allBytes(B1) });
    failedWith(parsed, 0, "ENTRY_TOO_LARGE", "limit-exceeded");
  });

  test("the stored line is measured, never its parsed form re-serialized: a 65,536-byte line that re-serializes longer is accepted", async () => {
    const key = seeded(21);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    // `1.5e-6` re-serializes as `0.0000015`: the same entry, and the same versionId and proof, three bytes longer each time.
    const nums = Array.from({ length: 200 }, () => 1.5e-6);
    let pad = 0;
    for (let i = 0; i < 40; i++) {
      const entry = await createOriginal({ versionTime: "2026-10-18T12:00:00.000Z", name: "Harbor", metadata: { nums, pad: "a".repeat(pad) }, resources: [photo(B1)], author: alice.ref("orig"), sign: alice.signer(key, "orig") });
      const line = serializeLog([entry]).slice(0, -1).replaceAll("0.0000015", "1.5e-6");
      const size = new TextEncoder().encode(line).length;
      if (size !== 65_536) {
        pad += 65_536 - size;
        continue;
      }
      expect(new TextEncoder().encode(JSON.stringify(JSON.parse(line))).length).toBe(66_136);
      const r = await verifyOriginal({ log: `${line}\n`, authors: [alice.evidence()], now: NOW, bytes: allBytes(B1) });
      expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
      // Entries parsed with parseLog carry their stored line's size; one parsed elsewhere is measured as its JCS line.
      const parsed = await verifyOriginal({ log: parseLog(`${line}\n`), authors: [alice.evidence()], now: NOW, bytes: allBytes(B1) });
      expect(parsed.history.status, JSON.stringify(parsed.history.failure)).toBe("valid");
      failedWith(await verifyOriginal({ log: [JSON.parse(line)], authors: [alice.evidence()], now: NOW, bytes: allBytes(B1) }), 0, "ENTRY_TOO_LARGE", "limit-exceeded");
      return;
    }
    throw new Error("no entry of 65,536 bytes");
  });
});
