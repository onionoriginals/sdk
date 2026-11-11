/**
 * Carried logs through the SDK (proposed; aviarytech/originals-spec PR 59 at
 * 3ed0f89): P7.11-P7.16. Each test cites its section 12 row as
 * `PR59 carried:` and a quote of the row's first column until the
 * conformance registry is re-pinned. The carrier formats themselves are
 * tested in packages/vh/tests/carried.test.ts.
 */
import { describe, expect, test } from "bun:test";
import type { AuthorDidEvidence } from "@originals/vh/originals";
import { MemoryStore, OriginalsSDK, btcoAlias, type OriginalsSigner, type SigningRequest } from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KEY = seed(51);
const MD1 = bytes("# Harbor\n\nFirst notes.\n");
const MD2 = bytes("# Harbor\n\nSecond notes.\n");
const MD3 = bytes("# Harbor\n\nThird notes.\n");

/** Counts calls to a signer, so a test can show nothing was signed (P7.16). */
function counting(signer: OriginalsSigner): OriginalsSigner & { calls: number } {
  const out = {
    calls: 0,
    verificationMethod: signer.verificationMethod,
    cryptosuite: signer.cryptosuite,
    sign: (request: SigningRequest) => {
      out.calls++;
      return signer.sign(request);
    },
  };
  return out;
}

async function harbor() {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const sdk = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: clock() });
  const signer = counting(alice.signer("orig", KEY));
  const author = alice.ref("orig");
  const created = await sdk.create({ name: "Harbor notes", resource: { mediaType: "text/markdown", bytes: MD1 }, author, signer });
  if (created.kind !== "original") throw new Error("expected an Original");
  const v2 = await sdk.edit(created.original.did, { parent: created.original.checkpoint, resource: { bytes: MD2 }, author, signer });
  const v3 = await sdk.edit(created.original.did, { parent: v2.original.checkpoint, resource: { bytes: MD3 }, author, signer });
  const corrected = await sdk.edit(created.original.did, { parent: v3.original.checkpoint, metadata: { corrected: true }, author, signer });
  return { alice, sdk, signer, author, did: created.original.did, checkpoints: [created.original.checkpoint, v2.original.checkpoint, v3.original.checkpoint, corrected.original.checkpoint] };
}

/** A reader with an empty store whose author source is a resolver it counts (P7.13). */
function reader(alice: Author, answer: (did: string) => AuthorDidEvidence | undefined = (did) => (did === alice.did ? alice.evidence() : undefined)) {
  const asked: string[] = [];
  const sdk = OriginalsSDK.create({
    store: new MemoryStore(),
    authors: async (did) => {
      asked.push(did);
      return answer(did);
    },
    clock: clock(Date.parse("2026-10-18T13:00:00Z")),
  });
  return { sdk, asked };
}

async function carried(env: Awaited<ReturnType<typeof harbor>>, checkpoint?: string) {
  const options = checkpoint ? { checkpoint } : {};
  const disclosed = await env.sdk.carriedDisclosure(env.did, options);
  return env.sdk.carry(env.did, { ...options, disclosed });
}

describe("P7.13: resolution only on the caller's opt-in", () => {
  test("PR59 carried: \"Carried file opened or previewed without the caller's opt-in to resolve\": no DID resolved; proofs unchecked", async () => {
    const env = await harbor();
    const file = await carried(env);
    const { sdk, asked } = reader(env.alice);
    const r = await sdk.readCarried(file.bytes);
    expect(asked).toEqual([]);
    expect(r.signers.requested).toBe(false);
    expect(r.proofs).toBe("unchecked");
    expect(r.verified).toEqual({ log: false, version: false });
  });

  test("PR59 carried: \"Carried file whose bytes, with the carrier removed, are the version its log's last entry names, signer DIDs resolved\": verified, valid as of that checkpoint, never current", async () => {
    const env = await harbor();
    const file = await carried(env);
    const { sdk, asked } = reader(env.alice);
    const r = await sdk.readCarried(file.bytes, { resolveSigners: true });
    expect(asked).toEqual([env.alice.did]);
    expect(r.verified).toEqual({ log: true, version: true });
    expect(r.validAsOf?.checkpoint).toBe(env.checkpoints[3]);
    expect(r.validAsOf?.signers[0]).toMatchObject({ did: env.alice.did, source: "fetched" });
    expect(r.current).toBe(false);
  });

  test("PR59 carried: \"Carried file read offline, signer DID not resolvable\": proofs unchecked; identity evidence and author binding incomplete, never a pass", async () => {
    const env = await harbor();
    const file = await carried(env);
    const { sdk, asked } = reader(env.alice, () => undefined);
    const r = await sdk.readCarried(file.bytes, { resolveSigners: true });
    expect(asked).toEqual([env.alice.did]);
    expect(r.signers.requested).toBe(true);
    expect(r.proofs).toBe("unchecked");
    expect(r.identityEvidence).toBe("incomplete");
    expect(r.authorBinding).toBe("incomplete");
    expect(r.verified).toEqual({ log: false, version: false });
  });

  test("a store's retained signer history is used without a request", async () => {
    const env = await harbor();
    const file = await carried(env);
    // The writer's own SDK holds Alice's history: no opt-in is needed to check the proofs.
    const r = await env.sdk.readCarried(file.bytes);
    expect(r.signers.requested).toBe(false);
    expect(r.verified).toEqual({ log: true, version: true });
  });
});

