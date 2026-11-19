/**
 * Signer sets (plan 050 §1, W1; owner decision of 19 November 2026, reversing
 * S8). An Original may be governed by a set of DIDs with a threshold instead of
 * one author: the asset's `authors` member, `{threshold, dids}`, and an entry
 * `author` that is an array of signer references exactly when its asset has
 * `authors`. Extra signatures go in VH-Log's `proof` array, one per signer, in
 * signer order (W1a).
 *
 * PROVISIONAL: the rule IDs P5.19-P5.23 and the section 14 members are plan
 * 050's proposals; the originals-spec pull request assigns the final IDs and
 * the C12 rows, and this file is updated to cite them.
 */
import { describe, expect, test } from "bun:test";
import { canonicalize, type JsonObject } from "../src/json/index.js";
import { appendEntry, createLog, signEntry, type EntrySigner, type LogEntry } from "../src/log/index.js";
import { base58btcEncode, sha256 } from "../src/crypto/index.js";
import { OriginalsError } from "../src/errors.js";
import {
  ORIGINALS_LIMITS,
  ORIGINALS_METHOD,
  authorRefsOf,
  checkAsset,
  cosignEntry,
  createOriginal,
  deactivateOriginal,
  deriveDocument,
  finalizeEntry,
  parseBtcoAlias,
  prepareCreateOriginal,
  prepareUpdateOriginal,
  resourceDigest,
  signersOf,
  updateOriginal,
  verifyOriginal,
  type AuthorRef,
  type AuthorSet,
  type EditorGrant,
  type OriginalsReport,
  type SatEvidence,
  type SatInscription,
} from "../src/originals/index.js";
import { NOW, VhAuthor, bytes, carrying, clock, photo, seeded } from "./helpers/originals.js";

const B1 = "harbor at dawn, first crop";
const B2 = "harbor at dawn, tighter crop";
const B3 = "harbor at dawn, wide";
const allBytes = Object.fromEntries([B1, B2, B3].map((t) => [resourceDigest(bytes(t)), bytes(t)]));
const KA = seeded(21);
const KB = seeded(31);
const KC = seeded(32);
const KD = seeded(33);
const KE = seeded(34);
const KA2 = seeded(41);

const grant = (did: string, g: Partial<Omit<EditorGrant, "did">> = {}): EditorGrant => ({ did, name: false, metadata: false, resource: true, ...g });
const sorted = <T extends { did: string }>(list: T[]) => [...list].sort((a, b) => (a.did < b.did ? -1 : a.did > b.did ? 1 : 0));
const set = (threshold: number, ...members: VhAuthor[]): AuthorSet => ({ threshold, dids: members.map((m) => m.did).sort() });

/** Every signer's proof, in the order given: for forging entries the builders would refuse. */
const all = (...signers: EntrySigner[]): EntrySigner => async (unsigned) => (await Promise.all(signers.map((s) => s(unsigned)))).flat();

interface Member { did: VhAuthor; ref: () => AuthorRef; sign: EntrySigner }

/** Alice, Bob and Carol govern "Harbor at dawn", two of three; Dave and Erin are outsiders. */
async function harbor(threshold = 2) {
  const make = async (key: ReturnType<typeof seeded>): Promise<Member> => {
    const did = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    return { did, ref: () => did.ref("orig"), sign: did.signer(key, "orig") };
  };
  const [alice, bob, carol, dave, erin] = await Promise.all([KA, KB, KC, KD, KE].map(make));
  const members = sorted([alice, bob, carol].map((m) => ({ ...m, did: m.did.did, m })));
  const at = clock();
  const authors = set(threshold, alice.did, bob.did, carol.did);
  const genesis = await createOriginal({
    versionTime: at(), name: "Harbor at dawn", resource: photo(B1), authors,
    author: [alice.ref(), bob.ref(), carol.ref()], sign: [alice.sign, bob.sign, carol.sign],
  });
  /** The signer references of `who`, sorted by DID, and their signers in the same order. */
  const signedBy = (...who: Member[]) => {
    const order = sorted(who.map((m) => ({ did: m.did.did, m })));
    return { author: order.map((o) => o.m.ref()), sign: order.map((o) => o.m.sign) };
  };
  return { alice, bob, carol, dave, erin, members, at, authors, genesis, signedBy };
}

const histories = (...who: Member[]) => who.map((m) => m.did);
const verify = (log: LogEntry[], dids: VhAuthor[], extra: Partial<Parameters<typeof verifyOriginal>[0]> = {}): Promise<OriginalsReport> =>
  verifyOriginal({ log, authors: dids.map((a) => a.evidence()), now: NOW, bytes: allBytes, ...extra });

function failedWith(r: OriginalsReport, index: number, code: string, category?: string) {
  expect(r.history.failure?.index, JSON.stringify(r.history.failure)).toBe(index);
  expect(r.history.failure?.code, JSON.stringify(r.history.failure)).toBe(code);
  if (category) expect(r.history.failure?.category).toBe(category);
  expect(r.current).toBe(false);
}

