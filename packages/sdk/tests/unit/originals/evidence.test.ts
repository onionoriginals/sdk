import { describe, expect, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import { resourceDigest } from "@originals/vh/originals";
import { MemoryStore, OriginalsSDK, readEvidence, readZip, writeZip } from "../../../src/originals/index.js";
import { encodeZip } from "../../../src/originals/zip.js";
import { Author, bytes, clock, seed } from "./helpers.js";

const B1 = bytes("harbor at dawn, first crop");
const B2 = bytes("harbor at dawn, tighter crop");
const KEY = seed(21);

async function harbor(store = new MemoryStore()) {
  const alice = await Author.create([{ fragment: "orig", secret: KEY }]);
  const sdk = OriginalsSDK.create({ store, authors: [alice.evidence()], clock: clock() });
  const signer = alice.signer("orig", KEY);
  const author = alice.ref("orig");
  const c = await sdk.create({ name: "Harbor at dawn", resources: [{ id: "photo", mediaType: "image/jpeg", bytes: B1 }], author, signer });
  if (c.kind !== "original") throw new Error("expected an Original");
  const e = await sdk.edit(c.original.did, { parent: c.original.checkpoint, resources: [{ id: "photo", bytes: B2 }], author, signer });
  return { alice, store, sdk, signer, author, did: c.original.did, v1: c.original.checkpoint, v2: e.original.checkpoint };
}

const reader = (alice: Author) =>
  OriginalsSDK.create({ store: new MemoryStore(), authors: [alice.evidence()], clock: clock(Date.parse("2026-10-18T13:00:00Z")) });

describe("evidence packages (section 7)", () => {
  test("C12-01: a complete package verifies in a fresh reader with no key: same checkpoint and versions", async () => {
    const { sdk, alice, did, v2 } = await harbor();
    const pkg = await sdk.package(did);
    expect(pkg.manifest).toMatchObject({ format: "originals-evidence/0.1", profile: "originals:1.0", original: did, checkpoint: v2, head: v2, completeness: "complete", missing: [] });
    const loaded = await reader(alice).load(pkg.bytes);
    expect(loaded.report.checkpoint).toBe(v2);
    expect(loaded.report.resources.versions.map((r) => [r.version, r.bytes])).toEqual([[1, "verified"], [2, "verified"]]);
    expect(loaded.report.reasons).toEqual(["not-anchored"]);
    // The package carries its own author evidence: a reader with no author source still verifies.
    const bare = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock() });
    const alone = await bare.load(pkg.bytes);
    expect(alone.report.identityEvidence.status).toBe("complete");
    expect(alone.report.authorBinding.status).toBe("valid");
  });

  test("C12-10: missing historical bytes make an explicitly partial package", async () => {
    const { sdk, store, alice, did, v1 } = await harbor();
    store.deleteResource(resourceDigest(B1));
    const pkg = await sdk.package(did);
    expect(pkg.manifest.completeness).toBe("partial");
    expect(pkg.manifest.missing).toEqual([{ kind: "resource", resource: "photo", version: 1, digest: resourceDigest(B1), versionId: v1 }]);
    const loaded = await reader(alice).load(pkg.bytes);
    expect(loaded.report.resources.status).toBe("partial");
    expect(loaded.report.resources.versions[1].bytes).toBe("verified");
    // The package says it is partial, honestly: the log verifies; the unavailable content is
    // reported, not a failure (P7.3, P7.4, P9.18).
    expect(loaded.reasons).toEqual(["not-anchored"]);
    expect(loaded.report.validAsOf).not.toBeNull();
    expect(loaded.report.reasons).toEqual(["not-anchored"]);
  });

  test("a package of an earlier checkpoint holds that prefix and is not the latest state (P7.6)", async () => {
    const { sdk, alice, did, v1, v2 } = await harbor();
    const pkg = await sdk.package(did, { checkpoint: v1 });
    expect(pkg.manifest).toMatchObject({ checkpoint: v1, head: v2 });
    const loaded = await reader(alice).load(pkg.bytes);
    expect(loaded.report.checkpoint).toBe(v1);
    expect(loaded.report.history.entries).toBe(1);
    expect(loaded.report.current).toBe(false);
    expect(loaded.reasons).toContain("package-checkpoint-is-not-its-head");
  });

  test("a manifest that misdescribes its contents is reported", async () => {
    const { sdk, store, alice, did } = await harbor();
    store.deleteResource(resourceDigest(B1));
    const files = readZip((await sdk.package(did)).bytes);
    const manifest = JSON.parse(new TextDecoder().decode(files.get("originals-evidence.json")!)) as Record<string, unknown>;
    files.set("originals-evidence.json", bytes(JSON.stringify({ ...manifest, completeness: "complete", missing: [] })));
    const loaded = await reader(alice).load(writeZip(files));
    expect(loaded.reasons).toContain("manifest-completeness-mismatch");
    expect(loaded.report.current).toBe(false);
  });

  test("an imported Original stays readable with the author evidence it came with", async () => {
    const { sdk, did, v2 } = await harbor();
    const bare = OriginalsSDK.create({ store: new MemoryStore(), authors: [], clock: clock(Date.parse("2026-10-18T13:00:00Z")) });
    const result = await bare.import((await sdk.package(did)).bytes);
    expect(result.original.checkpoint).toBe(v2);
    expect((await bare.get(did)).report.identityEvidence.status).toBe("complete");
  });

  test("C12-77: importing an older prefix never rolls back newer local history", async () => {
    const { sdk, alice, did, v1, v2 } = await harbor();
    const older = await sdk.package(did, { checkpoint: v1 });
    const newer = await sdk.package(did);
    const local = reader(alice);
    expect((await local.import(newer.bytes)).status).toBe("imported");
    const result = await local.import(older.bytes);
    expect(result.status).toBe("kept-newer-local");
    expect((await local.get(did)).checkpoint).toBe(v2);
    expect((await local.import(newer.bytes)).status).toBe("already-current");
  });

  test("importing a diverging branch is a conflict, not a replacement (P7.5)", async () => {
    const { sdk, alice, did, v1, signer, author } = await harbor();
    const elsewhere = reader(alice);
    await elsewhere.import((await sdk.package(did, { checkpoint: v1 })).bytes);
    await elsewhere.edit(did, { parent: v1, name: "Fork", author, signer });
    const result = await elsewhere.import((await sdk.package(did)).bytes);
    expect(result.status).toBe("conflict");
    expect((await elsewhere.get(did)).state.name).toBe("Fork");
  });
});

