/**
 * `git-remote-originals` (plan 049 phase 5; PROVISIONAL K16; CODE-27,
 * CODE-28): `git clone originals::<bundle>` verifies the bundle offline,
 * refuses unless the canonical head is agreed and the branch verifies
 * completely, and rebuilds byte-identical commits, first-parent only, with
 * second parents listed as grafts. Network is disabled in this process; the
 * clone reads a bundle file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { GitSource } from "../src/git.js";
import { openRepository, planClone } from "../src/index.js";
import { FixtureRepo, NOW, identity, workspace } from "./helpers.js";

const MAIN = "refs/heads/main";
const HELPER = resolve(import.meta.dir, "../src/remote-helper.ts");
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

function temp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** A PATH entry with `git-remote-originals` running the helper from source under this Bun. */
function helperPath(): string {
  const bin = temp("originals-helper-");
  writeFileSync(join(bin, "git-remote-originals"), `#!/bin/sh\nexec "${process.execPath}" "${HELPER}" "$@"\n`);
  chmodSync(join(bin, "git-remote-originals"), 0o755);
  return `${bin}:${process.env.PATH ?? ""}`;
}

function gitIn(dir: string, ...args: string[]) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

/** c1, a side branch merged with --no-ff, then c3: the merge's second parent is not mirrored. */
function history() {
  const repo = new FixtureRepo();
  cleanup.push(() => repo.remove());
  repo.commit({ "a.txt": "1\n", "dir/b.txt": "b\n", "run.sh": { exec: "#!/bin/sh\n" } });
  repo.git("checkout", "-q", "-b", "side");
  repo.commit({ "side.txt": "side\n" });
  repo.git("checkout", "-q", "main");
  repo.commit({ "a.txt": "2\n", "link": { link: "a.txt" } });
  repo.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
  repo.commit({ "dir/b.txt": null, "c.txt": "c\n" }, "three\n\nwith a body");
  return repo;
}

async function bundleOf(repo: FixtureRepo, options: { commits?: boolean } = {}) {
  const alice = await identity(1);
  const ws = workspace();
  const s = new GitSource(repo.dir);
  cleanup.push(() => s.close());
  const repoDid = await ws.initRepo({ name: "clone", identity: alice });
  await ws.mirror({ repo: repoDid, ref: MAIN, identity: alice, source: s, ...options });
  return { ws, repoDid, bytes: await ws.package(repoDid) };
}

function clone(bundle: Uint8Array) {
  const dir = temp("originals-clone-");
  const file = join(dir, "repo.zip");
  writeFileSync(file, bundle);
  const target = join(dir, "clone");
  const r = spawnSync("git", ["clone", `originals::${file}`, target], { encoding: "utf8", env: { ...process.env, PATH: helperPath() } });
  return { status: r.status, stderr: r.stderr, target };
}

describe("CODE-27 git clone originals::<bundle>", () => {
  test("first-parent commit ids are git's own; trees and files match; second parents are grafts", async () => {
    const repo = history();
    const { bytes } = await bundleOf(repo);
    const c = clone(bytes);
    expect(c.status, c.stderr).toBe(0);
    expect(c.stderr).toContain("verified");
    expect(gitIn(c.target, "log", "--first-parent", "--format=%H")).toBe(repo.git("log", "--first-parent", "--format=%H"));
    expect(gitIn(c.target, "rev-parse", "HEAD^{tree}")).toBe(repo.treeOf("HEAD"));
    expect(gitIn(c.target, "log", "-1", "--format=%B")).toBe("three\n\nwith a body");
    // Every object is byte-identical; the merge's second parent is stated, not present.
    const merge = repo.head("HEAD~1");
    expect(readFileSync(join(c.target, ".git", "info", "grafts"), "utf8")).toBe(`${merge} ${repo.head("HEAD~2")}\n`);
    expect(gitIn(c.target, "cat-file", "-p", merge)).toContain(`parent ${repo.head("side")}`);
    expect(spawnSync("git", ["-C", c.target, "fsck", "--no-progress"], { encoding: "utf8" }).status).toBe(0);
    expect(gitIn(c.target, "status", "--porcelain")).toBe("");
    expect(gitIn(c.target, "rev-parse", "--abbrev-ref", "origin/HEAD")).toBe("origin/main");
  });

  test("git fetch picks up a later bundle", async () => {
    const repo = history();
    const { ws, repoDid, bytes } = await bundleOf(repo);
    const c = clone(bytes);
    expect(c.status, c.stderr).toBe(0);
    const c4 = repo.commit({ "d.txt": "d\n" });
    const s = new GitSource(repo.dir);
    cleanup.push(() => s.close());
    await ws.mirror({ repo: repoDid, ref: MAIN, identity: await identity(1), source: s });
    writeFileSync(join(c.target, "..", "repo.zip"), await ws.package(repoDid));
    const f = spawnSync("git", ["-C", c.target, "fetch", "-q"], { encoding: "utf8", env: { ...process.env, PATH: helperPath() } });
    expect(f.status, f.stderr).toBe(0);
    expect(gitIn(c.target, "rev-parse", "origin/main")).toBe(c4);
  });
});

describe("CODE-28 the helper refuses what it cannot rebuild exactly", () => {
  test("commit objects not mirrored: refused, nothing cloned", async () => {
    const repo = history();
    const { bytes } = await bundleOf(repo, { commits: false });
    const opened = await openRepository(bytes, { now: NOW + 3_600_000 });
    const plan = await planClone(opened);
    expect(plan.plans).toEqual([]);
    expect(plan.refused[0].reason).toContain("commit ids claimed");
    const c = clone(bytes);
    expect(c.status).not.toBe(0);
    expect(c.stderr).toContain("refusing refs/heads/main");
  });

  test("no agreed canonical head: refused", async () => {
    const repo = history();
    const { ws, repoDid } = await bundleOf(repo);
    const alice = await identity(1);
    const dave = await identity(4);
    // Dave joins, signing the change that adds him (P5.20); main now needs both.
    await ws.updateRepo(repoDid, [alice, dave], (d) => ({ ...d, delegates: [alice.did, dave.did].sort(), refs: { [MAIN]: { ...d.refs[MAIN], threshold: 2 } } }));
    const opened = await openRepository(await ws.package(repoDid), { now: NOW + 3_600_000 });
    expect((await planClone(opened)).refused[0]).toMatchObject({ ref: MAIN, reason: expect.stringContaining("no-quorum") });
  });

  test("the plan holds every first-parent commit; a chain from a root commit is not shallow", async () => {
    // planClone reads the first commit's parent from its commit object: a parent would make it shallow there.
    const repo = history();
    const { bytes } = await bundleOf(repo);
    const plan = (await planClone(await openRepository(bytes, { now: NOW + 3_600_000 }))).plans[0];
    expect(plan.shallow).toBeNull(); // a root commit
    expect(plan.grafts).toHaveLength(1);
    expect(plan.commits.map((x) => x.commit)).toEqual(repo.git("log", "--first-parent", "--reverse", "--format=%H").split("\n"));
  });
});