function valid(r: OriginalsReport) {
  expect(r.history.status, JSON.stringify(r.history.failure)).toBe("valid");
  expect(r.authorBinding.status).toBe("valid");
  expect(r.identityEvidence.status, JSON.stringify(r.identityEvidence.failure)).toBe("complete");
}

async function rejects(run: () => unknown, code: string, category?: string) {
  let error: unknown;
  try {
    await run();
  } catch (e) {
    error = e;
  }
  expect(error, `expected ${code}`).toBeInstanceOf(OriginalsError);
  expect((error as OriginalsError).code, (error as Error).message).toBe(code);
  if (category) expect((error as OriginalsError).category).toBe(category);
}

/** Sign a state after `previous`, bypassing the builders' checks. */
const forge = (previous: LogEntry, state: JsonObject, sign: EntrySigner, parameters: JsonObject = {}, versionTime = "2026-10-18T12:30:00.000Z") =>
  appendEntry(previous, { versionTime, parameters, state, sign });
const forgeGenesis = (state: JsonObject, sign: EntrySigner) =>
  createLog({ versionTime: "2026-10-18T12:00:00.000Z", parameters: { method: ORIGINALS_METHOD, scid: "{SCID}" }, state: { ...state, id: "did:vh:{SCID}" }, sign });

/** A well-formed did:vh that names no one: `Qm` and 44 base58 characters. */
const fakeVh = (n: number) => `did:vh:Qm${base58btcEncode(sha256(bytes(String(n)))).slice(0, 44).padEnd(44, "1")}`;

describe("state: the asset's `authors` member (plan 050 §1; P14.4, P14.5, P7.7; PROVISIONAL)", () => {
  const base = { name: "Harbor", status: "active", resource: photo(B1), aliases: [] };
  const dids = [fakeVh(1), fakeVh(2), fakeVh(3)].sort();

  test("{threshold, dids} with sorted, unique DIDs of listed methods and 1 ≤ threshold ≤ n is accepted", () => {
    expect(checkAsset({ ...base, authors: { threshold: 2, dids } }).authors).toEqual({ threshold: 2, dids });
    expect(checkAsset({ ...base, authors: { threshold: 1, dids: [dids[0]] } }).authors?.dids).toEqual([dids[0]]);
  });

  test("anything else is rejected: other members, unsorted or repeated DIDs, unlisted methods, no members", () => {
    const bad: unknown[] = [
      { threshold: 2 },
      { dids },
      { threshold: 2, dids, extra: true },
      { threshold: 2, dids: [...dids].reverse() },
      { threshold: 1, dids: [dids[0], dids[0]] },
      { threshold: 1, dids: [] },
      { threshold: 1, dids: ["did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"] },
      { threshold: 1, dids: ["did:vh:short"] },
      { threshold: 1, dids: [`${dids[0]}#key`] },
      { threshold: 1, dids: "did:vh:x" },
      [dids],
    ];
    for (const authors of bad) {
      let error: unknown;
      try {
        checkAsset({ ...base, authors });
      } catch (e) {
        error = e;
      }
      expect((error as OriginalsError)?.code, JSON.stringify(authors)).toBe("STATE_AUTHORS");
    }
  });

  test("the threshold is an integer from 1 to the number of members", () => {
    for (const threshold of [0, 4, 1.5, "2", null, -1]) {
      expect(() => checkAsset({ ...base, authors: { threshold, dids } }), String(threshold)).toThrow(/threshold/);
    }
  });

  test("at most 32 members (ORIGINALS_LIMITS.authors, P7.7): 32 are accepted, 33 are over the limit", async () => {
    expect(ORIGINALS_LIMITS.authors).toBe(32);
    const many = Array.from({ length: 33 }, (_, i) => fakeVh(100 + i)).sort();
    expect(checkAsset({ ...base, authors: { threshold: 32, dids: many.slice(0, 32) } }).authors?.dids.length).toBe(32);
    await rejects(() => checkAsset({ ...base, authors: { threshold: 1, dids: many } }), "STATE_TOO_MANY_AUTHORS", "limit-exceeded");
  });

  test("an editor grant naming a member is rejected: an editor is not a member at the same entry (P5.15)", async () => {
    await rejects(() => checkAsset({ ...base, authors: { threshold: 1, dids }, editors: [grant(dids[1])] }), "STATE_EDITORS");
    expect(checkAsset({ ...base, authors: { threshold: 1, dids }, editors: [grant(fakeVh(9))] }).editors?.length).toBe(1);
  });
});

