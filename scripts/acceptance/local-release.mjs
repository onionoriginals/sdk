#!/usr/bin/env node
/**
 * Local release acceptance for the Originals Protocol (issue #976, section A).
 *
 * Runs each phase as a separate, fresh OS process with its own HOME, TMPDIR,
 * working directory and store, under an OS-level network denial where the
 * platform has one (macOS sandbox-exec; Linux unshare -rn) plus an in-process
 * guard. Phases use only the built public entry points (`@originals/sdk/originals`,
 * `@originals/sdk/originals/fs`, `@originals/vh/*`), except phase 0, which
 * runs the landing's did:webvh builder from its source under Bun.
 *
 *   node scripts/acceptance/local-release.mjs [--out <dir>] [--receipt <file>] [--require-os-sandbox]
 *
 * Writes a JSON receipt (default <out>/receipt.json), prints it, and exits 1
 * if any check fails. Run `bun run build` first (`bun run acceptance:local`
 * does both).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(join(here, "..", ".."));
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const out = realpathSync(flag("--out") ? (mkdirSync(flag("--out"), { recursive: true }), flag("--out")) : mkdtempSync(join(tmpdir(), "originals-acceptance-")));
const receiptPath = flag("--receipt") ?? join(out, "receipt.json");

const sh = (cmd, cmdArgs, opts = {}) => spawnSync(cmd, cmdArgs, { encoding: "utf8", cwd: root, ...opts });
const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const version = (pkg) => JSON.parse(readFileSync(join(root, pkg, "package.json"), "utf8")).version;
const which = (cmd) => sh("sh", ["-c", `command -v ${cmd}`]).stdout.trim() || null;

// ------------------------------------------------------------- preflight
const preflight = [];
const pre = (id, title, ok, detail) => preflight.push({ id, title, status: ok ? "PASS" : "FAIL", detail });

const sha = sh("git", ["rev-parse", "HEAD"]).stdout.trim();
const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
const dirty = sh("git", ["status", "--porcelain"]).stdout.trim().split("\n").filter(Boolean);
// The #964 repair, judged by the source, not by a commit: a CI checkout (shallow, or without
// PR #964's own commit) must pass it too. `didKeyMultikey` takes `fragment: "optional"`, and the
// log engine verifies entry proofs with it, so a bare did:key update-key proof verifies.
const repair964 = "47bc12494f46a21348f22d9e1bc78210a28ed8b2";
const source = (path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : "");
const cryptoSource = source("packages/vh/src/crypto/index.ts");
const logSource = source("packages/vh/src/log/index.ts");
const repairFacts = {
  didKeyMultikeyOptionalFragment: /export function didKeyMultikey\([^)]*fragment\?:\s*"required"\s*\|\s*"optional"/.test(cryptoSource) && /fragment === "optional"/.test(cryptoSource),
  entryProofsUseOptionalFragment: /didKeyMultikey\(proof\.verificationMethod,\s*\{\s*fragment:\s*"optional"\s*\}\)/.test(logSource),
};
const has964 = Object.values(repairFacts).every(Boolean);
// An extra fact only, when the commit object is here: restacking gives the change a new SHA, so
// match it by patch id (`git cherry` marks a commit "-" when HEAD already holds an equivalent change).
const commitAvailable = sh("git", ["cat-file", "-e", `${repair964}^{commit}`]).status === 0;
const commitFact = !commitAvailable
  ? "commit object unavailable"
  : sh("git", ["merge-base", "--is-ancestor", repair964, "HEAD"]).status === 0
    ? "ancestor"
    : /^- /m.test(sh("git", ["cherry", "HEAD", repair964]).stdout) ? "equivalent patch present" : "no equivalent patch";
const regressionTitle = "the DID log the landing builds, and an Original signed with its #key-1, verify as current";
const regressionPresent = readFileSync(join(root, "apps/landing/src/auth/webvh.test.ts"), "utf8").includes(regressionTitle);
pre("964-integrated", "the #964 did:key proof repair is in this revision's source", has964, { ...repairFacts, commit: repair964, commitFact });
// The real Bun binary, not a version-manager shim (a shim may try the network under a clean HOME).
const bunShim = which("bun");
const bun = bunShim ? sh(bunShim, ["-e", "console.log(process.execPath)"]).stdout.trim() || bunShim : null;
const regression = sh(bun ?? "bun", ["test", "src/auth/webvh.test.ts", "-t", "signed-in author DID"], { cwd: join(root, "apps/landing") });
const passCount = Number((`${regression.stdout}${regression.stderr}`.match(/(\d+) pass/) ?? [])[1] ?? 0);
pre("964-regression", "the landing's real DID-builder regression (#964) is present and passes", regressionPresent && regression.status === 0 && passCount >= 1, { file: "apps/landing/src/auth/webvh.test.ts", test: regressionTitle, pass: passCount, exit: regression.status });
const dists = ["packages/sdk/dist/originals/index.js", "packages/sdk/dist/originals/fs-store.js", "packages/sdk/dist/originals/cli.js", "packages/vh/dist/originals/index.js", "packages/sdk/dist/index.js"];
const missingDist = dists.filter((d) => !existsSync(join(root, d)));
pre("built", "built package entry points exist (run `bun run build`)", missingDist.length === 0, { missing: missingDist, sha256: Object.fromEntries(dists.filter((d) => existsSync(join(root, d))).map((d) => [d, sha256File(join(root, d))])) });

// OS-level network denial.
let osNetworkBlock = "none";
if (process.platform === "darwin" && which("sandbox-exec")) osNetworkBlock = "sandbox-exec";
else if (process.platform === "linux" && which("unshare") && sh("unshare", ["-rn", "true"]).status === 0) osNetworkBlock = "unshare-net";
if (args.includes("--require-os-sandbox")) pre("os-sandbox", "an OS-level network denial is available", osNetworkBlock !== "none", { osNetworkBlock });

// ------------------------------------------------------------- directories
const dirs = Object.fromEntries(["custody", "public", "artifacts", "storeA", "storeB", "storeC"].map((d) => [d, join(out, d)]));
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

const guard = join(here, "lib", "guard.mjs");
const phases = [
  { name: "0-author-identity", script: "phase0-author-identity.ts", runtime: "bun", dirs: ["custody", "public"] },
  { name: "1-author-a", script: "phase1-author-a.mjs", runtime: "node", dirs: ["custody", "public", "artifacts", "storeA"] },
  { name: "2-offline-reader", script: "phase2-offline-reader.mjs", runtime: "node", dirs: ["artifacts"], deny: ["custody", "storeA", "storeB"] },
  { name: "3-author-b", script: "phase3-author-b.mjs", runtime: "node", dirs: ["custody", "artifacts", "storeB"] },
  { name: "4-negatives", script: "phase4-negatives.mjs", runtime: "node", dirs: ["custody", "artifacts", "storeC"] },
];

function command(phase) {
  const script = join(here, phase.script);
  const inner = phase.runtime === "bun" ? [bun ?? "bun", "--preload", guard, script] : [process.execPath, "--import", pathToFileURL(guard).href, script];
  if (osNetworkBlock === "sandbox-exec") {
    const denyReads = (phase.deny ?? []).map((d) => `(subpath "${dirs[d]}")`).join(" ");
    const profile = `(version 1)(allow default)(deny network*)${denyReads ? `(deny file-read* ${denyReads})` : ""}`;
    return ["sandbox-exec", "-p", profile, ...inner];
  }
  if (osNetworkBlock === "unshare-net") return ["unshare", "-rn", ...inner];
  return inner;
}

const results = [];
const blocked = preflight.some((p) => p.status === "FAIL" && p.id !== "964-regression");
for (const phase of blocked ? [] : phases) {
  const home = join(out, "home", phase.name);
  const tmp = join(out, "tmp", phase.name);
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const resultFile = join(out, "results", `${phase.name}.json`);
  mkdirSync(dirname(resultFile), { recursive: true });
  const input = {
    dirs: Object.fromEntries(phase.dirs.map((d) => [d, dirs[d]])),
    osNetworkBlock,
    probeNode: process.execPath,
    forbiddenPaths: (phase.deny ?? []).flatMap((d) => [dirs[d], ...(d === "custody" ? [join(dirs.custody, "author-keys.json")] : [])]),
  };
  // A clean environment: nothing inherited but PATH.
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: tmp, LANG: "C.UTF-8", ACCEPTANCE_INPUT: JSON.stringify(input), ACCEPTANCE_RESULT: resultFile };
  // Portable second layer for the reader: the author's custody and stores are unreadable while it runs.
  const locked = (phase.deny ?? []).map((d) => [dirs[d], statSync(dirs[d]).mode & 0o777]);
  for (const [d] of locked) chmodSync(d, 0o000);
  const [cmd, ...cmdArgs] = command(phase);
  const started = Date.now();
  const run = spawnSync(cmd, cmdArgs, { cwd: tmp, env, encoding: "utf8", timeout: 300_000 });
  for (const [d, mode] of locked) chmodSync(d, mode);
  const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : { phase: phase.name, status: "FAIL", checks: [{ id: "result", title: "the phase wrote a result", status: "FAIL" }] };
  result.process = { command: [cmd, ...cmdArgs.map((a) => (a.startsWith("(version") ? "<sandbox profile>" : a))].map((a) => (a.startsWith(root) ? relative(root, a) || "." : a)), sandboxProfile: cmd === "sandbox-exec" ? cmdArgs[1] : undefined, exit: run.status, signal: run.signal, ms: Date.now() - started };
  if (run.status !== 0 || result.status !== "PASS") result.process.output = `${run.stdout}\n${run.stderr}`.trim().split("\n").slice(-40);
  results.push(result);
  process.stderr.write(`phase ${phase.name}: ${result.status} (${result.checks.filter((c) => c.status === "PASS").length}/${result.checks.length} checks, pid ${result.isolation?.pid})\n`);
  // Later phases consume this phase's output.
  if (result.status !== "PASS") break;
}

// ------------------------------------------------------------- isolation
const pids = results.map((r) => r.isolation?.pid);
const isolation = {
  orchestratorPid: process.pid,
  osNetworkBlock,
  inProcessGuard: "scripts/acceptance/lib/guard.mjs (fetch, net, tls, http(s), dns)",
  distinctProcesses: new Set(pids).size === pids.length && !pids.includes(process.pid) && pids.every((p) => Number.isInteger(p)),
  pids,
  runDir: out,
};

// ------------------------------------------------------------- artifacts
const artifacts = [];
for (const dir of ["artifacts", "public"]) {
  for (const name of existsSync(dirs[dir]) ? readdirSync(dirs[dir]).sort() : []) {
    const path = join(dirs[dir], name);
    artifacts.push({ path: relative(out, path), bytes: statSync(path).size, sha256: sha256File(path) });
  }
}

// ------------------------------------------------------------- gates
const check = (phase, id) => results.find((r) => r.phase === phase)?.checks.find((c) => c.id === id)?.status === "PASS";
const all = (...refs) => refs.every(([p, id]) => check(p, id));
const everyPhaseOffline = phases.every((p) => check(p.name, "network-blocked"));
const gates = {
  "A1-964-integrated": preflight.filter((p) => p.id.startsWith("964")).every((p) => p.status === "PASS"),
  "A2-create-revise-export": all(["1-author-a", "create"], ["1-author-a", "revise-text"], ["1-author-a", "revise-binary"], ["1-author-a", "resource-add"], ["1-author-a", "resource-remove"], ["1-author-a", "resource-set-refusals"], ["1-author-a", "export-package"]),
  "A3-offline-fresh-reader": everyPhaseOffline && all(["2-offline-reader", "no-authority"], ["2-offline-reader", "same-original"], ["2-offline-reader", "checkpoint"], ["2-offline-reader", "historical-versions"], ["2-offline-reader", "byte-digests"], ["2-offline-reader", "verified-vs-current"]),
  "A4-import-authority-continue": all(["3-author-b", "import"], ["3-author-b", "import-confers-no-authority"], ["3-author-b", "no-key-exported"], ["3-author-b", "continue-editing"]),
  "A5-negatives": all(["3-author-b", "stale-parent"], ["3-author-b", "stale-digest"], ["4-negatives", "missing-bytes-store"], ["4-negatives", "missing-bytes-archive"], ["4-negatives", "stale-prefix"], ["4-negatives", "divergent-local"], ["4-negatives", "divergent-reader"]),
  "process-isolation": isolation.distinctProcesses && everyPhaseOffline,
};
const status = preflight.every((p) => p.status === "PASS") && results.length === phases.length && results.every((r) => r.status === "PASS") && Object.values(gates).every(Boolean) ? "PASS" : "FAIL";

const receipt = {
  receipt: "originals-local-release-acceptance/1",
  scope: "onionoriginals/sdk#976 section A (local release). Not hosted publication, Turnkey, a public host or Bitcoin.",
  createdAt: new Date().toISOString(),
  status,
  source: { sha, branch, dirty: dirty.length > 0, dirtyFiles: dirty },
  packages: {
    "@originals/sdk": version("packages/sdk"),
    "@originals/vh": version("packages/vh"),
    "@originals/auth": version("packages/auth"),
    "@originals/landing": version("apps/landing"),
    "didwebvh-ts": JSON.parse(readFileSync(join(root, "node_modules/didwebvh-ts/package.json"), "utf8")).version,
  },
  runtimes: { node: process.version, bun: sh(bun ?? "bun", ["--version"]).stdout.trim(), platform: `${process.platform}-${process.arch}` },
  profile: { protocol: "originals:1.0 (PROVISIONAL method value)", cryptosuite: "eddsa-jcs-2022", witnesses: "none (Q14)", ordering: "claimed (unanchored)", freshness: "no freshness policy: an unanchored Original is never current, only valid as of its checkpoint (P7.10, originals-spec #46)" },
  author: { method: "did:webvh", builder: "apps/landing/src/auth/webvh.ts buildUserWebVHDid + BrowserWebVHSigner (the #964 regression path)", signerMode: "local Ed25519 keySigner over the authorship key (#key-1) from a custody file; the identity key (#key-0) is the DID's update key only", did: results[0]?.facts?.author?.did ?? null },
  original: results.find((r) => r.phase === "1-author-a")?.facts?.original ?? null,
  isolation,
  preflight,
  gates: Object.fromEntries(Object.entries(gates).map(([k, v]) => [k, v ? "PASS" : "FAIL"])),
  phases: results,
  artifacts,
  notIncluded: [
    "Section B: real Turnkey session, public host, deployed routes, browser restart and interrupted publication.",
  ],
};
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
process.stderr.write(`\nacceptance ${status}; receipt: ${receiptPath}\n`);
process.exit(status === "PASS" ? 0 : 1);
