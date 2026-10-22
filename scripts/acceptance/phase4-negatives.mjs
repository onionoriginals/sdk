/**
 * Phase 4 (Node, fresh process, network disabled): the negative cases.
 *
 * Each case uses its own new store under dir C, so results never leak
 * between cases. Every assertion names which part of the report it is about:
 * history validity, author binding (authorization), freshness, resource
 * availability or the fork. None of them is folded into another.
 *
 * - Missing bytes (C12-10): a historical resource is lost; history stays
 *   valid and availability is explicitly partial.
 * - Stale prefix (C12-22): an older package is valid history but not current.
 * - Divergent history (C12-23, P6.6, owner decision Q5): a branch signed from
 *   an earlier checkpoint, later in time and longer than client B's, is an
 *   unresolved fork in either import order; no branch is current or chosen.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OriginalsSDK, keySigner, readZip, writeZip } from "@originals/sdk/originals";
import { FileStore } from "@originals/sdk/originals/fs";
import { assert, assertEqual, findSecrets, fromHex, Phase, readBytes, sha256Hex, utf8 } from "./lib/phase.mjs";

const phase = new Phase("4-negatives");
const { dirs } = phase.input;
await phase.probeNetwork();

const pkgA = readBytes(join(dirs.artifacts, "original-A.zip"));
const pkgB = readBytes(join(dirs.artifacts, "original-B.zip"));
const expected = JSON.parse(readFileSync(join(dirs.artifacts, "expected-A.json"), "utf8"));
const did = expected.original;
const v1 = expected.versions[0];
const lostDigest = v1.resources.find((r) => r.id === "artwork.png").digest;
const store = async (name) => FileStore.open(join(dirs.storeC, name));
const reader = (s) => OriginalsSDK.create({ ...(s ? { store: s } : {}), authors: [] });
const parts = (r) => ({ history: r.history.status, authorBinding: r.authorBinding.status, identity: r.identityEvidence.status, resources: r.resources.status, assetFreshness: r.assetFreshness.status, fork: r.fork ? { version: r.fork.version, branches: r.fork.branches.map((b) => b.versionId) } : null, validAsOf: r.validAsOf?.checkpoint ?? null, current: r.current });

await phase.check("missing-bytes-store", "a store that lost a historical resource packages it as explicitly partial; history stays valid (C12-10)", async () => {
  const s = await store("missing");
  const sdk = reader(s);
  await sdk.import(pkgA);
  // Simulated storage loss: the content-addressed file is removed from disk. There is no API to drop bytes.
  rmSync(join(dirs.storeC, "missing", "resources", lostDigest));
  const view = await sdk.get(did);
  assertEqual([view.report.history.status, view.report.authorBinding.status, view.report.identityEvidence.status], ["valid", "valid", "complete"], "history/binding/identity");
  assertEqual(view.report.resources.status, "partial", "resources");
  assertEqual(view.report.resources.missing.map((m) => m.digest), [lostDigest], "missing");
  // P7.3, P7.4: missing bytes are unavailable content, never a verification failure: the result is
  // still valid as of its checkpoint (P7.10), and no resource reason is given.
  assertEqual([view.current, view.validAsOf?.checkpoint, view.report.reasons], [false, expected.checkpoint, ["not-anchored"]], "valid as of its checkpoint with missing bytes (content availability is reported separately)");
  const pkg = await sdk.package(did);
  assertEqual([pkg.manifest.completeness, pkg.manifest.missing], ["partial", [{ kind: "resource", resource: "artwork.png", version: 1, digest: lostDigest, versionId: v1.versionId }]], "manifest");
  writeFileSync(join(dirs.artifacts, "original-A-partial.zip"), pkg.bytes);
  const loaded = await reader().load(pkg.bytes);
  const r = loaded.report;
  assertEqual([r.history.status, r.authorBinding.status, r.identityEvidence.status, r.resources.status, r.checkpoint], ["valid", "valid", "complete", "partial", expected.checkpoint], "fresh reader");
  assert(r.resources.versions.filter((v) => v.digest !== lostDigest).every((v) => v.bytes === "verified"), "a supplied version is not verified");
  assertEqual(loaded.reasons.includes("manifest-completeness-mismatch"), false, "an honest partial manifest is reported as mismatched");
  assertEqual(r.current, false, "current");
  return { store: parts(view.report), reader: parts(r), reasons: loaded.reasons };
});

await phase.check("missing-bytes-archive", "a package stripped of a resource but still claiming complete is partial and flagged", async () => {
  const files = readZip(pkgA);
  assert(files.delete(`resources/${lostDigest}`), "the package had no such resource entry");
  const loaded = await reader().load(writeZip(files));
  assertEqual([loaded.report.history.status, loaded.report.authorBinding.status, loaded.report.resources.status, loaded.report.current], ["valid", "valid", "partial", false], "report");
  assert(loaded.reasons.includes("manifest-completeness-mismatch"), "the false completeness claim is not reported", loaded.reasons);
  return { reader: parts(loaded.report), reasons: loaded.reasons };
});

await phase.check("stale-prefix", "an older, valid package is stale for a reader that has seen the newer head (C12-22)", async () => {
  const sdk = reader(await store("stale"));
  assertEqual((await sdk.import(pkgB)).status, "imported", "import B");
  const loaded = await sdk.load(pkgA);
  const r = loaded.report;
  assertEqual([r.history.status, r.authorBinding.status, r.resources.status, r.fork], ["valid", "valid", "available", null], "history/binding/resources/fork");
  // Valid as of its own, older checkpoint; never current (C12-22, P7.10).
  assertEqual([r.assetFreshness.status, r.current, r.validAsOf?.checkpoint], ["stale", false, expected.checkpoint], "freshness/current/validAsOf");
  assert(loaded.reasons.includes("asset-log-older-than-retained"), "no stale reason", loaded.reasons);
  assertEqual((await sdk.import(pkgA)).status, "kept-newer-local", "importing the prefix (C12-77)");
  return { reader: parts(r), reasons: loaded.reasons };
});

const custody = JSON.parse(readFileSync(join(dirs.custody, "author-keys.json"), "utf8"));
const signer = keySigner({ keyType: "Ed25519", secretKey: fromHex(custody.authorship.secretKeyHex), verificationMethod: custody.authorship.verificationMethod });
let branchX;
const checkpointB = JSON.parse(new TextDecoder().decode(readZip(pkgB).get("originals-evidence.json"))).checkpoint;

await phase.check("divergent-local", "client C, signing from an earlier checkpoint, then imports client B's history: an unresolved fork (C12-23)", async () => {
  const sdk = reader(await store("fork-local"));
  await sdk.import(pkgA);
  const imported = await sdk.get(did);
  const ref = { did: expected.author, verificationMethod: custody.authorship.verificationMethod, versionId: imported.report.identityEvidence.latestVersionId };
  // Branch X is later in time and longer than client B's branch: neither may decide anything.
  const x1 = await sdk.edit(did, { parent: expected.checkpoint, name: "Harbor at dawn (client C)", author: ref, signer });
  const x2 = await sdk.edit(did, { parent: x1.original.checkpoint, resources: [{ id: "notes.md", bytes: utf8("client C notes") }], author: ref, signer });
  assertEqual([x2.original.validAsOf?.checkpoint, x2.original.report.reasons], [x2.original.checkpoint, ["not-anchored"]], "client C's own branch is valid as of its head before the fork is known");
  const pkgX = await sdk.package(did);
  assertEqual(findSecrets(pkgX.bytes, { authorship: fromHex(custody.authorship.secretKeyHex) }), [], "secrets in package X");
  writeFileSync(join(dirs.artifacts, "original-X.zip"), pkgX.bytes);
  branchX = { first: x1.original.checkpoint, head: x2.original.checkpoint, bytes: pkgX.bytes };

  const result = await sdk.import(pkgB);
  assertEqual(result.status, "conflict", "import of B");
  const view = await sdk.get(did);
  const r = view.report;
  assertEqual([r.history.status, r.authorBinding.status, r.identityEvidence.status, r.resources.status], ["valid", "valid", "complete", "available"], "each branch stays valid history with valid binding");
  assertEqual([r.fork?.version, r.fork?.branches.map((b) => b.versionId).sort()], [expected.versions.length + 1, [branchX.first, checkpointB].sort()], "fork");
  assertEqual([view.current, view.validAsOf], [false, null], "current/validAsOf: a forked Original is valid as of no checkpoint");
  assert(r.reasons.includes("fork-unresolved"), "no fork reason", r.reasons);
  assertEqual(view.checkpoint, branchX.head, "the local branch is kept, not replaced");
  // An edit still continues on the local branch and is still not current (P6.6).
  const more = await sdk.edit(did, { parent: view.checkpoint, name: "Still client C", author: ref, signer });
  assertEqual([more.status, more.original.current, more.original.report.fork?.version], ["committed", false, expected.versions.length + 1], "edit after the fork");
  return { store: parts(r), reasons: r.reasons, afterEdit: { current: more.original.current } };
});

await phase.check("divergent-reader", "a reader importing both branches, in the other order, also reports the fork with no winner", async () => {
  const sdk = reader(await store("fork-reader"));
  assertEqual((await sdk.import(pkgB)).status, "imported", "import B");
  const result = await sdk.import(branchX.bytes);
  assertEqual(result.status, "conflict", "import of X");
  const r = (await sdk.get(did)).report;
  assertEqual([r.history.status, r.authorBinding.status], ["valid", "valid"], "history/binding");
  assertEqual(r.fork?.branches.map((b) => b.versionId).sort(), [branchX.first, checkpointB].sort(), "fork branches");
  assertEqual([r.current, r.ordering], [false, "claimed"], "current/ordering");
  // Loading either branch alone against this store is not current either.
  const loadB = (await sdk.load(pkgB)).report;
  const loadX = (await sdk.load(branchX.bytes)).report;
  assertEqual([loadB.current, loadX.current, loadB.fork !== null, loadX.fork !== null], [false, false, true, true], "each branch loaded alone");
  return { store: parts(r), loadB: parts(loadB), loadX: parts(loadX) };
});

await phase.check("artifact-digests", "record the negative-case artifacts", () => ({
  "original-A-partial.zip": sha256Hex(readBytes(join(dirs.artifacts, "original-A-partial.zip"))),
  "original-X.zip": sha256Hex(branchX.bytes),
}));

phase.facts.cases = phase.checks.map((c) => `${c.id}:${c.status}`);
phase.finish();