describe("P5.19 (PROVISIONAL): the genesis of a set Original is signed by every member", () => {
  test("a two-of-three set signed by all three verifies; the report lists each signer and the document's controller is the member array", async () => {
    const { members, authors, genesis } = await harbor();
    expect(genesis.state.asset).toMatchObject({ authors });
    expect(genesis.state.author).toEqual(members.map((m) => m.m.ref()));
    // One proof per signer reference, in the same order, each by that signer's own key (P5.22).
    expect(genesis.proof.map((p) => p.verificationMethod)).toEqual(members.map((m) => m.m.ref().verificationMethod));
    const r = await verify([genesis], members.map((m) => m.m.did));
    valid(r);
    expect(r.signedBy).toEqual([{ versionId: genesis.versionId, role: "author", dids: authors.dids }]);
    expect(r.identityEvidence.authors.map((a) => [a.did, a.status])).toEqual(authors.dids.map((d) => [d, "complete"]));
    expect(r.validAsOf?.signers.map((s) => [s.did, s.role])).toEqual(authors.dids.map((d) => [d, "author"]));
    // P14.9: the derived DID document's controller is the member array at that version.
    expect(r.document?.controller).toEqual(authors.dids);
    expect(r.reasons).toEqual(["not-anchored"]);
  });

  test("a genesis missing one member's signature is rejected, by the builder and by a verifier", async () => {
    const { alice, bob, authors } = await harbor();
    const input = { versionTime: "2026-10-18T12:00:00.000Z", name: "Harbor", resource: photo(B1), authors };
    const two = sorted([{ did: alice.did.did, m: alice }, { did: bob.did.did, m: bob }]).map((o) => o.m);
    await rejects(() => prepareCreateOriginal({ ...input, author: two.map((m) => m.ref()) }), "AUTHORS_MEMBER_NOT_SIGNED", "unauthorized-key");
    const forged = await forgeGenesis({
      operation: "create", author: two.map((m) => m.ref()) as unknown as JsonObject[],
      asset: { name: "Harbor", status: "active", resource: photo(B1), aliases: [], authors } as unknown as JsonObject,
      transitions: [{ from: null, to: photo(B1).digest }],
    } as JsonObject, all(...two.map((m) => m.sign)));
    failedWith(await verify([forged], two.map((m) => m.did)), 0, "AUTHORS_MEMBER_NOT_SIGNED", "unauthorized-key");
  });

  test("`author` is an array exactly when the asset has `authors`", async () => {
    const { alice, authors, members } = await harbor();
    const asset = { name: "Harbor", status: "active", resource: photo(B1), aliases: [] };
    const transitions = [{ from: null, to: photo(B1).digest }];
    // A set Original naming one author object.
    const one = await forgeGenesis({ operation: "create", author: alice.ref(), asset: { ...asset, authors }, transitions } as unknown as JsonObject, alice.sign);
    failedWith(await verify([one], [alice.did]), 0, "STATE_AUTHOR");
    // A single-author Original naming an array.
    const array = await forgeGenesis({ operation: "create", author: [alice.ref()], asset, transitions } as unknown as JsonObject, alice.sign);
    failedWith(await verify([array], [alice.did]), 0, "STATE_AUTHOR");
    // An unsorted or repeated array.
    const refs = members.map((m) => m.m.ref());
    for (const author of [[...refs].reverse(), [refs[0], refs[0], refs[1], refs[2]]]) {
      const bad = await forgeGenesis({ operation: "create", author, asset: { ...asset, authors }, transitions } as unknown as JsonObject, all(...author.map((r) => members.find((m) => m.did === r.did)!.m.sign)));
      failedWith(await verify([bad], members.map((m) => m.m.did)), 0, "STATE_AUTHOR");
    }
  });
});

