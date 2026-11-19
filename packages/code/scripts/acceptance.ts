/**
 * CODE-ACC (plan 049): mirror `main` of a git repository (this one by
 * default), package a repo bundle and verify it with no network and no key.
 * Prints timings and sizes against git's own packs.
 *
 *   bun scripts/acceptance.ts [--git <repo>] [--ref refs/heads/main] [--rev origin/main] [--keep <dir>] [--json <file>]
 *                             [--segment-entries <n>]   (K13: split the branch into segments of n entries)
 *                             [--clone]                 (K16: git clone originals::<bundle> and compare first-parent ids)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
/** The revision mirrored as `ref`: `--rev origin/main` mirrors the remote's main when the local branch is stale. */
const rev = opt("rev") ?? ref;
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
const mainPack = Number(packOf([rev]));
const firstParentPack = Number(packOf(["--first-parent", rev]));
const commits = Number(git("rev-list", "--count", rev));
const firstParent = Number(git("rev-list", "--count", "--first-parent", rev));
const files = git("ls-tree", "-r", "--name-only", rev).split("\n").length;

console.log(`repository ${gitDir} ${ref} = ${rev} (${git("rev-parse", rev)}): ${commits} commits (${firstParent} first-parent), ${files} files`);
console.log(`git packs: all refs ${mib(repoPack)}; ${ref} ${mib(mainPack)}; ${ref} first-parent only ${mib(firstParentPack)}`);
console.log(`workspace ${root}`);

const identity = await createLocalIdentity();
const segmentEntries = opt("segment-entries") ? Number(opt("segment-entries")) : undefined;
const ws = await openWorkspace(join(root, "ws"), segmentEntries ? { segmentEntries } : {});
const source = new GitSource(gitDir, { revisions: { [ref]: rev } });
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
  console.log(`mirror: +${m.appended} entries into ${m.branch} in ${ms.toFixed(1)} s; converted ${source.stats.trees} trees, ${source.stats.blobs} blobs (${mib(source.stats.blobBytes)} raw), ${source.stats.commitObjects} commit objects (${mib(source.stats.commitBytes)})`);
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

// The listed branch (the newest segment when segmented, K13).
const b = report.branches.find((x) => x.code?.binding.status === "confirmed") ?? report.branches[0];
const segments = report.branches.filter((x) => x.code?.history.status === "valid" && x.report?.validAsOf).length;
const c = report.canonical[0];
console.log(`verify (offline, ${fetches} fetches attempted): ${verifySeconds.toFixed(1)} s`);
console.log(`  repo: originals ${report.repo.report?.history.status}, code ${report.repo.code?.history.status}`);
console.log(`  branch: originals ${b.report?.history.status} (${b.report?.history.entries} entries, validAsOf ${b.report?.validAsOf?.checkpoint}), code ${b.code?.history.status}, binding ${b.code?.binding.status}`);
console.log(`  content ${b.code?.content.status}: ${b.code?.content.objects} objects, ${mib(b.code?.content.bytes ?? 0)}; git trees ${b.code?.gitBinding.status} (${b.code?.gitBinding.checked} checked)`);
console.log(`  commits ${b.code?.commitBinding.status}: ${b.code?.commitBinding.checked} commit ids recomputed from commit objects, ${b.code?.commitBinding.claimed} claimed, ${b.code?.commitBinding.unchecked} unchecked`);
console.log(`  canonical ${c?.ref}: ${c?.status} ${c?.head?.commit ?? ""} (git: ${git("rev-parse", rev)})`);
console.log(`  segments: ${b.code?.segment.segments.length} (${segments} valid), chain ${b.code?.chain.length} commits`);
console.log(`  current: ${report.current}`);

const result: Record<string, unknown> = {
  repository: { commits, firstParent, files, packs: { allRefs: repoPack, ref: mainPack, firstParentOnly: firstParentPack } },
  mirror: { seconds: mirrorSeconds, entries: b.report?.history.entries, trees: source.stats.trees, blobs: source.stats.blobs, blobBytes: source.stats.blobBytes, commitObjects: source.stats.commitObjects, commitBytes: source.stats.commitBytes },
  store: { objects: usage.objects, objectBytes: usage.bytes, originalsBytes },
  bundle: { bytes: bundle.length, seconds: packageSeconds },
  verify: { seconds: verifySeconds, fetches, canonical: c?.status, head: c?.head?.commit, gitHead: git("rev-parse", rev), content: b.code?.content.status, gitTrees: b.code?.gitBinding.status, commits: b.code?.commitBinding.status, commitsChecked: b.code?.commitBinding.checked, segments: b.code?.segment.segments.length, chain: b.code?.chain.length, current: report.current },
};
// K16: clone the bundle through git-remote-originals and compare with git.
let cloneResult: { seconds: number; commits: number; idsMatch: boolean; tree: boolean; fsck: boolean; grafts: number } | undefined;
if (args.includes("--clone")) {
  const helperDir = join(root, "bin");
  mkdirSync(helperDir, { recursive: true });
  writeFileSync(join(helperDir, "git-remote-originals"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "../src/remote-helper.ts")}" "$@"\n`, { mode: 0o755 });
  const file = join(root, "repo.zip");
  writeFileSync(file, bundle);
  const target = join(root, "clone");
  const env = { ...process.env, PATH: `${helperDir}:${process.env.PATH ?? ""}` };
  const started = performance.now();
  const r = spawnSync("git", ["clone", "-q", `originals::${file}`, target], { env, encoding: "utf8" });
  const seconds = (performance.now() - started) / 1000;
  if (r.status !== 0) console.log(r.stderr);
  const ids = r.status === 0 ? execFileSync("git", ["-C", target, "log", "--first-parent", "--format=%H"], { encoding: "utf8", maxBuffer: 1 << 28 }) : "";
  const want = git("log", "--first-parent", "--format=%H", rev);
  const tree = r.status === 0 && execFileSync("git", ["-C", target, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim() === git("rev-parse", `${rev}^{tree}`);
  const fsck = r.status === 0 && spawnSync("git", ["-C", target, "fsck", "--no-progress"], { encoding: "utf8" }).status === 0;
  let grafts = 0;
  try {
    grafts = readFileSync(join(target, ".git", "info", "grafts"), "utf8").split("\n").filter(Boolean).length;
  } catch {
    grafts = 0;
  }
  cloneResult = { seconds, commits: ids.trim().split("\n").filter(Boolean).length, idsMatch: ids.trim() === want, tree, fsck, grafts };
  console.log(`clone: git clone originals::<bundle> in ${seconds.toFixed(1)} s; ${cloneResult.commits} first-parent commits, ids ${cloneResult.idsMatch ? "match" : "DIFFER from"} git's; tree ${tree ? "matches" : "DIFFERS"}; fsck ${fsck ? "clean" : "FAILED"}; ${grafts} merge commits grafted to their first parent`);
}

if (cloneResult) result.clone = cloneResult;
if (opt("json")) writeFileSync(opt("json")!, `${JSON.stringify(result, null, 2)}\n`);
if (!keep) rmSync(root, { recursive: true, force: true });
const ok = report.repo.code?.history.status === "valid" && b.code?.history.status === "valid" && b.report?.validAsOf && c?.status === "agreed" && c.head?.commit === git("rev-parse", rev) && b.code?.commitBinding.status === "matches" && b.code.chain.length === firstParent && segments === report.branches.length && fetches === 0 && (!cloneResult || (cloneResult.idsMatch && cloneResult.tree && cloneResult.fsck));
console.log(ok ? "CODE-ACC: PASS" : "CODE-ACC: FAIL");
process.exit(ok ? 0 : 1);
