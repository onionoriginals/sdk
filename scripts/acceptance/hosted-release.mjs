#!/usr/bin/env node
/**
 * Hosted feature-enablement acceptance (issue #976, section B).
 *
 *   node scripts/acceptance/hosted-release.mjs --target local [--out <dir>] [--receipt <file>]
 *   node scripts/acceptance/hosted-release.mjs --base-url https://<staging-host> --email <test inbox> [--production-url https://originals.build]
 *
 * `--target local` is a dry run: the landing's real routes and store on
 * loopback, the landing engine in fresh Bun processes with a FileStore per
 * client (a restart is a new process on the same store), and a signed-out
 * Node reader. It stands in for Turnkey with a custody file, so it is never a
 * section B receipt: every gate is NOT-RUN, and `dryRun` holds the results.
 *
 * `--base-url` is the B run on the owner's staging host: Chromium on
 * persistent profiles, the real Turnkey session in the page, the operator
 * typing each OTP. See scripts/acceptance/hosted-README.md.
 *
 * Writes a JSON receipt (`originals-hosted-acceptance/1`), prints it, and
 * exits 1 on any failure.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { recordPhaseResult } from "./lib/phase-result.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = realpathSync(join(here, "..", ".."));
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const baseUrl = flag("--base-url");
const target = baseUrl ? "staging" : flag("--target");
if (target !== "local" && target !== "staging") {
  process.stderr.write("usage: hosted-release.mjs --target local | --base-url https://<staging-host> --email <test inbox>\n");
  process.exit(2);
}
const out = realpathSync(flag("--out") ? (mkdirSync(flag("--out"), { recursive: true }), flag("--out")) : mkdtempSync(join(tmpdir(), "originals-hosted-acceptance-")));
const receiptPath = flag("--receipt") ?? join(out, "receipt.json");

const sh = (cmd, cmdArgs, opts = {}) => spawnSync(cmd, cmdArgs, { encoding: "utf8", cwd: root, ...opts });
const version = (pkg) => JSON.parse(readFileSync(join(root, pkg, "package.json"), "utf8")).version;
const bunShim = sh("sh", ["-c", "command -v bun"]).stdout.trim();
const bun = bunShim ? sh(bunShim, ["-e", "console.log(process.execPath)"]).stdout.trim() || bunShim : "bun";

// ------------------------------------------------------------- preflight
const preflight = [];
const pre = (id, title, ok, detail) => preflight.push({ id, title, status: ok ? "PASS" : "FAIL", detail });
const sha = sh("git", ["rev-parse", "HEAD"]).stdout.trim();
const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
const dirty = sh("git", ["status", "--porcelain"]).stdout.trim().split("\n").filter(Boolean);
const dists = ["packages/sdk/dist/originals/index.js", "packages/sdk/dist/originals/fs-store.js", "packages/vh/dist/originals/index.js"];
pre("built", "built package entry points exist (run `bun run build`)", dists.every((d) => existsSync(join(root, d))), { missing: dists.filter((d) => !existsSync(join(root, d))) });
// B6 in source (hosted-README.md): resolveFeatures({}) and resolveFeatures(<production env>)
// both leave hostedPublication off, with or without the switch, and the production deploy
// config never sets it. Evaluated, not pattern-matched: Bun runs the candidate's features.ts.
const railway = readFileSync(join(root, ".railway/railway.ts"), "utf8");
const featuresProbe = sh(bun, ["-e", `
  const { resolveFeatures } = await import(${JSON.stringify(join(root, "apps/landing/src/sdk/features.ts"))});
  const production = { VITE_WEBVH_HOST: "originals.build", VITE_BTC_NETWORK: "mainnet" };
  console.log(JSON.stringify({
    empty: resolveFeatures({}).hostedPublication,
    production: resolveFeatures(production).hostedPublication,
    productionWithSwitch: resolveFeatures({ ...production, VITE_ACCEPTANCE_HOSTED_PUBLICATION: "1" }).hostedPublication,
  }));
`]);
const b6 = (() => { try { return JSON.parse(featuresProbe.stdout.trim().split("\n").at(-1)); } catch { return null; } })();
pre("b6-source-off", "resolveFeatures({}) and resolveFeatures(<production env>) leave hostedPublication off, with or without the switch; production config doesn't set it", !!b6 && b6.empty === false && b6.production === false && b6.productionWithSwitch === false && !railway.includes("VITE_ACCEPTANCE_HOSTED_PUBLICATION"), { file: "apps/landing/src/sdk/features.ts", resolved: b6, ...(b6 ? {} : { error: featuresProbe.stderr.slice(-400) }) });
if (target === "staging") pre("email", "--email names the test inbox", !!flag("--email"), {});

// ------------------------------------------------------------- phases
const results = [];
function runPhase(name, cmd, cmdArgs, input, { interactive = false } = {}) {
  const home = join(out, "home", name);
  const tmp = join(out, "tmp", name);
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const resultFile = join(out, "results", `${name}.json`);
  mkdirSync(dirname(resultFile), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: tmp, LANG: "C.UTF-8", ACCEPTANCE_INPUT: JSON.stringify({ phaseName: name, ...input }), ACCEPTANCE_RESULT: resultFile, ...(process.env.CHROMIUM_PATH ? { CHROMIUM_PATH: process.env.CHROMIUM_PATH } : {}) };
  const started = Date.now();
  const run = spawnSync(cmd, cmdArgs, { cwd: tmp, env, encoding: "utf8", timeout: 600_000, stdio: interactive ? ["inherit", "pipe", "inherit"] : "pipe" });
  const result = recordPhaseResult({ name, resultFile, run, command: [cmd, ...cmdArgs], root, ms: Date.now() - started });
  results.push(result);
  process.stderr.write(`phase ${name}: ${result.status} (${result.checks.filter((c) => c.status === "PASS").length}/${result.checks.length} checks)\n`);
  return result;
}
const factsOf = (name) => results.find((r) => r.phase === name)?.facts ?? {};
const readerCases = (works, expect) => works.map(([name, w, e]) => ({ name, alias: w?.alias, checkpoint: w?.checkpoint, resources: w?.resources, expect: e ?? expect }));

let server = null;
const blocked = preflight.some((p) => p.status === "FAIL");
if (!blocked && target === "local") {
  const dirs = Object.fromEntries(["custody", "storeA", "storeB", "storeC", "data"].map((d) => [d, join(out, d)]));
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const portFile = join(out, "port");
  const jwtSecret = randomBytes(32).toString("hex");
  server = spawn(bun, [join(here, "hosted", "local-server.ts")], { env: { PATH: process.env.PATH, ACCEPTANCE_DATA_DIR: dirs.data, ACCEPTANCE_JWT_SECRET: jwtSecret, ACCEPTANCE_PORT_FILE: portFile }, stdio: "ignore" });
  for (let i = 0; i < 200 && !existsSync(portFile); i++) spawnSync("sleep", ["0.05"]);
  const port = Number(readFileSync(portFile, "utf8"));
  const local = { port, domain: "acceptance.example", sub: "sub-acceptance-0976b", jwtSecret };
  const bunPhase = (name, script, phaseDirs, prior) => runPhase(name, bun, [join(here, "hosted", script)], { ...local, dirs: Object.fromEntries(phaseDirs.map((d) => [d, dirs[d]])), ...(prior ? { prior } : {}) });
  // The reader gets no directory, no secret and no cookie: only the port it reads the public URLs through.
  const reader = (name, cases) => runPhase(name, process.execPath, [join(here, "hosted", "reader.mjs")], { target: "local", port, cases });
  const steps = [
    () => bunPhase("L0-identity", "l0-identity.ts", ["custody"]),
    () => bunPhase("L1-client-a", "l1-client-a.ts", ["custody", "storeA"]),
    () => { const f = factsOf("L1-client-a"); return reader("L2-reader", readerCases([["work1", f.work1], ["work2", f.work2, "incomplete"], ["work3", f.work3, "incomplete"]], "complete")); },
    () => bunPhase("L3-client-a-restart", "l3-client-a-restart.ts", ["custody", "storeA"], factsOf("L1-client-a")),
    () => { const f = factsOf("L3-client-a-restart"); return reader("L4-reader", readerCases([["work1", f.work1], ["work2", f.work2], ["work3", f.work3]], "complete")); },
    () => bunPhase("L5-client-b", "l5-client-b.ts", ["custody", "storeA", "storeB", "storeC"], factsOf("L3-client-a-restart")),
    () => reader("L6-reader", readerCases([["work1", factsOf("L5-client-b").work1]], "complete")),
    () => bunPhase("L7-signed-out", "l6-signed-out.ts", []),
  ];
  for (const step of steps) if (step().status !== "PASS") break;
  server.kill();
} else if (!blocked) {
  const profiles = { a: join(out, "profiles", "client-a"), b: join(out, "profiles", "client-b") };
  const browser = (name, action, extra = {}) => runPhase(name, process.execPath, [join(here, "hosted", "browser-client.mjs")], { action, baseUrl, email: flag("--email"), ...extra }, { interactive: true });
  const reader = (name, cases) => runPhase(name, process.execPath, [join(here, "hosted", "reader.mjs")], { target: "staging", cases });
  const steps = [
    () => browser("S1-client-a", "client-a", { profile: profiles.a }),
    () => { const f = factsOf("S1-client-a"); return reader("S2-reader", readerCases([["work1", f.work1], ["work2", f.work2, "incomplete"], ["work3", f.work3, "incomplete"]], "complete")); },
    () => browser("S3-client-a-restart", "client-a-restart", { profile: profiles.a, prior: factsOf("S1-client-a") }),
    () => { const f = factsOf("S3-client-a-restart"); return reader("S4-reader", readerCases([["work1", f.work1], ["work2", f.work2], ["work3", f.work3]], "complete")); },
    () => browser("S5-client-b", "client-b", { profile: profiles.b, prior: factsOf("S3-client-a-restart") }),
    () => reader("S6-reader", readerCases([["work1", factsOf("S5-client-b").work1]], "complete")),
    () => browser("S6b-client-a-stale", "client-a-stale", { profile: profiles.a, prior: factsOf("S3-client-a-restart") }),
    () => browser("S7-signed-out", "signed-out"),
    () => browser("S8-production", "production", { productionUrl: flag("--production-url") }),
  ];
  for (const step of steps) if (step().status !== "PASS") break;
}

// ------------------------------------------------------------- gates
const p = target === "local" ? { id: "L0-identity", a: "L1-client-a", r1: "L2-reader", ar: "L3-client-a-restart", r2: "L4-reader", b: "L5-client-b", r3: "L6-reader", so: "L7-signed-out" } : { a: "S1-client-a", r1: "S2-reader", ar: "S3-client-a-restart", r2: "S4-reader", b: "S5-client-b", r3: "S6-reader", stale: "S6b-client-a-stale", so: "S7-signed-out", prod: "S8-production" };
const ok = (phase, id) => results.find((r) => r.phase === phase)?.checks.find((c) => c.id === id)?.status === "PASS";
const all = (...refs) => refs.every(([ph, id]) => ok(ph, id));
const computed = {
  "B1-turnkey-create-revise-publish": target === "local" ? all([p.id, "author-identity"], [p.a, "b1-create-revise"], [p.a, "b1-publish"], [p.a, "b1-key-roles"]) : all([p.a, "b1-create-revise-publish"], [p.a, "b1-key-roles"]),
  "B2-signed-out-reader": all([p.r1, "no-authority"], [p.r1, "work1-complete"], [p.r1, "no-cookies"], [p.r2, "work1-complete"]),
  // Stale parent (C12-125) runs on both targets. Another key can't continue
  // a restored work: that check runs only locally, because on staging the
  // page's only signer is the account's own Turnkey session.
  "B3-restore-continue": all([p.ar, "b3-reopen-continue"], [p.b, "b3-other-client-restore"], [p.r3, "work1-complete"]) && (target === "staging" ? all([p.stale, "b3-stale-parent"]) : all([p.ar, "b3-listed"], [p.b, "b3-stale-parent"], [p.b, "b3-restore-no-authority"])),
  "B4-interrupted-publication": all([p.a, "b4-interrupt-work2"], [p.a, "b4-interrupt-work3"], [p.r1, "work2-incomplete"], [p.r1, "work3-incomplete"], [p.ar, "b4-resume-work2"], [p.ar, "b4-resume-work3"], [p.r2, "work2-complete"], [p.r2, "work3-complete"]),
  "B5-signed-out-ephemeral": target === "local" ? all([p.so, "b5-ephemeral"], [p.so, "b5-package-public-only"]) : all([p.so, "b5-ephemeral"]),
  "B6-flag-off": preflight.find((x) => x.id === "b6-source-off")?.status === "PASS" && (target === "local" || ok(p.prod, "b6-production-off")),
};
const passed = preflight.every((x) => x.status === "PASS") && results.length > 0 && results.every((r) => r.status === "PASS") && Object.values(computed).every(Boolean);

// The deployed revision (G6): the server's and the SPA's must both equal the source SHA.
let deployed = null;
if (target === "staging") {
  const v = await fetch(`${baseUrl.replace(/\/$/, "")}/api/version`).then((r) => r.json()).catch(() => null);
  deployed = { baseUrl, revision: v?.revision ?? null, spaRevision: v?.spaRevision ?? null, matchesSource: v?.revision === sha && v?.spaRevision === sha, production: factsOf(p.prod).version ?? null };
}
const status = target === "local" ? (passed ? "DRY-RUN-PASS" : "FAIL") : passed && dirty.length === 0 && deployed?.matchesSource ? "PASS" : "FAIL";

// ------------------------------------------------------------- artifacts and receipt
const artifacts = [];
for (const r of results) artifacts.push({ path: relative(out, join(out, "results", `${r.phase}.json`)), sha256: createHash("sha256").update(readFileSync(join(out, "results", `${r.phase}.json`))).digest("hex") });
const receipt = {
  receipt: "originals-hosted-acceptance/1",
  scope: "onionoriginals/sdk#976 section B (hosted feature enablement). Not Bitcoin.",
  target,
  createdAt: new Date().toISOString(),
  status,
  source: { sha, branch, dirty: dirty.length > 0, dirtyFiles: dirty },
  deployed,
  packages: { "@originals/sdk": version("packages/sdk"), "@originals/vh": version("packages/vh"), "@originals/auth": version("packages/auth"), "@originals/landing": version("apps/landing") },
  runtimes: { node: process.version, bun: sh(bun, ["--version"]).stdout.trim(), platform: `${process.platform}-${process.arch}` },
  profile: { protocol: "originals:1.0 (PROVISIONAL method value)", cryptosuite: "eddsa-jcs-2022", witnesses: "none (Q14)", ordering: "claimed (unanchored)", freshness: "never current unanchored (P7.10)" },
  signerMode: target === "local" ? "dry run: Ed25519 keys from a custody file standing in for Turnkey, in the app's two roles" : "Turnkey client-held session (non-extractable P-256 session key in IndexedDB; Ed25519 wallet accounts held by Turnkey)",
  author: { ...(factsOf(p.id ?? p.a).author ?? factsOf(p.a).author ?? {}), roles: factsOf(p.a).roles ?? null },
  originals: ["work1", "work2", "work3"].map((w) => ({ case: w === "work1" ? "B1-B3" : "B4", ...(results.map((r) => r.facts?.[w]).filter(Boolean).at(-1) ?? {}) })),
  isolation: { phases: results.map((r) => ({ phase: r.phase, pid: r.isolation?.pid, runtime: r.isolation?.runtime, envNames: r.isolation?.envNames, dirs: r.isolation?.dirs })), runDir: out },
  preflight,
  gates: Object.fromEntries(Object.entries(computed).map(([k, v]) => [k, target === "local" ? "NOT-RUN" : v ? "PASS" : "FAIL"])),
  ...(target === "local" ? { dryRun: Object.fromEntries(Object.entries(computed).map(([k, v]) => [k, v ? "PASS" : "FAIL"])) } : {}),
  phases: results,
  manual: results.flatMap((r) => r.facts?.manual ?? []),
  artifacts,
  unavailable: ["Unpublished work does not sync between clients; it moves by evidence package import (section A)."],
  notIncluded: ["Bitcoin anchoring, signing and commit/reveal restart.", ...(target === "local" ? ["Turnkey and a public host: a dry run is never a section B receipt."] : [])],
};

// No secret may reach the receipt: JWTs, cookies, private key members, custody secrets.
const text = JSON.stringify(receipt);
const custodyFile = join(out, "custody", "author-keys.json");
const secrets = existsSync(custodyFile) ? Object.values(JSON.parse(readFileSync(custodyFile, "utf8"))).filter((v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v)) : [];
const leaks = [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./.test(text) && "jwt", /auth_token=/.test(text) && "cookie", /secretKeyMultibase|privateKey/.test(text) && "private-key-member", ...secrets.filter((s) => text.includes(s)).map(() => "custody-secret")].filter(Boolean);
if (leaks.length) {
  receipt.status = "FAIL";
  receipt.secretScan = { status: "FAIL", hits: leaks };
} else receipt.secretScan = { status: "PASS" };

writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
process.stderr.write(`\nhosted acceptance ${receipt.status}; receipt: ${receiptPath}\n`);
process.exit(receipt.status === "PASS" || receipt.status === "DRY-RUN-PASS" ? 0 : 1);