describe("P5.20 (PROVISIONAL): author entries are signed by the parent's threshold of the parent's members", () => {
  test("two of three meet the threshold; one is short of it and is rejected", async () => {
    const { alice, bob, carol, at, genesis, signedBy } = await harbor();
    const renamed = await updateOriginal(genesis, { versionTime: at(), name: "Harbor, renamed", ...signedBy(alice, carol) });
    expect(renamed.proof.length).toBe(2);
    const r = await verify([genesis, renamed], histories(alice, bob, carol));
    valid(r);
    expect(r.signedBy[1]).toEqual({ versionId: renamed.versionId, role: "author", dids: [alice.did.did, carol.did.did].sort() });
    await rejects(() => prepareUpdateOriginal(genesis, { versionTime: at(), name: "Harbor, alone", author: [bob.ref()] }), "AUTHORS_THRESHOLD_NOT_MET", "unauthorized-key");
    const alone = await forge(genesis, { ...genesis.state, operation: "update", author: [bob.ref()] as unknown as JsonObject[], asset: { ...(genesis.state.asset as JsonObject), name: "Harbor, alone" }, transitions: [] }, bob.sign);
    failedWith(await verify([genesis, alone], histories(alice, bob, carol)), 1, "AUTHORS_THRESHOLD_NOT_MET", "unauthorized-key");
  });

  test("a signer outside the set is rejected, never reported as missing evidence, even without its history", async () => {
    const { alice, bob, carol, dave, genesis, signedBy } = await harbor();
    const { author, sign } = signedBy(alice, dave);
    const outside = await forge(genesis, { ...genesis.state, operation: "update", author: author as unknown as JsonObject[], asset: { ...(genesis.state.asset as JsonObject), name: "Harbor, Dave" }, transitions: [] }, all(...sign));
    failedWith(await verify([genesis, outside], histories(alice, bob, carol)), 1, "SIGNER_NOT_MEMBER", "unauthorized-key");
    failedWith(await verify([genesis, outside], histories(alice, bob, carol, dave)), 1, "SIGNER_NOT_MEMBER", "unauthorized-key");
    // Even when enough members sign too.
    const extra = signedBy(alice, bob, dave);
    const plus = await forge(genesis, { ...genesis.state, operation: "update", author: extra.author as unknown as JsonObject[], asset: { ...(genesis.state.asset as JsonObject), name: "Harbor, plus" }, transitions: [] }, all(...extra.sign));
    failedWith(await verify([genesis, plus], histories(alice, bob, carol, dave)), 1, "SIGNER_NOT_MEMBER");
  });

  test("an added member signs; adding one without that member's signature is rejected", async () => {
    const { alice, bob, carol, dave, at, genesis, signedBy } = await harbor();
    const four = set(2, alice.did, bob.did, carol.did, dave.did);
    const added = await updateOriginal(genesis, { versionTime: at(), authors: four, ...signedBy(alice, bob, dave) });
    valid(await verify([genesis, added], histories(alice, bob, carol, dave)));
    await rejects(() => prepareUpdateOriginal(genesis, { versionTime: at(), authors: four, ...signedBy(alice, bob) }), "AUTHORS_MEMBER_NOT_SIGNED", "unauthorized-key");
    const unsigned = signedBy(alice, bob);
    const forged = await forge(genesis, { ...genesis.state, operation: "update", author: unsigned.author as unknown as JsonObject[], asset: { ...(genesis.state.asset as JsonObject), authors: four as unknown as JsonObject }, transitions: [] }, all(...unsigned.sign));
    failedWith(await verify([genesis, forged], histories(alice, bob, carol, dave)), 1, "AUTHORS_MEMBER_NOT_SIGNED", "unauthorized-key");
    // An added member's signature does not count toward the parent's threshold.
    await rejects(() => prepareUpdateOriginal(genesis, { versionTime: at(), authors: four, ...signedBy(alice, dave) }), "AUTHORS_THRESHOLD_NOT_MET");
  });

  test("the parent's set decides: raising the threshold needs the old one, a removed member may sign its removal but nothing after", async () => {
    const { alice, bob, carol, at, genesis, signedBy } = await harbor();
    const strict = await updateOriginal(genesis, { versionTime: at(), authors: set(3, alice.did, bob.did, carol.did), ...signedBy(alice, bob) });
    await rejects(() => prepareUpdateOriginal(strict, { versionTime: at(), name: "Harbor, two", ...signedBy(alice, bob) }), "AUTHORS_THRESHOLD_NOT_MET");
    const removed = await updateOriginal(strict, { versionTime: at(), authors: set(1, alice.did, bob.did), ...signedBy(alice, bob, carol) });
    await rejects(() => prepareUpdateOriginal(removed, { versionTime: at(), name: "Harbor, Carol", ...signedBy(carol) }), "SIGNER_NOT_MEMBER");
    // A set may shrink to one member.
    const alone = await updateOriginal(removed, { versionTime: at(), authors: set(1, bob.did), ...signedBy(bob) });
    const r = await verify([genesis, strict, removed, alone], histories(alice, bob, carol));
    valid(r);
    expect(r.state?.authors).toEqual(set(1, bob.did));
    expect(r.document?.controller).toEqual([bob.did.did]);
  });

  test("`authors` is never removed, and is changed only by an author entry", async () => {
    const { alice, bob, carol, erin, at, genesis, signedBy } = await harbor();
    const { authors: _gone, ...without } = genesis.state.asset as JsonObject;
    const { author, sign } = signedBy(alice, bob);
    const dropped = await forge(genesis, { ...genesis.state, operation: "update", author: author as unknown as JsonObject[], asset: without, transitions: [] }, all(...sign));
    failedWith(await verify([genesis, dropped], histories(alice, bob, carol)), 1, "STATE_AUTHORS");
    const single = await forge(genesis, { ...genesis.state, operation: "update", author: alice.ref(), asset: without, transitions: [] }, alice.sign);
    expect((await verify([genesis, single], histories(alice, bob, carol))).history.status).toBe("invalid");
    // An editor entry carries its parent's `author` array unchanged and cannot change `authors`.
    const granted = await updateOriginal(genesis, { versionTime: at(), editors: [grant(erin.did.did)], ...signedBy(alice, bob) });
    const byErin = await updateOriginal(granted, { versionTime: at(), resource: photo(B2), editor: erin.ref(), sign: erin.sign });
    expect(byErin.state.author).toEqual(granted.state.author);
    expect(byErin.proof.length).toBe(1);
    const r = await verify([genesis, granted, byErin], histories(alice, bob, carol, erin));
    valid(r);
    expect(r.signedBy[2]).toEqual({ versionId: byErin.versionId, role: "editor", dids: [erin.did.did] });
    await rejects(() => prepareUpdateOriginal(granted, { versionTime: at(), resource: photo(B2), editor: erin.ref(), author: [alice.ref()] }), "EDITOR_AUTHOR_CHANGED");
    const changing = await forge(granted, { ...byErin.state, asset: { ...(byErin.state.asset as JsonObject), authors: set(1, alice.did, bob.did, carol.did) as unknown as JsonObject } }, erin.sign);
    failedWith(await verify([genesis, granted, changing], histories(alice, bob, carol, erin)), 2, "EDITOR_AUTHOR_ONLY", "outside-grant");
  });

  test("an editor who is also a member is rejected: granted to a member, or added as a member while granted", async () => {
    const { alice, bob, carol, erin, at, genesis, signedBy } = await harbor();
    await rejects(() => prepareUpdateOriginal(genesis, { versionTime: at(), editors: [grant(bob.did.did)], ...signedBy(alice, bob) }), "STATE_EDITORS");
    const granted = await updateOriginal(genesis, { versionTime: at(), editors: [grant(erin.did.did)], ...signedBy(alice, bob) });
    await rejects(() => prepareUpdateOriginal(granted, { versionTime: at(), authors: set(2, alice.did, bob.did, carol.did, erin.did), ...signedBy(alice, bob, erin) }), "STATE_EDITORS");
    const { author, sign } = signedBy(alice, bob, erin);
    const forged = await forge(granted, { ...granted.state, operation: "update", author: author as unknown as JsonObject[], asset: { ...(granted.state.asset as JsonObject), authors: set(2, alice.did, bob.did, carol.did, erin.did) as unknown as JsonObject }, transitions: [] }, all(...sign));
    failedWith(await verify([genesis, granted, forged], histories(alice, bob, carol, erin)), 2, "STATE_EDITORS");
  });

  test("deactivation is an author entry: a threshold signs it", async () => {
    const { alice, bob, carol, at, genesis, signedBy } = await harbor();
    await rejects(() => deactivateOriginal(genesis, { versionTime: at(), ...signedBy(alice) }), "AUTHORS_THRESHOLD_NOT_MET");
    const end = await deactivateOriginal(genesis, { versionTime: at(), ...signedBy(bob, carol) });
    const r = await verify([genesis, end], histories(alice, bob, carol));
    valid(r);
    expect(r.deactivated).toBe(true);
  });
});

