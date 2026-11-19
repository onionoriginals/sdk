/**
 * Raw git commit objects (plan 049 O3, decided 2026-11-19; PROVISIONAL K12;
 * CODE-19, CODE-20). Network is disabled for every test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWorkspace } from "../src/fs.js";
import { GitSource } from "../src/git.js";
import { gitCommitId, parseGitCommit, readBundle, verifyRepository, writeBundle, type CommitSource } from "../src/index.js";
import { FixtureRepo, NOW, identity, setup, ticking } from "./helpers.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const f of cleanup.splice(0)) f();
});

function source(repo: FixtureRepo) {
  const s = new GitSource(repo.dir);
  cleanup.push(() => s.close());
  return s;
}

/** Three commits on main, then a merge of a side branch, then one more. */
function history(repo: FixtureRepo): string[] {
  cleanup.push(() => repo.remove());
  const c1 = repo.commit({ "a.txt": "1\n" });
  repo.git("checkout", "-q", "-b", "side");
  repo.commit({ "side.txt": "side\n" });
  repo.git("checkout", "-q", "main");
  const c2 = repo.commit({ "a.txt": "2\n" });
  repo.git("merge", "-q", "--no-ff", "-m", "merge side", "side");
  const c3 = repo.head();
  const c4 = repo.commit({ "a.txt": "4\n" }, "four\n\nwith a body");
  return [c1, c2, c3, c4];
}

const later = { now: NOW + 3_600_000 };