describe("P7.15, P7.16: writing a carried file", () => {
  test("PR59 carried: \"Writer asked to carry a draft, a version other than the last entry's, or, after anchoring, an entry not accepted on the anchor\": refused", async () => {
    const env = await harbor();
    // A draft is never history, so its versionId is no committed checkpoint.
    const draft = await env.sdk.prepareEdit(env.did, { parent: env.checkpoints[3], name: "Draft", author: env.author });
    await expect(env.sdk.carriedDisclosure(env.did, { checkpoint: draft.entry.versionId })).rejects.toMatchObject({ code: "CARRIER_NOT_ACCEPTED" });
    // The SDK always carries the bytes of the checkpoint's own version (P7.15): version 2 at checkpoint 2.
    const atTwo = await carried(env, env.checkpoints[1]);
    expect((await env.sdk.readCarried(atTwo.bytes)).verified.version).toBe(true);
    // After anchoring: the anchoring entry, committed locally but not shown accepted on the anchor.
    const anchored = await env.sdk.anchor(env.did, { parent: env.checkpoints[3], author: env.author, signer: env.signer, sat: btcoAlias("regtest", "5000000000") });
    await expect(env.sdk.carriedDisclosure(env.did)).rejects.toMatchObject({ code: "CARRIER_NOT_ACCEPTED" });
    await expect(env.sdk.carriedDisclosure(env.did, { checkpoint: anchored.original.checkpoint })).rejects.toMatchObject({ code: "CARRIER_NOT_ACCEPTED" });
    // A checkpoint before the anchoring entry is still accepted.
    expect((await env.sdk.carriedDisclosure(env.did, { checkpoint: env.checkpoints[3] })).checkpoint).toBe(env.checkpoints[3]);
  });

  test("PR59 carried: \"Writer about to write a carrier\": the user is told what the file discloses first; a JSON carrier says the data gains a member", async () => {
    const env = await harbor();
    await expect(env.sdk.carry(env.did, {} as never)).rejects.toMatchObject({ code: "CARRIER_DISCLOSURE_REQUIRED" });
    const d = await env.sdk.carriedDisclosure(env.did);
    expect(d).toMatchObject({ entries: 4, signers: [env.alice.did], metadata: true, dataGainsMember: false });
    const json = await env.sdk.create({ name: "Data", resource: { mediaType: "application/json", bytes: bytes('{"a":1}') }, author: env.author, signer: env.signer });
    if (json.kind !== "original") throw new Error("expected an Original");
    const jd = await env.sdk.carriedDisclosure(json.original.did);
    expect(jd.dataGainsMember).toBe(true);
    const file = await env.sdk.carry(json.original.did, { disclosed: jd });
    expect(new TextDecoder().decode(file.bytes).startsWith('{"a":1,"originalLog":[')).toBe(true);
  });

  test("PR59 carried: \"Carrier added or removed\": no entry signed; the version is unchanged", async () => {
    const env = await harbor();
    const before = await env.sdk.committedLog(env.did);
    const calls = env.signer.calls;
    const file = await carried(env);
    expect(env.signer.calls).toBe(calls);
    expect(await env.sdk.committedLog(env.did)).toBe(before);
    // Removed again, the bytes are the version itself; importing it back adds nothing.
    const r = await env.sdk.readCarried(file.bytes);
    expect(r.version).toEqual(MD3);
    expect((await env.sdk.importCarried(file.bytes)).status).toBe("already-current");
    expect(await env.sdk.committedLog(env.did)).toBe(before);
    expect(env.signer.calls).toBe(calls);
  });

  test("PR59 carried: \"Carried file presented by an SDK or UI\": never labelled an evidence package or complete", async () => {
    const env = await harbor();
    const file = await carried(env);
    expect(file.kind).toBe("carried-file");
    expect(file.disclosure.text).toContain("not an evidence package");
    const r = await env.sdk.readCarried(file.bytes);
    expect(r.kind).toBe("carried-file");
    expect(r.completeness).toBe("no-claim");
    // An evidence package reader refuses it: it is not one.
    await expect(env.sdk.load(file.bytes)).rejects.toBeDefined();
  });
});

