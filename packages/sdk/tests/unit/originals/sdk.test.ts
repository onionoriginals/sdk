import { describe, expect, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import { resourceDigest } from "@originals/vh/originals";
import { MemoryStore, OriginalsSDK, keySigner, type OriginalsSigner, type SigningRequest } from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const B1 = bytes("harbor at dawn, first crop");
const B2 = bytes("harbor at dawn, tighter crop");
const KEY = seed(21);

async function setup() {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const store = new MemoryStore();
  const sdk = OriginalsSDK.create({ store, authors: [alice.evidence()], clock: clock() });
  const signer = alice.signer("orig", KEY);
  const author = alice.ref("orig");
  return { alice, store, sdk, signer, author };
}

async function harbor() {
  const env = await setup();
  const created = await env.sdk.create({ name: "Harbor at dawn", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: B1 }], author: env.author, signer: env.signer });
  if (created.kind !== "original") throw new Error("expected an Original");
  return { ...env, original: created.original };
}

async function rejects(promise: Promise<unknown>, category: string, code?: string) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, "expected a rejection").toBeInstanceOf(OriginalsError);
  expect((caught as OriginalsError).category).toBe(category as never);
  if (code) expect((caught as OriginalsError).code).toBe(code);
}

describe("create, edit and deactivate", () => {
  test("the photo example through the SDK: versions derived from history (P4.4)", async () => {
    const { sdk, signer, author, original } = await harbor();
    expect(original.report.reasons).toEqual(["not-anchored"]);
    const cropped = await sdk.edit(original.did, { parent: original.checkpoint, resources: [{ id: "photo", bytes: B2 }], author, signer });
    const corrected = await sdk.edit(original.did, { parent: cropped.original.checkpoint, metadata: { caption: "Corrected" }, author, signer });
    expect(corrected.status).toBe("committed");
    expect(corrected.original.resources.map((r) => [r.version, r.digest])).toEqual([[1, resourceDigest(B1)], [2, resourceDigest(B2)]]);
    expect(corrected.original.state.metadata).toEqual({ caption: "Corrected" });
    const v2 = await sdk.get(original.did, { checkpoint: cropped.original.checkpoint });
    expect(v2.state.metadata).toBeUndefined();
    expect(v2.current).toBe(false);
  });

  test("a create without a signer is an explicit unsigned draft, never history (P6.3)", async () => {
    const { sdk, signer, author } = await setup();
    const result = await sdk.create({ name: "Draft", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: B1 }], author });
    expect(result.kind).toBe("draft");
    if (result.kind !== "draft") return;
    expect(result.draft.signed).toBe(false);
    expect(result.draft.entry.proof).toBeUndefined();
    await rejects(sdk.get(result.draft.original), "incomplete-evidence", "ORIGINAL_NOT_FOUND");
    const committed = await sdk.commit(result.draft, signer);
    expect(committed.original.did).toBe(result.draft.original);
  });

  test("C12-17 and C12-18 through the API: metadata replaced, kept or removed; a null name rejected", async () => {
    const { sdk, signer, author, original } = await harbor();
    const set = await sdk.edit(original.did, { parent: original.checkpoint, metadata: { a: 1 }, author, signer });
    const kept = await sdk.edit(original.did, { parent: set.original.checkpoint, name: "Harbor", author, signer });
    expect(kept.original.state.metadata).toEqual({ a: 1 });
    const removed = await sdk.edit(original.did, { parent: kept.original.checkpoint, metadata: null, author, signer });
    expect(removed.original.state.metadata).toBeUndefined();
    await rejects(sdk.edit(original.did, { parent: removed.original.checkpoint, name: null as never, author, signer }), "invalid-evidence", "STATE_NAME");
  });

  test("C12-11: a caller's version counter is rejected; versions come from history", async () => {
    const { sdk, signer, author, original } = await harbor();
    const input = { id: "photo", bytes: B2, version: 9 } as never;
    await rejects(sdk.edit(original.did, { parent: original.checkpoint, resources: [input], author, signer }), "invalid-evidence", "INPUT_INVALID");
  });

  test("C12-19 and C12-16 through the API: same bytes do not advance; unknown resources are rejected", async () => {
    const { sdk, signer, author, original } = await harbor();
    const same = await sdk.edit(original.did, { parent: original.checkpoint, resources: [{ id: "photo", bytes: B1 }], author, signer });
    expect(same.original.resources.length).toBe(1);
    await rejects(sdk.edit(original.did, { parent: same.original.checkpoint, resources: [{ id: "sidecar", bytes: B2, mediaType: "text/plain" }], author, signer }), "invalid-evidence", "STATE_RESOURCE_SET");
  });

  test("C12-21 through the API: deactivation is terminal", async () => {
    const { sdk, signer, author, original } = await harbor();
    const ended = await sdk.deactivate(original.did, { parent: original.checkpoint, author, signer });
    expect(ended.original.state.status).toBe("deactivated");
    await rejects(sdk.edit(original.did, { parent: ended.original.checkpoint, name: "Again", author, signer }), "deactivated", "ORIGINAL_DEACTIVATED");
    expect((await sdk.get(original.did, { checkpoint: original.checkpoint })).state.status).toBe("active");
  });
});

