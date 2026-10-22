/**
 * Phase 1 (Node, fresh process, network disabled): author client A.
 *
 * A FileStore in dir A, the author's did:webvh from phase 0 and the
 * authorship key from the custody file. Create an Original with a binary
 * image, a binary blob and a text resource; revise it twice; export the
 * complete evidence package. The package and an expectations file (public
 * claims a reader checks against) go to the artifacts directory; the key never
 * leaves the custody file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { OriginalsSDK, crc32, keySigner } from "@originals/sdk/originals";
import { FileStore } from "@originals/sdk/originals/fs";
import { assert, assertEqual, describeError, filesUnder, findSecrets, fromHex, Phase, readBytes, rejection, sha256Hex, utf8 } from "./lib/phase.mjs";

const phase = new Phase("1-author-a");
const { dirs } = phase.input;
await phase.probeNetwork();

/** A real PNG: 48x48 RGB of random pixels, so the bytes do not compress away. */
function png(seedBytes) {
  const width = 48;
  const height = 48;
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) raw.set(seedBytes.subarray(y * width * 3, (y + 1) * width * 3), y * (1 + width * 3) + 1);
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(utf8(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  return Uint8Array.from(parts.flatMap((p) => [...p]));
}
const noise = () => crypto.getRandomValues(new Uint8Array(48 * 48 * 3));

const custody = JSON.parse(readFileSync(join(dirs.custody, "author-keys.json"), "utf8"));
const authorDid = JSON.parse(readFileSync(join(dirs.public, "author-did.json"), "utf8"));
const secrets = { authorship: fromHex(custody.authorship.secretKeyHex), identity: fromHex(custody.identity.secretKeyHex) };
const evidence = { did: authorDid.did, log: authorDid.log };
const author = { did: authorDid.did, verificationMethod: authorDid.assertionMethod, versionId: authorDid.versionId };
const signer = keySigner({ keyType: "Ed25519", secretKey: secrets.authorship, verificationMethod: custody.authorship.verificationMethod });
const sdk = OriginalsSDK.create({ store: await FileStore.open(dirs.storeA), authors: [{ ...evidence, obtainedAt: new Date().toISOString() }] });

const art1 = png(noise());
const art2 = png(noise());
const blob = Uint8Array.from({ length: 4096 }, (_, i) => (i * 37 + (i >> 8)) & 0xff);
const notes1 = utf8("# Harbor at dawn\n\nFirst pass — ink on paper, scanned at 600 dpi. Ünïcödé ✓\n");
const notes2 = utf8("# Harbor at dawn\n\nSecond pass — tightened the horizon; colour notes added. Ünïcödé ✓\n");

const versions = [];
const record = (view) => {
  versions.push({ versionId: view.checkpoint, name: view.state.name, resources: view.state.resources.map((r) => ({ id: r.id, mediaType: r.mediaType, size: r.size, digest: r.digest })) });
};
let did;
let head;

await phase.check("create", "create an Original with binary (image/png, octet-stream) and text resources", async () => {
  const created = await sdk.create({
    name: "Harbor at dawn",
    metadata: { medium: "ink", year: 2026 },
    resources: [
      { id: "artwork.png", mediaType: "image/png", bytes: art1 },
      { id: "scan.bin", mediaType: "application/octet-stream", bytes: blob },
      { id: "notes.md", mediaType: "text/markdown", bytes: notes1 },
    ],
    author,
    signer,
  });
  assertEqual(created.kind, "original", "create returned a draft");
  const v = created.original;
  assert(v.did.startsWith("did:vh:"), "not a did:vh", v.did);
  // An unanchored Original is never current, even for its author: it is valid as of its checkpoint (P7.10).
  assertEqual([v.current, v.validAsOf?.checkpoint, v.report.reasons], [false, v.checkpoint, ["not-anchored"]], "a fresh Original is valid as of its checkpoint");
  did = v.did;
  head = v.checkpoint;
  record(v);
  return { did, checkpoint: head, author: v.report.identityEvidence.author };
});

await phase.check("revise-text", "revise: change the text resource's bytes from an explicit parent", async () => {
  const e = await sdk.edit(did, { parent: head, resources: [{ id: "notes.md", bytes: notes2, expectedDigest: versions[0].resources[2].digest }], author, signer });
  assertEqual(e.status, "committed", "edit status");
  assertEqual(e.original.resources.filter((r) => r.resource === "notes.md").map((r) => r.version), [1, 2], "notes.md versions");
  head = e.original.checkpoint;
  record(e.original);
  return { checkpoint: head };
});

await phase.check("revise-binary", "revise: change the image bytes, the name and the metadata", async () => {
  const e = await sdk.edit(did, { parent: head, name: "Harbor at dawn (final)", metadata: { medium: "ink and wash", year: 2026 }, resources: [{ id: "artwork.png", bytes: art2 }], author, signer });
  head = e.original.checkpoint;
  record(e.original);
  assertEqual(e.original.resources.map((r) => `${r.resource}@${r.version}`), ["artwork.png@1", "scan.bin@1", "notes.md@1", "notes.md@2", "artwork.png@2"], "resource versions");
  assertEqual([e.original.current, e.original.validAsOf?.checkpoint, e.original.report.reasons], [false, head, ["not-anchored"]], "the author's head is valid as of its checkpoint");
  return { checkpoint: head };
});

await phase.check("resource-set-fixed", "adding a resource after genesis is rejected (P4.1); the head does not move", async () => {
  const error = await rejection(sdk.edit(did, { parent: head, resources: [{ id: "extra.txt", mediaType: "text/plain", bytes: utf8("extra") }], author, signer }), "adding a resource");
  assertEqual([error.category, error.code], ["invalid-evidence", "STATE_RESOURCE_SET"], "error");
  assertEqual((await sdk.get(did)).checkpoint, head, "head after the rejected add");
  return { rejected: describeError(error), removal: "EditInput has no removal operation; P4.1 fixes the resource set at genesis" };
});

await phase.check("export-package", "export the complete evidence package; no private key in it or in store A", async () => {
  const pkg = await sdk.package(did);
  assertEqual([pkg.manifest.completeness, pkg.manifest.checkpoint, pkg.manifest.head, pkg.manifest.original], ["complete", head, head, did], "manifest");
  const hits = findSecrets(pkg.bytes, secrets);
  assertEqual(hits, [], "secret encodings found in the package");
  const storeHits = filesUnder(dirs.storeA).flatMap((f) => findSecrets(readBytes(f), secrets).map((h) => `${f}:${h}`));
  assertEqual(storeHits, [], "secret encodings found in store A");
  const path = join(dirs.artifacts, "original-A.zip");
  writeFileSync(path, pkg.bytes);
  const digests = {};
  for (const [label, bytes] of Object.entries({ "artwork.png@1": art1, "artwork.png@2": art2, "scan.bin@1": blob, "notes.md@1": notes1, "notes.md@2": notes2 })) digests[label] = sha256Hex(bytes);
  const expected = { original: did, checkpoint: head, author: author.did, authorMethod: "did:webvh", versions, sha256: digests };
  writeFileSync(join(dirs.artifacts, "expected-A.json"), `${JSON.stringify(expected, null, 2)}\n`);
  phase.facts.original = { did, checkpoint: head, versionIds: versions.map((v) => v.versionId) };
  return { path, bytes: pkg.bytes.length, sha256: sha256Hex(pkg.bytes), filesScanned: filesUnder(dirs.storeA).length };
});

phase.finish();
