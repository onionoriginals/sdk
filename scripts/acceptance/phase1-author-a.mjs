/**
 * Phase 1 (Node, fresh process, network disabled): author client A.
 *
 * A FileStore in dir A, the author's did:webvh from phase 0 and the
 * authorship key from the custody file. Create an Original from its one
 * resource, a PNG image (P4.1; owner decision, 1 November 2026,
 * originals-spec #53); revise it twice, so it has versions 1 to 3 and the
 * earlier ones stay verifiable (P4.4, P8.3); show that the same bytes leave
 * the version where it is; show that a second resource, a removal and an
 * ungranted editor's new version are refused before signing (P4.1, P5.16);
 * export the complete evidence package. The package and an expectations file
 * (public claims a reader checks against) go to the artifacts directory; the
 * key never leaves the custody file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OriginalsSDK, keySigner } from "@originals/sdk/originals";
import { FileStore } from "@originals/sdk/originals/fs";
import { assert, assertEqual, describeError, filesUnder, findSecrets, fromHex, Phase, readBytes, rejection, sha256Hex } from "./lib/phase.mjs";
import { png } from "./lib/png.mjs";

const phase = new Phase("1-author-a");
const { dirs } = phase.input;
await phase.probeNetwork();

const custody = JSON.parse(readFileSync(join(dirs.custody, "author-keys.json"), "utf8"));
const authorDid = JSON.parse(readFileSync(join(dirs.public, "author-did.json"), "utf8"));
const secrets = { authorship: fromHex(custody.authorship.secretKeyHex), identity: fromHex(custody.identity.secretKeyHex) };
const evidence = { did: authorDid.did, log: authorDid.log };
const author = { did: authorDid.did, verificationMethod: authorDid.assertionMethod, versionId: authorDid.versionId };
const signer = keySigner({ keyType: "Ed25519", secretKey: secrets.authorship, verificationMethod: custody.authorship.verificationMethod });
const sdk = OriginalsSDK.create({ store: await FileStore.open(dirs.storeA), authors: [{ ...evidence, obtainedAt: new Date().toISOString() }] });

const art = [png(), png(), png()];

const versions = [];
const record = (view) => {
  const r = view.state.resource;
  versions.push({ versionId: view.checkpoint, name: view.state.name, resource: { mediaType: r.mediaType, size: r.size, digest: r.digest } });
};
const versionsOf = (view) => view.resources.map((v) => v.version);
let did;
let head;

await phase.check("create", "create an Original from its one resource, an image/png (P4.1)", async () => {
  const created = await sdk.create({
    name: "Harbor at dawn",
    metadata: { medium: "ink", year: 2026 },
    resource: { mediaType: "image/png", bytes: art[0] },
    author,
    signer,
  });
  assertEqual(created.kind, "original", "create returned a draft");
  const v = created.original;
  assert(v.did.startsWith("did:vh:"), "not a did:vh", v.did);
  assertEqual(versionsOf(v), [1], "resource versions");
  // An unanchored Original is never current, even for its author: it is valid as of its checkpoint (P7.10).
  assertEqual([v.current, v.validAsOf?.checkpoint, v.report.reasons], [false, v.checkpoint, ["not-anchored"]], "a fresh Original is valid as of its checkpoint");
  did = v.did;
  head = v.checkpoint;
  record(v);
  return { did, checkpoint: head, author: v.report.identityEvidence.author };
});

await phase.check("revise", "revise: the resource's next version, from an explicit parent and the digest edited from (P4.4, P4.5)", async () => {
  const e = await sdk.edit(did, { parent: head, resource: { bytes: art[1], expectedDigest: versions[0].resource.digest }, author, signer });
  assertEqual(e.status, "committed", "edit status");
  assertEqual(versionsOf(e.original), [1, 2], "resource versions");
  head = e.original.checkpoint;
  record(e.original);
  return { checkpoint: head };
});

await phase.check("revise-again", "revise again: version 3, with a new name and metadata; versions 1 and 2 stay verified (P8.3)", async () => {
  const e = await sdk.edit(did, { parent: head, name: "Harbor at dawn (final)", metadata: { medium: "ink and wash", year: 2026 }, resource: { bytes: art[2] }, author, signer });
  head = e.original.checkpoint;
  record(e.original);
  assertEqual(e.original.resources.map((r) => [r.version, r.bytes]), [[1, "verified"], [2, "verified"], [3, "verified"]], "resource versions");
  assertEqual([e.original.current, e.original.validAsOf?.checkpoint, e.original.report.reasons], [false, head, ["not-anchored"]], "the author's head is valid as of its checkpoint");
  return { checkpoint: head };
});

await phase.check("unchanged-bytes", "the same bytes again leave the version at 3, with no transition (P4.4, P14.4)", async () => {
  const e = await sdk.edit(did, { parent: head, metadata: { medium: "ink and wash", year: 2026, framed: false }, resource: { bytes: art[2] }, author, signer });
  assertEqual(e.status, "committed", "edit status");
  assertEqual(versionsOf(e.original), [1, 2, 3], "resource versions");
  const line = (await sdk.committedLog(did)).trimEnd().split("\n").at(-1);
  assertEqual(JSON.parse(line).state.transitions, [], "transitions of the metadata-only entry");
  head = e.original.checkpoint;
  record(e.original);
  return { checkpoint: head };
});

await phase.check("resource-refusals", "refused before signing: a second resource or a removal (P4.1), and an editor's new version without the resource grant (P5.16); the head moves only for the author's grant", async () => {
  let asked = 0;
  const counting = { ...signer, sign: (request) => (asked++, signer.sign(request)) };
  const second = await rejection(sdk.edit(did, { parent: head, resources: [{ id: "extra.txt", mediaType: "text/plain", bytes: png() }], author, signer: counting }), "a second resource");
  assertEqual([second.category, second.code], ["invalid-evidence", "INPUT_INVALID"], "second resource");
  const removed = await rejection(sdk.edit(did, { parent: head, remove: ["artwork.png"], author, signer: counting }), "removing the resource");
  assertEqual([removed.category, removed.code], ["invalid-evidence", "INPUT_INVALID"], "removal");
  assertEqual(asked, 0, "the signer was asked to sign");
  // The author grants an editor the name and the metadata, not the resource (P5.15).
  const editorDid = "did:vh:QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ";
  const granted = await sdk.edit(did, { parent: head, editors: [{ did: editorDid, name: true, metadata: true, resource: false }], author, signer });
  assertEqual(granted.status, "committed", "grant status");
  head = granted.original.checkpoint;
  record(granted.original);
  const editor = { did: editorDid, verificationMethod: `${editorDid}#edit`, versionId: "1-QmfGEUAcMpzo25kF2Rhn8L5FAXysfGnkzjwdKoNPi615XQ" };
  const before = asked;
  const outside = await rejection(sdk.edit(did, { parent: head, resource: { bytes: png() }, editor, signer: counting }), "an editor's new version without the grant");
  assertEqual([outside.category, outside.code], ["outside-grant", "EDITOR_OUTSIDE_GRANT"], "editor outside its grant");
  assertEqual(asked, before, "the signer was asked to sign");
  assertEqual((await sdk.get(did)).checkpoint, head, "head after the refusals");
  return { secondResource: describeError(second), removal: describeError(removed), editorOutsideGrant: describeError(outside) };
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
  art.forEach((bytes, i) => (digests[`v${i + 1}`] = sha256Hex(bytes)));
  const expected = { original: did, checkpoint: head, author: author.did, authorMethod: "did:webvh", versions, sha256: digests };
  writeFileSync(join(dirs.artifacts, "expected-A.json"), `${JSON.stringify(expected, null, 2)}\n`);
  phase.facts.original = { did, checkpoint: head, versionIds: versions.map((v) => v.versionId) };
  return { path, bytes: pkg.bytes.length, sha256: sha256Hex(pkg.bytes), filesScanned: filesUnder(dirs.storeA).length };
});

phase.finish();
