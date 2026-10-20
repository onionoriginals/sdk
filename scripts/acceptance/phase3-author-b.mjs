/**
 * Phase 3 (Node, fresh process, network disabled): author client B.
 *
 * A new, empty FileStore in dir B imports the package. Importing gives no
 * signing authority (P8.4, C12-20): nothing secret is in the package or the
 * store, an unsigned draft stays a draft, and an edit without the author's
 * key fails with the store unchanged. Signing authority is then supplied
 * separately, from the custody file, through the SDK's author-key flow
 * (`keySigner` + an AuthorRef whose versionId comes from the imported
 * evidence), and editing continues from an explicit parent. The stale-parent
 * negatives (C12-12, P4.5) run here, against the moved head.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OriginalsSDK, keySigner } from "@originals/sdk/originals";
import { FileStore } from "@originals/sdk/originals/fs";
import { assert, assertEqual, describeError, filesUnder, findSecrets, fromHex, Phase, readBytes, rejection, sha256Hex, utf8 } from "./lib/phase.mjs";

const phase = new Phase("3-author-b");
const { dirs } = phase.input;
await phase.probeNetwork();

const zip = readBytes(join(dirs.artifacts, "original-A.zip"));
const expected = JSON.parse(readFileSync(join(dirs.artifacts, "expected-A.json"), "utf8"));
const store = await FileStore.open(dirs.storeB);
// Client B knows no author DID up front: the evidence comes with the package.
const sdk = OriginalsSDK.create({ store, authors: [], freshness: "asserted" });
const did = expected.original;
let imported;
let authorVersionId;

await phase.check("empty-store", "store B starts empty", async () => {
  assertEqual(await store.list(), [], "store B list");
});

await phase.check("import", "import the package into store B: same did:vh, checkpoint and history", async () => {
  const result = await sdk.import(zip);
  assertEqual([result.status, result.original.did, result.original.checkpoint], ["imported", did, expected.checkpoint], "import");
  assertEqual(result.original.report.authorBinding.status, "valid", "authorBinding");
  imported = result.original;
  authorVersionId = result.original.report.identityEvidence.latestVersionId;
  return { status: result.status, checkpoint: imported.checkpoint, authorVersionId };
});

// The custody file is read only after the import-only checks, which must pass without it.
const author = { did: expected.author, verificationMethod: `${expected.author}#key-1` };
const ref = () => ({ did: author.did, verificationMethod: author.verificationMethod, versionId: authorVersionId });

await phase.check("import-confers-no-authority", "importing alone gives no signing authority (P8.4, C12-20)", async () => {
  const head = (await store.get(did)).log;
  // 1. The SDK has nothing to sign with: an edit with no signer is refused and nothing is written.
  const noSigner = await rejection(sdk.edit(did, { parent: imported.checkpoint, name: "No key", author: ref() }), "edit without a signer");
  assertEqual([noSigner.category, noSigner.code], ["unauthorized-key", "SIGNER_REQUIRED"], "no-signer error");
  // 2. A key that is not the author's cannot stand in for it, even naming the author's method.
  const intruderKey = crypto.getRandomValues(new Uint8Array(32));
  const intruder = keySigner({ keyType: "Ed25519", secretKey: intruderKey, verificationMethod: author.verificationMethod });
  const wrongKey = await rejection(sdk.edit(did, { parent: imported.checkpoint, name: "Intruder", author: ref(), signer: intruder }), "edit with an intruder key");
  assertEqual([wrongKey.category, wrongKey.code], ["invalid-evidence", "COMMIT_VERIFICATION_FAILED"], "intruder error");
  // 3. Preparing is allowed and stays an unsigned draft (P6.3); it is not history.
  const draft = await sdk.prepareEdit(did, { parent: imported.checkpoint, name: "Draft only", author: ref() });
  assertEqual([draft.kind, draft.signed], ["draft", false], "draft");
  assertEqual((await store.get(did)).log, head, "store B log after the refused edits");
  return { noSigner: describeError(noSigner), intruder: describeError(wrongKey), draft: { kind: draft.kind, signed: draft.signed } };
});

const custody = JSON.parse(readFileSync(join(dirs.custody, "author-keys.json"), "utf8"));
const secrets = { authorship: fromHex(custody.authorship.secretKeyHex), identity: fromHex(custody.identity.secretKeyHex) };

await phase.check("no-key-exported", "no encoding of either author secret is in the package or anywhere in store B", () => {
  assertEqual(findSecrets(zip, secrets), [], "package");
  const hits = filesUnder(dirs.storeB).flatMap((f) => findSecrets(readBytes(f), secrets).map((h) => `${f}:${h}`));
  assertEqual(hits, [], "store B");
  return { packageSha256: sha256Hex(zip), storeFiles: filesUnder(dirs.storeB).length, encodingsChecked: 9 };
});

await phase.check("update-key-cannot-author", "the DID's update (identity) key cannot sign an Original entry (P5.11)", async () => {
  const signer = keySigner({ keyType: "Ed25519", secretKey: secrets.identity, verificationMethod: `${author.did}#key-0` });
  const error = await rejection(sdk.edit(did, { parent: imported.checkpoint, name: "Signed by the update key", author: { ...ref(), verificationMethod: `${author.did}#key-0` }, signer }), "edit signed by the update key");
  assertEqual((await sdk.get(did)).checkpoint, imported.checkpoint, "head after the refused edit");
  return describeError(error);
});

const signer = keySigner({ keyType: "Ed25519", secretKey: secrets.authorship, verificationMethod: custody.authorship.verificationMethod });
let continued;
const notes3 = utf8("# Harbor at dawn\n\nThird pass, from client B — framing notes. Ünïcödé ✓\n");

await phase.check("continue-editing", "with the author key supplied separately, edit from the explicit imported parent", async () => {
  const notes = imported.state.resources.find((r) => r.id === "notes.md");
  const e = await sdk.edit(did, { parent: imported.checkpoint, name: "Harbor at dawn (framed)", resources: [{ id: "notes.md", bytes: notes3, expectedDigest: notes.digest }], author: ref(), signer });
  assertEqual([e.status, e.original.did], ["committed", did], "edit");
  const ids = e.original.report.resources.versions.map((v) => v.versionId);
  assert(e.original.current, "client B's head is not current", e.original.report.reasons);
  continued = e.original;
  // Identity and history preserved: the log is A's log plus one entry.
  const log = (await store.get(did)).log.trimEnd().split("\n").map((l) => JSON.parse(l).versionId);
  assertEqual(log.slice(0, expected.versions.length), expected.versions.map((v) => v.versionId), "versionIds prefix");
  assertEqual([log.length, log[log.length - 1]], [expected.versions.length + 1, e.original.checkpoint], "new head");
  assertEqual(e.original.resources.filter((r) => r.resource === "notes.md").map((r) => r.version), [1, 2, 3], "notes.md versions");
  return { checkpoint: e.original.checkpoint, versionIds: log, resourceVersionIds: [...new Set(ids)].length };
});

await phase.check("stale-parent", "an edit against the old parent is a conflict, never a rebase (P4.5, C12-12)", async () => {
  const before = (await store.get(did)).log;
  const error = await rejection(sdk.edit(did, { parent: imported.checkpoint, name: "Edited from the old parent", author: ref(), signer }), "stale-parent edit");
  assertEqual(error.category, "stale-parent", "category");
  assertEqual((await store.get(did)).log, before, "log after the stale edit");
  return describeError(error);
});

await phase.check("stale-digest", "an edit naming a resource digest that has moved is a conflict (P4.5)", async () => {
  const before = (await store.get(did)).log;
  const old = imported.state.resources.find((r) => r.id === "notes.md").digest;
  const error = await rejection(sdk.edit(did, { parent: continued.checkpoint, resources: [{ id: "notes.md", bytes: utf8("lost update"), expectedDigest: old }], author: ref(), signer }), "stale-digest edit");
  assertEqual([error.category, error.code], ["stale-parent", "STALE_DIGEST"], "error");
  assertEqual((await store.get(did)).log, before, "log after the stale-digest edit");
  return describeError(error);
});

await phase.check("export-B", "export client B's package (complete, at its new head)", async () => {
  const pkg = await sdk.package(did);
  assertEqual([pkg.manifest.completeness, pkg.manifest.checkpoint], ["complete", continued.checkpoint], "manifest");
  assertEqual(findSecrets(pkg.bytes, secrets), [], "secrets in package B");
  writeFileSync(join(dirs.artifacts, "original-B.zip"), pkg.bytes);
  phase.facts.original = { did, checkpoint: continued.checkpoint };
  return { sha256: sha256Hex(pkg.bytes), bytes: pkg.bytes.length };
});

phase.finish();
