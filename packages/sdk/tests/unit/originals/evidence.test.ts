import { describe, expect, test } from "bun:test";
import { OriginalsError } from "@originals/vh";
import { resourceDigest } from "@originals/vh/originals";
import { MemoryStore, OriginalsSDK, readEvidence, readManifest, readZip, signerPath, writeZip } from "../../../src/originals/index.js";
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

  test("C12-152: an evidence package built twice from the same contents is byte-identical (P14.10)", async () => {
    const { sdk, did } = await harbor();
    expect((await sdk.package(did)).bytes).toEqual((await sdk.package(did)).bytes);
  });

  test("C12-153: an archive with a compressed entry or a name over 255 bytes is rejected (P14.10)", () => {
    fails(encodeZip([raw("a", { method: 8 })]), "ARCHIVE_COMPRESSED");
    fails(encodeZip([raw("x".repeat(256))]), "ARCHIVE_PATH");
  });

  test("P14.10: the 255 name limit counts UTF-8 bytes, for the reader and the writer", () => {
    // 128 two-byte characters: 128 UTF-16 code units, 256 UTF-8 bytes.
    const wide = "é".repeat(128);
    fails(encodeZip([raw(wide)]), "ARCHIVE_PATH");
    expect(() => writeZip(new Map([[wide, bytes("x")]]))).toThrow(expect.objectContaining({ code: "ARCHIVE_PATH" }) as never);
    const fits = "é".repeat(127) + "x"; // 255 bytes
    expect([...readZip(writeZip(new Map([[fits, bytes("x")]]))).keys()]).toEqual([fits]);
  });

  test("C12-175: the order, date, UTF-8 flag and mode rules bind the writer; the reader accepts an archive that breaks them (P14.10)", () => {
    // Unsorted names, no UTF-8 flag, mode 0100755.
    const zip = encodeZip([raw("b.txt", { flags: 0, externalAttributes: (0o100755 << 16) >>> 0 }), raw("a.txt")]);
    // Another date in both headers: local header offset 12, central header offset 14.
    const view = new DataView(zip.buffer);
    const central = view.getUint32(zip.length - 22 + 16, true);
    const otherDate = (46 << 9) | (10 << 5) | 23; // 2026-10-23
    view.setUint16(12, otherDate, true);
    view.setUint16(central + 14, otherDate, true);
    expect([...readZip(zip).keys()].sort()).toEqual(["a.txt", "b.txt"]);
    // The writer still produces the deterministic form.
    const written = writeZip(readZip(zip));
    expect([...readZip(written).keys()]).toEqual(["a.txt", "b.txt"]);
    expect(new DataView(written.buffer).getUint16(12, true)).toBe((0 << 9) | (1 << 5) | 1);
  });

  test("C12-180: the reader decodes every name as UTF-8, rejecting one that is not, and rejects an entry whose mode is not a regular file (P14.10, P7.5)", () => {
    // A name byte made invalid UTF-8 in both headers.
    const zip = encodeZip([raw("a.txt")]);
    const view = new DataView(zip.buffer);
    const central = view.getUint32(zip.length - 22 + 16, true);
    zip[30] = 0xff;
    zip[central + 46] = 0xff;
    fails(zip, "ARCHIVE_PATH");
    // Invalid UTF-8 in the local header's name only: still ARCHIVE_PATH, never a raw TypeError.
    const local = encodeZip([raw("a.txt")]);
    local[30] = 0xff;
    fails(local, "ARCHIVE_PATH");
    for (const type of [0o040000, 0o010000, 0o020000, 0o060000, 0o140000]) {
      fails(encodeZip([raw("a.txt", { externalAttributes: ((type | 0o644) << 16) >>> 0 })]), "ARCHIVE_PATH");
    }
    // No Unix mode at all (a DOS attribute only, or none) is not a regular file either (owner decision on #993's review).
    for (const externalAttributes of [0, 0x10, 0x20]) fails(encodeZip([raw("a.txt", { externalAttributes })]), "ARCHIVE_PATH");
    expect([...readZip(encodeZip([raw("a.txt", { externalAttributes: (0o100600 << 16) >>> 0 })])).keys()]).toEqual(["a.txt"]);
  });

  test("P14.10: missing items have exact shapes; an identity item names its role", () => {
    const manifest = (missing: unknown[]) =>
      bytes(JSON.stringify({ format: "originals-evidence/0.1", profile: "originals:1.0", original: "did:vh:Qm", checkpoint: "1-Qm", head: "1-Qm", completeness: "partial", missing }));
    const resource = { kind: "resource", resource: "photo", version: 1, digest: resourceDigest(B1), versionId: "1-Qm" };
    const identity = { kind: "identity", did: "did:vh:QmAlice", role: "author" };
    expect(readManifest(manifest([resource, identity, { ...identity, role: "editor" }])).missing).toHaveLength(3);
    const bad: unknown[] = [
      { kind: "identity", did: "did:vh:QmAlice" }, // role is required
      { ...identity, role: "owner" },
      { ...identity, extra: true },
      { ...resource, size: 3 },
      { kind: "resource", resource: "photo", version: 1, digest: resourceDigest(B1) },
      { ...resource, version: "1" },
      { kind: "file", path: "x" },
      "identity",
    ];
    for (const item of bad) expect(() => readManifest(manifest([item])), JSON.stringify(item)).toThrow(expect.objectContaining({ code: "EVIDENCE_MANIFEST" }) as never);
  });

  test("signer DID histories are under signers/<hex sha256 of the DID>/, and no asset witness file is written or read (P14.10, P9.8)", async () => {
    const { sdk, alice, did } = await harbor();
    const files = readZip((await sdk.package(did)).bytes);
    const hex = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(alice.did)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(signerPath(alice.did)).toBe(`signers/${hex}`);
    expect(files.has(`signers/${hex}/did.jsonl`)).toBe(true);
    expect([...files.keys()].some((name) => name.startsWith("authors/") || name === "asset/did-witness.json")).toBe(false);
    // The old directory and an asset witness file are not part of the layout (no legacy reading).
    for (const extra of [[`authors/${hex}/did.jsonl`, files.get(`signers/${hex}/did.jsonl`)!], ["asset/did-witness.json", bytes("[]")]] as const) {
      const changed = new Map(files);
      if (extra[0].startsWith("signers/")) changed.delete(`signers/${hex}/did.jsonl`);
      changed.set(extra[0], extra[1]);
      expect(() => readEvidence(writeZip(changed))).toThrow(expect.objectContaining({ code: "EVIDENCE_LAYOUT" }) as never);
    }
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