describe("C12-83: untrusted archives are bounded and checked before extraction (P7.5)", () => {
  const raw = (name: string, extra: Partial<Parameters<typeof encodeZip>[0][number]> = {}) => ({ name, data: bytes("x"), ...extra });
  const fails = (zip: Uint8Array, code: string, limits?: Parameters<typeof readZip>[1]) => {
    let caught: unknown;
    try {
      readZip(zip, limits);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OriginalsError);
    expect((caught as OriginalsError).code).toBe(code);
  };

  test("round-trips an uncompressed archive deterministically", () => {
    const files = new Map([["b.txt", bytes("b")], ["a.txt", bytes("a")]]);
    const one = writeZip(files);
    expect(writeZip(new Map([...files].reverse()))).toEqual(one);
    expect([...readZip(one).keys()]).toEqual(["a.txt", "b.txt"]);
  });

  test("rejects traversal, absolute paths, backslashes, directories and duplicates", () => {
    for (const name of ["../x", "a/../../x", "/etc/passwd", "C:/x", "a\\b", "dir/", "a//b", "./a", "nul\u0000", ""]) {
      fails(encodeZip([raw(name)]), "ARCHIVE_PATH");
    }
    fails(encodeZip([raw("a"), raw("a")]), "ARCHIVE_DUPLICATE");
    expect(() => writeZip(new Map([["../x", bytes("x")]]))).toThrow(OriginalsError);
  });

  test("rejects symbolic links, compressed or encrypted entries and corrupted data", () => {
    fails(encodeZip([raw("link", { externalAttributes: (0o120777 << 16) >>> 0 })]), "ARCHIVE_SYMLINK");
    fails(encodeZip([raw("a", { method: 8 })]), "ARCHIVE_COMPRESSED");
    fails(encodeZip([raw("a", { flags: 1 })]), "ARCHIVE_ENCRYPTED");
    const zip = writeZip(new Map([["originals-evidence.json", bytes("{}")]]));
    zip[30 + "originals-evidence.json".length] ^= 0xff; // first data byte
    fails(zip, "ARCHIVE_CRC");
    fails(new Uint8Array([1, 2, 3]), "ARCHIVE_INVALID");
  });

  test("enforces entry count and size bounds from the central directory", () => {
    const many = new Map(Array.from({ length: 5 }, (_, i) => [`resources/r${i}`, bytes("x")] as [string, Uint8Array]));
    fails(writeZip(many), "ARCHIVE_TOO_MANY_ENTRIES", { maxEntries: 4 });
    fails(writeZip(new Map([["big", new Uint8Array(100)]])), "ARCHIVE_TOO_LARGE", { maxTotalBytes: 99 });
  });

  test("an evidence package accepts only its own layout", () => {
    const files = new Map([["originals-evidence.json", bytes("{}")], ["extra/file", bytes("x")]]);
    let caught: unknown;
    try {
      readEvidence(writeZip(files));
    } catch (error) {
      caught = error;
    }
    expect((caught as OriginalsError).code).toBe("EVIDENCE_LAYOUT");
  });
});
