/**
 * Editors (P5.9, P5.11, P5.15-P5.18, P6.6, P7.8, P7.9): the author grants an
 * editor DID permission to change named content; the editor signs its own
 * entries with its own DID, checked against the grant in the parent's state.
 * The `editors` member names are PROVISIONAL (D4). Editor authority is VH-Log
 * PR 11's "Editors from a Controller" [S25]: the engine's editor hook, which
 * the Originals profile implements with its grants.
 */
import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../src/json/index.js";
import { appendEntry, serializeLog, type LogEntry } from "../src/log/index.js";
import {
  ORIGINALS_LIMITS,
  checkAsset,
  createOriginal,
  deactivateOriginal,
  resourceDigest,
  updateOriginal,
  verifyOriginal,
  type AuthorRef,
  type EditorGrant,
  type OriginalsReport,
} from "../src/originals/index.js";
import { didWebvhLogUrl } from "../src/webvh/index.js";
import { NOW, VhAuthor, WebvhAuthor, bytes, clock, photo, seeded } from "./helpers/originals.js";

const B1 = "harbor at dawn, first crop";
const B2 = "harbor at dawn, Bob's crop";
const B3 = "harbor at dawn, Bob's second crop";
const allBytes = Object.fromEntries([B1, B2, B3].map((t) => [resourceDigest(bytes(t)), bytes(t)]));
const KA = seeded(21);
const KB = seeded(31);
const KC = seeded(32);

const grant = (did: string, g: Partial<Omit<EditorGrant, "did">> = {}): EditorGrant => ({ did, name: false, metadata: false, resources: [], ...g });

/** The spec's example: Alice grants Bob `resources: ["photo"]` and Carol `metadata: true`. */
async function harbor() {
  const alice = await VhAuthor.create([{ fragment: "orig", signer: KA }]);
  const bob = await VhAuthor.create([{ fragment: "edit", signer: KB }]);
  const carol = await VhAuthor.create([{ fragment: "edit", signer: KC }]);
  const at = clock();
  const ref = alice.ref("orig");
  const sign = alice.signer(KA, "orig");
  const editors = [grant(bob.did, { resources: ["photo"] }), grant(carol.did, { metadata: true })];
  const genesis = await createOriginal({ versionTime: at(), name: "Harbor at dawn", resources: [photo(B1)], author: ref, sign, editors });
  const asBob = { editor: bob.ref("edit"), sign: bob.signer(KB, "edit") };
  const asCarol = { editor: carol.ref("edit"), sign: carol.signer(KC, "edit") };
  return { alice, bob, carol, at, ref, sign, editors, genesis, asBob, asCarol };
}

type Options = Parameters<typeof verifyOriginal>[0];
const verify = (log: LogEntry[], dids: Array<VhAuthor | WebvhAuthor>, extra: Partial<Options> = {}): Promise<OriginalsReport> =>
  verifyOriginal({ log, authors: dids.map((a) => a.evidence()), now: NOW, bytes: allBytes, ...extra });

function failedWith(r: OriginalsReport, index: number, code: string, category?: string) {
  expect(r.history.failure?.index, JSON.stringify(r.history.failure)).toBe(index);
  expect(r.history.failure?.code).toBe(code);
  if (category) expect(r.history.failure?.category).toBe(category);
  expect(r.current).toBe(false);
}

/** Sign an edited state after `previous`, bypassing the builder's checks. */
const forge = (previous: LogEntry, state: JsonObject, sign: Parameters<typeof appendEntry>[1]["sign"], parameters: JsonObject = {}) =>
  appendEntry(previous, { versionTime: "2026-10-18T12:30:00.000Z", parameters, state, sign });

describe("C12-113: two editors sign within their grants, on successive heads, with no author signature", () => {
  test("both entries are accepted, the author is unchanged and each entry identifies its editor (P5.16)", async () => {
    const { alice, bob, carol, at, ref, genesis, asBob, asCarol } = await harbor();
    const byBob = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], ...asBob });
    const byCarol = await updateOriginal(byBob, { versionTime: at(), metadata: { caption: "Corrected caption" }, ...asCarol });
    expect(byBob.state.author).toEqual(ref);
    expect(byCarol.state.author).toEqual(ref);
    expect(byBob.state.editor).toEqual(bob.ref("edit"));
    expect(byCarol.state.editor).toEqual(carol.ref("edit"));
    expect(byBob.parameters).toEqual({});
    const r = await verify([genesis, byBob, byCarol], [alice, bob, carol]);
    expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
    expect(r.authorBinding.status).toBe("valid");
    expect(r.identityEvidence.author).toBe(alice.did);
    expect(r.identityEvidence.status).toBe("complete");
    expect(r.identityEvidence.editors.map((e) => [e.did, e.status, e.latestVersionId, e.freshness])).toEqual([
      [bob.did, "complete", bob.versionId, "not-established"],
      [carol.did, "complete", carol.versionId, "not-established"],
    ]);
    expect(r.state?.metadata).toEqual({ caption: "Corrected caption" });
    expect(r.resources.versions.map((v) => [v.version, v.versionId])).toEqual([[1, genesis.versionId], [2, byBob.versionId]]);
    expect(r.document?.controller).toBe(alice.did);
    expect(r.reasons).toEqual(["not-anchored"]);
  });

  test("an editor DID's history is needed only for the editors that signed (P7.1)", async () => {
    const { alice, bob, at, genesis, asBob } = await harbor();
    const byBob = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], ...asBob });
    const r = await verify([genesis, byBob], [alice, bob]);
    expect(r.identityEvidence.editors.map((e) => e.did)).toEqual([bob.did]);
    expect(r.reasons).toEqual(["not-anchored"]);
  });
});

