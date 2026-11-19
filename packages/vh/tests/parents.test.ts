/**
 * Parent Originals: authority from a parent, pinned (P5.24–P5.27; originals-spec
 * #66, owner decision of 19 November 2026, D8). A child Original names a
 * parent Original and pins a versionId of the parent's log in every entry. An
 * editor entry of the child may rely on a grant in the parent's `editors` at
 * that pin, an inherited grant. The parent contributes grants only.
 *
 * Section 12 rows C12-398 to C12-410 (table rows 301–313). Row 314, the
 * evidence package, is the SDK's (packages/sdk/tests/unit/originals/parents.test.ts).
 */
import { describe, expect, test } from "bun:test";
import type { JsonObject } from "../src/json/index.js";
import { appendEntry, createLog, serializeLog, type EntrySigner, type LogEntry } from "../src/log/index.js";
import { OriginalsError } from "../src/errors.js";
import {
  ORIGINALS_METHOD,
  createOriginal,
  deactivateOriginal,
  inheritedGrant,
  parseBtcoAlias,
  prepareUpdateOriginal,
  resourceDigest,
  updateOriginal,
  verifyOriginal,
  type AuthorRef,
  type EditorGrant,
  type EntryState,
  type OriginalsReport,
  type ParentEvidence,
  type SatEvidence,
  type SatInscription,
} from "../src/originals/index.js";
import { NOW, VhAuthor, bytes, carrying, photo, seeded } from "./helpers/originals.js";

const P1 = "repository, first tree";
const P2 = "repository, second tree";
const C1 = "branch, first tree";
const C2 = "branch, docs changed";
const C3 = "branch, docs changed again";
const allBytes = Object.fromEntries([P1, P2, C1, C2, C3].map((t) => [resourceDigest(bytes(t)), bytes(t)]));

const grant = (did: string, g: Partial<Omit<EditorGrant, "did">> = {}): EditorGrant => ({ did, name: false, metadata: false, resource: true, ...g });

interface Who { did: VhAuthor; ref: () => AuthorRef; sign: EntrySigner }
const who = async (seed: number, fragment = "orig"): Promise<Who> => {
  const key = seeded(seed);
  const did = await VhAuthor.create([{ fragment, signer: key }]);
  return { did, ref: () => did.ref(fragment), sign: did.signer(key, fragment) };
};
const as = (w: Who) => ({ author: w.ref(), sign: w.sign });
const asEditor = (w: Who) => ({ editor: w.ref(), sign: w.sign });

const T0 = Date.parse("2026-10-18T12:00:00Z");
/** An entry's versionTime a minute before block `height` (blocks are ten minutes apart). */
const time = (height: number, n = 0) => new Date(T0 + height * 600_000 - 60_000 + n * 1000).toISOString();

/**
 * Alice's repository R grants Dana `resource: true`; Bob's branch B names R as
 * its parent, pinning the version that grants Dana. Erin is an outsider.
 */
async function repository() {
  const [alice, bob, dana, erin] = await Promise.all([who(21), who(31), who(41, "edit"), who(51)]);
  const r1 = await createOriginal({ versionTime: time(1), name: "Repository", resource: photo(P1), ...as(alice) });
  const r2 = await updateOriginal(r1, { versionTime: time(2), editors: [grant(dana.did.did)], ...as(alice) });
  const parent = { did: r1.state.id as string, versionId: r2.versionId };
  const b1 = await createOriginal({ versionTime: time(3), name: "Branch", resource: photo(C1), parent, ...as(bob) });
  return { alice, bob, dana, erin, r1, r2, b1, parent };
}

const signers = (...list: Who[]) => list.map((w) => w.did.evidence());
const parentOf = (log: LogEntry[], extra: Partial<ParentEvidence> = {}): ParentEvidence => ({ did: log[0].state.id as string, log: serializeLog(log), ...extra });
const verify = (log: LogEntry[], authors: Who[], parents: ParentEvidence[] = [], extra: Partial<Parameters<typeof verifyOriginal>[0]> = {}): Promise<OriginalsReport> =>
  verifyOriginal({ log, authors: signers(...authors), parents, now: NOW, bytes: allBytes, ...extra });

