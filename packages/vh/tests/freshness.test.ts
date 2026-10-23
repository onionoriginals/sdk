/**
 * Phase 2 (plan 011, PR 6): author DID rotation, freshness and retained
 * versionIds, and forks reported as unresolved conflicts (P2.1, P5.10, P6.6,
 * P7.6, P7.8, P7.9; owner decision Q5).
 */
import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../src/json/index.js";
import { serializeLog, type LogEntry } from "../src/log/index.js";
import { createOriginal, resourceDigest, updateOriginal, verifyOriginal, type OriginalsReport } from "../src/originals/index.js";
import { NOW, VhAuthor, bytes, clock, photo, seeded } from "./helpers/originals.js";

const B1 = "harbor at dawn, first crop";
const B2 = "harbor at dawn, tighter crop";
const B3 = "harbor at dawn, wide";
const allBytes = Object.fromEntries([B1, B2, B3].map((t) => [resourceDigest(bytes(t)), bytes(t)]));

async function harbor() {
  const key = seeded(21);
  const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
  const at = clock();
  const sign = alice.signer(key, "orig");
  const ref = alice.ref("orig");
  const genesis = await createOriginal({ versionTime: at(), name: "Harbor at dawn", resources: [photo(B1)], author: ref, sign });
  const cropped = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], author: ref, sign });
  return { alice, key, sign, ref, at, genesis, cropped };
}

type Options = Parameters<typeof verifyOriginal>[0];
const verify = (log: LogEntry[], authors: VhAuthor[], extra: Partial<Options> = {}): Promise<OriginalsReport> =>
  verifyOriginal({ log, authors: authors.map((a) => a.evidence()), now: NOW, bytes: allBytes, ...extra });

describe("author DID rotation (P5.10)", () => {
  test("C12-51: a key the author DID added signs with no asset log entry for the change", async () => {
    const { alice, key, genesis, cropped, at } = await harbor();
    const added = seeded(22);
    await alice.rotate([{ fragment: "orig", signer: key }, { fragment: "studio", signer: added }]);
    const next = await updateOriginal(cropped, { versionTime: at(), name: "Harbor, studio print", author: alice.ref("studio"), sign: alice.signer(added, "studio") });
    const r = await verify([genesis, cropped, next], [alice]);
    expect(r.history.status).toBe("valid");
    expect(r.authorBinding.status).toBe("valid");
    expect(r.state?.name).toBe("Harbor, studio print");
    expect(r.reasons).toEqual(["not-anchored"]);
  });

  test("C12-08 (unanchored): an entry naming an old author DID version with a backdated time is never current", async () => {
    const { alice, sign, genesis, cropped } = await harbor();
    const v1 = alice.versionId;
    await alice.rotate([{ fragment: "orig2", signer: seeded(23) }]); // the author removes the stolen key
    // The thief still holds the removed key, names the old version and claims whatever time it likes.
    const forged = await updateOriginal(cropped, { versionTime: "2026-10-18T12:00:05.000Z", name: "Not by Alice", author: alice.ref("orig", v1), sign });
    const r = await verify([genesis, cropped, forged], [alice]);
    expect(r.history.status).toBe("valid"); // historically authorized at the version it names
    expect(r.ordering).toBe("claimed"); // no timestamp-only acceptance
    expect(r.current).toBe(false);
    expect(r.reasons).toContain("historically-authorized-only");
  });

  test("C12-41 (unanchored): every entry signed by a removed key stays valid history but not current", async () => {
    const { alice, genesis, cropped } = await harbor();
    await alice.rotate([{ fragment: "orig2", signer: seeded(23) }]);
    const r = await verify([genesis, cropped], [alice]);
    expect(r.history.status).toBe("valid");
    expect(r.authorBinding.status).toBe("valid");
    expect(r.current).toBe(false);
  });
});

describe("asset log freshness and retained versionIds (P7.6, P7.8)", () => {
  test("a valid unanchored log is a historical result, valid as of its checkpoint, never the latest state (P7.10)", async () => {
    const { alice, genesis, cropped } = await harbor();
    const r = await verify([genesis, cropped], [alice]);
    expect(r.history.status).toBe("valid");
    expect(r.assetFreshness.status).toBe("not-established");
    expect(r.validAsOf?.checkpoint).toBe(cropped.versionId);
    expect(r.reasons).toEqual(["not-anchored"]);
    expect(r.current).toBe(false);
  });

  test("C12-22: an old valid prefix served as current is stale against the retained versionId", async () => {
    const { alice, genesis, cropped } = await harbor();
    const r = await verify([genesis], [alice], { retained: { original: cropped.versionId } });
    expect(r.history.status).toBe("valid");
    expect(r.checkpoint).toBe(genesis.versionId);
    expect(r.assetFreshness).toMatchObject({ status: "stale", retainedVersionId: cropped.versionId });
    expect(r.reasons).toContain("asset-log-older-than-retained");
    expect(r.current).toBe(false);
    // The retained versionId never moves backwards.
    expect(r.retain.original).toBe(cropped.versionId);
  });

  test("a log at or past the retained versionId is not stale, and the new head is retained", async () => {
    const { alice, genesis, cropped } = await harbor();
    const r = await verify([genesis, cropped], [alice], { retained: { original: genesis.versionId } });
    expect(r.assetFreshness.status).toBe("not-established");
    expect(r.reasons).toEqual(["not-anchored"]);
    expect(r.retain).toEqual({ original: cropped.versionId, authors: { [alice.did]: alice.versionId } });
  });

  test("a copy ahead of the supplied log makes it stale; the supplied log is still what is reported", async () => {
    const { alice, genesis, cropped } = await harbor();
    const r = await verify([genesis], [alice], { copies: [{ source: "mirror", log: serializeLog([genesis, cropped]) }] });
    expect(r.head).toBe(genesis.versionId);
    expect(r.assetFreshness.status).toBe("stale");
    expect(r.assetFreshness.copies).toEqual([
      { source: "supplied", versionId: genesis.versionId, status: "behind" },
      { source: "mirror", versionId: cropped.versionId, status: "current" },
    ]);
    expect(r.fork).toBeNull();
    expect(r.current).toBe(false);
  });

  test("a supplied log that fails verification is reported as failing, never as a copy's history", async () => {
    const { alice, genesis, cropped } = await harbor();
    const broken = { ...cropped, state: { ...cropped.state, asset: { ...(cropped.state as JsonObject).asset as JsonObject, name: "forged" } } };
    const r = await verify([genesis, broken as LogEntry], [alice], { copies: [{ source: "mirror", log: serializeLog([genesis, cropped]) }] });
    expect(r.history.status).not.toBe("valid");
    expect(r.head).toBe(genesis.versionId);
    expect(r.current).toBe(false);
  });
});

