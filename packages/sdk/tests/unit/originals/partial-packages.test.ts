/**
 * Partial evidence packages chosen by the packager (`omitResources`) and a
 * server that accepts them only against bytes it already holds
 * (`import(zip, { requireResources })`). Leaving bytes out never changes what
 * verifies: the log, author binding and identity evidence verify as before,
 * and the left-out versions are reported as unavailable content, never as a
 * failure (C12-10; P7.3, P7.4, P14.10).
 */
import { describe, expect, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import { resourceDigest } from "@originals/vh/originals";
import { MemoryStore, OriginalsSDK, readEvidence, readZip, writeEvidence, type OriginalView } from "../../../src/originals/index.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const KEY = seed(23);
const V = [bytes("sketch one"), bytes("sketch two"), bytes("sketch three"), bytes("sketch four")];

/** An Original with versions V1..V4, and V2's bytes again as version 5. */
async function drawing(store = new MemoryStore()) {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const sdk = OriginalsSDK.create({ store, authors: [alice.evidence()], clock: clock() });
  const signer = alice.signer("orig", KEY);
  const author = alice.ref("orig");
  const c = await sdk.create({ name: "Drawing", resource: { mediaType: "image/png", bytes: V[0] }, author, signer });
  if (c.kind !== "original") throw new Error("expected an Original");
  let view: OriginalView = c.original;
  for (const b of V.slice(1)) view = (await sdk.edit(view.did, { parent: view.checkpoint, resource: { bytes: b }, author, signer })).original;
  return { alice, store, sdk, signer, author, did: view.did, view };
}

const reader = (alice: Author, store = new MemoryStore()) =>
  OriginalsSDK.create({ store, authors: [alice.evidence()], clock: clock(Date.parse("2026-10-18T13:00:00Z")) });

/** What Easel hand-rolled before this option: read the complete package, drop the bytes, write it again. */
function handRolled(zip: Uint8Array, view: OriginalView, known: number): Uint8Array {
  const contents = readEvidence(zip);
  const keep = new Set(view.resources.filter((r) => r.version > known).map((r) => r.digest));
  for (const r of view.resources.filter((r) => r.version <= known && !keep.has(r.digest))) {
    delete contents.bytes[r.digest];
    contents.manifest.missing.push({ kind: "resource", version: r.version, digest: r.digest, versionId: r.versionId });
  }
  contents.manifest.completeness = "partial";
  return writeEvidence(contents);
}

describe("package(did, { omitResources })", () => {
  test("C12-10: leaves out the first versions' bytes and lists them as missing; the log verifies as before", async () => {
    const { sdk, alice, did, view } = await drawing();
    const full = await sdk.package(did);
    const pkg = await sdk.package(did, { omitResources: { throughVersion: 3 } });
    expect(pkg.manifest.completeness).toBe("partial");
    expect(pkg.manifest.missing).toEqual(view.resources.slice(0, 3).map((r) => ({ kind: "resource", version: r.version, digest: r.digest, versionId: r.versionId })));
    expect([...readZip(pkg.bytes).keys()].filter((n) => n.startsWith("resources/"))).toEqual([`resources/${resourceDigest(V[3])}`]);
    expect(pkg.bytes.length).toBeLessThan(full.bytes.length);

    const fullReport = (await reader(alice).load(full.bytes)).report;
    const loaded = await reader(alice).load(pkg.bytes);
    expect(loaded.reasons).toEqual(["not-anchored"]);
    // Everything but resource availability is what the complete package reports.
    const { resources: _a, ...rest } = loaded.report;
    const { resources: _b, ...fullRest } = fullReport;
    expect(rest).toEqual(fullRest);
    expect(loaded.report.resources.status).toBe("partial");
    expect(loaded.report.resources.versions.map((r) => r.bytes)).toEqual(["missing", "missing", "missing", "verified"]);
  });

  test("is byte-identical to the hand-rolled partial package it replaces", async () => {
    const { sdk, did, view } = await drawing();
    const full = await sdk.package(did);
    for (const known of [1, 2, 3]) {
      expect((await sdk.package(did, { omitResources: { throughVersion: known } })).bytes).toEqual(handRolled(full.bytes, view, known));
    }
  });

  test("keeps bytes a packaged version names, and omits by digest", async () => {
    const { sdk, author, signer, did, view } = await drawing();
    // Version 5 is version 2's bytes again: through version 4, those bytes stay packaged.
    const v5 = (await sdk.edit(did, { parent: view.checkpoint, resource: { bytes: V[1] }, author, signer })).original;
    const pkg = await sdk.package(did, { omitResources: { throughVersion: 4 } });
    expect(pkg.manifest.missing.map((m) => (m.kind === "resource" ? m.version : 0))).toEqual([1, 3, 4]);
    const names = [...readZip(pkg.bytes).keys()].filter((n) => n.startsWith("resources/"));
    expect(names).toEqual([`resources/${resourceDigest(V[1])}`]);
    const byDigest = await sdk.package(did, { omitResources: { digests: [resourceDigest(V[0]), resourceDigest(V[2])] } });
    expect(byDigest.manifest.missing.map((m) => (m.kind === "resource" ? m.version : 0))).toEqual([1, 3]);
    expect(v5.resources.length).toBe(5);
  });

  test("with nothing to leave out, it is the complete package, byte for byte", async () => {
    const { sdk, did } = await drawing();
    const full = await sdk.package(did);
    expect((await sdk.package(did, { omitResources: {} })).bytes).toEqual(full.bytes);
    expect((await sdk.package(did, { omitResources: { throughVersion: 0, digests: [] } })).bytes).toEqual(full.bytes);
    expect(full.manifest.completeness).toBe("complete");
  });

  test("refuses malformed options", async () => {
    const { sdk, did } = await drawing();
    for (const bad of [{ throughVersion: -1 }, { throughVersion: 1.5 }, { through: 2 }, { digests: "z123" }] as never[]) {
      const e = await sdk.package(did, { omitResources: bad }).catch((x) => x);
      expect(e).toBeInstanceOf(OriginalsError);
      expect((e as OriginalsError).code).toBe("INPUT_INVALID");
    }
    expect(((await sdk.package(did, { other: 1 } as never).catch((x) => x)) as OriginalsError).code).toBe("INPUT_INVALID");
  });

  test("refuses option objects that are not plain, typed options (INPUT_INVALID, not a TypeError)", async () => {
    const { sdk, did } = await drawing();
    const bad = [null, "x", [], Object.create({ other: 1 }), { checkpoint: 1 }, { omitResources: { throughVersion: null } }, { omitResources: { digests: [null, 123] } }, { omitResources: null }];
    for (const options of bad) {
      const e = await sdk.package(did, options as never).catch((x) => x);
      expect(e).toBeInstanceOf(OriginalsError);
      expect((e as OriginalsError).code).toBe("INPUT_INVALID");
      expect((e as OriginalsError).category).toBe("invalid-evidence");
    }
    expect((await sdk.package(did, undefined)).manifest.completeness).toBe("complete");
  });
});

describe("import(zip, { requireResources, original })", () => {
  /** A server store that has imported the complete package of the first `n` versions. */
  async function server(alice: Author, sdk: OriginalsSDK, did: string, view: OriginalView, n: number) {
    const store = new MemoryStore();
    const s = reader(alice, store);
    await s.import((await sdk.package(did, { checkpoint: view.resources[n - 1].versionId })).bytes);
    return { s, store };
  }

  test("C12-10: accepts a partial package when the store holds every left-out version, and reports them verified", async () => {
    const { sdk, alice, did, view } = await drawing();
    const { s } = await server(alice, sdk, did, view, 3);
    const pkg = await sdk.package(did, { omitResources: { throughVersion: 3 } });
    const result = await s.import(pkg.bytes, { original: did, requireResources: true });
    expect(result.status).toBe("imported");
    expect(result.original.checkpoint).toBe(view.checkpoint);
    expect(result.original.resources.map((r) => r.bytes)).toEqual(["verified", "verified", "verified", "verified"]);
  });

  test("refuses one whose left-out bytes this store lacks, before storing anything", async () => {
    const { sdk, alice, did, view } = await drawing();
    const { s, store } = await server(alice, sdk, did, view, 2);
    const before = await store.get(did);
    const pkg = await sdk.package(did, { omitResources: { throughVersion: 3 } });
    const e = (await s.import(pkg.bytes, { requireResources: true }).catch((x) => x)) as OriginalsError;
    expect(e).toBeInstanceOf(OriginalsError);
    expect(e.category).toBe("unavailable-bytes");
    expect(e.code).toBe("RESOURCES_NOT_HELD");
    expect(e.details?.missing).toEqual([{ version: 3, digest: view.resources[2].digest, versionId: view.resources[2].versionId }]);
    expect(await store.get(did)).toEqual(before);
    expect(await store.getResource(view.resources[3].digest)).toBeUndefined();
    // Without the option the same package imports, with version 3 unavailable (P7.4).
    const plain = await s.import(pkg.bytes);
    expect(plain.status).toBe("imported");
    expect(plain.original.resources.map((r) => r.bytes)).toEqual(["verified", "verified", "missing", "verified"]);
  });

  test("refuses a fresh store, and a package whose bytes do not match their digest", async () => {
    const { sdk, alice, did } = await drawing();
    const partial = await sdk.package(did, { omitResources: { throughVersion: 1 } });
    expect(((await reader(alice).import(partial.bytes, { requireResources: true }).catch((x) => x)) as OriginalsError).code).toBe("RESOURCES_NOT_HELD");

    const contents = readEvidence((await sdk.package(did)).bytes);
    const digest = resourceDigest(V[3]);
    contents.bytes[digest] = bytes("sketch FOUR");
    const swapped = writeEvidence(contents);
    const e = (await reader(alice).import(swapped, { requireResources: true }).catch((x) => x)) as OriginalsError;
    expect(e.code).toBe("RESOURCE_DIGEST_MISMATCH");
    expect(e.category).toBe("invalid-evidence");
  });

  test("refuses a package for another Original when `original` is given", async () => {
    const { sdk, alice, did } = await drawing();
    const pkg = await sdk.package(did);
    const e = (await reader(alice).import(pkg.bytes, { original: "did:vh:zSomethingElse" }).catch((x) => x)) as OriginalsError;
    expect(e.code).toBe("IMPORT_REJECTED");
    expect((await reader(alice).import(pkg.bytes, { original: did })).status).toBe("imported");
    expect(((await reader(alice).import(pkg.bytes, { strict: true } as never).catch((x) => x)) as OriginalsError).code).toBe("INPUT_INVALID");
  });

  test("refuses option objects that are not plain, typed options, before anything is stored", async () => {
    const { sdk, alice, did } = await drawing();
    const partial = (await sdk.package(did, { omitResources: { throughVersion: 4 } })).bytes;
    // A string "true" must never silently disable the guard; an inherited key is still an unknown field.
    const bad = [null, "x", [], Object.create({ unknown: 1 }), { requireResources: "true" }, { requireResources: 1 }, { original: 7 }];
    for (const options of bad) {
      const store = new MemoryStore();
      const e = await reader(alice, store).import(partial, options as never).catch((x) => x);
      expect(e).toBeInstanceOf(OriginalsError);
      expect((e as OriginalsError).code).toBe("INPUT_INVALID");
      expect((e as OriginalsError).category).toBe("invalid-evidence");
      expect(await store.get(did)).toBeUndefined();
    }
    expect((await reader(alice).import(partial, { requireResources: undefined })).status).toBe("imported");
  });
});

describe("import(zip, { requireResources }) covers the whole imported log (P4.3, P7.4)", () => {
  /** A package with its manifest's checkpoint set to `checkpoint` and its bytes edited. */
  function tampered(zip: Uint8Array, checkpoint: string, edit: (bytes: Record<string, Uint8Array>) => void): Uint8Array {
    const contents = readEvidence(zip);
    contents.manifest.checkpoint = checkpoint;
    edit(contents.bytes);
    return writeEvidence(contents);
  }

  test("C12-10: a manifest naming an earlier checkpoint cannot hide a later version's missing bytes", async () => {
    const { sdk, alice, did, view } = await drawing();
    const full = (await sdk.package(did)).bytes;
    const pkg = tampered(full, view.resources[0].versionId, (b) => delete b[view.resources[3].digest]);
    const store = new MemoryStore();
    const e = (await reader(alice, store).import(pkg, { requireResources: true }).catch((x) => x)) as OriginalsError;
    expect(e).toBeInstanceOf(OriginalsError);
    expect(e.code).toBe("RESOURCES_NOT_HELD");
    expect(e.category).toBe("unavailable-bytes");
    expect(e.details?.missing).toEqual([{ version: 4, digest: view.resources[3].digest, versionId: view.resources[3].versionId }]);
    expect(await store.get(did)).toBeUndefined();
  });

  test("C12-10: a manifest naming an unknown checkpoint cannot hide missing bytes either", async () => {
    const { sdk, alice, did, view } = await drawing();
    const full = (await sdk.package(did)).bytes;
    const pkg = tampered(full, "nonexistent", (b) => delete b[view.resources[3].digest]);
    const store = new MemoryStore();
    const e = (await reader(alice, store).import(pkg, { requireResources: true }).catch((x) => x)) as OriginalsError;
    expect(e.code).toBe("RESOURCES_NOT_HELD");
    expect((e.details?.missing as Array<{ version: number }>).map((m) => m.version)).toEqual([4]);
    expect(await store.get(did)).toBeUndefined();
  });

  test("C12-10: corrupt bytes for a version after the manifest's checkpoint are RESOURCE_DIGEST_MISMATCH, and never stored", async () => {
    const { sdk, alice, did, view } = await drawing();
    const full = (await sdk.package(did)).bytes;
    const pkg = tampered(full, view.resources[0].versionId, (b) => (b[view.resources[3].digest] = bytes("CORRUPT")));
    const store = new MemoryStore();
    const e = (await reader(alice, store).import(pkg, { requireResources: true }).catch((x) => x)) as OriginalsError;
    expect(e.code).toBe("RESOURCE_DIGEST_MISMATCH");
    expect(e.category).toBe("invalid-evidence");
    expect(await store.get(did)).toBeUndefined();
    expect(await store.getResource(view.resources[3].digest)).toBeUndefined();
  });

  test("without requireResources, such a package imports as before (main's behaviour), its bad bytes never stored", async () => {
    const { sdk, alice, did, view } = await drawing();
    const full = (await sdk.package(did)).bytes;
    const pkg = tampered(full, view.resources[0].versionId, (b) => (b[view.resources[3].digest] = bytes("CORRUPT")));
    const store = new MemoryStore();
    const result = await reader(alice, store).import(pkg);
    expect(result.status).toBe("imported");
    expect(await store.getResource(view.resources[3].digest)).toBeUndefined();
  });
});

describe("import keeps verified bytes when its history is already held (P7.3)", () => {
  test("C12-10: re-importing the complete package after a partial one stores its bytes: already-current, now verified", async () => {
    const { sdk, alice, did, view } = await drawing();
    const store = new MemoryStore();
    const s = reader(alice, store);
    await s.import((await sdk.package(did, { omitResources: { throughVersion: 4 } })).bytes);
    expect((await s.get(did)).resources.map((r) => r.bytes)).toEqual(["missing", "missing", "missing", "missing"]);
    const retry = await s.import((await sdk.package(did)).bytes, { requireResources: true });
    expect(retry.status).toBe("already-current");
    expect(retry.original.resources.map((r) => r.bytes)).toEqual(["verified", "verified", "verified", "verified"]);
    expect(await s.resourceBytes(view.resources[3].digest)).toEqual(V[3]);
  });

  test("C12-10: an older prefix (kept-newer-local) still supplies the bytes it carries, and never under a wrong digest", async () => {
    const { sdk, alice, did, view } = await drawing();
    const store = new MemoryStore();
    const s = reader(alice, store);
    await s.import((await sdk.package(did, { omitResources: { throughVersion: 4 } })).bytes);
    const older = readEvidence((await sdk.package(did, { checkpoint: view.resources[1].versionId })).bytes);
    older.bytes[view.resources[1].digest] = bytes("CORRUPT");
    const result = await s.import(writeEvidence(older));
    expect(result.status).toBe("kept-newer-local");
    expect(result.original.resources.map((r) => r.bytes)).toEqual(["verified", "missing", "missing", "missing"]);
    expect(await store.getResource(view.resources[1].digest)).toBeUndefined();
  });
});
