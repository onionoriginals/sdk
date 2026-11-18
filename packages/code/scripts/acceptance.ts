/**
 * CODE-ACC (plan 049): mirror `main` of a git repository (this one by
 * default), package a repo bundle and verify it with no network and no key.
 * Prints timings and sizes against git's own packs.
 *
 *   bun scripts/acceptance.ts [--git <repo>] [--ref refs/heads/main] [--keep <dir>] [--json <file>]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openWorkspace } from "../src/fs.js";
import { GitSource } from "../src/git.js";
import { createLocalIdentity, verifyRepository } from "../src/index.js";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const gitDir = resolve(opt("git") ?? join(import.meta.dir, "../../.."));
const ref = opt("ref") ?? "refs/heads/main";
const keep = opt("keep");
const root = keep ? resolve(keep) : mkdtempSync(join(tmpdir(), "originals-code-acc-"));

const git = (...a: string[]) => execFileSync("git", ["-C", gitDir, ...a], { encoding: "utf8", maxBuffer: 1 << 30 }).trim();
const mib = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;
const time = async <T>(f: () => Promise<T>): Promise<[T, number]> => {
  const t = performance.now();
  const r = await f();
  return [r, (performance.now() - t) / 1000];
};

const commonDir = resolve(gitDir, git("rev-parse", "--git-common-dir"));
const packDir = join(commonDir, "objects", "pack");
const repoPack = readdirSync(packDir).filter((f) => f.endsWith(".pack")).reduce((n, f) => n + statSync(join(packDir, f)).size, 0);
const packOf = (revArgs: string[]) =>
  execFileSync("sh", ["-c", `git -C '${gitDir}' rev-list --objects ${revArgs.join(" ")} | git -C '${gitDir}' pack-objects --stdout -q | wc -c`], { encoding: "utf8", maxBuffer: 1 << 30 }).trim();
const mainPack = Number(packOf([ref]));
const firstParentPack = Number(packOf(["--first-parent", ref]));
const commits = Number(git("rev-list", "--count", ref));
const firstParent = Number(git("rev-list", "--count", "--first-parent", ref));
const files = git("ls-tree", "-r", "--name-only", ref).split("\n").length;

console.log(`repository ${gitDir} ${ref}: ${commits} commits (${firstParent} first-parent), ${files} files`);
console.log(`git packs: all refs ${mib(repoPack)}; ${ref} ${mib(mainPack)}; ${ref} first-parent only ${mib(firstParentPack)}`);
console.log(`workspace ${root}`);

const identity = await createLocalIdentity();
const ws = await openWorkspace(join(root, "ws"));
const source = new GitSource(gitDir);
let bundle: Uint8Array;
let mirrorSeconds: number;
let packageSeconds: number;
let originalsBytes = 0;
let usage: { objects: number; bytes: number };
try {
  await ws.rememberIdentity(identity);
  const repo = await ws.workspace.initRepo({ name: "originals-sdk", identity });
  await ws.setRepo(repo);
  const [m, ms] = await time(() => ws.workspace.mirror({ repo, ref, identity, source }));
  mirrorSeconds = ms;
  console.log(`mirror: +${m.appended} entries into ${m.branch} in ${ms.toFixed(1)} s; converted ${source.stats.trees} trees, ${source.stats.blobs} blobs (${mib(source.stats.blobBytes)} raw)`);
  [bundle, packageSeconds] = await time(() => ws.workspace.package(repo));
  usage = await ws.objects.usage();
  const du = (p: string): number => (statSync(p).isDirectory() ? readdirSync(p).reduce((n, f) => n + du(join(p, f)), 0) : statSync(p).size);
  originalsBytes = du(join(root, "ws", "originals"));
  console.log(`store: ${usage.objects} objects, ${mib(usage.bytes)} compressed; Originals logs and root trees ${mib(originalsBytes)}`);
  console.log(`package: ${mib(bundle.length)} bundle in ${packageSeconds.toFixed(1)} s`);
} finally {
  source.close();
  await ws.close();
}

// Verify as a stranger: no workspace, no key, and fetch refuses every request.
const realFetch = globalThis.fetch;
let fetches = 0;
globalThis.fetch = (() => {
  fetches++;
  return Promise.reject(new Error("network disabled for CODE-ACC"));
}) as unknown as typeof fetch;
const [report, verifySeconds] = await time(() => verifyRepository(bundle));
globalThis.fetch = realFetch;

const b = report.branches[0];
const c = report.canonical[0];
console.log(`verify (offline, ${fetches} fetches attempted): ${verifySeconds.toFixed(1)} s`);
console.log(`  repo: originals ${report.repo.report?.history.status}, code ${report.repo.code?.history.status}`);
console.log(`  branch: originals ${b.report?.history.status} (${b.report?.history.entries} entries, validAsOf ${b.report?.validAsOf?.checkpoint}), code ${b.code?.history.status}, binding ${b.code?.binding.status}`);
console.log(`  content ${b.code?.content.status}: ${b.code?.content.objects} objects, ${mib(b.code?.content.bytes ?? 0)}; git trees ${b.code?.gitBinding.status} (${b.code?.gitBinding.checked} checked)`);
console.log(`  canonical ${c?.ref}: ${c?.status} ${c?.head?.commit ?? ""} (git: ${git("rev-parse", ref)})`);
console.log(`  current: ${report.current}`);

const result = {
  repository: { commits, firstParent, files, packs: { allRefs: repoPack, ref: mainPack, firstParentOnly: firstParentPack } },
  mirror: { seconds: mirrorSeconds, entries: b.report?.history.entries, trees: source.stats.trees, blobs: source.stats.blobs, blobBytes: source.stats.blobBytes },
  store: { objects: usage.objects, objectBytes: usage.bytes, originalsBytes },
  bundle: { bytes: bundle.length, seconds: packageSeconds },
  verify: { seconds: verifySeconds, fetches, canonical: c?.status, head: c?.head?.commit, gitHead: git("rev-parse", ref), content: b.code?.content.status, gitTrees: b.code?.gitBinding.status, current: report.current },
};
if (opt("json")) writeFileSync(opt("json")!, `${JSON.stringify(result, null, 2)}\n`);
if (!keep) rmSync(root, { recursive: true, force: true });
const ok = report.repo.code?.history.status === "valid" && b.code?.history.status === "valid" && b.report?.validAsOf && c?.status === "agreed" && c.head?.commit === result.verify.gitHead && fetches === 0;
console.log(ok ? "CODE-ACC: PASS" : "CODE-ACC: FAIL");
process.exit(ok ? 0 : 1);