describe("conflicts and retries (P4.5, P6.1, P6.4)", () => {
  test("C12-12: a stale parent or prior digest is a conflict, never a rebase", async () => {
    const { sdk, signer, author, original } = await harbor();
    const a = await sdk.prepareEdit(original.did, { parent: original.checkpoint, name: "A", author });
    const b = await sdk.prepareEdit(original.did, { parent: original.checkpoint, name: "B", author });
    await sdk.commit(a, signer);
    await rejects(sdk.commit(b, signer), "stale-parent", "STALE_PARENT");
    await rejects(sdk.edit(original.did, { parent: original.checkpoint, name: "C", author, signer }), "stale-parent", "STALE_PARENT");
    const head = (await sdk.get(original.did)).checkpoint;
    await rejects(sdk.edit(original.did, { parent: head, resources: [{ id: "photo", bytes: B2, expectedDigest: resourceDigest(B2) }], author, signer }), "stale-parent", "STALE_DIGEST");
    expect((await sdk.get(original.did)).state.name).toBe("A");
  });

  test("C12-15: retrying an accepted, identical candidate returns its checkpoint", async () => {
    const { sdk, signer, author, original } = await harbor();
    const draft = await sdk.prepareEdit(original.did, { parent: original.checkpoint, name: "Once", author });
    const first = await sdk.commit(draft, signer);
    const again = await sdk.commit(draft, signer);
    expect(again.status).toBe("duplicate");
    expect(again.original.checkpoint).toBe(first.original.checkpoint);
    expect(again.original.report.history.entries).toBe(2);
  });

  test("C12-13: a rejecting signer or an invalid proof leaves the prior checkpoint", async () => {
    const { sdk, signer, author, original } = await harbor();
    const refusing: OriginalsSigner = { ...signer, sign: () => Promise.reject(new Error("user declined")) };
    await expect(sdk.edit(original.did, { parent: original.checkpoint, name: "X", author, signer: refusing })).rejects.toThrow("user declined");
    const garbage: OriginalsSigner = { ...signer, sign: () => Promise.resolve(new Uint8Array(64).fill(7)) };
    await rejects(sdk.edit(original.did, { parent: original.checkpoint, name: "X", author, signer: garbage }), "invalid-evidence", "COMMIT_VERIFICATION_FAILED");
    const now = await sdk.get(original.did);
    expect(now.checkpoint).toBe(original.checkpoint);
    expect(now.state.name).toBe("Harbor at dawn");
  });

  test("timestamps strictly increase, in milliseconds, even when the clock stalls", async () => {
    const env = await setup();
    const stalled = OriginalsSDK.create({ store: env.store, authors: [env.alice.evidence()], clock: () => Date.parse("2026-10-18T12:00:00Z") });
    const c = await stalled.create({ name: "x", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: B1 }], author: env.author, signer: env.signer });
    if (c.kind !== "original") throw new Error("expected an Original");
    const e = await stalled.edit(c.original.did, { parent: c.original.checkpoint, name: "y", author: env.author, signer: env.signer });
    expect(e.original.report.history.status).toBe("valid");
  });
});

