/**
 * Unanchored Originals are never current (originals-spec #46, merged in
 * master 051049d8b): P7.10, P7.9, P6.5, P5.18. Off Bitcoin nothing shows that
 * a newer entry or another branch does not exist, so a valid unanchored
 * Original is reported only as valid as of its verified checkpoint, with the
 * signer DID versions relied on and when that evidence was obtained. An entry
 * whose key its signer's latest verified DID state no longer lists, or any
 * entry once the author DID is deactivated, is historically authorized only,
 * and every result that includes it says so, without invalidating the
 * checkpoint.
 */
import { describe, expect, test } from "bun:test";
import type { LogEntry } from "../src/log/index.js";
import { createOriginal, resourceDigest, updateOriginal, verifyOriginal, type EditorGrant, type OriginalsReport } from "../src/originals/index.js";
import { NOW, VhAuthor, bytes, clock, photo, seeded } from "./helpers/originals.js";

const B1 = "harbor at dawn, first crop";
const B2 = "harbor at dawn, tighter crop";
const B3 = "harbor at dawn, wide";
const allBytes = Object.fromEntries([B1, B2, B3].map((t) => [resourceDigest(bytes(t)), bytes(t)]));
const KA = seeded(21);
const KB = seeded(31);
const grant = (did: string, g: Partial<Omit<EditorGrant, "did">> = {}): EditorGrant => ({ did, name: false, metadata: false, resources: [], ...g });
const FETCHED = new Date(NOW - 2_000).toISOString();

async function harbor() {
  const alice = await VhAuthor.create([{ fragment: "orig", signer: KA }]);
  const bob = await VhAuthor.create([{ fragment: "edit", signer: KB }]);
  const at = clock();
  const ref = alice.ref("orig");
  const sign = alice.signer(KA, "orig");
  const genesis = await createOriginal({ versionTime: at(), name: "Harbor at dawn", resources: [photo(B1)], author: ref, sign, editors: [grant(bob.did, { resources: ["photo"] })] });
  const cropped = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], author: ref, sign });
  const asBob = { editor: bob.ref("edit"), sign: bob.signer(KB, "edit") };
  return { alice, bob, at, ref, sign, genesis, cropped, asBob };
}

const verify = (log: LogEntry[], dids: VhAuthor[], extra: Partial<Parameters<typeof verifyOriginal>[0]> = {}): Promise<OriginalsReport> =>
  verifyOriginal({ log, authors: dids.map((a) => ({ ...a.evidence(), obtainedAt: FETCHED, source: "fetched" as const })), now: NOW, bytes: allBytes, ...extra });

describe("P7.10: an unanchored Original is never current", () => {
  test("C12-145: complete evidence and signer DID histories fetched moments ago: valid as of its checkpoint, with each signer's versionId and fetch time; never current", async () => {
    const { alice, bob, at, genesis, cropped, asBob } = await harbor();
    const byBob = await updateOriginal(cropped, { versionTime: at(), resources: [photo(B3)], ...asBob });
    const r = await verify([genesis, cropped, byBob], [alice, bob]);
    expect(r.history.status).toBe("valid");
    expect(r.identityEvidence.status).toBe("complete");
    expect(r.current).toBe(false);
    expect(r.reasons).toEqual(["not-anchored"]);
    expect(r.validAsOf).toEqual({
      checkpoint: byBob.versionId,
      signers: [
        { did: alice.did, role: "author", versionId: alice.versionId, obtainedAt: FETCHED, source: "fetched" },
        { did: bob.did, role: "editor", versionId: bob.versionId, obtainedAt: FETCHED, source: "fetched" },
      ],
    });
    expect(r.historicallyAuthorizedOnly).toEqual([]);
  });

  test("evidence that does not say when it was obtained is reported with obtainedAt null, never a guessed time", async () => {
    const { alice, bob, genesis, cropped } = await harbor();
    const r = await verifyOriginal({ log: [genesis, cropped], authors: [alice.evidence(), bob.evidence()], now: NOW, bytes: allBytes });
    expect(r.current).toBe(false);
    expect(r.validAsOf?.signers).toEqual([{ did: alice.did, role: "author", versionId: alice.versionId, obtainedAt: null, source: null }]);
  });

  test("C12-22: an old valid prefix served as current is valid as of its own checkpoint, never current", async () => {
    const { alice, bob, genesis, cropped } = await harbor();
    const r = await verify([genesis], [alice, bob], { retained: { original: cropped.versionId } });
    expect(r.current).toBe(false);
    expect(r.validAsOf?.checkpoint).toBe(genesis.versionId);
    expect(r.assetFreshness.status).toBe("stale");
    expect(r.reasons).toEqual(expect.arrayContaining(["not-anchored", "asset-log-older-than-retained"]));
  });

  test("an earlier checkpoint is valid as of that checkpoint", async () => {
    const { alice, bob, genesis, cropped } = await harbor();
    const r = await verify([genesis, cropped], [alice, bob], { checkpoint: genesis.versionId });
    expect(r.validAsOf?.checkpoint).toBe(genesis.versionId);
    expect(r.current).toBe(false);
  });

  test("C12-23, C12-143: divergent branches are reported as a conflict, and no branch is reported valid as of a checkpoint", async () => {
    const { alice, bob, ref, sign, genesis, cropped } = await harbor();
    const renamed = await updateOriginal(genesis, { versionTime: "2026-10-18T13:00:00.000Z", name: "Harbor, renamed", author: ref, sign });
    const r = await verify([genesis, renamed], [alice, bob], { retained: { original: cropped.versionId } });
    expect(r.fork).not.toBeNull();
    expect(r.validAsOf).toBeNull();
    expect(r.reasons).toContain("fork-unresolved");
  });

  test("a result whose history does not verify is not valid as of anything", async () => {
    const { alice, genesis, cropped } = await harbor();
    const r = await verify([genesis, cropped], [alice]); // the editor's history is not needed: Bob signed nothing
    expect(r.validAsOf).not.toBeNull();
    const missing = await verifyOriginal({ log: [genesis, cropped], authors: [], now: NOW, bytes: allBytes });
    expect(missing.identityEvidence.status).toBe("incomplete");
    expect(missing.validAsOf).toBeNull();
  });
});

