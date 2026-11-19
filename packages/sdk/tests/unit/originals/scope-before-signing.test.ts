/**
 * Scopes are checked before anyone is asked to sign (P5.28, P5.29, P5.24):
 * `edit`, `prepareEdit`, `sign` and `cosign` find the grant the verifier
 * would rely on, direct first and then inherited at the pin, and check the
 * change against its scope. Outside: refused as `outside-grant`, naming the
 * paths or operations, with no signature asked for. Unchecked (bytes not
 * held, an unknown type, no view): refused as `incomplete-evidence` unless
 * `uncheckedScope: "allow"`, and a candidate signed that way is never
 * committed or submitted by this SDK.
 *
 * Rows C12-412 (inside allowed, outside rejected), C12-413 (a rename touches
 * both paths), C12-414 (items operations) and C12-415 (unknown type or
 * missing bytes is unchecked).
 */
import { describe, expect, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import { canonicalize, type JsonObject } from "@originals/vh/json";
import { CODE_TREE_FORMAT, CODE_TREE_MEDIA_TYPE, ITEM_LIST_MEDIA_TYPE, resourceDigest, type EditorGrant } from "@originals/vh/originals";
import { MemoryStore, OriginalsSDK, keySigner, type OriginalsSigner, type SigningRequest } from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const encoder = new TextEncoder();

async function caught(promise: Promise<unknown>): Promise<OriginalsError> {
  const e = await promise.then(() => undefined, (x: unknown) => x);
  expect(e, "expected a rejection").toBeInstanceOf(OriginalsError);
  return e as OriginalsError;
}

/** A code tree with `docs/` and `src/`, each one file: its objects by digest and the root's bytes. */
function tree(files: { docs?: Record<string, string>; src?: Record<string, string> }) {
  const objects = new Map<string, Uint8Array>();
  const put = (b: Uint8Array) => {
    const d = resourceDigest(b);
    objects.set(d, b);
    return d;
  };
  const dir = (entries: Record<string, { mode: string; digest: string }>) => encoder.encode(canonicalize({ entries, format: CODE_TREE_FORMAT } as unknown as JsonObject));
  const sub = (f: Record<string, string>) => put(dir(Object.fromEntries(Object.entries(f).map(([n, c]) => [n, { mode: "100644", digest: put(bytes(c)) }]))));
  const entries: Record<string, { mode: string; digest: string }> = {};
  if (files.docs) entries.docs = { mode: "40000", digest: sub(files.docs) };
  if (files.src) entries.src = { mode: "40000", digest: sub(files.src) };
  return { objects, root: dir(entries), subtrees: Object.fromEntries(Object.entries(entries).map(([n, e]) => [n, e.digest])) };
}

/** A signer that counts the signatures it is asked for. */
function counted(signer: OriginalsSigner): OriginalsSigner & { asked: number } {
  const c = {
    asked: 0,
    cryptosuite: signer.cryptosuite,
    verificationMethod: signer.verificationMethod,
    sign(request: SigningRequest) {
      c.asked++;
      return signer.sign(request);
    },
  };
  return c;
}

const DOCS_ONLY: EditorGrant["scope"] = { type: "paths", paths: ["docs/**"] };

async function setup(opts: { inherited?: boolean; scope?: EditorGrant["scope"]; mediaType?: string; initial?: Uint8Array } = {}) {
  const [ka, kb, kd] = [seed(51), seed(61), seed(71)];
  const [alice, bob, dana] = await Promise.all([ka, kb, kd].map((k) => Author.create([{ fragment: "orig", secret: k }])));
  const sign = (a: Author, k: Uint8Array): OriginalsSigner => keySigner({ keyType: "Ed25519", secretKey: k, verificationMethod: `${a.did}#orig` });
  const store = new MemoryStore();
  const sdk = OriginalsSDK.create({ store, authors: async (did) => [alice, bob, dana].find((d) => d.did === did)?.evidence(), clock: clock() });
  const grant: EditorGrant = { did: dana.did, name: false, metadata: false, resource: true, scope: opts.scope ?? DOCS_ONLY };
  const v1 = tree({ docs: { "guide.md": "guide v1" }, src: { "main.ts": "main v1" } });
  for (const [d, b] of v1.objects) await store.putResource(d, b);
  const resource = { mediaType: opts.mediaType ?? CODE_TREE_MEDIA_TYPE, bytes: opts.initial ?? v1.root };
  let did: string;
  let head: string;
  if (opts.inherited) {
    // Alice's repository grants Dana; Bob's branch inherits the grant at its pin (P5.24).
    const repo = await sdk.create({ name: "Repository", resource: { mediaType: "application/octet-stream", bytes: bytes("repo") }, author: alice.ref("orig"), signer: sign(alice, ka), editors: [grant] });
    if (repo.kind !== "original") throw new Error("expected an Original");
    const branch = await sdk.create({ name: "Branch", resource, author: bob.ref("orig"), signer: sign(bob, kb), parent: { did: repo.original.did, versionId: repo.original.checkpoint } });
    if (branch.kind !== "original") throw new Error("expected an Original");
    [did, head] = [branch.original.did, branch.original.checkpoint];
  } else {
    const created = await sdk.create({ name: "Repository", resource, author: alice.ref("orig"), signer: sign(alice, ka), editors: [grant] });
    if (created.kind !== "original") throw new Error("expected an Original");
    [did, head] = [created.original.did, created.original.checkpoint];
  }
  const asDana = counted(sign(dana, kd));
  return { sdk, store, did, head, dana, asDana, danaRef: dana.ref("orig") };
}

for (const inherited of [false, true]) {
  const how = inherited ? "an inherited grant (P5.24)" : "a direct grant";
  describe(`C12-412 (P5.28): ${how} with a paths scope is checked before signing`, () => {
    test("a change inside docs/** is signed and committed, its scope reported checked", async () => {
      const env = await setup({ inherited });
      const v2 = tree({ docs: { "guide.md": "guide v2" }, src: { "main.ts": "main v1" } });
      for (const [d, b] of v2.objects) await env.store.putResource(d, b);
      const edited = await env.sdk.edit(env.did, { parent: env.head, resource: { bytes: v2.root }, editor: env.danaRef, signer: env.asDana });
      expect(edited.original.report.grants[0]).toMatchObject({ source: inherited ? "inherited" : "direct", scope: { type: "paths", status: "checked" } });
      expect(env.asDana.asked).toBe(1);
    });

    test("a change outside is refused as outside-grant naming the paths, and no signature is asked for", async () => {
      const env = await setup({ inherited });
      const v2 = tree({ docs: { "guide.md": "guide v2" }, src: { "main.ts": "main v2" } });
      for (const [d, b] of v2.objects) await env.store.putResource(d, b);
      const e = await caught(env.sdk.edit(env.did, { parent: env.head, resource: { bytes: v2.root }, editor: env.danaRef, signer: env.asDana }));
      expect([e.category, e.code]).toEqual(["outside-grant", "SCOPE_OUTSIDE"]);
      expect(e.details).toMatchObject({ type: "paths", outside: ["src/main.ts"], source: inherited ? "inherited" : "direct" });
      expect(env.asDana.asked).toBe(0);
      // The draft path refuses it too, before any signer is involved.
      expect((await caught(env.sdk.prepareEdit(env.did, { parent: env.head, resource: { bytes: v2.root }, editor: env.danaRef }))).code).toBe("SCOPE_OUTSIDE");
      expect((await env.sdk.get(env.did)).checkpoint).toBe(env.head);
    });
  });
}

describe("C12-413 (P5.29): a rename touches both paths", () => {
  test("moving docs/a.md to src/a.md is outside docs/**, naming src/a.md", async () => {
    const env = await setup({ initial: tree({ docs: { "a.md": "a" }, src: { "main.ts": "m" } }).root });
    const before = tree({ docs: { "a.md": "a" }, src: { "main.ts": "m" } });
    const moved = tree({ docs: { "b.md": "b" }, src: { "a.md": "a", "main.ts": "m" } });
    for (const [d, b] of [...before.objects, ...moved.objects]) await env.store.putResource(d, b);
    const e = await caught(env.sdk.edit(env.did, { parent: env.head, resource: { bytes: moved.root }, editor: env.danaRef, signer: env.asDana }));
    expect(e.code).toBe("SCOPE_OUTSIDE");
    expect(e.details).toMatchObject({ outside: ["src/a.md"] });
    expect(env.asDana.asked).toBe(0);
  });
});

describe("C12-414 (P5.29): an items scope allows only the operations it lists", () => {
  const list = (items: Record<string, string>) => encoder.encode(canonicalize({ items } as unknown as JsonObject));
  test("adding is signed; editing an item is refused naming it", async () => {
    const env = await setup({ scope: { type: "items", ops: ["add"] }, mediaType: ITEM_LIST_MEDIA_TYPE, initial: list({ a: "milk" }) });
    const added = await env.sdk.edit(env.did, { parent: env.head, resource: { bytes: list({ a: "milk", b: "eggs" }) }, editor: env.danaRef, signer: env.asDana });
    const e = await caught(env.sdk.edit(env.did, { parent: added.original.checkpoint, resource: { bytes: list({ a: "oat milk", b: "eggs" }) }, editor: env.danaRef, signer: env.asDana }));
    expect([e.category, e.code]).toEqual(["outside-grant", "SCOPE_OUTSIDE"]);
    expect(e.details).toMatchObject({ type: "items", outside: ["edit a"] });
    expect(env.asDana.asked).toBe(1);
  });
});

describe("C12-415 (P5.28): a scope that cannot be checked is refused unless allowed, and never committed", () => {
  async function missingSubtree() {
    const env = await setup();
    // The new docs subtree is not in the store: the check needs it and cannot have it.
    const v2 = tree({ docs: { "guide.md": "guide v2" }, src: { "main.ts": "main v1" } });
    return { ...env, v2 };
  }

  test("missing bytes: refused as incomplete-evidence naming the object, no signature asked for", async () => {
    const env = await missingSubtree();
    const e = await caught(env.sdk.edit(env.did, { parent: env.head, resource: { bytes: env.v2.root }, editor: env.danaRef, signer: env.asDana }));
    expect([e.category, e.code]).toEqual(["incomplete-evidence", "SCOPE_UNCHECKED"]);
    expect(e.details).toMatchObject({ type: "paths", reason: "missing-bytes", missing: [env.v2.subtrees.docs] });
    expect(env.asDana.asked).toBe(0);
  });

  test("an unknown scope type is unchecked too", async () => {
    const env = await setup({ scope: { type: "regions", regions: ["north"] } as never });
    const v2 = tree({ docs: { "guide.md": "guide v2" }, src: { "main.ts": "main v1" } });
    for (const [d, b] of v2.objects) await env.store.putResource(d, b);
    const e = await caught(env.sdk.edit(env.did, { parent: env.head, resource: { bytes: v2.root }, editor: env.danaRef, signer: env.asDana }));
    expect(e.code).toBe("SCOPE_UNCHECKED");
    expect(e.details).toMatchObject({ type: "regions", reason: "unknown-type" });
  });

  test('uncheckedScope: "allow" signs it; the candidate says unchecked and is never committed or submitted here', async () => {
    const env = await missingSubtree();
    const draft = await env.sdk.prepareEdit(env.did, { parent: env.head, resource: { bytes: env.v2.root }, editor: env.danaRef, uncheckedScope: "allow" });
    const candidate = await env.sdk.sign(draft, env.asDana);
    expect(env.asDana.asked).toBe(1);
    expect(candidate.scope).toMatchObject({ status: "unchecked", type: "paths", reason: "missing-bytes", source: "direct" });
    expect(typeof candidate.line).toBe("string");
    expect((await caught(env.sdk.commitDraft({ ...draft, proofs: [candidate.entry.proof[0]] }))).code).toBe("SCOPE_UNCHECKED");
    const host = { submit: () => Promise.reject(new Error("never sent")), accepted: () => Promise.reject(new Error("unused")) };
    expect((await caught(env.sdk.submit(candidate, host))).code).toBe("SCOPE_UNCHECKED");
    expect((await env.sdk.get(env.did)).checkpoint).toBe(env.head);
    // Once the store holds the subtree, the same change is checked and committed.
    for (const [d, b] of env.v2.objects) await env.store.putResource(d, b);
    const edited = await env.sdk.edit(env.did, { parent: env.head, resource: { bytes: env.v2.root }, editor: env.danaRef, signer: env.asDana });
    expect(edited.original.report.grants[0].scope).toEqual({ type: "paths", status: "checked" });
  });

  test("cosign checks too: a draft whose choice is refuse is refused there before the signer is asked", async () => {
    const env = await missingSubtree();
    const draft = await env.sdk.prepareEdit(env.did, { parent: env.head, resource: { bytes: env.v2.root }, editor: env.danaRef, uncheckedScope: "allow" });
    const cosigned = await env.sdk.cosign(draft, env.asDana);
    expect(cosigned.proofs).toHaveLength(1);
    const e = await caught(env.sdk.cosign({ ...draft, uncheckedScope: "refuse" }, env.asDana));
    expect(e.code).toBe("SCOPE_UNCHECKED");
    expect(env.asDana.asked).toBe(1);
  });

  test("uncheckedScope takes only refuse or allow", async () => {
    const env = await missingSubtree();
    expect((await caught(env.sdk.prepareEdit(env.did, { parent: env.head, resource: { bytes: env.v2.root }, editor: env.danaRef, uncheckedScope: "yes" as never }))).code).toBe("INPUT_INVALID");
  });
});