function valid(r: OriginalsReport) {
  expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
  expect(r.authorBinding.status).toBe("valid");
  expect(r.identityEvidence.status, JSON.stringify(r.identityEvidence.failure)).toBe("complete");
}

function failedWith(r: OriginalsReport, index: number, code: string, category?: string) {
  expect(r.history.failure?.index, JSON.stringify(r.history.failure)).toBe(index);
  expect(r.history.failure?.code, JSON.stringify(r.history.failure)).toBe(code);
  if (category) expect(r.history.failure?.category).toBe(category);
  expect(r.validAsOf).toBeNull();
}

async function rejects(run: () => unknown, code: string) {
  let error: unknown;
  try {
    await run();
  } catch (e) {
    error = e;
  }
  expect(error, `expected ${code}`).toBeInstanceOf(OriginalsError);
  expect((error as OriginalsError).code, (error as Error).message).toBe(code);
}

/** Sign a state after `previous`, bypassing the builders' checks. */
const forge = (previous: LogEntry, state: JsonObject, sign: EntrySigner, versionTime: string) => appendEntry(previous, { versionTime, parameters: {}, state, sign });
const asset = (e: LogEntry) => e.state.asset as JsonObject;

describe("C12-398: an inherited grant authorizes a child editor entry (P5.24)", () => {
  test("Dana, granted in the parent at the pin, edits the branch; the report names the inherited grant and the parent version", async () => {
    const { alice, bob, dana, r1, r2, b1, parent } = await repository();
    const b2 = await updateOriginal(b1, { versionTime: time(4), resource: photo(C2), ...asEditor(dana), inherited: grant(dana.did.did) });
    const r = await verify([b1, b2], [alice, bob, dana], [parentOf([r1, r2])]);
    valid(r);
    expect(r.grants).toEqual([{ versionId: b2.versionId, editor: dana.did.did, source: "inherited", parent }]);
    expect(r.parentAuthority).toEqual({ did: parent.did, status: "verified", pins: [parent.versionId], anchored: false, forked: false, latestVersionId: r2.versionId, anchoring: "not-applicable" });
    expect(r.historicallyAuthorizedOnly).toEqual([]);
    // The builder needs the inherited grant: without it Dana has none in the branch.
    await rejects(() => prepareUpdateOriginal(b1, { versionTime: time(4), resource: photo(C2), editor: dana.ref() }), "EDITOR_NOT_GRANTED");
  });

  test("a direct grant that allows the change is the one reported; one grant must allow the whole change", async () => {
    const { alice, bob, dana, r1, r2, b1 } = await repository();
    const direct = await updateOriginal(b1, { versionTime: time(4), editors: [grant(dana.did.did, { resource: false, metadata: true })], ...as(bob) });
    const meta = await updateOriginal(direct, { versionTime: time(5), metadata: { note: "docs" }, ...asEditor(dana), inherited: grant(dana.did.did) });
    const res = await updateOriginal(meta, { versionTime: time(6), resource: photo(C2), ...asEditor(dana), inherited: grant(dana.did.did) });
    const r = await verify([b1, direct, meta, res], [alice, bob, dana], [parentOf([r1, r2])]);
    valid(r);
    expect(r.grants.map((g) => g.source)).toEqual(["direct", "inherited"]);
    // Metadata (direct) and the resource (inherited) together: no one grant allows both.
    const both = await forge(direct, { ...direct.state, editor: dana.ref() as unknown as JsonObject, asset: { ...asset(direct), metadata: { note: "x" }, resource: photo(C2) } as unknown as JsonObject, transitions: [{ from: photo(C1).digest, to: photo(C2).digest }] }, dana.sign, time(5));
    failedWith(await verify([b1, direct, both], [alice, bob, dana], [parentOf([r1, r2])]), 2, "EDITOR_OUTSIDE_GRANT", "outside-grant");
  });
});