describe("P5.22 (PROVISIONAL): one proof per signer reference, in the same order", () => {
  test("a missing, extra or reordered proof is rejected; each verificationMethod is byte-identical to its reference", async () => {
    const { alice, bob, carol, genesis, signedBy } = await harbor();
    const { author, sign } = signedBy(alice, bob);
    const state = { ...genesis.state, operation: "update", author: author as unknown as JsonObject[], asset: { ...(genesis.state.asset as JsonObject), name: "Harbor, renamed" }, transitions: [] };
    const good = await forge(genesis, state, all(...sign));
    valid(await verify([genesis, good], histories(alice, bob, carol)));
    const missing = { ...good, proof: [good.proof[0]] };
    failedWith(await verify([genesis, missing], histories(alice, bob, carol)), 1, "PROOF_COUNT");
    const extra = { ...good, proof: [...good.proof, good.proof[1]] };
    failedWith(await verify([genesis, extra], histories(alice, bob, carol)), 1, "PROOF_COUNT");
    const swapped = { ...good, proof: [good.proof[1], good.proof[0]] };
    failedWith(await verify([genesis, swapped], histories(alice, bob, carol)), 1, "AUTHOR_VM_MISMATCH", "author-binding");
    // A verificationMethod that names the same key another way (a relative reference) is not byte-identical.
    const relative = structuredClone(good);
    relative.proof[0].verificationMethod = "#orig";
    failedWith(await verify([genesis, relative], histories(alice, bob, carol)), 1, "AUTHOR_VM_MISMATCH");
  });

  test("a single-author entry still carries exactly one proof (two are rejected, as before)", async () => {
    const alice = await VhAuthor.create([{ fragment: "orig", signer: KA }]);
    const genesis = await createOriginal({ versionTime: "2026-10-18T12:00:00.000Z", name: "Harbor", resource: photo(B1), author: alice.ref("orig"), sign: alice.signer(KA, "orig") });
    const doubled = { ...genesis, proof: [genesis.proof[0], genesis.proof[0]] };
    failedWith(await verify([doubled], [alice]), 0, "PROOF_COUNT");
  });

  test("cosign in any order, then finalize: the proofs are ordered by DID, and the entry equals one signed at once", async () => {
    const { alice, bob, carol, at, genesis, signedBy } = await harbor();
    const { author, sign } = signedBy(alice, bob, carol);
    const unsigned = prepareUpdateOriginal(genesis, { versionTime: at(), name: "Harbor, cosigned", author });
    let partial = await cosignEntry(unsigned, carol.sign);
    partial = await cosignEntry(partial, alice.sign);
    await rejects(() => finalizeEntry(partial), "PROOF_MISSING");
    partial = await cosignEntry(partial, bob.sign);
    await rejects(() => cosignEntry(partial, bob.sign), "PROOF_DUPLICATE");
    await rejects(async () => cosignEntry(unsigned, (await harbor()).dave.sign), "SIGNER_NOT_NAMED");
    const final = finalizeEntry(partial);
    expect(final.proof.map((p) => p.verificationMethod)).toEqual(author.map((r) => r.verificationMethod));
    const atOnce = await signEntry(unsigned, all(...sign));
    expect(canonicalize(final as unknown as JsonObject)).toBe(canonicalize(atOnce as unknown as JsonObject));
    valid(await verify([genesis, final], histories(alice, bob, carol)));
  });

  test("P5.8 per identity: a member's versionId never goes backwards, whatever the others name", async () => {
    const { alice, bob, carol, at, genesis, signedBy } = await harbor();
    const first = alice.ref();
    await alice.did.rotate([{ fragment: "orig", signer: KA }]);
    const newer = await updateOriginal(genesis, { versionTime: at(), name: "Harbor, newer", ...signedBy(alice, bob) });
    expect(newer.state.author).toContainEqual(alice.ref());
    const older = { author: sorted([first, bob.ref()]), sign: signedBy(alice, bob).sign };
    const back = await forge(newer, { ...newer.state, author: older.author as unknown as JsonObject[], asset: { ...(newer.state.asset as JsonObject), name: "Harbor, older" } }, all(...older.sign));
    failedWith(await verify([genesis, newer, back], histories(alice, bob, carol)), 2, "AUTHOR_VERSION_REGRESSED");
    // Bob and Carol name the version their own earlier entries named, unaffected by Alice's.
    const others = await updateOriginal(newer, { versionTime: at(), name: "Harbor, others", ...signedBy(bob, carol) });
    valid(await verify([genesis, newer, others], histories(alice, bob, carol)));
  });

  test("missing history for a member that signed is incomplete evidence, never a pass", async () => {
    const { alice, bob, carol, genesis } = await harbor();
    const r = await verify([genesis], histories(alice, bob));
    expect(r.history.status).toBe("incomplete");
    expect(r.identityEvidence.status).toBe("incomplete");
    expect(r.validAsOf).toBeNull();
    expect(r.history.failure?.message).toContain(carol.did.did);
  });
});