describe("C12-114: an editor entry changing content outside its grant", () => {
  test("the name, the metadata or a resource it is not granted is rejected (P5.16)", async () => {
    const { alice, bob, carol, at, genesis, asBob, asCarol } = await harbor();
    // The builder refuses before anything is signed.
    for (const change of [{ ...asBob, name: "Bob's harbor" }, { ...asBob, metadata: { caption: "x" } }, { ...asCarol, resources: [photo(B2)] }]) {
      await expect(updateOriginal(genesis, { versionTime: at(), ...change })).rejects.toMatchObject({ category: "outside-grant", code: "EDITOR_OUTSIDE_GRANT" });
    }
    // A forged entry is rejected by the verifier, even with a valid proof.
    const asset = genesis.state.asset as JsonObject;
    const renamed = await forge(genesis, { ...genesis.state, operation: "update", transitions: [], editor: bob.ref("edit"), asset: { ...asset, name: "Bob's harbor" } }, asBob.sign);
    failedWith(await verify([genesis, renamed], [alice, bob, carol]), 1, "EDITOR_OUTSIDE_GRANT", "outside-grant");
    const removed = await forge(genesis, { ...genesis.state, operation: "update", transitions: [], editor: carol.ref("edit"), asset: { ...asset, metadata: { caption: "x" } } }, asCarol.sign);
    expect((await verify([genesis, removed], [alice, bob, carol])).history.status).toBe("valid");
    const photoByCarol = await forge(genesis, {
      ...genesis.state, operation: "update", editor: carol.ref("edit"),
      asset: { ...asset, resources: [photo(B2)] }, transitions: [{ resource: "photo", from: photo(B1).digest, to: photo(B2).digest }],
    }, asCarol.sign);
    failedWith(await verify([genesis, photoByCarol], [alice, bob, carol]), 1, "EDITOR_OUTSIDE_GRANT", "outside-grant");
  });
});