describe("CODE-19 commit objects mirrored verbatim", () => {
  test("public by default: each entry names its commit object; the verifier recomputes the commit id, tree and first parent", async () => {
    const { alice, repo, ws } = await setup();
    const commits = history(repo);
    const repoDid = await ws.initRepo({ name: "commits", identity: alice });
    const r = await ws.mirror({ repo: repoDid, ref: "refs/heads/main", identity: alice, source: source(repo) });
    expect(r.commitObjects).toBe("included");

    const bundle = await ws.package(repoDid);
    const contents = await readBundle(bundle);
    // The bundle carries each commit object byte for byte: its git id is the commit's.
    const ids = new Set([...contents.objects.values()].map((b) => gitCommitId(b)));
    for (const c of commits) expect(ids.has(c)).toBe(true);
    const merge = [...contents.objects.values()].find((b) => gitCommitId(b) === commits[2])!;
    expect(parseGitCommit(merge).parents).toHaveLength(2); // second parents stay in the object, unmirrored (K9)

    const report = await verifyRepository(bundle, later);
    const b = report.branches[0].code!;
    expect(b.history.status).toBe("valid");
    expect(b.commitBinding).toMatchObject({ status: "matches", checked: 4, unchecked: 0, claimed: 0, mismatches: [], base: null });
    expect(b.gitBinding.status).toBe("matches"); // reported separately
    expect(report.canonical[0]).toMatchObject({ status: "agreed", head: { commit: commits[3] } });
  });

  test("a source marked private mirrors no commit objects without explicit opt-in; ids are then claimed", async () => {
    const { alice, repo, ws } = await setup();
    history(repo);
    const repoDid = await ws.initRepo({ name: "private", identity: alice });
    const r = await ws.mirror({ repo: repoDid, ref: "refs/heads/main", identity: alice, source: source(repo), private: true });
    expect(r.commitObjects).toBe("omitted-private");
    const report = await verifyRepository(await ws.package(repoDid), later);
    const b = report.branches[0].code!;
    expect(b.history.status).toBe("valid");
    expect(b.commitBinding).toMatchObject({ status: "claimed", checked: 0, claimed: 4 });
    expect(b.commitBinding.base).toBeUndefined();
  });

  test("a private source with commits: true mirrors them; commits: false opts a public one out", async () => {
    const { alice, repo, ws } = await setup();
    history(repo);
    const repoDid = await ws.initRepo({ name: "opt-in", identity: alice });
    const r = await ws.mirror({ repo: repoDid, ref: "refs/heads/main", identity: alice, source: source(repo), private: true, commits: true });
    expect(r.commitObjects).toBe("included");
    expect((await verifyRepository(await ws.package(repoDid), later)).branches[0].code!.commitBinding.status).toBe("matches");

    const other = await setup();
    const repo2 = new FixtureRepo();
    history(repo2);
    const repo2Did = await other.ws.initRepo({ name: "opt-out", identity: other.alice });
    const r2 = await other.ws.mirror({ repo: repo2Did, ref: "refs/heads/main", identity: other.alice, source: source(repo2), commits: false });
    expect(r2.commitObjects).toBe("omitted");
    expect((await verifyRepository(await other.ws.package(repo2Did), later)).branches[0].code!.commitBinding.status).toBe("claimed");
  });

  test("a branch written before K12 and extended after it verifies; old commits stay claimed", async () => {
    const { alice, repo, ws } = await setup();
    cleanup.push(() => repo.remove());
    repo.commit({ "a.txt": "1" });
    repo.commit({ "a.txt": "2" });
    const repoDid = await ws.initRepo({ name: "mixed", identity: alice });
    await ws.mirror({ repo: repoDid, ref: "refs/heads/main", identity: alice, source: source(repo), commits: false });
    repo.commit({ "a.txt": "3" });
    await ws.mirror({ repo: repoDid, ref: "refs/heads/main", identity: alice, source: source(repo) });
    const b = (await verifyRepository(await ws.package(repoDid), later)).branches[0].code!;
    expect(b.history.status).toBe("valid");
    // The third commit's first parent is checked against the second, whose id is claimed.
    expect(b.commitBinding).toMatchObject({ status: "claimed", checked: 1, claimed: 2 });
  });

  test("a missing commit object is unchecked and content partial, never a pass", async () => {
    const { alice, repo, ws } = await setup();
    const commits = history(repo);
    const repoDid = await ws.initRepo({ name: "missing", identity: alice });
    await ws.mirror({ repo: repoDid, ref: "refs/heads/main", identity: alice, source: source(repo) });
    const contents = await readBundle(await ws.package(repoDid));
    const objects = new Map([...contents.objects].filter(([, b]) => gitCommitId(b) !== commits[1]));
    const partial = writeBundle({ repo: contents.manifest.repo, checkpoint: contents.manifest.checkpoint, packages: contents.packages, objects: objects.entries() });
    const b = (await verifyRepository(partial, later)).branches[0].code!;
    expect(b.history.status).toBe("valid");
    expect(b.content.status).toBe("partial");
    expect(b.commitBinding).toMatchObject({ status: "unchecked", checked: 3, unchecked: 1 });
  });

  test("the disk workspace remembers that its source is private", async () => {
    const dir = mkdtempSync(join(tmpdir(), "originals-code-private-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const alice = await identity(1);
    const ws = await openWorkspace(dir, { clock: ticking() });
    await ws.setRepo(await ws.workspace.initRepo({ name: "p", identity: alice }), { private: true });
    await ws.close();
    const again = await openWorkspace(dir);
    expect(again.private).toBe(true);
    await again.close();
  });
});

describe("CODE-20 commit binding mismatches fail the code history", () => {
  async function lyingMirror(lie: (real: GitSource) => CommitSource) {
    const { alice, repo, ws } = await setup();
    const commits = history(repo);
    const repoDid = await ws.initRepo({ name: "lying", identity: alice });
    await ws.mirror({ repo: repoDid, ref: "refs/heads/main", identity: alice, source: lie(source(repo)) });
    const report = await verifyRepository(await ws.package(repoDid), later);
    return { commits, report, b: report.branches[0] };
  }

  test("a commit object that does not hash to the entry's commit id", async () => {
    const { b, report } = await lyingMirror((real) => {
      let previous: string | undefined;
      return {
        firstParent: (ref) => real.firstParent(ref),
        // Each entry names the previous commit's object: a valid Original whose code claims do not hold.
        convert: async (c, o, opts) => {
          const m = await real.convert(c, o, opts);
          const swapped = { ...m, ...(previous ? { object: previous } : {}) };
          previous = m.object;
          return swapped;
        },
      };
    });
    expect(b.report?.validAsOf).not.toBeNull(); // the Originals report is separate and unchanged
    expect(b.code?.history).toMatchObject({ status: "invalid", failure: { code: "GIT_COMMIT_MISMATCH", index: 1 } });
    expect(b.code?.commitBinding.status).toBe("mismatch");
    expect(report.canonical[0]).toMatchObject({ status: "no-quorum", head: null });
  });

  test("a commit object whose tree is not the entry's tree", async () => {
    const { b } = await lyingMirror((real) => {
      let first: { tree: string; root: { digest: string; size: number } } | undefined;
      return {
        firstParent: (ref) => real.firstParent(ref),
        // The second entry claims the first commit's tree (which its objects confirm), with its own commit object.
        convert: async (c, o, opts) => {
          const m = await real.convert(c, o, opts);
          if (!first) {
            first = { tree: m.tree, root: m.root };
            return m;
          }
          return { ...m, tree: first.tree, root: first.root };
        },
      };
    });
    expect(b.code?.history).toMatchObject({ status: "invalid", failure: { code: "COMMIT_TREE_MISMATCH", index: 1 } });
    expect(b.code?.gitBinding.mismatches).toEqual([]);
  });

  test("a commit whose first parent is not the previous entry's commit (a skipped commit)", async () => {
    const { b } = await lyingMirror((real) => ({
      firstParent: async (ref) => {
        const all = await real.firstParent(ref);
        return [all[0], ...all.slice(2)];
      },
      convert: (c, o, opts) => real.convert(c, o, opts),
    }));
    expect(b.code?.history).toMatchObject({ status: "invalid", failure: { code: "COMMIT_PARENT_MISMATCH", index: 1 } });
  });
});

describe("parseGitCommit", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  test("reads tree and parents; refuses anything else", () => {
    const t = "a".repeat(40);
    const p = "b".repeat(40);
    expect(parseGitCommit(enc(`tree ${t}\nparent ${p}\nauthor x <x> 0 +0000\n\nmsg\n`))).toEqual({ tree: t, parents: [p] });
    expect(parseGitCommit(enc(`tree ${t}\nauthor x <x> 0 +0000\n\nmsg\n`))).toEqual({ tree: t, parents: [] });
    expect(() => parseGitCommit(enc(`parent ${p}\ntree ${t}\n\n`))).toThrow();
    expect(() => parseGitCommit(enc(`tree ${t.toUpperCase()}\n\n`))).toThrow();
    expect(() => parseGitCommit(enc(`tree ${t}`))).toThrow();
  });
});