describe("C12-23: divergent valid branches are an unresolved fork (P2.1, P6.6, Q5)", () => {
  async function forked() {
    const h = await harbor();
    // Branch B: a rename from the same parent, claiming a later time than branch A.
    const renamed = await updateOriginal(h.genesis, { versionTime: "2026-10-18T13:00:00.000Z", name: "Harbor, renamed", author: h.ref, sign: h.sign });
    return { ...h, renamed };
  }

  test("two copies that diverge: both branches reported, neither current, whatever the timestamps", async () => {
    const { alice, genesis, cropped, renamed } = await forked();
    for (const [mine, theirs] of [[cropped, renamed], [renamed, cropped]]) {
      const r = await verify([genesis, mine], [alice], { copies: [{ source: "mirror", log: serializeLog([genesis, theirs]) }] });
      expect(r.fork).toEqual({ version: 2, branches: [{ source: "supplied", versionId: mine.versionId }, { source: "mirror", versionId: theirs.versionId }] });
      expect(r.history.status).toBe("valid"); // each branch is valid on its own
      expect(r.current).toBe(false);
      expect(r.reasons).toContain("fork-unresolved");
      // A fork does not move the retained versionId.
      expect(r.retain.original).toBeNull();
    }
  });

  test("a log that diverges from the retained versionId is a fork with the history seen before", async () => {
    const { alice, genesis, cropped, renamed } = await forked();
    const r = await verify([genesis, renamed], [alice], { retained: { original: cropped.versionId } });
    expect(r.fork).toEqual({ version: 2, branches: [{ source: "supplied", versionId: renamed.versionId }, { source: "retained", versionId: cropped.versionId }] });
    expect(r.current).toBe(false);
    expect(r.retain.original).toBe(cropped.versionId);
  });

  test("a copy that fails verification is reported invalid, not a fork", async () => {
    const { alice, genesis, cropped, renamed } = await forked();
    const broken = { ...renamed, proof: [{ ...renamed.proof[0], proofValue: "z1111" }] };
    const r = await verify([genesis, cropped], [alice], { copies: [{ source: "mirror", log: serializeLog([genesis, broken as LogEntry]) }] });
    expect(r.fork).toBeNull();
    expect(r.assetFreshness.copies.find((c) => c.source === "mirror")?.status).toBe("invalid");
    expect(r.reasons).toEqual(["not-anchored"]);
  });
});

describe("author DID freshness (P7.8)", () => {
  test("C12-64: stale author DID history served with a current asset log is not currently authorized", async () => {
    const { alice, genesis, cropped } = await harbor();
    const before = alice.entries.slice();
    await alice.rotate([{ fragment: "orig", signer: seeded(21) }, { fragment: "spare", signer: seeded(24) }]);
    const latest = alice.versionId;
    const r = await verifyOriginal({
      log: [genesis, cropped], authors: [alice.evidence(before)], now: NOW, bytes: allBytes,
      retained: { authors: { [alice.did]: latest } },
    });
    expect(r.history.status).toBe("valid");
    expect(r.identityEvidence).toMatchObject({ freshness: "stale", latestVersionId: before[0].versionId, retainedVersionId: latest });
    expect(r.reasons).toContain("author-history-older-than-retained");
    expect(r.current).toBe(false);
    expect(r.retain.authors[alice.did]).toBe(latest);
  });

  test("author DID history that diverges from the retained versionId is incomplete identity evidence", async () => {
    const { alice, genesis, cropped } = await harbor();
    const base = alice.entries.slice();
    await alice.rotate([{ fragment: "orig", signer: seeded(21) }, { fragment: "a", signer: seeded(25) }]);
    const seen = alice.versionId;
    alice.entries = base;
    await alice.rotate([{ fragment: "orig", signer: seeded(21) }, { fragment: "b", signer: seeded(26) }]);
    const r = await verify([genesis, cropped], [alice], { retained: { authors: { [alice.did]: seen } } });
    expect(r.identityEvidence.status).toBe("incomplete");
    expect(r.identityEvidence.failure?.code).toBe("AUTHOR_DID_FORK");
    expect(r.current).toBe(false);
    expect(r.retain.authors[alice.did]).toBe(seen);
  });
});