describe("C12-115: an editor entry that changes grants, aliases, lifecycle or parameters, anchors, or deactivates", () => {
  test("is rejected: only an author entry may (P5.16)", async () => {
    const { alice, bob, carol, at, genesis, asBob } = await harbor();
    await expect(updateOriginal(genesis, { versionTime: at(), editors: [grant(bob.did, { name: true, resources: ["photo"] })], ...asBob })).rejects.toMatchObject({ code: "EDITOR_AUTHOR_ONLY" });
    await expect(updateOriginal(genesis, { versionTime: at(), aliases: ["did:webvh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ:example.com"], ...asBob })).rejects.toMatchObject({ code: "EDITOR_AUTHOR_ONLY" });
    const asset = genesis.state.asset as JsonObject;
    const base = { ...genesis.state, operation: "update", transitions: [], editor: bob.ref("edit") };
    const cases: Array<[JsonObject, JsonObject, string]> = [
      [{ ...base, asset: { ...asset, editors: [grant(bob.did, { name: true, resources: ["photo"] })] } }, {}, "EDITOR_AUTHOR_ONLY"],
      [{ ...base, asset: { ...asset, editors: [grant(bob.did, { resources: ["photo"] })] } }, {}, "EDITOR_AUTHOR_ONLY"],
      [{ ...base, asset: { ...asset, aliases: ["did:webvh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ:example.com"] } }, {}, "EDITOR_AUTHOR_ONLY"],
      // Deactivating sets a parameter, which no editor entry may (VH-Log PR 11 [S25], P5.16).
      [{ ...base, operation: "deactivate", asset: { ...asset, status: "deactivated" } }, { deactivated: true }, "EDITOR_PARAMETERS"],
      [base, { ttl: 60 }, "EDITOR_PARAMETERS"],
    ];
    for (const [state, parameters, code] of cases) {
      const r = await verify([genesis, await forge(genesis, state, asBob.sign, parameters)], [alice, bob, carol]);
      expect(r.history.failure?.code, code).toBe(code);
      expect(r.history.entries).toBe(1);
    }
    // Anchoring adds a did:btco alias: an author entry's change (P9.10), refused here as any alias change is.
    const anchoring = await forge(genesis, { ...base, asset: { ...asset, aliases: ["did:btco:1234"] } }, asBob.sign);
    expect((await verify([genesis, anchoring], [alice, bob, carol])).history.entries).toBe(1);
    // The SDK-level deactivation builder takes no editor.
    await expect(deactivateOriginal(genesis, { versionTime: at(), ...asBob } as never)).rejects.toThrow();
  });

  test("C12-140: an editor entry whose proof's verificationMethod is the author's, or whose operation is not update, is rejected (P5.2, P5.16)", async () => {
    const { alice, bob, carol, genesis, sign } = await harbor();
    const asset = genesis.state.asset as JsonObject;
    const byAuthorKey = await forge(genesis, { ...genesis.state, operation: "update", transitions: [], asset: { ...asset, name: "x" }, editor: bob.ref("edit") }, sign);
    const r = await verify([genesis, byAuthorKey], [alice, bob, carol]);
    expect(r.history.failure?.index).toBe(1);
    expect(r.history.failure?.category).toBe("author-binding");
    const deactivating = await forge(genesis, { ...genesis.state, operation: "deactivate", transitions: [], asset: { ...asset, status: "deactivated" }, editor: bob.ref("edit") }, bob.signer(KB, "edit"), { deactivated: true });
    // Its `deactivated` parameter is refused first: an editor entry sets no parameter (VH-Log PR 11 [S25]).
    failedWith(await verify([genesis, deactivating], [alice, bob, carol]), 1, "EDITOR_PARAMETERS", "outside-grant");
    // Without the parameter, the operation itself is the author's (P5.16).
    const operationOnly = await forge(genesis, { ...genesis.state, operation: "deactivate", transitions: [], editor: bob.ref("edit") }, bob.signer(KB, "edit"));
    failedWith(await verify([genesis, operationOnly], [alice, bob, carol]), 1, "EDITOR_AUTHOR_ONLY", "outside-grant");
  });

  test("the grant's scope is judged before the state's other rules: an editor dropping a published Original's alias is outside its grant (P5.16, P9.3)", async () => {
    const { alice, bob, carol, at, ref, sign, genesis } = await harbor();
    const web = "did:webvh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ:example.com";
    const published = await updateOriginal(genesis, { versionTime: at(), aliases: [web], author: ref, sign });
    const dropped = await forge(published, { ...published.state, operation: "update", transitions: [], editor: bob.ref("edit"), asset: { ...(published.state.asset as JsonObject), aliases: [] } }, bob.signer(KB, "edit"));
    failedWith(await verify([genesis, published, dropped], [alice, bob, carol]), 2, "EDITOR_AUTHOR_ONLY", "outside-grant");
  });

  test("an editor entry cannot be the genesis entry", async () => {
    const { alice, bob, asBob } = await harbor();
    const genesis = await createOriginal({ versionTime: "2026-10-18T12:00:00.000Z", name: "x", resources: [photo(B1)], author: alice.ref("orig"), sign: asBob.sign, editor: bob.ref("edit") } as never).catch((e: unknown) => e);
    expect(genesis).toMatchObject({ code: "EDITOR_AUTHOR_ONLY" });
  });
});

describe("C12-116: an editor entry whose author reference differs from its parent's", () => {
  test("is rejected (P5.16)", async () => {
    const { alice, bob, carol, at, genesis, asBob } = await harbor();
    await alice.rotate([{ fragment: "orig", signer: KA }]);
    await expect(updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], author: alice.ref("orig"), ...asBob })).rejects.toMatchObject({ code: "EDITOR_AUTHOR_CHANGED" });
    const asset = genesis.state.asset as JsonObject;
    const moved = await forge(genesis, {
      ...genesis.state, operation: "update", editor: bob.ref("edit"), author: alice.ref("orig"),
      asset: { ...asset, resources: [photo(B2)] }, transitions: [{ resource: "photo", from: photo(B1).digest, to: photo(B2).digest }],
    }, asBob.sign);
    failedWith(await verify([genesis, moved], [alice, bob, carol]), 1, "EDITOR_AUTHOR_CHANGED");
  });
});

