import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { base58btcEncode, multibaseEncode, sha256 } from "../src/crypto/index.js";
import { OriginalsError } from "../src/errors.js";
import { parseJson, type JsonObject } from "../src/json/index.js";
import { appendEntry, createLog, serializeLog, signWith, verifyLog, type LogEntry, type Specialisation } from "../src/log/index.js";
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
    const r = await verifyOriginal({ log: serializeLog(log), authors: [alice.evidence()], now: NOW, bytes: allBytes(B1, B2), freshness: "asserted" });
    expect(r.history.status).toBe("valid");
    expect(r.authorBinding.status).toBe("valid");
    expect(r.identityEvidence).toMatchObject({ status: "complete", author: alice.did, latestVersionId: alice.versionId, freshness: "asserted" });
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
    expect(r.current).toBe(true);
  });

  test("without a freshness assertion the result is verified but not current (P7.8)", async () => {
    const { alice, log } = await harbor();
    const r = await report(log, [alice]);
    expect(r.history.status).toBe("valid");
    expect(r.identityEvidence.freshness).toBe("not-established");
    expect(r.current).toBe(false);
    expect(r.reasons).toContain("author-freshness-not-established");
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
    const r = await report(log, [alice], { bytes: tampered, freshness: "asserted" });
    expect(r.resources.status).toBe("digest-failure");
    expect(r.resources.failures.map((v) => [v.version, v.bytes])).toEqual([[2, "mismatch"]]);
    expect(r.current).toBe(false);
  });

  test("C12-10: missing historical bytes give explicit partial availability; supplied bytes are still checked", async () => {
    const { alice, log } = await harbor();
    const r = await report(log, [alice], { bytes: allBytes(B2), freshness: "asserted" });
    expect(r.resources.status).toBe("partial");
    expect(r.resources.missing.map((v) => [v.resource, v.version, v.versionId])).toEqual([["photo", 1, log[0].versionId]]);
    expect(r.resources.versions[1].bytes).toBe("verified");
    expect(r.history.status).toBe("valid");
    expect(r.current).toBe(false);
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

  test("C12-16: resources cannot be added, removed or renamed after genesis", async () => {
    const { alice, log, ref, sign, at } = await harbor();
    await expect(updateOriginal(log[2], { versionTime: at(), resources: [photo("x", "sidecar")], author: ref, sign })).rejects.toThrow(OriginalsError);
    const asset = log[2].state.asset as JsonObject;
    for (const resources of [[photo(B2), photo("x", "sidecar")], [], [photo(B2, "image")]]) {
      const entry = await resign(log[2], { ...log[2].state, transitions: [], asset: { ...asset, resources } }, sign);
      failedWith(await report([...log, entry], [alice]), 3, "STATE_RESOURCE_SET");
    }
  });

  test("C12-89: a digest outside the SHA-256 set is an unsupported profile", async () => {
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

  test("C12-82: a delta instead of the full asset state is rejected", async () => {
    const { alice, log, sign } = await harbor();
    const delta = await resign(log[2], { ...log[2].state, asset: { metadata: { caption: "x" } } }, sign);
    failedWith(await report([...log, delta], [alice]), 3, "STATE_MEMBERS");
  });

  test("C12-88: an undefined state member or duplicate JSON keys are rejected", async () => {
    const { alice, log, sign } = await harbor();
    const extra = await resign(log[2], { ...log[2].state, note: "unsigned-looking" }, sign);
    failedWith(await report([...log, extra], [alice]), 3, "STATE_MEMBERS");
    const text = serializeLog(log).replace('"operation":"create"', '"operation":"create","operation":"create"');
    const r = await report(text, [alice]);
    expect(r.history.failure?.code).toBe("JSON_DUPLICATE_KEY");
    expect(r.history.entries).toBe(0);
  });

  test("C12-85: lifecycle status and VH deactivated must agree", async () => {
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
    const r = await report([...log, end], [alice], { freshness: "asserted" });
    expect(r.deactivated).toBe(true);
    expect(r.state?.status).toBe("deactivated");
    expect(r.history.status).toBe("valid");
    const after = await resign(end, { ...log[2].state }, sign);
    failedWith(await report([...log, end, after], [alice]), 4, "ENTRY_AFTER_DEACTIVATION");
    expect((await report([...log, end], [alice], { checkpoint: log[1].versionId })).state?.status).toBe("active");
  });

  test("C12-58: an entry that sets updateKeys or nextKeyHashes is rejected", async () => {
    const { alice, log, sign } = await harbor();
    for (const parameters of [{ updateKeys: [seeded(3).publicKeyMultibase] }, { nextKeyHashes: [] }]) {
      const keyed = await resign(log[2], { ...log[2].state, transitions: [] }, sign, parameters);
      failedWith(await report([...log, keyed], [alice]), 3, "PARAMETER_FORBIDDEN");
    }
  });

  test("C12-72: two proofs are rejected", async () => {
    const { alice, log } = await harbor();
    const doubled = structuredClone(log);
    doubled[1].proof = [doubled[1].proof[0], doubled[1].proof[0]];
    failedWith(await report(doubled, [alice]), 1, "PROOF_COUNT");
  });

  test("C12-81: bip340-jcs-2025 author keys work; any other cryptosuite is rejected", async () => {
    const schnorr = seeded(22, "secp256k1");
    const bob = await VhAuthor.create([{ fragment: "btc", signer: schnorr }]);
    const genesis = await createOriginal({ versionTime: "2026-10-18T12:00:00.000Z", name: "Map", resources: [photo(B1)], author: bob.ref("btc"), sign: bob.signer(schnorr, "btc") });
    const r = await verifyOriginal({ log: [genesis], authors: [bob.evidence()], now: NOW, bytes: allBytes(B1), freshness: "asserted" });
    expect(r.current).toBe(true);
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

  test("C12-91: histories beyond the profile limits report the last valid prefix as limit-exceeded", async () => {
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

  test("C12-07, C12-60, C12-62: wrong relationship, controller or document", async () => {
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

  test("C12-63: a key expressed as JWK fails author binding", async () => {
    const key = seeded(21);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const doc = alice.document(alice.did, [{ fragment: "orig", signer: key }]);
    (doc.verificationMethod as JsonObject[])[0] = { id: `${alice.did}#orig`, type: "JsonWebKey", controller: alice.did, publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: "AAAA" } };
    const v = await appendEntry(alice.entries[0], { versionTime: "2026-10-18T09:30:00Z", parameters: {}, state: doc, sign: signWith(alice.update, { cryptosuite: "eddsa-jcs-2022", verificationMethod: `did:key:${alice.update.publicKeyMultibase}#${alice.update.publicKeyMultibase}` }) });
    alice.entries.push(v);
    const genesis = await createOriginal({ versionTime: "2026-10-18T12:00:00.000Z", name: "x", resources: [photo(B1)], author: alice.ref("orig"), sign: alice.signer(key, "orig") });
    failedWith(await report([genesis], [alice]), 0, "AUTHOR_VM_TYPE", "author-binding");
  });

  test("P5.11: an update key of the author DID's own log cannot sign Originals", async () => {
    const alice = await VhAuthor.create([]);
    await alice.rotate([{ fragment: "update", signer: alice.update }]);
    const genesis = await createOriginal({ versionTime: "2026-10-18T12:00:00.000Z", name: "x", resources: [photo(B1)], author: alice.ref("update"), sign: alice.signer(alice.update, "update") });
    failedWith(await report([genesis], [alice]), 0, "AUTHOR_KEY_IS_UPDATE_KEY", "author-binding");
  });

  test("C12-61: an entry without the author DID versionId is rejected", async () => {
    const { alice, log, sign } = await harbor();
    const { versionId: _v, ...noVersion } = log[2].state.author as JsonObject;
    const entry = await resign(log[2], { ...log[2].state, transitions: [], author: noVersion }, sign);
    failedWith(await report([...log, entry], [alice]), 3, "STATE_AUTHOR");
  });

  test("C12-64: the author DID is fixed and its version never goes backwards", async () => {
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

  test("C12-65: an author DID method the profile does not list is rejected", async () => {
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
    const r = await verifyOriginal({ log, authors: [], now: NOW, freshness: "asserted" });
    expect(r.history.status).toBe("incomplete");
    expect(r.history.failure?.category).toBe("incomplete-evidence");
    expect(r.authorBinding.status).toBe("incomplete");
    expect(r.identityEvidence.status).toBe("incomplete");
    expect(r.current).toBe(false);
  });

  test("C12-46 (local): a key removed from the latest author DID leaves the history valid but not current (P7.9)", async () => {
    const { alice, log } = await harbor();
    await alice.rotate([{ fragment: "orig2", signer: seeded(23) }]);
    const r = await report(log, [alice], { freshness: "asserted" });
    expect(r.history.status).toBe("valid");
    expect(r.current).toBe(false);
    expect(r.reasons).toContain("head-key-not-in-latest-author-document");
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
    const r = await report([genesis], [alice], { freshness: "asserted" });
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
  });

  test("C12-57 (local): a deactivated author DID makes an unanchored Original non-current (P6.5)", async () => {
    const { alice, log } = await harbor();
    await alice.deactivate();
    const r = await report(log, [alice], { freshness: "asserted" });
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
    const r = await verifyOriginal({ log: [genesis], authors: [evidence], now: NOW, bytes: allBytes(B1), freshness: "asserted" });
    expect(r.current, JSON.stringify(r.reasons)).toBe(true);
    // The rotated-away update key k1 is not an author key.
    const unwitnessed = await verifyOriginal({ log: [genesis], authors: [{ did: fx.did, log: serializeLog(fx.logA) }], now: NOW });
    expect(unwitnessed.identityEvidence.status).toBe("incomplete");
  });
});

describe("the derived DID document and generic resolvers (P3.5, P3.8)", () => {
  test("C12-78 and C12-77: every resolver derives the same document from the log; no stored document is used", async () => {
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

  test("C12-79: a plain did:vh resolver rejects an Originals log by its method value", async () => {
    const { log } = await harbor();
    const r = await resolveDidVh(`did:vh:${log[0].parameters.scid as string}`, { didLog: log, now: NOW });
    expect(r.didResolutionMetadata.error).toBe("invalidDid");
    expect(r.didResolutionMetadata.problemDetails?.code).toBe("VERSION_UNSUPPORTED");
    expect(ORIGINALS_METHOD).toBe("originals:1.0");
  });

  test("C12-80: a later entry cannot move the log to plain did:vh", async () => {
    const { alice, log, sign } = await harbor();
    const moved = await resign(log[2], { ...log[2].state, transitions: [] }, sign, { method: "did:vh:1.0" });
    failedWith(await report([...log, moved], [alice]), 3, "VERSION_UNSUPPORTED");
  });

  test("C12-74: a VH-valid log that breaks Originals rules is not Originals-verified", async () => {
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
    const publish = await resign(log[2], { ...log[2].state, transitions: [], operation: "publish" }, sign);
    failedWith(await report([...log, publish], [alice]), 3, "STATE_OPERATION_UNSUPPORTED", "unsupported-profile");
  });

  test("an asset log never activates witnesses; an empty witness parameter is a no-op (owner decision Q14)", async () => {
    const { alice, log, sign } = await harbor();
    const witnesses = { threshold: 2, witnesses: [5, 6, 7].map((n) => ({ id: `did:key:${seeded(n).publicKeyMultibase}` })) };
    const witnessed = await resign(log[2], { ...log[2].state, transitions: [] }, sign, { witness: witnesses });
    failedWith(await report([...log, witnessed], [alice]), 3, "WITNESS_NOT_PERMITTED", "invalid-evidence");
    const empty = await resign(log[2], { ...log[2].state, transitions: [] }, sign, { witness: {} });
    const r = await report([...log, empty], [alice], { freshness: "asserted" });
    expect(r.history.status).toBe("valid");
    expect(r.ordering).toBe("claimed");
  });

  test("digests are multibase base58btc sha2-256 multihashes (PROVISIONAL, D4)", () => {
    const d = resourceDigest(bytes("abc"));
    expect(d).toBe(`z${base58btcEncode(new Uint8Array([0x12, 0x20, ...sha256(bytes("abc"))]))}`);
    expect(d.startsWith("zQm")).toBe(true);
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