describe("P5.21 (PROVISIONAL): converting a single-author Original into a set Original", () => {
  async function single() {
    const h = await harbor();
    const genesis = await createOriginal({ versionTime: h.at(), name: "Harbor", resource: photo(B1), author: h.alice.ref(), sign: h.alice.sign });
    return { ...h, genesis };
  }

  test("the author and every other member sign; from then on the Original is a set Original", async () => {
    const { alice, bob, at, genesis, signedBy } = await single();
    const converted = await updateOriginal(genesis, { versionTime: at(), authors: set(1, alice.did, bob.did), ...signedBy(alice, bob) });
    const byBob = await updateOriginal(converted, { versionTime: at(), name: "Harbor, Bob", ...signedBy(bob) });
    const r = await verify([genesis, converted, byBob], histories(alice, bob));
    valid(r);
    expect(r.signedBy.map((s) => s.dids)).toEqual([[alice.did.did], [alice.did.did, bob.did.did].sort(), [bob.did.did]]);
    expect(r.document?.controller).toEqual([alice.did.did, bob.did.did].sort());
    // The single-author genesis keeps its single controller.
    expect(deriveDocument([{ entry: genesis } as never]).controller).toBe(alice.did.did);
  });

  test("a conversion that drops the author, misses a member's signature or the author's is rejected", async () => {
    const { alice, bob, carol, at, genesis, signedBy } = await single();
    await rejects(() => prepareUpdateOriginal(genesis, { versionTime: at(), authors: set(1, bob.did, carol.did), ...signedBy(alice, bob, carol) }), "STATE_AUTHORS");
    const { author, sign } = signedBy(bob, carol);
    const dropped = await forge(genesis, { ...genesis.state, operation: "update", author: author as unknown as JsonObject[], asset: { ...(genesis.state.asset as JsonObject), authors: set(1, bob.did, carol.did) as unknown as JsonObject }, transitions: [] }, all(...sign));
    failedWith(await verify([genesis, dropped], histories(alice, bob, carol)), 1, "STATE_AUTHORS");
    await rejects(() => prepareUpdateOriginal(genesis, { versionTime: at(), authors: set(1, alice.did, bob.did), ...signedBy(alice) }), "AUTHORS_MEMBER_NOT_SIGNED");
    const notAuthor = signedBy(bob);
    const forged = await forge(genesis, { ...genesis.state, operation: "update", author: notAuthor.author as unknown as JsonObject[], asset: { ...(genesis.state.asset as JsonObject), authors: set(1, bob.did) as unknown as JsonObject }, transitions: [] }, all(...notAuthor.sign));
    expect((await verify([genesis, forged], histories(alice, bob))).history.status).toBe("invalid");
  });

  test("an editor entry cannot convert", async () => {
    const { alice, bob, erin, at, genesis } = await single();
    const granted = await updateOriginal(genesis, { versionTime: at(), editors: [grant(erin.did.did)], author: alice.ref(), sign: alice.sign });
    const forged = await forge(granted, { ...granted.state, operation: "update", editor: erin.ref(), author: [alice.ref()] as unknown as JsonObject[], asset: { ...(granted.state.asset as JsonObject), authors: set(1, alice.did) as unknown as JsonObject } }, erin.sign);
    const r = await verify([genesis, granted, forged], histories(alice, bob, erin));
    expect(r.history.failure?.index).toBe(2);
    expect(["EDITOR_AUTHOR_ONLY", "EDITOR_AUTHOR_CHANGED"]).toContain(r.history.failure?.code);
  });
});

