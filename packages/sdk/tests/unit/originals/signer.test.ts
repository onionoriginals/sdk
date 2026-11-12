/**
 * The signer contract (P5.11): a signer holding an Originals key parses the
 * entry, shows the person whose key signs who signs, the Original, the
 * operation and the resource changes, and refuses input that is not a
 * well-formed Originals entry. Tests cite their section 12 rows by registry id.
 */
import { describe, expect, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import type { JsonObject } from "@originals/vh/json";
import type { UnsignedEntry } from "@originals/vh/log";
import { MemoryStore, OriginalsSDK, describeEntry, keySigner, summarize, type SigningRequest } from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KA = seed(21);
const B1 = bytes("harbor at dawn");
const B2 = bytes("harbor at dawn, cropped");

async function refused(promise: Promise<unknown>, why: string) {
  const caught = await promise.then(() => undefined, (e: unknown) => e);
  expect(caught, `expected a refusal: ${why}`).toBeInstanceOf(OriginalsError);
  expect((caught as OriginalsError).code, why).toBe("SIGNER_REFUSED");
}

async function harbor() {
  const alice = await Author.create([{ fragment: "orig", secret: KA }]);
  const store = new MemoryStore();
  const sdk = OriginalsSDK.create({ store, authors: async (did) => (did === alice.did ? alice.evidence() : undefined), clock: clock() });
  const created = await sdk.create({ name: "Harbor at dawn", resource: { mediaType: "image/jpeg", bytes: B1 }, author: alice.ref("orig"), signer: alice.signer("orig", KA) });
  if (created.kind !== "original") throw new Error("expected an Original");
  const did = created.original.did;
  const draft = await sdk.prepareEdit(did, { parent: created.original.checkpoint, author: alice.ref("orig"), resource: { bytes: B2 } });
  const genesis = JSON.parse((await store.get(did))!.log.trimEnd().split("\n")[0]) as UnsignedEntry;
  const vm = alice.ref("orig").verificationMethod;
  const proofOptions = { type: "DataIntegrityProof" as const, cryptosuite: "eddsa-jcs-2022" as const, verificationMethod: vm, proofPurpose: "assertionMethod" };
  return { alice, sdk, did, draft, genesis, vm, proofOptions };
}

/** A request for `entry` whose summary and display are what the entry itself says, with no parent. */
function honest(entry: UnsignedEntry, proofOptions: SigningRequest["proofOptions"]): SigningRequest {
  let summary;
  try {
    summary = summarize(entry);
  } catch {
    summary = {} as never;
  }
  let display = "";
  try {
    display = describeEntry(summary);
  } catch {
    // nothing to show
  }
  return { entry, proofOptions, summary, display };
}

describe("C12-302: a signer refuses input that is not a well-formed Originals entry, or that does not show what it signs (P5.11)", () => {
  test("input that is not an Originals entry at all", async () => {
    const { draft, proofOptions, vm } = await harbor();
    const signer = keySigner({ keyType: "Ed25519", secretKey: KA, verificationMethod: vm });
    const entry = draft.entry as unknown as JsonObject;
    const state = entry.state as JsonObject;
    const inputs: Array<[string, unknown]> = [
      ["nothing", undefined],
      ["a string", "sign me"],
      ["an empty object", {}],
      ["arbitrary bytes as a JSON array", [1, 2, 3]],
      ["a did:webvh log entry", { versionId: "1-QmX", versionTime: "2026-10-18T12:00:00Z", parameters: { method: "did:webvh:1.0", scid: "QmX" }, state: { id: "did:webvh:QmX:example.com" } }],
      ["no state", { ...entry, state: undefined }],
      ["a state with no asset", { ...entry, state: { ...state, asset: undefined } }],
      ["an unknown operation", { ...entry, state: { ...state, operation: "transfer" } }],
      ["a state with an undefined member", { ...entry, state: { ...state, owner: "bc1q..." } }],
      ["an asset with an undefined member", { ...entry, state: { ...state, asset: { ...(state.asset as JsonObject), price: 10 } } }],
      ["an alias of another DID method", { ...entry, state: { ...state, asset: { ...(state.asset as JsonObject), aliases: ["did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"] } } }],
      ["a resource that is not a descriptor", { ...entry, state: { ...state, asset: { ...(state.asset as JsonObject), resource: { mediaType: "image/jpeg", size: -1, digest: "x" } } } }],
      ["later-entry parameters with members (P14.1)", { ...entry, parameters: { ttl: 60 } }],
      ["later-entry parameters repeating the method (P14.1)", { ...entry, parameters: { method: "originals:1.0" } }],
      ["a null parameter value (P14.1)", { ...entry, parameters: { deactivated: null } }],
      ["a versionTime that is not P14.2's", { ...entry, versionTime: "yesterday" }],
      ["an entry that already carries a proof", { ...entry, proof: [{ type: "DataIntegrityProof" }] }],
    ];
    for (const [why, input] of inputs) {
      await refused(Promise.resolve().then(() => signer.sign(honest(input as UnsignedEntry, proofOptions))), why);
      await refused(Promise.resolve().then(() => signer.sign({ ...draft, entry: input as UnsignedEntry, proofOptions })), `${why}, with the draft's summary`);
    }
    // The well-formed entry itself signs.
    expect((await signer.sign({ entry: draft.entry, proofOptions, summary: draft.summary, display: draft.display })).length).toBe(64);
  });

  test("a request that does not show who signs, the Original, the operation and the resource changes", async () => {
    const { draft, proofOptions, vm } = await harbor();
    const signer = keySigner({ keyType: "Ed25519", secretKey: KA, verificationMethod: vm });
    const s = draft.summary;
    const hiding: Array<[string, unknown]> = [
      ["no summary", undefined],
      ["no signer", { ...s, signer: undefined }],
      ["another signer", { ...s, signer: { ...s.signer, did: "did:vh:QmSomeoneElseSomeoneElseSomeoneElseSomeone1" } }],
      ["no Original", { ...s, original: undefined }],
      ["another Original", { ...s, original: "did:vh:QmAnotherOriginalAnotherOriginalAnotherOrig" }],
      ["no operation", { ...s, operation: undefined }],
      ["another operation", { ...s, operation: "deactivate" }],
      ["no resource changes", { ...s, changes: [] }],
      ["other resource changes", { ...s, changes: [{ from: null, to: s.changes[0].to }] }],
    ];
    for (const [why, summary] of hiding) {
      await refused(signer.sign({ entry: draft.entry, proofOptions, summary: summary as never, display: "" }), why);
    }
    // What is shown is recomputed from the entry: it names the signer, the Original, the operation and the change.
    let shown = "";
    const showing = keySigner({ keyType: "Ed25519", secretKey: KA, verificationMethod: vm, confirm: (text) => ((shown = text), true) });
    await showing.sign({ entry: draft.entry, proofOptions, summary: s, display: "a display that says nothing" });
    expect(shown).toContain(`Signing as author ${s.signer.did} with ${vm}`);
    expect(shown).toContain(`Original: ${draft.original}`);
    expect(shown).toContain("Operation: update");
    expect(shown).toContain(`Resource: new version ${s.changes[0].from} -> ${s.changes[0].to}`);
  });
});