describe("P7.9: historically authorized only", () => {
  test("C12-41 (unanchored): entries signed by a key the author DID later removed are historically authorized only; the checkpoint stays valid", async () => {
    const { alice, bob, at, genesis, cropped } = await harbor();
    await alice.rotate([{ fragment: "orig2", signer: seeded(23) }]);
    const next = await updateOriginal(cropped, { versionTime: at(), name: "Harbor, new key", author: alice.ref("orig2"), sign: alice.signer(seeded(23), "orig2") });
    const r = await verify([genesis, cropped, next], [alice, bob]);
    expect(r.history.status).toBe("valid");
    expect(r.validAsOf?.checkpoint).toBe(next.versionId);
    expect(r.current).toBe(false);
    // The two entries before the rotation, not the one signed with the new key.
    expect(r.historicallyAuthorizedOnly).toEqual([
      { versionId: genesis.versionId, did: alice.did, role: "author", reason: "key-not-in-latest-signer-document" },
      { versionId: cropped.versionId, did: alice.did, role: "author", reason: "key-not-in-latest-signer-document" },
    ]);
    expect(r.reasons).toContain("historically-authorized-only");
    // Any result that includes such an entry says so: an earlier checkpoint too.
    const early = await verify([genesis, cropped, next], [alice, bob], { checkpoint: genesis.versionId });
    expect(early.validAsOf?.checkpoint).toBe(genesis.versionId);
    expect(early.historicallyAuthorizedOnly.map((h) => h.versionId)).toEqual([genesis.versionId]);
  });

  test("C12-48 (not anchored): after the author DID's deactivation, the deactivation is reported and every entry is historically authorized only", async () => {
    const { alice, bob, genesis, cropped } = await harbor();
    await alice.deactivate();
    const r = await verify([genesis, cropped], [alice, bob]);
    expect(r.history.status).toBe("valid");
    expect(r.identityEvidence.deactivated).toBe(true);
    expect(r.reasons).toEqual(expect.arrayContaining(["not-anchored", "author-did-deactivated", "historically-authorized-only"]));
    expect(r.validAsOf?.checkpoint).toBe(cropped.versionId);
    expect(r.historicallyAuthorizedOnly).toEqual([
      { versionId: genesis.versionId, did: alice.did, role: "author", reason: "author-did-deactivated" },
      { versionId: cropped.versionId, did: alice.did, role: "author", reason: "author-did-deactivated" },
    ]);
  });

  test("C12-121, C12-122 (unanchored): an editor entry by a removed key, by a deactivated editor DID, or after the author DID's deactivation (P5.18)", async () => {
    {
      const { alice, bob, at, genesis, asBob } = await harbor();
      const byBob = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], ...asBob });
      await bob.rotate([{ fragment: "edit-2", signer: seeded(35) }]);
      const r = await verify([genesis, byBob], [alice, bob]);
      expect(r.validAsOf?.checkpoint).toBe(byBob.versionId);
      expect(r.historicallyAuthorizedOnly).toEqual([{ versionId: byBob.versionId, did: bob.did, role: "editor", reason: "key-not-in-latest-signer-document" }]);
    }
    {
      const { alice, bob, at, genesis, asBob } = await harbor();
      const byBob = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], ...asBob });
      await bob.deactivate();
      const r = await verify([genesis, byBob], [alice, bob]);
      expect(r.historicallyAuthorizedOnly).toEqual([{ versionId: byBob.versionId, did: bob.did, role: "editor", reason: "signer-did-deactivated" }]);
      expect(r.identityEvidence.editors[0]).toMatchObject({ did: bob.did, deactivated: true });
    }
    {
      const { alice, bob, at, genesis, asBob } = await harbor();
      const byBob = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], ...asBob });
      await alice.deactivate();
      const r = await verify([genesis, byBob], [alice, bob]);
      expect(r.historicallyAuthorizedOnly.map((h) => [h.role, h.reason])).toEqual([["author", "author-did-deactivated"], ["editor", "author-did-deactivated"]]);
    }
  });
});