describe("P7.14, P7.5: importing a carried log", () => {
  test("PR59 carried: \"Carried log older than the reader's local history, or on another branch\": local history kept; a branch reported as a conflict", async () => {
    const env = await harbor();
    // Older than the local history: the local history is kept.
    const older = await carried(env, env.checkpoints[1]);
    expect((await env.sdk.importCarried(older.bytes)).status).toBe("kept-newer-local");
    expect((await env.sdk.get(env.did)).head).toBe(env.checkpoints[3]);
    // Bob imports Alice's carried file, then the two histories diverge.
    // Bob's clock a few seconds ahead of Alice's, so neither's entries are future-dated for the other.
    const bob = OriginalsSDK.create({ store: new MemoryStore(), authors: [env.alice.evidence()], clock: clock(Date.parse("2026-10-18T12:00:05Z")) });
    const imported = await bob.importCarried((await carried(env)).bytes, { original: env.did });
    expect(imported.status).toBe("imported");
    const signer = env.alice.signer("orig", KEY);
    await env.sdk.edit(env.did, { parent: env.checkpoints[3], name: "Alice's branch", author: env.author, signer });
    const theirs = await bob.edit(env.did, { parent: env.checkpoints[3], name: "Bob's copy of Alice's key", author: env.author, signer });
    const disclosed = await bob.carriedDisclosure(env.did);
    const branch = await bob.carry(env.did, { disclosed });
    const result = await env.sdk.importCarried(branch.bytes);
    expect(result.status).toBe("conflict");
    expect(result.original.report.fork).not.toBeNull();
    expect(result.original.state.name).toBe("Alice's branch");
    expect(theirs.original.checkpoint).not.toBe(result.original.head);
  });

  test("an import is refused unless the carried log verifies to its last entry", async () => {
    const env = await harbor();
    const file = await carried(env);
    const { sdk } = reader(env.alice);
    await expect(sdk.importCarried(file.bytes)).rejects.toMatchObject({ code: "IMPORT_REJECTED" });
    await expect(sdk.importCarried(file.bytes, { resolveSigners: true, original: "did:vh:QmOther" })).rejects.toMatchObject({ code: "IMPORT_REJECTED" });
    const ok = await sdk.importCarried(file.bytes, { resolveSigners: true });
    expect(ok.status).toBe("imported");
    // The version's bytes came with it; the others are unavailable content.
    expect(await sdk.resourceBytes(ok.original.state.resource.digest)).toEqual(MD3);
  });

  test("a log where no carrier is defined is imported on its own result, without its bytes (P7.12)", async () => {
    const env = await harbor();
    const json = await env.sdk.create({ name: "Data", resource: { mediaType: "application/json", bytes: bytes('{"a":1}') }, author: env.author, signer: env.signer });
    if (json.kind !== "original") throw new Error("expected an Original");
    const file = await env.sdk.carry(json.original.did, { disclosed: await env.sdk.carriedDisclosure(json.original.did) });
    // Moved so it is no longer the root's last member: not a carrier.
    const text = new TextDecoder().decode(file.bytes);
    const member = text.slice(text.indexOf(',"originalLog"'), -1);
    const stray = bytes(`{${member.slice(1)},"a":1}`);
    const { sdk } = reader(env.alice);
    const r = await sdk.readCarried(stray, { resolveSigners: true });
    expect(r.carrierStatus).toBe("stray");
    expect(r.verified).toEqual({ log: true, version: false });
    const imported = await sdk.importCarried(stray, { resolveSigners: true });
    expect(imported.status).toBe("imported");
    expect(await sdk.resourceBytes(imported.original.state.resource.digest)).toBeUndefined();
  });
});