describe("C12-399, C12-404: an inherited grant the parent's latest state no longer gives is historically authorized only (P5.26)", () => {
  test("C12-399: revoked or narrowed in the parent after the pin: the entry stays valid, labelled historically authorized only", async () => {
    const { alice, bob, dana, r1, r2, b1 } = await repository();
    const b2 = await updateOriginal(b1, { versionTime: time(4), resource: photo(C2), ...asEditor(dana), inherited: grant(dana.did.did) });
    const narrowed = await updateOriginal(r2, { versionTime: time(5), editors: [grant(dana.did.did, { resource: false, metadata: true })], ...as(alice) });
    const n = await verify([b1, b2], [alice, bob, dana], [parentOf([r1, r2, narrowed])]);
    valid(n);
    expect(n.historicallyAuthorizedOnly).toEqual([{ versionId: b2.versionId, did: dana.did.did, role: "editor", reason: "inherited-grant-revoked", parent: { did: r1.state.id, versionId: r2.versionId } }]);
    expect(n.reasons).toContain("historically-authorized-only");
    const revoked = await updateOriginal(narrowed, { versionTime: time(6), editors: null, ...as(alice) });
    const v = await verify([b1, b2], [alice, bob, dana], [parentOf([r1, r2, narrowed, revoked])]);
    valid(v);
    expect(v.historicallyAuthorizedOnly.map((h) => h.reason)).toEqual(["inherited-grant-revoked"]);
    // Once the branch pins the revocation, Dana's next entry has no grant.
    const pinned = await updateOriginal(b2, { versionTime: time(7), name: "Branch, pinned", pin: revoked.versionId, ...as(bob) });
    const after = await forge(pinned, { ...pinned.state, editor: dana.ref() as unknown as JsonObject, asset: { ...asset(pinned), resource: photo(C3) } as unknown as JsonObject, transitions: [{ from: photo(C2).digest, to: photo(C3).digest }] }, dana.sign, time(8));
    failedWith(await verify([b1, b2, pinned, after], [alice, bob, dana], [parentOf([r1, r2, narrowed, revoked])]), 3, "EDITOR_NOT_GRANTED", "unauthorized-key");
  });

  test("the parent's deactivation in its latest state also labels the entry (P5.26)", async () => {
    const { alice, bob, dana, r1, r2, b1 } = await repository();
    const b2 = await updateOriginal(b1, { versionTime: time(4), resource: photo(C2), ...asEditor(dana), inherited: grant(dana.did.did) });
    const end = await deactivateOriginal(r2, { versionTime: time(5), ...as(alice) });
    const r = await verify([b1, b2], [alice, bob, dana], [parentOf([r1, r2, end])]);
    valid(r);
    expect(r.historicallyAuthorizedOnly.map((h) => h.reason)).toEqual(["parent-deactivated"]);
  });

  test("C12-404: a parent with divergent valid branches has no latest state: inherited entries are historically authorized only", async () => {
    const { alice, bob, dana, r1, r2, b1 } = await repository();
    const b2 = await updateOriginal(b1, { versionTime: time(4), resource: photo(C2), ...asEditor(dana), inherited: grant(dana.did.did) });
    const left = await updateOriginal(r2, { versionTime: time(5), name: "Repository, left", ...as(alice) });
    const right = await updateOriginal(r2, { versionTime: time(5, 1), name: "Repository, right", ...as(alice) });
    const r = await verify([b1, b2], [alice, bob, dana], [parentOf([r1, r2, left], { copies: [{ source: "mirror", log: serializeLog([r1, r2, right]) }] })]);
    valid(r);
    expect(r.parentAuthority?.forked).toBe(true);
    expect(r.parentAuthority?.latestVersionId).toBeNull();
    expect(r.historicallyAuthorizedOnly.map((h) => [h.versionId, h.reason])).toEqual([[b2.versionId, "parent-forked"]]);
    // An entry that does not rely on an inherited grant is unaffected by the parent's later state.
    const byBob = await updateOriginal(b1, { versionTime: time(4), name: "Branch, Bob", ...as(bob) });
    const s = await verify([b1, byBob], [alice, bob, dana], [parentOf([r1, r2, left], { copies: [{ source: "mirror", log: serializeLog([r1, r2, right]) }] })]);
    expect(s.historicallyAuthorizedOnly).toEqual([]);
  });
});