describe("signing (P5.11)", () => {
  test("the signer is shown the Original, operation and resource changes", async () => {
    const { sdk, signer, author, original } = await harbor();
    const seen: SigningRequest[] = [];
    const watching: OriginalsSigner = { ...signer, sign: (request) => (seen.push(request), signer.sign(request)) };
    await sdk.edit(original.did, { parent: original.checkpoint, resources: [{ id: "photo", bytes: B2 }], author, signer: watching });
    expect(seen[0].summary).toMatchObject({
      original: original.did, operation: "update", name: "Harbor at dawn",
      changes: [{ resource: "photo", from: resourceDigest(B1), to: resourceDigest(B2) }],
    });
  });

  test("keySigner refuses anything that is not a well-formed Originals entry for its key", async () => {
    const { signer } = await harbor();
    const request = (entry: Record<string, unknown>): SigningRequest => ({
      entry: entry as never,
      proofOptions: { type: "DataIntegrityProof", cryptosuite: "eddsa-jcs-2022", verificationMethod: signer.verificationMethod, proofPurpose: "assertionMethod" },
      summary: {} as never,
    });
    await rejects(signer.sign(request({ versionId: "1-x", versionTime: "t", parameters: { method: "did:vh:1.0" }, state: {} })), "invalid-evidence", "SIGNER_REFUSED");
    await rejects(signer.sign({ ...request({}), proofOptions: { ...request({}).proofOptions, verificationMethod: "did:vh:other#k" } }), "invalid-evidence", "SIGNER_REFUSED");
    expect(() => keySigner({ keyType: "Ed25519", secretKey: KEY, verificationMethod: "not a did url" })).toThrow(OriginalsError);
  });
});

describe("C12-20: import, then edit without authority", () => {
  test("reading succeeds; an edit signed by a key the author DID does not list fails", async () => {
    const { sdk, alice, original } = await harbor();
    const pkg = await sdk.package(original.did);
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: clock(Date.parse("2026-10-18T13:00:00Z")) });
    const imported = await reader.import(pkg.bytes);
    expect(imported.status).toBe("imported");
    const view = await reader.get(original.did);
    expect(view.state.name).toBe("Harbor at dawn");
    // A key of the reader's own is not an author key of Alice's DID.
    const intruder = keySigner({ keyType: "Ed25519", secretKey: seed(77), verificationMethod: `${alice.did}#orig` });
    await rejects(reader.edit(original.did, { parent: view.checkpoint, name: "Mine", author: alice.ref("orig"), signer: intruder }), "invalid-evidence", "COMMIT_VERIFICATION_FAILED");
    expect((await reader.get(original.did)).checkpoint).toBe(view.checkpoint);
  });

  test("an edit with no signer at all is a structured unauthorized-key error, and nothing is written (#976)", async () => {
    const { sdk, alice, original } = await harbor();
    const reader = OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: clock(Date.parse("2026-10-18T13:00:00Z")) });
    await reader.import((await sdk.package(original.did)).bytes);
    // A JavaScript caller, or one holding no key after an import, passes no signer.
    const noSigner = { parent: original.checkpoint, name: "Mine", author: alice.ref("orig") } as unknown as Parameters<OriginalsSDK["edit"]>[1];
    await rejects(reader.edit(original.did, noSigner), "unauthorized-key", "SIGNER_REQUIRED");
    const draft = await reader.prepareEdit(original.did, { parent: original.checkpoint, name: "Mine", author: alice.ref("orig") });
    await rejects(reader.commit(draft, { sign: "not a function" } as unknown as OriginalsSigner), "unauthorized-key", "SIGNER_REQUIRED");
    expect((await reader.get(original.did)).checkpoint).toBe(original.checkpoint);
  });
});

describe("C12-150: the SDK never commits an entry over 65,536 UTF-8 bytes (P7.7; P14.13, PROVISIONAL originals-spec #48)", () => {
  test("an entry whose line is 66,000 UTF-8 bytes but fewer UTF-16 code units is refused", async () => {
    const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
    const store = new MemoryStore();
    const sdk = OriginalsSDK.create({ store, authors: [alice.evidence()], clock: clock() });
    const created = sdk.create({ name: "Harbor", metadata: { wide: "é".repeat(33_000) }, resources: [{ id: "photo", mediaType: "image/jpeg", bytes: B1 }], author: alice.ref("orig"), signer: alice.signer("orig", KEY) });
    await expect(created).rejects.toMatchObject({ category: "limit-exceeded" });
  });
});