describe("P5.23 (PROVISIONAL): currency by threshold (P7.9)", () => {
  test("a removed key makes an entry historically authorized only below the parent's threshold, and current at or above it", async () => {
    const { alice, bob, carol, at, genesis, signedBy } = await harbor();
    const byTwo = await updateOriginal(genesis, { versionTime: at(), name: "Harbor, two", ...signedBy(alice, bob) });
    const byThree = await updateOriginal(byTwo, { versionTime: at(), name: "Harbor, three", ...signedBy(alice, bob, carol) });
    // Alice removes the key she signed with.
    await alice.did.rotate([{ fragment: "next", signer: KA2 }]);
    const r = await verify([genesis, byTwo, byThree], histories(alice, bob, carol));
    valid(r);
    // Genesis (three of three, threshold 2) and byThree keep two current signers; byTwo has one.
    expect(r.historicallyAuthorizedOnly).toEqual([
      expect.objectContaining({ versionId: byTwo.versionId, role: "author", did: alice.did.did, reason: "key-not-in-latest-signer-document", threshold: 2, signers: [{ did: alice.did.did, reason: "key-not-in-latest-signer-document" }] }),
    ]);
    expect(r.reasons).toContain("historically-authorized-only");
    expect(r.validAsOf).not.toBeNull();
  });

  test("a deactivated member's signature is not current", async () => {
    const { alice, bob, carol, at, genesis, signedBy } = await harbor();
    const byTwo = await updateOriginal(genesis, { versionTime: at(), name: "Harbor, two", ...signedBy(alice, bob) });
    await bob.did.deactivate();
    const r = await verify([genesis, byTwo], histories(alice, bob, carol));
    expect(r.historicallyAuthorizedOnly.map((h) => [h.versionId, h.reason])).toEqual([[byTwo.versionId, "signer-did-deactivated"]]);
  });
});

// ---------------------------------------------------------------------------- Bitcoin

const SAT = "did:btco:reg:5000000000";
const T0 = Date.parse("2026-10-18T12:00:00Z");
const time = (height: number) => new Date(T0 + height * 600_000 - 60_000).toISOString();
let counter = 0;
const nextId = () => `${(counter++).toString(16).padStart(64, "d")}i0`;
type Inscribed = Omit<SatInscription, "sat" | "network">;
const inscribe = (entries: LogEntry | LogEntry[], height: number): Inscribed => ({
  id: nextId(), height, transactionIndex: 1, inscriptionIndex: 0, confirmations: 120 - height, inscriptionTime: T0 + height * 600_000, ...carrying(entries),
});
function satRead(inscriptions: Inscribed[]): SatEvidence {
  const { sat, network } = parseBtcoAlias(SAT);
  return { sat: SAT, index: "ord-a", tip: { height: 119, hash: "bb".repeat(32) }, inscriptions: inscriptions.map((i) => ({ sat, network, ...i })), owner: { output: `${"cc".repeat(32)}:1`, confirmations: 3 } };
}