describe("C12-400: the pin never goes backwards, nor to another branch of the parent's log (P5.24)", () => {
  test("a pin older than its parent entry's is rejected; the same or a later one is accepted", async () => {
    const { alice, bob, dana, r1, r2, b1 } = await repository();
    const r3 = await updateOriginal(r2, { versionTime: time(4), name: "Repository, renamed", ...as(alice) });
    const forward = await updateOriginal(b1, { versionTime: time(5), name: "Branch, later pin", pin: r3.versionId, ...as(bob) });
    valid(await verify([b1, forward], [alice, bob, dana], [parentOf([r1, r2, r3])]));
    const back = await updateOriginal(forward, { versionTime: time(6), name: "Branch, older pin", pin: r2.versionId, ...as(bob) });
    failedWith(await verify([b1, forward, back], [alice, bob, dana], [parentOf([r1, r2, r3])]), 2, "PARENT_PIN_BACKWARDS", "invalid-evidence");
  });

  test("a pin that moves to another branch of the parent's log is rejected", async () => {
    const { alice, bob, dana, r1, r2, b1 } = await repository();
    const left = await updateOriginal(r2, { versionTime: time(4), name: "Repository, left", ...as(alice) });
    const right = await updateOriginal(r2, { versionTime: time(4, 1), name: "Repository, right", ...as(alice) });
    const onLeft = await updateOriginal(b1, { versionTime: time(5), name: "Branch, left", pin: left.versionId, ...as(bob) });
    const onRight = await updateOriginal(onLeft, { versionTime: time(6), name: "Branch, right", pin: right.versionId, ...as(bob) });
    const parents = [parentOf([r1, r2, left], { copies: [{ source: "mirror", log: serializeLog([r1, r2, right]) }] })];
    failedWith(await verify([b1, onLeft, onRight], [alice, bob, dana], parents), 2, "PARENT_PIN_OTHER_BRANCH", "invalid-evidence");
  });
});

describe("C12-401, C12-402: missing parent evidence is incomplete, never a pass (P5.25)", () => {
  test("C12-401: a child verified without its parent's log is incomplete, the parent listed missing", async () => {
    const { alice, bob, dana, b1, parent } = await repository();
    const r = await verify([b1], [alice, bob, dana]);
    expect(r.history.status).toBe("incomplete");
    expect(r.history.failure).toMatchObject({ index: 0, code: "PARENT_EVIDENCE_MISSING", category: "incomplete-evidence" });
    expect(r.parentAuthority).toMatchObject({ did: parent.did, status: "missing" });
    expect(r.validAsOf).toBeNull();
    expect(r.reasons).toContain("parent-evidence-incomplete");
  });

  test("C12-401: a log that stops before the pin is incomplete, not a pass", async () => {
    const { alice, bob, dana, r1, b1 } = await repository();
    const r = await verify([b1], [alice, bob, dana], [parentOf([r1])]);
    expect(r.history.status).toBe("incomplete");
    expect(r.history.failure?.code).toBe("PARENT_VERSION_MISSING");
    expect(r.parentAuthority?.status).toBe("incomplete");
  });

  test("C12-402: a pin absent from an unanchored parent's log that reaches its number is incomplete: it may be on a branch not obtained", async () => {
    const { alice, bob, dana, r1, r2, b1 } = await repository();
    const left = await updateOriginal(r2, { versionTime: time(4), name: "Repository, left", ...as(alice) });
    const right = await updateOriginal(r2, { versionTime: time(4, 1), name: "Repository, right", ...as(alice) });
    const onRight = await updateOriginal(b1, { versionTime: time(5), name: "Branch, right", pin: right.versionId, ...as(bob) });
    const r = await verify([b1, onRight], [alice, bob, dana], [parentOf([r1, r2, left])]);
    expect(r.history.status).toBe("incomplete");
    expect(r.history.failure).toMatchObject({ index: 1, code: "PARENT_VERSION_MISSING", category: "incomplete-evidence" });
    expect(r.validAsOf).toBeNull();
  });
});