describe("C12-117, C12-119: grants take effect from the next entry, revocations too (P5.17)", () => {
  test("an editor with no grant in the parent's state is rejected, including after revocation; its earlier entries stay valid", async () => {
    const { alice, bob, carol, at, ref, sign, genesis, asBob } = await harbor();
    const byBob = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], ...asBob });
    const revoked = await updateOriginal(byBob, { versionTime: at(), editors: [grant(carol.did, { metadata: true })], author: ref, sign });
    expect((revoked.state.asset as JsonObject).editors).toEqual([grant(carol.did, { metadata: true })]);
    // C12-117: after revocation, Bob's change is rejected by the builder and by the verifier.
    await expect(updateOriginal(revoked, { versionTime: at(), resources: [photo(B3)], ...asBob })).rejects.toMatchObject({ category: "unauthorized-key", code: "EDITOR_NOT_GRANTED" });
    const asset = revoked.state.asset as JsonObject;
    const late = await forge(revoked, {
      ...revoked.state, operation: "update", editor: bob.ref("edit"),
      asset: { ...asset, resources: [photo(B3)] }, transitions: [{ resource: "photo", from: photo(B2).digest, to: photo(B3).digest }],
    }, asBob.sign);
    failedWith(await verify([genesis, byBob, revoked, late], [alice, bob, carol]), 3, "EDITOR_NOT_GRANTED", "unauthorized-key");
    // C12-119: Bob's entry before the revocation remains valid.
    const r = await verify([genesis, byBob, revoked], [alice, bob, carol]);
    expect(r.history.status).toBe("valid");
    expect(r.resources.versions.at(-1)?.versionId).toBe(byBob.versionId);
    expect(r.reasons).toEqual(["not-anchored"]);
    // C12-05: a key of another identity, never granted, changes nothing.
    const dave = await VhAuthor.create([{ fragment: "edit", signer: seeded(33) }]);
    const byDave = await forge(genesis, { ...genesis.state, operation: "update", transitions: [], editor: dave.ref("edit"), asset: { ...(genesis.state.asset as JsonObject), metadata: { x: 1 } } }, dave.signer(seeded(33), "edit"));
    failedWith(await verify([genesis, byDave], [alice, bob, carol, dave]), 1, "EDITOR_NOT_GRANTED", "unauthorized-key");
  });

  test("a grant added by an author entry is usable from the next entry; narrowing it limits the next one", async () => {
    const { alice, bob, carol, at, ref, sign, genesis, asBob } = await harbor();
    const widened = await updateOriginal(genesis, { versionTime: at(), editors: [grant(bob.did, { name: true, resources: ["photo"] })], author: ref, sign });
    const renamed = await updateOriginal(widened, { versionTime: at(), name: "Harbor, by Bob", ...asBob });
    const narrowed = await updateOriginal(renamed, { versionTime: at(), editors: [grant(bob.did, { resources: ["photo"] })], author: ref, sign });
    await expect(updateOriginal(narrowed, { versionTime: at(), name: "Again", ...asBob })).rejects.toMatchObject({ code: "EDITOR_OUTSIDE_GRANT" });
    const r = await verify([genesis, widened, renamed, narrowed], [alice, bob, carol]);
    expect(r.state?.name).toBe("Harbor, by Bob");
    expect(r.state?.editors).toEqual([grant(bob.did, { resources: ["photo"] })]);
    // Removing every grant leaves no editors list (PROVISIONAL: absent means none).
    const none = await updateOriginal(narrowed, { versionTime: at(), editors: null, author: ref, sign });
    expect((none.state.asset as JsonObject).editors).toBeUndefined();
  });
});

describe("C12-120, C12-142: grant rules (P5.15)", () => {
  test("a grant naming the author DID, a DID of the author's identity, a duplicate editor or an unlisted DID method is rejected", async () => {
    const { alice, bob, at, ref, sign, genesis } = await harbor();
    const webAlice = await WebvhAuthor.create([{ fragment: "orig", signer: KA }]);
    await webAlice.move("new.example.org", [{ fragment: "orig", signer: KA }]);
    const webRef = webAlice.ref("orig");
    const webGenesis = await createOriginal({ versionTime: at(), name: "x", resources: [photo(B1)], author: webRef, sign: webAlice.signer(KA, webRef) });
    for (const [previous, author, signWith, editors] of [
      [genesis, ref, sign, [grant(alice.did)]],
      [webGenesis, webRef, webAlice.signer(KA, webRef), [grant(webAlice.location)]],
      [genesis, ref, sign, [grant(bob.did), grant(bob.did, { name: true })]],
      [genesis, ref, sign, [grant("did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK")]],
      [genesis, ref, sign, [grant("did:web:example.com")]],
      [genesis, ref, sign, [grant(bob.did, { resources: ["sidecar"] })]],
      [genesis, ref, sign, [grant(bob.did, { resources: ["photo", "photo"] })]],
    ] as Array<[LogEntry, AuthorRef, Parameters<typeof updateOriginal>[1]["sign"], EditorGrant[]]>) {
      await expect(updateOriginal(previous, { versionTime: at(), editors, author, sign: signWith })).rejects.toMatchObject({ code: "STATE_EDITORS" });
    }
    // The verifier rejects such a state too.
    const asset = genesis.state.asset as JsonObject;
    const self = await forge(genesis, { ...genesis.state, operation: "update", transitions: [], asset: { ...asset, editors: [grant(alice.did)] } }, sign);
    failedWith(await verify([genesis, self], [alice, bob]), 1, "STATE_EDITORS");
    // Members are exactly did, name, metadata and resources (PROVISIONAL, D4).
    expect(() => checkAsset({ ...asset, editors: [{ ...grant(bob.did), role: "admin" }] }, alice.did)).toThrow(/editors/);
    expect(() => checkAsset({ ...asset, editors: [] }, alice.did)).toThrow(/editors/);
  });

  test("C12-144: a grant naming the Original's own did:vh or one of its aliases is rejected (P5.15, P9.12)", async () => {
    const { alice, bob, at, ref, sign, genesis } = await harbor();
    const own = genesis.state.id as string;
    await expect(updateOriginal(genesis, { versionTime: at(), editors: [grant(own)], author: ref, sign })).rejects.toMatchObject({ code: "STATE_EDITORS" });
    const asset = genesis.state.asset as JsonObject;
    const self = await forge(genesis, { ...genesis.state, operation: "update", transitions: [], asset: { ...asset, editors: [grant(own)] } }, sign);
    failedWith(await verify([genesis, self], [alice, bob]), 1, "STATE_EDITORS");
    // The Original's did:webvh alias names the Original too, so a grant to it confers nothing.
    const alias = "did:webvh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ:example.com";
    const aliased = await forge(genesis, { ...genesis.state, operation: "update", transitions: [], asset: { ...asset, aliases: [alias], editors: [grant(alias)] } }, sign);
    failedWith(await verify([genesis, aliased], [alice, bob]), 1, "STATE_EDITORS");
  });

  test("C12-142: the profile limits the number of grants (P7.7)", async () => {
    const { alice, genesis } = await harbor();
    const asset = genesis.state.asset as JsonObject;
    const many = Array.from({ length: ORIGINALS_LIMITS.editors + 1 }, (_, i) => grant(`did:vh:Qm${String(i).padStart(44, "x")}`));
    expect(() => checkAsset({ ...asset, editors: many }, alice.did)).toThrow(expect.objectContaining({ category: "limit-exceeded" }) as never);
  });
});