describe("W1b, P9.10, P9.15 (PROVISIONAL): anchoring and inscriptions need the threshold", () => {
  async function anchored() {
    const h = await harbor();
    const genesis = await createOriginal({
      versionTime: time(1), name: "Harbor", resource: photo(B1), authors: h.authors,
      author: h.members.map((m) => m.m.ref()), sign: h.members.map((m) => m.m.sign),
    });
    // Bob and Carol anchor, so the anchor does not depend on Alice's key.
    const anchor = await updateOriginal(genesis, { versionTime: time(9), aliases: [SAT], ...h.signedBy(h.bob, h.carol) });
    return { ...h, genesis, anchor };
  }
  const read = (log: LogEntry[], who: VhAuthor[], inscriptions: Inscribed[]) =>
    verifyOriginal({ log, authors: who.map((a) => a.evidence()), now: NOW, bytes: allBytes, bitcoin: [satRead(inscriptions)] });

  test("an anchoring entry below the threshold is rejected; at the threshold it anchors", async () => {
    const { alice, bob, carol, genesis, anchor, signedBy } = await anchored();
    await rejects(() => prepareUpdateOriginal(genesis, { versionTime: time(9), aliases: [SAT], ...signedBy(alice) }), "AUTHORS_THRESHOLD_NOT_MET");
    const r = await read([genesis, anchor], histories(alice, bob, carol), [inscribe([genesis, anchor], 10)]);
    valid(r);
    expect(r.anchoring?.status).toBe("anchored");
    expect(r.current).toBe(true);
    const { author, sign } = signedBy(alice);
    const short = await forge(genesis, { ...anchor.state, author: author as unknown as JsonObject[] }, all(...sign), {}, time(9));
    const s = await read([genesis, short], histories(alice, bob, carol), [inscribe([genesis, short], 10)]);
    expect(s.anchoring?.status).not.toBe("anchored");
    expect(s.current).toBe(false);
  });

  test("an inscribed entry is checked per signer at its inscription: below the threshold of valid keys it is ignored, at it accepted", async () => {
    const { alice, bob, carol, anchor, genesis, signedBy } = await anchored();
    const byTwo = await updateOriginal(anchor, { versionTime: time(20), name: "Harbor, two", ...signedBy(alice, bob) });
    const byThree = await updateOriginal(anchor, { versionTime: time(20), name: "Harbor, three", ...signedBy(alice, bob, carol) });
    // Alice's key is removed before either inscription (her DID's versions are at 09:00, before every inscription).
    await alice.did.rotate([{ fragment: "next", signer: KA2 }]);
    const anchoring = inscribe([genesis, anchor], 10);
    const two = await read([genesis, anchor], histories(alice, bob, carol), [anchoring, inscribe(byTwo, 20)]);
    expect(two.anchoring?.ignored).toEqual([expect.objectContaining({ versionId: byTwo.versionId, reason: "author-key-not-valid-at-inscription-time" })]);
    expect(two.head).toBe(anchor.versionId);
    const three = await read([genesis, anchor], histories(alice, bob, carol), [anchoring, inscribe(byThree, 20)]);
    expect(three.anchoring?.ignored).toEqual([]);
    expect(three.head).toBe(byThree.versionId);
    expect(three.current).toBe(true);
  });
});

describe("single-author Originals are byte-identical (plan 050 §4 W1)", () => {
  test("the builders' bytes and the derived document are those of the code before signer sets", async () => {
    // Pinned on main 874555b0, before W1: a genesis with an editor grant, an editor entry and a deactivation.
    const key = seeded(21);
    const alice = await VhAuthor.create([{ fragment: "orig", signer: key }]);
    const bob = await VhAuthor.create([{ fragment: "edit", signer: seeded(31) }]);
    const at = clock();
    const sign = alice.signer(key, "orig");
    const ref = alice.ref("orig");
    const g = await createOriginal({ versionTime: at(), name: "Harbor at dawn", resource: photo("one"), author: ref, sign, editors: [{ did: bob.did, name: true, metadata: false, resource: true }] });
    const u = await updateOriginal(g, { versionTime: at(), resource: photo("two"), editor: bob.ref("edit"), sign: bob.signer(seeded(31), "edit") });
    const d = await deactivateOriginal(u, { versionTime: at(), author: ref, sign });
    const text = [g, u, d].map((e) => canonicalize(e as unknown as JsonObject)).join("\n");
    expect(base58btcEncode(sha256(bytes(text)))).toBe("2ZWUKZrBRfGu64y8C4uAZcanDxdm4qfjUW2Ez4cCdx7c");
    expect([g.versionId, d.versionId]).toEqual(["1-QmYfuzXL9B1Vc9EQwohMgudw45jQ4vcCx1zeG1ByFu11CC", "3-QmdxDTgPr7t1BpYie8LvEoywu6Dr1bbHBMMsxV8nfkJ5bG"]);
    expect(JSON.stringify(deriveDocument([{ entry: d } as never]))).toBe(
      '{"@context":["https://www.w3.org/ns/did/v1"],"id":"did:vh:QmZPSFdQH2Dg7UvA66GL6U3NGHYo4AeLjWabMJJJZWQ7Cj","controller":"did:vh:QmbmTWUJAkf3SvA11VTzkfcbd4cq7ufKD8RuxZBXuujgjh","service":[{"id":"did:vh:QmZPSFdQH2Dg7UvA66GL6U3NGHYo4AeLjWabMJJJZWQ7Cj#files","type":"OriginalsFiles","serviceEndpoint":{"mediaType":"image/jpeg","size":3,"digest":"zQmSdaSpt6GUcjA9NrmBzqHu1XNprwzqDzbeb2h5nKDK2bC"}}]}',
    );
    // The report on a single-author Original lists its one author.
    const r = await verifyOriginal({ log: [g, u, d], authors: [alice.evidence(), bob.evidence()], now: NOW, bytes: { [photo("one").digest]: bytes("one"), [photo("two").digest]: bytes("two") } });
    expect(r.signedBy.map((s) => [s.role, s.dids])).toEqual([["author", [alice.did]], ["editor", [bob.did]], ["author", [alice.did]]]);
    expect(r.identityEvidence.author).toBe(alice.did);
    expect(r.identityEvidence.authors.map((a) => a.did)).toEqual([alice.did]);
    expect(signersOf(g.state as never)).toEqual({ role: "author", refs: [ref] });
    expect(authorRefsOf(g.state as never)).toEqual([ref]);
  });
});