describe("C12-403: a pin at the parent's deactivation grants nothing (P5.25)", () => {
  test("an editor entry relying on an inherited grant there is rejected; an author entry may still pin it", async () => {
    const { alice, bob, dana, r1, r2, b1 } = await repository();
    const end = await deactivateOriginal(r2, { versionTime: time(4), ...as(alice) });
    const pinned = await updateOriginal(b1, { versionTime: time(5), name: "Branch, after the repository", pin: end.versionId, ...as(bob) });
    valid(await verify([b1, pinned], [alice, bob, dana], [parentOf([r1, r2, end])]));
    const byDana = await forge(pinned, { ...pinned.state, editor: dana.ref() as unknown as JsonObject, asset: { ...asset(pinned), resource: photo(C2) } as unknown as JsonObject, transitions: [{ from: photo(C1).digest, to: photo(C2).digest }] }, dana.sign, time(6));
    failedWith(await verify([b1, pinned, byDana], [alice, bob, dana], [parentOf([r1, r2, end])]), 2, "PARENT_DEACTIVATED_AT_PIN", "unauthorized-key");
  });
});

describe("C12-405: `parent` is set at genesis only, never to the Original itself (P5.24)", () => {
  test("a genesis naming its own did:vh as parent is rejected", async () => {
    const { alice, bob, dana, r2 } = await repository();
    const self = await createLog({
      versionTime: time(3), parameters: { method: ORIGINALS_METHOD, scid: "{SCID}" },
      state: { id: "did:vh:{SCID}", operation: "create", author: bob.ref() as unknown as JsonObject, asset: { name: "Self", status: "active", resource: photo(C1), aliases: [], parent: { did: "did:vh:{SCID}", versionId: r2.versionId } }, transitions: [{ from: null, to: photo(C1).digest }] },
      sign: bob.sign,
    });
    failedWith(await verify([self], [alice, bob, dana]), 0, "STATE_PARENT", "invalid-evidence");
  });

  test("a later entry that adds, removes or retargets `parent` is rejected", async () => {
    const { alice, bob, dana, r1, r2, b1, parent } = await repository();
    const { parent: _p, ...without } = asset(b1);
    const removed = await forge(b1, { ...b1.state, operation: "update", author: bob.ref() as unknown as JsonObject, asset: without, transitions: [] }, bob.sign, time(4));
    failedWith(await verify([b1, removed], [alice, bob, dana], [parentOf([r1, r2])]), 1, "STATE_PARENT");
    const other = await createOriginal({ versionTime: time(1, 1), name: "Another", resource: photo(P2), ...as(alice) });
    const retarget = await forge(b1, { ...b1.state, operation: "update", asset: { ...asset(b1), parent: { did: other.state.id, versionId: other.versionId } } as unknown as JsonObject, transitions: [] }, bob.sign, time(4));
    failedWith(await verify([b1, retarget], [alice, bob, dana], [parentOf([r1, r2]), parentOf([other])]), 1, "STATE_PARENT");
    const plain = await createOriginal({ versionTime: time(3), name: "Plain", resource: photo(C1), ...as(bob) });
    const added = await forge(plain, { ...plain.state, operation: "update", asset: { ...asset(plain), parent } as unknown as JsonObject, transitions: [] }, bob.sign, time(4));
    failedWith(await verify([plain, added], [alice, bob, dana], [parentOf([r1, r2])]), 1, "STATE_PARENT");
    await rejects(() => prepareUpdateOriginal(plain, { versionTime: time(4), pin: r2.versionId, author: bob.ref() }), "STATE_PARENT");
  });
});