describe("C12-06: a key that is not a method of the editor DID", () => {
  test("fails signer binding, whatever the grant (P5.3, P5.16)", async () => {
    const { alice, bob, carol, genesis } = await harbor();
    const loose = seeded(34);
    const claim = { ...bob.ref("loose") };
    const entry = await forge(genesis, {
      ...genesis.state, operation: "update", editor: claim,
      asset: { ...(genesis.state.asset as JsonObject), resources: [photo(B2)] }, transitions: [{ resource: "photo", from: photo(B1).digest, to: photo(B2).digest }],
    }, bob.signer(loose, "loose"));
    failedWith(await verify([genesis, entry], [alice, bob, carol]), 1, "AUTHOR_VM_NOT_IN_DOCUMENT", "author-binding");
    // The proof must be by the editor's method the entry names (P5.2).
    const byAlice = await forge(genesis, {
      ...genesis.state, operation: "update", editor: bob.ref("edit"),
      asset: { ...(genesis.state.asset as JsonObject), resources: [photo(B2)] }, transitions: [{ resource: "photo", from: photo(B1).digest, to: photo(B2).digest }],
    }, alice.signer(KA, "orig"));
    failedWith(await verify([genesis, byAlice], [alice, bob, carol]), 1, "SIGNER_VM_MISMATCH", "author-binding");
  });

  test("an editor's key that is an update key of its own DID log cannot sign (P5.3, P5.18)", async () => {
    const { alice, carol, at, ref, sign } = await harbor();
    const eve = await VhAuthor.create([]);
    await eve.rotate([{ fragment: "edit", signer: eve.update }]);
    const genesis = await createOriginal({ versionTime: at(), name: "x", resources: [photo(B1)], author: ref, sign, editors: [grant(eve.did, { metadata: true })] });
    const entry = await updateOriginal(genesis, { versionTime: at(), metadata: { by: "eve" }, editor: eve.ref("edit"), sign: eve.signer(eve.update, "edit") });
    failedWith(await verify([genesis, entry], [alice, carol, eve]), 1, "AUTHOR_KEY_IS_UPDATE_KEY", "author-binding");
  });
});

describe("C12-141: per-signer version order (P5.8, P5.18)", () => {
  test("an editor may not name an older editor DID version than its own previous entry; the author's order is its own", async () => {
    const { alice, bob, carol, at, ref, sign, genesis, asBob } = await harbor();
    const v1 = bob.versionId;
    await bob.rotate([{ fragment: "edit", signer: KB }]);
    const newer = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], editor: bob.ref("edit"), sign: asBob.sign });
    const older = await updateOriginal(newer, { versionTime: at(), resources: [photo(B3)], editor: bob.ref("edit", v1), sign: asBob.sign });
    failedWith(await verify([genesis, newer, older], [alice, bob, carol]), 2, "SIGNER_VERSION_REGRESSED");
    // An author entry after editor entries is compared with the author's own earlier entries only.
    const byAuthor = await updateOriginal(newer, { versionTime: at(), name: "Harbor", author: ref, sign });
    expect((await verify([genesis, newer, byAuthor], [alice, bob, carol])).history.status).toBe("valid");
  });
});

