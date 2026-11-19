/**
 * Scoped grants through the SDK (P5.28, P5.29, P14.10; originals-spec #66):
 * an editor's commit is checked against its grant's `paths` scope over the
 * code tree's path view, with the referenced tree objects read from the
 * store, and evidence packages carry the objects the checks need, or list
 * them as `{ kind: "object", digest }` missing items.
 *
 * Rows C12-412 and C12-416.
 */
import { describe, expect, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import { canonicalize, type JsonObject } from "@originals/vh/json";
import { CODE_TREE_FORMAT, CODE_TREE_MEDIA_TYPE, resourceDigest } from "@originals/vh/originals";
import { MemoryStore, OriginalsSDK, keySigner, readZip, writeZip, type OriginalsSigner } from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const encoder = new TextEncoder();

async function rejects(promise: Promise<unknown>, category: string, code?: string) {
  const caught = await promise.then(() => undefined, (e: unknown) => e);
  expect(caught, "expected a rejection").toBeInstanceOf(OriginalsError);
  expect((caught as OriginalsError).category, (caught as Error).message).toBe(category as never);
  if (code) expect((caught as OriginalsError).code, (caught as Error).message).toBe(code);
}

/** A code tree: each object by digest; the root's bytes and digest. */
function trees(spec: { docs: string; src: string }) {
  const objects = new Map<string, Uint8Array>();
  const put = (b: Uint8Array) => {
    const d = resourceDigest(b);
    objects.set(d, b);
    return d;
  };
  const dir = (entries: Record<string, { mode: string; digest: string }>) => encoder.encode(canonicalize({ entries, format: CODE_TREE_FORMAT } as unknown as JsonObject));
  const docs = put(dir({ "guide.md": { mode: "100644", digest: put(bytes(spec.docs)) } }));
  const src = put(dir({ "main.ts": { mode: "100644", digest: put(bytes(spec.src)) } }));
  const root = dir({ docs: { mode: "40000", digest: docs }, src: { mode: "40000", digest: src } });
  return { objects, root, docs };
}

async function repository() {
  const [ka, kd] = [seed(21), seed(41)];
  const [alice, dana] = await Promise.all([Author.create([{ fragment: "orig", secret: ka }]), Author.create([{ fragment: "orig", secret: kd }])]);
  const signer = (a: Author, k: Uint8Array): OriginalsSigner => keySigner({ keyType: "Ed25519", secretKey: k, verificationMethod: `${a.did}#orig` });
  const store = new MemoryStore();
  const sdk = OriginalsSDK.create({ store, authors: async (did) => [alice, dana].find((d) => d.did === did)?.evidence(), clock: clock() });
  const v1 = trees({ docs: "guide v1", src: "main v1" });
  for (const [d, b] of v1.objects) await store.putResource(d, b);
  const created = await sdk.create({
    name: "Repository", resource: { mediaType: CODE_TREE_MEDIA_TYPE, bytes: v1.root }, author: alice.ref("orig"), signer: signer(alice, ka),
    editors: [{ did: dana.did, name: false, metadata: false, resource: true, scope: { type: "paths", paths: ["docs/**"] } }],
  });
  if (created.kind !== "original") throw new Error("expected an Original");
  return { alice, dana, asDana: signer(dana, kd), sdk, store, did: created.original.did, v1: created.original.checkpoint };
}

describe("C12-412 (P5.28, P5.29): an editor's commit under a paths scope", () => {
  test("a change inside the scope commits; one outside is refused and never committed", async () => {
    const { dana, asDana, sdk, store, did, v1 } = await repository();
    const inside = trees({ docs: "guide v2", src: "main v1" });
    for (const [d, b] of inside.objects) await store.putResource(d, b);
    const edited = await sdk.edit(did, { parent: v1, resource: { bytes: inside.root }, editor: dana.ref("orig"), signer: asDana });
    expect(edited.original.report.grants).toEqual([{ versionId: edited.original.checkpoint, editor: dana.did, source: "direct", scope: { type: "paths", status: "checked" } }]);
    const outside = trees({ docs: "guide v2", src: "main v2" });
    for (const [d, b] of outside.objects) await store.putResource(d, b);
    await rejects(sdk.edit(did, { parent: edited.original.checkpoint, resource: { bytes: outside.root }, editor: dana.ref("orig"), signer: asDana }), "outside-grant", "SCOPE_OUTSIDE");
    expect((await sdk.get(did)).checkpoint).toBe(edited.original.checkpoint);
  });
});

describe("C12-416 (P5.28, P7.1, P14.10): packages carry the objects scope checks need", () => {
  test("the package holds the changed subtrees; without one a reader reports the scope unchecked and the manifest wrong", async () => {
    const { dana, asDana, sdk, store, did, v1 } = await repository();
    const inside = trees({ docs: "guide v2", src: "main v1" });
    for (const [d, b] of inside.objects) await store.putResource(d, b);
    await sdk.edit(did, { parent: v1, resource: { bytes: inside.root }, editor: dana.ref("orig"), signer: asDana });
    const pkg = await sdk.package(did);
    expect(pkg.manifest.completeness).toBe("complete");
    const files = new Map(readZip(pkg.bytes));
    expect(files.has(`resources/${inside.docs}`)).toBe(true);
    const fresh = () => OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock() });
    expect((await fresh().load(pkg.bytes)).report.history.status).toBe("valid");
    files.delete(`resources/${inside.docs}`);
    const stripped = await fresh().load(writeZip(files));
    expect(stripped.report.history.failure?.code).toBe("SCOPE_UNCHECKED");
    expect(stripped.report.scopeObjects.missing).toEqual([inside.docs]);
    expect(stripped.reasons).toContain("manifest-completeness-mismatch");
    // Declared partial, with the object listed: honest, and still not a pass.
    const manifest = JSON.parse(new TextDecoder().decode(files.get("originals-evidence.json")!));
    files.set("originals-evidence.json", encoder.encode(JSON.stringify({ ...manifest, completeness: "partial", missing: [{ kind: "object", digest: inside.docs }] })));
    const honest = await fresh().load(writeZip(files));
    expect(honest.reasons).not.toContain("manifest-completeness-mismatch");
    expect(honest.report.validAsOf).toBeNull();
  });
});