describe("C12-407, C12-408, C12-409: the parent contributes its own grants only (P5.24)", () => {
  test("C12-407: an inherited grant naming the child's author, a member of its set, or its anchoring sat authorizes nothing", async () => {
    const [alice, bob, carol] = await Promise.all([who(21), who(31), who(32)]);
    const SAT = "did:btco:reg:5000000001";
    const r1 = await createOriginal({ versionTime: time(1), name: "Repository", resource: photo(P1), editors: [grant(bob.did.did), grant(carol.did.did), grant(SAT)], ...as(alice) });
    const b1 = await createOriginal({ versionTime: time(3), name: "Branch", resource: photo(C1), parent: { did: r1.state.id as string, versionId: r1.versionId }, ...as(bob) });
    // Bob, the branch's author, as an editor of his own branch through the repository's grant.
    const byBob = await forge(b1, { ...b1.state, operation: "update", editor: bob.ref() as unknown as JsonObject, asset: { ...asset(b1), resource: photo(C2) } as unknown as JsonObject, transitions: [{ from: photo(C1).digest, to: photo(C2).digest }] }, bob.sign, time(4));
    failedWith(await verify([b1, byBob], [alice, bob], [parentOf([r1])]), 1, "EDITOR_NOT_GRANTED", "unauthorized-key");
    // A set branch: Carol, a member, as an editor through the repository's grant.
    const set = await createOriginal({ versionTime: time(3), name: "Set branch", resource: photo(C1), parent: { did: r1.state.id as string, versionId: r1.versionId }, authors: { threshold: 1, dids: [bob.did.did, carol.did.did].sort() }, author: [bob.ref(), carol.ref()].sort((a, b) => (a.did < b.did ? -1 : 1)), sign: [bob.sign, carol.sign] });
    const byCarol = await forge(set, { ...set.state, operation: "update", editor: carol.ref() as unknown as JsonObject, asset: { ...asset(set), resource: photo(C2) } as unknown as JsonObject, transitions: [{ from: photo(C1).digest, to: photo(C2).digest }] }, carol.sign, time(4));
    failedWith(await verify([set, byCarol], [alice, bob, carol], [parentOf([r1])]), 1, "EDITOR_NOT_GRANTED");
    // The branch's anchoring sat, granted in the repository: once the branch is anchored on it, that
    // inherited grant authorizes nothing, so holding the sat confers no edit authority (P9.12).
    const anchored = await updateOriginal(b1, { versionTime: time(4), aliases: [SAT], ...as(bob) });
    const r = await verify([b1, anchored], [alice, bob], [parentOf([r1])]);
    expect(r.history.status).toBe("valid");
    const child = anchored.state as unknown as EntryState;
    expect(inheritedGrant(r1.state as unknown as EntryState, SAT, { id: child.id, author: child.author, asset: child.asset })).toBeUndefined();
    expect(inheritedGrant(r1.state as unknown as EntryState, SAT, { id: (b1.state as unknown as EntryState).id, author: child.author, asset: (b1.state as unknown as EntryState).asset })).toEqual(grant(SAT));
  });

  test("C12-408: the parent's author, with no grant covering the change, cannot sign the child", async () => {
    const { alice, bob, dana, r1, r2, b1 } = await repository();
    const asAuthor = await forge(b1, { ...b1.state, operation: "update", author: alice.ref() as unknown as JsonObject, asset: { ...asset(b1), name: "Branch, Alice" }, transitions: [] }, alice.sign, time(4));
    failedWith(await verify([b1, asAuthor], [alice, bob, dana], [parentOf([r1, r2])]), 1, "AUTHOR_DID_CHANGED");
    const asEd = await forge(b1, { ...b1.state, operation: "update", editor: alice.ref() as unknown as JsonObject, asset: { ...asset(b1), name: "Branch, Alice" }, transitions: [] }, alice.sign, time(4));
    failedWith(await verify([b1, asEd], [alice, bob, dana], [parentOf([r1, r2])]), 1, "EDITOR_NOT_GRANTED", "unauthorized-key");
  });

  test("C12-409: a grant the parent itself inherits from its own parent gives the child nothing", async () => {
    const { alice, bob, dana, r1, r2 } = await repository();
    const erin = await who(51);
    // R grants Dana; M is a child of R with no grant of its own; C is a child of M.
    const m1 = await createOriginal({ versionTime: time(3), name: "Middle", resource: photo(P2), parent: { did: r1.state.id as string, versionId: r2.versionId }, ...as(erin) });
    const c1 = await createOriginal({ versionTime: time(4), name: "Grandchild", resource: photo(C1), parent: { did: m1.state.id as string, versionId: m1.versionId }, ...as(bob) });
    const byDana = await forge(c1, { ...c1.state, operation: "update", editor: dana.ref() as unknown as JsonObject, asset: { ...asset(c1), resource: photo(C2) } as unknown as JsonObject, transitions: [{ from: photo(C1).digest, to: photo(C2).digest }] }, dana.sign, time(5));
    const parents = [parentOf([m1]), parentOf([r1, r2])];
    // The grandchild alone verifies, with both ancestors' evidence: the middle is checked against the repository.
    valid(await verify([c1], [alice, bob, dana, erin], parents));
    failedWith(await verify([c1, byDana], [alice, bob, dana, erin], parents), 1, "EDITOR_NOT_GRANTED", "unauthorized-key");
    // Without the repository's log, the middle Original is incomplete, and so is the grandchild.
    expect((await verify([c1], [alice, bob, dana, erin], [parentOf([m1])])).history.status).toBe("incomplete");
  });
});