describe("C12-121 (unanchored), C12-122 (unanchored): editor keys and the author DID's deactivation (P5.18, P7.9)", () => {
  test("an editor entry signed with a key removed from the editor DID is valid history but not current", async () => {
    const { alice, bob, carol, at, genesis, asBob } = await harbor();
    const byBob = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], ...asBob });
    await bob.rotate([{ fragment: "edit-2", signer: seeded(35) }]);
    const r = await verify([genesis, byBob], [alice, bob, carol]);
    expect(r.history.status).toBe("valid");
    expect(r.reasons).toEqual(["not-anchored", "historically-authorized-only"]);
    expect(r.current).toBe(false);
  });

  test("once the author DID is deactivated, an editor entry is not current", async () => {
    const { alice, bob, carol, at, genesis, asBob } = await harbor();
    await alice.deactivate();
    const byBob = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], ...asBob });
    const r = await verify([genesis, byBob], [alice, bob, carol]);
    expect(r.history.status).toBe("valid");
    expect(r.reasons).toContain("author-did-deactivated");
    expect(r.current).toBe(false);
  });
});

describe("C12-124: editor DID history missing for an editor entry", () => {
  test("incomplete identity evidence naming the editor; not current (P7.1, P5.6)", async () => {
    const { alice, bob, carol, at, genesis, asBob } = await harbor();
    const byBob = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], ...asBob });
    const r = await verify([genesis, byBob], [alice, carol]);
    failedWith(r, 1, "EDITOR_HISTORY_MISSING", "incomplete-evidence");
    expect(r.history.status).toBe("incomplete");
    expect(r.identityEvidence.status).toBe("incomplete");
    expect(r.identityEvidence.editors).toEqual([expect.objectContaining({ did: bob.did, status: "incomplete" })]);
  });
});

describe("editor freshness and retained versions (P7.8)", () => {
  test("each editor's freshness is reported (P7.8)", async () => {
    const { alice, bob, carol, at, genesis, asBob } = await harbor();
    const byBob = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], ...asBob });
    const plain = await verifyOriginal({ log: [genesis, byBob], authors: [alice.evidence(), bob.evidence(), carol.evidence()], now: NOW, bytes: allBytes });
    expect(plain.identityEvidence.editors[0]).toMatchObject({ did: bob.did, freshness: "not-established" });
    expect(plain.current).toBe(false);
    // A retained editor version the evidence falls short of is stale.
    const v2 = await bob.rotate([{ fragment: "edit", signer: KB }]);
    const stale = await verify([genesis, byBob], [alice, carol], { authors: [alice.evidence(), bob.evidence(bob.entries.slice(0, 1)), carol.evidence()], retained: { authors: { [bob.did]: v2 } } });
    expect(stale.identityEvidence.editors[0]).toMatchObject({ did: bob.did, freshness: "stale", retainedVersionId: v2 });
    expect(stale.reasons).toContain("editor-history-older-than-retained");
    const fresh = await verify([genesis, byBob], [alice, bob, carol]);
    expect(fresh.retain.authors[bob.did]).toBe(v2);
  });
});

describe("C12-118, C12-130, C12-131: editor entries in forks (P5.17, P6.6)", () => {
  test("an editor entry and a revoking author entry with the same parent are an unresolved fork", async () => {
    const { alice, bob, carol, at, ref, sign, genesis, asBob } = await harbor();
    const byBob = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], ...asBob });
    const revoke = await updateOriginal(genesis, { versionTime: at(), editors: [grant(carol.did, { metadata: true })], author: ref, sign });
    for (const [mine, theirs] of [[byBob, revoke], [revoke, byBob]]) {
      const r = await verify([genesis, mine], [alice, bob, carol], { copies: [{ source: "mirror", log: serializeLog([genesis, theirs]) }] });
      expect(r.history.status).toBe("valid");
      expect(r.fork?.branches.map((b) => b.versionId).sort()).toEqual([byBob.versionId, revoke.versionId].sort());
      expect(r.current).toBe(false);
      expect(r.reasons).toContain("fork-unresolved");
    }
  });

  test("the longer branch, or the branch with more signers, wins nothing", async () => {
    const { alice, bob, carol, at, ref, sign, genesis, asBob, asCarol } = await harbor();
    const byBob = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], ...asBob });
    const byCarol = await updateOriginal(byBob, { versionTime: at(), metadata: { caption: "c" }, ...asCarol });
    const byBobAgain = await updateOriginal(byCarol, { versionTime: at(), resources: [photo(B3)], ...asBob });
    const short = await updateOriginal(genesis, { versionTime: at(), name: "Harbor (Alice)", author: ref, sign });
    const long = [genesis, byBob, byCarol, byBobAgain];
    for (const [mine, theirs] of [[long, [genesis, short]], [[genesis, short], long]]) {
      const r = await verify(mine, [alice, bob, carol], { copies: [{ source: "mirror", log: serializeLog(theirs) }] });
      expect(r.fork).not.toBeNull();
      expect(r.current).toBe(false);
    }
  });

  test("an entry on one branch bringing in content from the other is an ordinary single-parent entry; the fork remains", async () => {
    const { alice, bob, carol, at, ref, sign, genesis, asBob } = await harbor();
    const byBob = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], ...asBob });
    const byAlice = await updateOriginal(genesis, { versionTime: at(), name: "Harbor (Alice)", author: ref, sign });
    // Alice brings Bob's photo into her branch.
    const merged = await updateOriginal(byAlice, { versionTime: at(), resources: [photo(B2)], author: ref, sign });
    const r = await verify([genesis, byAlice, merged], [alice, bob, carol], { copies: [{ source: "mirror", log: serializeLog([genesis, byBob]) }] });
    expect(r.history.status).toBe("valid");
    expect(r.state?.resources[0].digest).toBe(photo(B2).digest);
    expect(r.state?.name).toBe("Harbor (Alice)");
    expect(r.fork).not.toBeNull();
    expect(r.current).toBe(false);
  });
});

