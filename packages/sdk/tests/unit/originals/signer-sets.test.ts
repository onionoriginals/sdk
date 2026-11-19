/**
 * Signer sets through the SDK (P5.19; owner decision of 19 November
 * 2026): `sdk.create` with `authors: {threshold, members}` and several
 * signers, `sdk.edit` with the signers of an author entry, and a draft flow
 * for signers who are not all present: `prepare*`, `cosign` per signer, then
 * `commitDraft`. Each signer is shown the entry as itself (P5.11). Evidence
 * packages carry every member DID that signed (P7.1), and reports list the
 * signers per entry.
 *
 * Rules P5.19–P5.23 (originals-spec #66): rows C12-382, C12-383 and C12-388.
 */
import { describe, expect, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import type { AuthorRef } from "@originals/vh/originals";
import { MemoryStore, OriginalsSDK, describeEntry, keySigner, readZip, signerPath, writeZip, type EntrySummary, type OriginalsSigner } from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const B1 = bytes("harbor at dawn, first crop");
const B2 = bytes("harbor at dawn, tighter crop");
const KA = seed(21);
const KB = seed(31);
const KC = seed(32);
const KD = seed(33);

async function rejects(promise: Promise<unknown>, category: string, code?: string) {
  const caught = await promise.then(() => undefined, (e: unknown) => e);
  expect(caught, "expected a rejection").toBeInstanceOf(OriginalsError);
  expect((caught as OriginalsError).category, (caught as Error).message).toBe(category as never);
  if (code) expect((caught as OriginalsError).code, (caught as Error).message).toBe(code);
}

const byDid = <T extends { did: string }>(list: T[]) => [...list].sort((a, b) => (a.did < b.did ? -1 : 1));

/** Alice, Bob and Carol govern "Harbor at dawn", two of three; Dave is not a member. */
async function harbor() {
  const [alice, bob, carol, dave] = await Promise.all([KA, KB, KC, KD].map((k) => Author.create([{ fragment: "orig", secret: k }])));
  const keys = new Map([[alice, KA], [bob, KB], [carol, KC], [dave, KD]]);
  const shown: Array<{ did: string; display: string; summary: EntrySummary }> = [];
  /** A member's key signer, recording what it is shown (P5.11). */
  const signer = (a: Author): OriginalsSigner => keySigner({
    keyType: "Ed25519", secretKey: keys.get(a)!, verificationMethod: `${a.did}#orig`,
    confirm: (display, summary) => {
      shown.push({ did: a.did, display, summary });
      return true;
    },
  });
  const all = [alice, bob, carol, dave];
  const store = new MemoryStore();
  const sdk = OriginalsSDK.create({ store, authors: async (did) => all.find((d) => d.did === did)?.evidence(), clock: clock() });
  const members = byDid([alice, bob, carol]);
  const created = await sdk.create({
    name: "Harbor at dawn", resource: { mediaType: "image/jpeg", bytes: B1 },
    authors: { threshold: 2, members: members.map((m) => m.ref("orig")) },
    signers: [alice, bob, carol].map(signer),
  });
  if (created.kind !== "original") throw new Error("expected an Original");
  /** The signer references and signers of `who`, as an author entry needs them. */
  const as = (...who: Author[]): { author: AuthorRef[]; signers: OriginalsSigner[] } => ({ author: byDid(who).map((a) => a.ref("orig")), signers: who.map(signer) });
  return { alice, bob, carol, dave, sdk, store, signer, shown, as, all, did: created.original.did, v1: created.original.checkpoint, created: created.original };
}

describe("C12-382 (P5.19): sdk.create with a signer set", () => {
  test("every member signs genesis; the report lists them and the document's controller is the member array", async () => {
    const { alice, bob, carol, created, shown } = await harbor();
    const dids = byDid([alice, bob, carol]).map((a) => a.did);
    expect(created.state.authors).toEqual({ threshold: 2, dids });
    expect(created.report.history.status).toBe("valid");
    expect(created.report.signedBy).toEqual([{ versionId: created.checkpoint, role: "author", dids }]);
    expect(created.report.document?.controller).toEqual(dids);
    expect(created.report.identityEvidence.authors.map((a) => [a.did, a.status])).toEqual(dids.map((d) => [d, "complete"]));
    // Each member was shown the entry as itself, with every signer and the set (P5.11).
    expect(shown.map((s) => s.did).sort()).toEqual(dids);
    for (const s of shown) {
      expect(s.summary.signer.did).toBe(s.did);
      expect(s.summary.signers.map((r) => r.did)).toEqual(dids);
      expect(s.summary.authors).toEqual({ threshold: 2, dids });
      expect(s.display).toContain(`Signing as author ${s.did}`);
      expect(s.display).toContain("Signer set: changed to 2 of 3");
    }
  });

  test("a create naming a member no signer is given for is refused before anything is signed", async () => {
    const { alice, bob, carol, sdk, signer, shown } = await harbor();
    shown.length = 0;
    const input = { name: "Another", resource: { mediaType: "image/jpeg", bytes: B2 }, authors: { threshold: 1, members: byDid([alice, bob, carol]).map((a) => a.ref("orig")) } };
    await rejects(sdk.create({ ...input, signers: [signer(alice), signer(bob)] }), "unauthorized-key", "SIGNER_MISSING");
    expect(shown).toEqual([]);
    // A create gives one author, or a signer set, never both.
    await rejects(sdk.create({ ...input, author: alice.ref("orig"), signers: [signer(alice)] } as never), "invalid-evidence", "INPUT_INVALID");
  });
});

describe("C12-383 (P5.20): sdk.edit by a threshold of members", () => {
  test("two of three sign an edit; one is refused before anyone signs; a non-member is refused", async () => {
    const { alice, bob, carol, dave, sdk, did, v1, as, shown } = await harbor();
    shown.length = 0;
    const edited = await sdk.edit(did, { parent: v1, resource: { bytes: B2 }, ...as(alice, carol) });
    expect(edited.original.report.signedBy[1].dids).toEqual(byDid([alice, carol]).map((a) => a.did));
    expect(shown.map((s) => s.did).sort()).toEqual(byDid([alice, carol]).map((a) => a.did));
    shown.length = 0;
    const v2 = edited.original.checkpoint;
    await rejects(sdk.edit(did, { parent: v2, name: "Harbor, Bob", ...as(bob) }), "unauthorized-key", "AUTHORS_THRESHOLD_NOT_MET");
    await rejects(sdk.edit(did, { parent: v2, name: "Harbor, Dave", ...as(bob, dave) }), "unauthorized-key", "SIGNER_NOT_MEMBER");
    expect(shown).toEqual([]);
    expect((await sdk.get(did)).checkpoint).toBe(v2);
  });

  test("adding a member: the new member signs; the set and threshold change only in an author entry", async () => {
    const { alice, bob, carol, dave, sdk, did, v1, as } = await harbor();
    const dids = byDid([alice, bob, carol, dave]).map((a) => a.did);
    await rejects(sdk.edit(did, { parent: v1, authors: { threshold: 3, dids }, ...as(alice, bob) }), "unauthorized-key", "AUTHORS_MEMBER_NOT_SIGNED");
    const added = await sdk.edit(did, { parent: v1, authors: { threshold: 3, dids }, ...as(alice, bob, dave) });
    expect(added.original.state.authors).toEqual({ threshold: 3, dids });
    // Now three of four.
    await rejects(sdk.edit(did, { parent: added.original.checkpoint, name: "Harbor, two", ...as(alice, dave) }), "unauthorized-key", "AUTHORS_THRESHOLD_NOT_MET");
    const three = await sdk.edit(did, { parent: added.original.checkpoint, name: "Harbor, three", ...as(alice, carol, dave) });
    expect(three.original.state.name).toBe("Harbor, three");
  });

  test("deactivation is signed by a threshold", async () => {
    const { bob, carol, sdk, did, v1, as } = await harbor();
    const ended = await sdk.deactivate(did, { parent: v1, ...as(bob, carol) });
    expect(ended.original.report.deactivated).toBe(true);
  });
});

describe("P5.22: the draft flow for signers who are not all present", () => {
  test("prepare, cosign per signer at different times, then commitDraft", async () => {
    const { alice, carol, sdk, did, v1, signer, as, shown } = await harbor();
    shown.length = 0;
    const draft = await sdk.prepareEdit(did, { parent: v1, name: "Harbor, cosigned", author: as(alice, carol).author });
    expect(draft.proofs).toEqual([]);
    const byCarol = await sdk.cosign(draft, signer(carol));
    expect(byCarol.proofs.map((p) => p.verificationMethod)).toEqual([`${carol.did}#orig`]);
    // The drafts are values: the earlier one is unchanged.
    expect(draft.proofs).toEqual([]);
    await rejects(sdk.commitDraft(byCarol), "unauthorized-key", "PROOF_MISSING");
    await rejects(sdk.cosign(byCarol, signer(carol)), "invalid-evidence", "PROOF_DUPLICATE");
    const both = await sdk.cosign(byCarol, signer(alice));
    expect(shown.map((s) => s.did)).toEqual([carol.did, alice.did]);
    const committed = await sdk.commitDraft(both);
    expect(committed.status).toBe("committed");
    expect(committed.original.state.name).toBe("Harbor, cosigned");
    expect(committed.original.report.signedBy[1].dids).toEqual(byDid([alice, carol]).map((a) => a.did));
    // Committing the same draft again is a duplicate, never a second entry.
    expect((await sdk.commitDraft(both)).status).toBe("duplicate");
  });

  test("cosign refuses a signer the entry does not name; a bad cosignature fails verification at commit and nothing is committed", async () => {
    const { alice, bob, carol, sdk, did, v1, signer, as } = await harbor();
    const draft = await sdk.prepareEdit(did, { parent: v1, name: "Harbor, forged", author: as(alice, bob).author });
    await rejects(sdk.cosign(draft, signer(carol)), "invalid-evidence", "SIGNER_NOT_NAMED");
    // Bob's verification method with another key.
    const impostor = keySigner({ keyType: "Ed25519", secretKey: KD, verificationMethod: `${bob.did}#orig` });
    const partial = await sdk.cosign(await sdk.cosign(draft, signer(alice)), impostor);
    await rejects(sdk.commitDraft(partial), "invalid-evidence", "COMMIT_VERIFICATION_FAILED");
    expect((await sdk.get(did)).checkpoint).toBe(v1);
  });

  test("a genesis draft is cosigned by every member, as the create it replaces", async () => {
    const { alice, bob, carol, sdk, signer } = await harbor();
    const members = byDid([alice, bob, carol]);
    let draft = await sdk.prepareCreate({ name: "Harbor, drafted", resource: { mediaType: "image/jpeg", bytes: B2 }, authors: { threshold: 3, members: members.map((m) => m.ref("orig")) } });
    for (const m of [bob, carol, alice]) draft = await sdk.cosign(draft, signer(m));
    const committed = await sdk.commitDraft(draft);
    expect(committed.original.state.authors?.threshold).toBe(3);
    expect(committed.original.report.validAsOf?.signers.map((s) => s.did)).toEqual(members.map((m) => m.did));
  });
});

describe("C12-388 (P5.21): converting a single-author Original through the SDK", () => {
  test("the author and the new member sign the conversion; the new member then edits as a set of one threshold", async () => {
    const { alice, bob, sdk, signer, as } = await harbor();
    const made = await sdk.create({ name: "Solo", resource: { mediaType: "image/jpeg", bytes: B1 }, author: alice.ref("orig"), signer: signer(alice) });
    if (made.kind !== "original") throw new Error("expected an Original");
    const dids = byDid([alice, bob]).map((a) => a.did);
    const converted = await sdk.edit(made.original.did, { parent: made.original.checkpoint, authors: { threshold: 1, dids }, ...as(alice, bob) });
    expect(converted.original.report.document?.controller).toEqual(dids);
    const byBob = await sdk.edit(made.original.did, { parent: converted.original.checkpoint, name: "Solo, Bob", ...as(bob) });
    expect(byBob.original.state.name).toBe("Solo, Bob");
  });
});

describe("P7.1: evidence packages carry identity evidence for every signing member", () => {
  test("a fresh reader verifies the package with no other evidence; without a member's history it is incomplete, never a pass", async () => {
    const { alice, carol, sdk, did, v1, as, all } = await harbor();
    await sdk.edit(did, { parent: v1, name: "Harbor, renamed", ...as(alice, carol) });
    const pkg = await sdk.package(did);
    expect(pkg.manifest.completeness).toBe("complete");
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [] });
    const loaded = await reader.load(pkg.bytes);
    expect(loaded.report.history.status).toBe("valid");
    expect(loaded.report.identityEvidence.status).toBe("complete");
    expect(loaded.report.identityEvidence.authors.length).toBe(3);

    const files = readZip(pkg.bytes);
    for (const m of [alice, carol, all[1]]) expect(files.has(`${signerPath(m.did)}/did.jsonl`), m.did).toBe(true);

    // Without Bob's history the result is incomplete identity evidence, never a pass.
    const bob = all[1];
    const stripped = new Map([...files].filter(([path]) => !path.startsWith(`${signerPath(bob.did)}/`)));
    const manifest = JSON.parse(new TextDecoder().decode(stripped.get("originals-evidence.json"))) as Record<string, unknown>;
    stripped.set("originals-evidence.json", new TextEncoder().encode(JSON.stringify({ ...manifest, completeness: "partial", missing: [{ kind: "identity", did: bob.did, role: "author" }] })));
    const partial = await OriginalsSDK.create({ store: new MemoryStore(), authors: [] }).load(writeZip(stripped));
    expect(partial.report.history.failure?.code).toBe("AUTHOR_HISTORY_MISSING");
    expect(partial.report.identityEvidence.status).toBe("incomplete");
    expect(partial.report.identityEvidence.authors).toContainEqual(expect.objectContaining({ did: bob.did, status: "incomplete" }));
    expect(partial.report.validAsOf).toBeNull();
    expect(partial.reasons).not.toContain("manifest-completeness-mismatch");
  });

  test("the signer's display names every signer and the signer set (P5.11)", async () => {
    const { alice, bob, carol, created } = await harbor();
    const text = describeEntry({
      original: created.did, operation: "update", name: "Harbor", author: byDid([alice, bob]).map((a) => a.ref("orig")),
      signer: { role: "author", ...alice.ref("orig") }, signers: byDid([alice, bob]).map((a) => a.ref("orig")),
      authors: { threshold: 2, dids: byDid([alice, bob, carol]).map((a) => a.did) }, authorsChanged: true,
      changes: [], nameChanged: false, metadataChanged: false, editorsChanged: false, editors: [], versionTime: "2026-10-18T12:00:00.000Z",
    });
    expect(text).toContain(`Signers: ${byDid([alice, bob]).map((a) => a.did).join(", ")}`);
    expect(text).toContain("Signer set: changed to 2 of 3");
  });
});