describe("C12-410: advancing the pin needs no grant (P5.16, P5.24)", () => {
  test("an editor entry under a metadata-only grant changes the metadata and advances the pin", async () => {
    const { alice, bob, dana, r1, r2, b1 } = await repository();
    const r3 = await updateOriginal(r2, { versionTime: time(4), name: "Repository, renamed", ...as(alice) });
    const meta = await updateOriginal(b1, { versionTime: time(5), editors: [grant(dana.did.did, { resource: false, metadata: true })], ...as(bob) });
    const moved = await updateOriginal(meta, { versionTime: time(6), metadata: { note: "pinned later" }, pin: r3.versionId, ...asEditor(dana) });
    const r = await verify([b1, meta, moved], [alice, bob, dana], [parentOf([r1, r2, r3])]);
    valid(r);
    expect(r.state?.parent?.versionId).toBe(r3.versionId);
    expect(r.parentAuthority?.pins).toEqual([r2.versionId, r3.versionId]);
  });
});

// ---------------------------------------------------------------------------- Bitcoin

const SAT_R = "did:btco:reg:5000000010";
const SAT_B = "did:btco:reg:5000000020";
let counter = 0;
const nextId = () => `${(counter++).toString(16).padStart(64, "e")}i0`;
type Inscribed = Omit<SatInscription, "sat" | "network">;
const inscribe = (entries: LogEntry | LogEntry[], height: number): Inscribed => ({
  id: nextId(), height, transactionIndex: 1, inscriptionIndex: 0, confirmations: 120 - height, inscriptionTime: T0 + height * 600_000, ...carrying(entries),
});
function satRead(alias: string, inscriptions: Inscribed[]): SatEvidence {
  const { sat, network } = parseBtcoAlias(alias);
  return { sat: alias, index: "ord-a", tip: { height: 119, hash: "bb".repeat(32) }, inscriptions: inscriptions.map((i) => ({ sat, network, ...i })), owner: { output: `${"cc".repeat(32)}:1`, confirmations: 3 } };
}

