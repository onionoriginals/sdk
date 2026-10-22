/**
 * Phase 2 (Node, fresh process, network disabled): an offline reader.
 *
 * No store, no key, no author session. The reader receives only the evidence
 * package and the author's public claims (expected-A.json: the Original's DID,
 * checkpoint and digests). It verifies the Original, the checkpoint, every
 * historical version and every byte from the package alone, and records
 * verified, current, freshness and ordering separately (section 7).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { base58btcDecode } from "@originals/vh/crypto";
import { verifyOriginal } from "@originals/vh/originals";
import { OriginalsSDK, readEvidence } from "@originals/sdk/originals";
import { assert, assertEqual, Phase, readBytes, sha256Hex } from "./lib/phase.mjs";

const phase = new Phase("2-offline-reader");
const { dirs, forbiddenPaths } = phase.input;
await phase.probeNetwork();

await phase.check("no-authority", "the reader has no key, store or author session", async () => {
  assert(!("custody" in dirs) && !("storeA" in dirs), "the reader was given a custody or store directory", dirs);
  const keyVars = Object.keys(process.env).filter((k) => /KEY|SECRET|TOKEN|TURNKEY|SESSION/i.test(k));
  assertEqual(keyVars, [], "key-like environment variables");
  const reads = {};
  for (const path of forbiddenPaths) {
    try {
      readFileSync(path);
      reads[path] = "READABLE";
    } catch (error) {
      reads[path] = error.code;
    }
  }
  assert(Object.values(reads).every((c) => c === "EACCES" || c === "EPERM" || c === "EISDIR"), "the author's custody or store is readable from the reader", reads);
  return reads;
});

const zip = readBytes(join(dirs.artifacts, "original-A.zip"));
const expected = JSON.parse(readFileSync(join(dirs.artifacts, "expected-A.json"), "utf8"));
phase.facts.package = { sha256: sha256Hex(zip), bytes: zip.length };
const reader = OriginalsSDK.create({ authors: [] }); // default in-memory store, discarded on exit
const { manifest, report, reasons } = await reader.load(zip);
const contents = readEvidence(zip);

await phase.check("same-original", "the package names and proves the same Original", () => {
  assertEqual([report.original, manifest.original], [expected.original, expected.original], "original");
  return { original: report.original };
});
await phase.check("checkpoint", "the verified checkpoint is the author's head", () => {
  assertEqual([report.checkpoint, report.head, manifest.checkpoint, manifest.head], Array(4).fill(expected.checkpoint), "checkpoint/head");
  return { checkpoint: report.checkpoint };
});
await phase.check("history", "history: valid through every entry", () => {
  assertEqual([report.history.status, report.history.entries], ["valid", expected.versions.length], "history");
  return report.history;
});
await phase.check("author-binding", "author binding: every entry signed by an assertionMethod key of the did:webvh author (P5.3)", () => {
  assertEqual(report.authorBinding.status, "valid", "authorBinding");
  assertEqual([report.identityEvidence.status, report.identityEvidence.author], ["complete", expected.author], "identity evidence");
  assert(expected.author.startsWith("did:webvh:"), "the author is not a did:webvh");
  return { authorBinding: report.authorBinding.status, identityEvidence: report.identityEvidence };
});
await phase.check("resources", "every resource version's bytes are present and verified", () => {
  assertEqual(report.resources.status, "available", "resources.status");
  assert(report.resources.versions.every((v) => v.bytes === "verified"), "a version is not verified", report.resources.versions);
  assertEqual(report.resources.versions.length, 5, "resource versions");
  return report.resources.versions.map((v) => `${v.resource}@${v.version}:${v.bytes}`);
});
await phase.check("byte-digests", "independently: each packaged byte string hashes to its SHA-256 multihash digest and the author's claim", () => {
  const out = {};
  for (const v of report.resources.versions) {
    const bytes = contents.bytes[v.digest];
    assert(bytes, `no bytes for ${v.resource}@${v.version}`);
    const multihash = base58btcDecode(v.digest.slice(1));
    assert(v.digest.startsWith("z") && multihash[0] === 0x12 && multihash[1] === 0x20, "digest is not a base58btc sha2-256 multihash", v.digest);
    const hex = sha256Hex(bytes);
    assertEqual(Buffer.from(multihash.subarray(2)).toString("hex"), hex, `${v.resource}@${v.version} digest`);
    assertEqual(hex, expected.sha256[`${v.resource}@${v.version}`], `${v.resource}@${v.version} vs the author's claim`);
    out[`${v.resource}@${v.version}`] = hex;
  }
  return out;
});
await phase.check("historical-versions", "every historical checkpoint verifies from the package alone, with its own state", async () => {
  const out = [];
  for (const [i, want] of expected.versions.entries()) {
    const r = await verifyOriginal({ log: contents.log, authors: contents.authors, bytes: contents.bytes, checkpoint: want.versionId, now: Date.now() });
    assertEqual([r.history.status, r.authorBinding.status, r.identityEvidence.status, r.checkpoint], ["valid", "valid", "complete", want.versionId], `version ${i + 1}`);
    assertEqual(r.state.name, want.name, `version ${i + 1} name`);
    assertEqual(r.state.resources.map((x) => [x.id, x.digest]), want.resources.map((x) => [x.id, x.digest]), `version ${i + 1} resources`);
    out.push({ versionId: want.versionId, name: r.state.name, resources: r.state.resources.length });
  }
  return out;
});
await phase.check("verified-vs-current", "verified is true; an unanchored Original is valid as of its checkpoint, never current (P7.6, P7.10)", () => {
  const verified = report.history.status === "valid" && report.authorBinding.status === "valid" && report.identityEvidence.status === "complete" && report.resources.status === "available" && report.checkpoint === manifest.checkpoint && report.fork === null;
  assert(verified, "the package does not verify");
  // Off Bitcoin nothing shows this is the latest state (P7.10): not current, and says why.
  assertEqual([report.current, report.assetFreshness.status, report.identityEvidence.freshness, report.ordering, report.fork], [false, "not-established", "not-established", "claimed", null], "current/freshness/ordering/fork");
  assertEqual(reasons, ["not-anchored"], "the only reason is that it is not anchored");
  // Valid as of its checkpoint, with the author DID version relied on and when this reader obtained it (C12-145).
  const signer = report.validAsOf?.signers?.[0];
  assertEqual([report.validAsOf?.checkpoint, signer?.did, signer?.role, signer?.versionId, signer?.source], [manifest.checkpoint, expected.author, "author", report.identityEvidence.latestVersionId, "package"], "validAsOf");
  assert(typeof signer?.obtainedAt === "string", "no obtainedAt", signer);
  assertEqual(report.historicallyAuthorizedOnly, [], "historically authorized only");
  phase.facts.result = { verified, current: report.current, validAsOf: report.validAsOf, assetFreshness: report.assetFreshness.status, identityFreshness: report.identityEvidence.freshness, ordering: report.ordering, fork: report.fork, reasons };
  return phase.facts.result;
});
await phase.check("no-freshness-policy", "no freshness policy makes an unanchored Original current: the option and the CLI flag are gone (P7.10)", async () => {
  const again = await OriginalsSDK.create({ authors: [], freshness: "asserted" }).load(zip);
  assertEqual([again.report.current, again.report.assetFreshness.status, again.report.checkpoint, again.report.history.status], [false, "not-established", expected.checkpoint, "valid"], "an unknown freshness option changes nothing");
  const cli = join(dirname(fileURLToPath(import.meta.resolve("@originals/sdk/originals"))), "cli.js");
  const run = spawnSync(process.execPath, [...process.execArgv, cli, "verify", join(dirs.artifacts, "original-A.zip"), "--freshness", "asserted"], { encoding: "utf8", env: process.env, timeout: 60_000 });
  assertEqual(run.status, 2, "`--freshness asserted` is a usage error");
  return { current: again.report.current, cliExit: run.status };
});
await phase.check("cli", "the `originals verify --json` CLI agrees, offline", () => {
  const cli = join(dirname(fileURLToPath(import.meta.resolve("@originals/sdk/originals"))), "cli.js");
  const run = spawnSync(process.execPath, [...process.execArgv, cli, "verify", join(dirs.artifacts, "original-A.zip"), "--json"], { encoding: "utf8", env: process.env, timeout: 60_000 });
  assertEqual(run.status, 0, `cli exit (stderr: ${run.stderr})`);
  const out = JSON.parse(run.stdout);
  assertEqual([out.verified, out.checkpoint, out.current, out.validAsOf?.checkpoint], [true, expected.checkpoint, false, expected.checkpoint], "cli verified/checkpoint/current/validAsOf");
  return { exit: run.status, verified: out.verified, current: out.current };
});

phase.finish();