describe("C12-134: a moved author whose latest asset entry is an editor entry (P5.14, P7.8)", () => {
  test("the author's location comes from the latest author entry; editor entries do not reveal where the author moved", async () => {
    const alice = await WebvhAuthor.create([{ fragment: "orig-1", signer: KA }]);
    const bob = await VhAuthor.create([{ fragment: "edit", signer: KB }]);
    const at = clock();
    const ref = alice.ref("orig-1");
    const genesis = await createOriginal({ versionTime: at(), name: "Harbor", resources: [photo(B1)], author: ref, sign: alice.signer(KA, ref), editors: [grant(bob.did, { resources: ["photo"] })] });
    await alice.move("new.example.org", [{ fragment: "orig-1", signer: KA }]);
    const byBob = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], editor: bob.ref("edit"), sign: bob.signer(KB, "edit") });
    expect(byBob.state.author).toEqual(ref);
    const log = [genesis, byBob];
    // The log is where Alice now is, but nothing in the asset log says so: not established.
    const atNew = await verifyOriginal({ log, authors: [{ ...alice.evidence(), retrievedFrom: didWebvhLogUrl(alice.location) }, bob.evidence()], now: NOW, bytes: allBytes });
    expect(atNew.identityEvidence.freshness).toBe("not-established");

    expect(atNew.current).toBe(false);
    // Found where the latest author entry says she was, but her log there says she has moved: not her latest (P7.8).
    const atOld = await verifyOriginal({ log, authors: [{ ...alice.evidence(), retrievedFrom: didWebvhLogUrl(alice.did) }, bob.evidence()], now: NOW, bytes: allBytes });
    expect(atOld.identityEvidence.freshness).toBe("not-established");
  });
});