describe("C12-402, C12-406: an anchored parent (P5.25, P5.27)", () => {
  /** R anchored at height 10, and changed at height 15; B anchored at 12, pinning R's anchor. */
  async function anchoredPair() {
    const h = await repository();
    const r3 = await updateOriginal(h.r2, { versionTime: time(9), aliases: [SAT_R], ...as(h.alice) });
    const r4 = await updateOriginal(r3, { versionTime: time(15), name: "Repository, renamed", ...as(h.alice) });
    const rRead = satRead(SAT_R, [inscribe([h.r1, h.r2, r3], 10), inscribe(r4, 15)]);
    const b2 = await updateOriginal(h.b1, { versionTime: time(11), aliases: [SAT_B], pin: r3.versionId, ...as(h.bob) });
    const anchoring = inscribe([h.b1, b2], 12);
    const parent: ParentEvidence = { did: h.r1.state.id as string, bitcoin: [rRead] };
    return { ...h, r3, r4, rRead, b2, anchoring, parent };
  }
  const read = (log: LogEntry[], who: Who[], inscriptions: Inscribed[], parents: ParentEvidence[]) =>
    verifyOriginal({ log, authors: signers(...who), parents, now: NOW, bytes: allBytes, bitcoin: [satRead(SAT_B, inscriptions)] });

  test("C12-406: an inscription pinning a parent version older than the parent's accepted head then is rejected; pinning that head is accepted", async () => {
    const { alice, bob, dana, b1, b2, r3, r4, anchoring, parent } = await anchoredPair();
    // At height 20 R's accepted head is r4 (inscribed at 15).
    const old = await updateOriginal(b2, { versionTime: time(19), resource: photo(C2), ...asEditor(dana), inherited: grant(dana.did.did) });
    const r = await read([b1, b2], [alice, bob, dana], [anchoring, inscribe(old, 20)], [parent]);
    expect(r.anchoring?.status).toBe("anchored");
    expect(r.head).toBe(b2.versionId);
    expect(r.anchoring?.ignored).toEqual([expect.objectContaining({ versionId: old.versionId, reason: "parent-pin-behind-parent-head" })]);
    const atHead = await updateOriginal(b2, { versionTime: time(19), resource: photo(C2), pin: r4.versionId, ...asEditor(dana), inherited: grant(dana.did.did) });
    const s = await read([b1, b2], [alice, bob, dana], [anchoring, inscribe(atHead, 20)], [parent]);
    expect(s.head).toBe(atHead.versionId);
    expect(s.current).toBe(true);
    expect(s.parentAuthority).toMatchObject({ anchored: true, anchoring: "checked" });
    expect(s.grants).toEqual([{ versionId: atHead.versionId, editor: dana.did.did, source: "inherited", parent: { did: r3.state.id, versionId: r4.versionId } }]);
    // Before R's change was inscribed (height 14), the older pin is R's head and stands.
    const early = await read([b1, b2], [alice, bob, dana], [anchoring, inscribe(old, 14)], [parent]);
    expect(early.head).toBe(old.versionId);
  });

  test("C12-406: without the parent's sat read, the parent's anchored history is not established, so the child's pins are missing: never accepted, never current", async () => {
    const { alice, bob, dana, b1, b2, r1, r2, r3, r4, anchoring } = await anchoredPair();
    const atHead = await updateOriginal(b2, { versionTime: time(19), resource: photo(C2), pin: r4.versionId, ...asEditor(dana), inherited: grant(dana.did.did) });
    const r = await read([b1, b2], [alice, bob, dana], [anchoring, inscribe(atHead, 20)], [parentOf([r1, r2, r3, r4])]);
    expect(r.head).not.toBe(atHead.versionId);
    expect(r.current).toBe(false);
    // The genesis pins r2, which the held log does show: valid as of the genesis only.
    expect(r.validAsOf?.checkpoint ?? null).not.toBe(atHead.versionId);
  });

  test("C12-402: against an anchored parent, a pin outside its accepted history is rejected", async () => {
    const { alice, bob, dana, b1, r3, parent } = await anchoredPair();
    // A version 4 of R that R's sat never accepted: Alice signs it, but it is not inscribed.
    const stray = await updateOriginal(r3, { versionTime: time(14), name: "Repository, stray", ...as(alice) });
    const pinned = await updateOriginal(b1, { versionTime: time(16), name: "Branch, stray pin", pin: stray.versionId, ...as(bob) });
    const r = await verify([b1, pinned], [alice, bob, dana], [parent]);
    failedWith(r, 1, "PARENT_PIN_NOT_ACCEPTED", "invalid-evidence");
  });
});