describe("review of the editors PR (A1, A2, A5, grant DID syntax)", () => {
  test("C12-121, C12-122: an unanchored head by an editor whose DID's latest verified state is deactivated is not current (P5.18, P6.5, P7.9)", async () => {
    const { alice, bob, carol, at, genesis, asBob } = await harbor();
    await bob.deactivate();
    // A thief holding Bob's key signs naming Bob's version before the deactivation.
    const byBob = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], ...asBob });
    const r = await verify([genesis, byBob], [alice, bob, carol]);
    expect(r.history.status).toBe("valid");
    expect(r.identityEvidence.editors[0]).toMatchObject({ did: bob.did, deactivated: true });
    expect(r.reasons).toContain("historically-authorized-only");
    expect(r.current).toBe(false);
  });

  test("C12-48, C12-122: an entry naming a signer DID version that is itself deactivated is rejected, for the author and for an editor (P5.3, P6.5)", async () => {
    const editorCase = await harbor();
    await editorCase.bob.deactivate();
    const ref = editorCase.bob.ref("edit", editorCase.bob.versionId);
    const byBob = await forge(editorCase.genesis, {
      ...editorCase.genesis.state, operation: "update", editor: ref,
      asset: { ...(editorCase.genesis.state.asset as JsonObject), resources: [photo(B2)] }, transitions: [{ resource: "photo", from: photo(B1).digest, to: photo(B2).digest }],
    }, editorCase.bob.signer(KB, "edit"));
    failedWith(await verify([editorCase.genesis, byBob], [editorCase.alice, editorCase.bob, editorCase.carol]), 1, "SIGNER_VERSION_DEACTIVATED", "deactivated");

    const authorCase = await harbor();
    await authorCase.alice.deactivate();
    const aliceRef = authorCase.alice.ref("orig", authorCase.alice.versionId);
    const byAlice = await forge(authorCase.genesis, { ...authorCase.genesis.state, operation: "update", transitions: [], author: aliceRef, asset: { ...(authorCase.genesis.state.asset as JsonObject), name: "M" } }, authorCase.alice.signer(KA, "orig"));
    failedWith(await verify([authorCase.genesis, byAlice], [authorCase.alice, authorCase.bob, authorCase.carol]), 1, "SIGNER_VERSION_DEACTIVATED", "deactivated");
  });

  test("C12-120: two grants for one did:webvh identity (one SCID, two locations) are rejected (P5.14, P5.15)", async () => {
    const { alice, at, ref, sign, genesis } = await harbor();
    const ed = await WebvhAuthor.create([{ fragment: "e", signer: seeded(41) }], { domain: "a.example.com" });
    await ed.move("b.example.com", [{ fragment: "e", signer: seeded(41) }]);
    const editors = [grant(ed.did, { resources: ["photo"] }), grant(ed.location, { resources: ["photo"] })];
    await expect(updateOriginal(genesis, { versionTime: at(), editors, author: ref, sign })).rejects.toMatchObject({ code: "STATE_EDITORS" });
    expect(() => checkAsset({ ...(genesis.state.asset as JsonObject), editors }, alice.did)).toThrow(/identity/);
  });

  test("per-signer version order is by identity: a moved editor cannot go back by naming its other DID (P5.8, P5.14, P5.18)", async () => {
    const KE1 = seeded(41);
    const KE2 = seeded(42);
    const { alice, at, ref, sign } = await harbor();
    const ed = await WebvhAuthor.create([{ fragment: "e", signer: KE1 }], { domain: "a.example.com" });
    const vOld = ed.versionId;
    // Granted under its first DID; later the author re-grants it under the DID it moved to.
    const genesis = await createOriginal({ versionTime: at(), name: "N", resources: [photo(B1)], author: ref, sign, editors: [grant(ed.did, { resources: ["photo"] })] });
    await ed.move("b.example.com", [{ fragment: "e", signer: KE1 }]);
    await ed.rotate([{ fragment: "e2", signer: KE2 }]);
    const newRef = { did: ed.did, verificationMethod: `${ed.location}#e2`, versionId: ed.versionId };
    const e1 = await updateOriginal(genesis, { versionTime: at(), resources: [photo(B2)], editor: newRef, sign: ed.signer(KE2, newRef) });
    const regrant = await updateOriginal(e1, { versionTime: at(), editors: [grant(ed.location, { resources: ["photo"] })], author: ref, sign });
    // As its other DID, naming the version before the move: older than its own earlier entry.
    const oldRef = { did: ed.location, verificationMethod: `${ed.did}#e`, versionId: vOld };
    const back = await forge(regrant, {
      ...regrant.state, operation: "update", editor: oldRef, author: regrant.state.author,
      asset: { ...(regrant.state.asset as JsonObject), resources: [photo(B3)] }, transitions: [{ resource: "photo", from: photo(B2).digest, to: photo(B3).digest }],
    }, ed.signer(KE1, oldRef));
    const r = await verifyOriginal({ log: [genesis, e1, regrant, back], authors: [alice.evidence(), ed.evidence(), ed.evidence(undefined, ed.location)], now: NOW, bytes: allBytes });
    failedWith(r, 3, "SIGNER_VERSION_REGRESSED");
  });

  test("C12-05, C12-117: an ungranted editor is rejected, not reported as missing evidence (P5.16, P5.17)", async () => {
    const { alice, bob, genesis } = await harbor();
    const mallory = await VhAuthor.create([{ fragment: "edit", signer: seeded(66) }]);
    const asset = genesis.state.asset as JsonObject;
    const entry = await forge(genesis, { ...genesis.state, operation: "update", transitions: [], editor: mallory.ref("edit"), asset: { ...asset, name: "pwned" } }, mallory.signer(seeded(66), "edit"));
    // Mallory's DID history is not even supplied: the missing grant decides first.
    const r = await verify([genesis, entry], [alice, bob]);
    failedWith(r, 1, "EDITOR_NOT_GRANTED", "unauthorized-key");
    expect(r.history.status).toBe("invalid");
    expect(r.identityEvidence.editors).toEqual([]);
  });

  test("C12-120: a grant DID with a query, fragment or path, or a malformed did:vh or did:btco, is rejected; the author's DID with a suffix is the author's identity (P5.15)", async () => {
    const { alice, bob, genesis } = await harbor();
    const asset = genesis.state.asset as JsonObject;
    for (const did of [`${bob.did}?versionId=1`, `${bob.did}#x`, `${bob.did}/p`, "did:vh:x y", "did:vh:abc", "did:btco:0123", "did:btco:abc", "did:btco:2099999997690000", "did:btco:reg:", "did:btco:main:5"]) {
      expect(() => checkAsset({ ...asset, editors: [grant(did)] }, alice.did), did).toThrow(expect.objectContaining({ code: "STATE_EDITORS" }) as never);
    }
    for (const did of [`${alice.did}?versionId=1`, `${alice.did}#x`, `${alice.did}/p`]) {
      expect(() => checkAsset({ ...asset, editors: [grant(did)] }, alice.did), did).toThrow(/author's identity/);
    }
    for (const did of ["did:btco:0", "did:btco:2099999997689999", "did:btco:reg:5", "did:btco:sig:12", "did:btco:test:7"]) {
      expect(() => checkAsset({ ...asset, editors: [grant(did)] }, alice.did), did).not.toThrow();
    }
  });
});
