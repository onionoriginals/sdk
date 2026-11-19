/**
 * `@originals/code/git` (Node only): commits from a git repository as a
 * `CommitSource` (plan 049 phase 1). One long-lived `git cat-file --batch`
 * process reads commits, trees and blobs; each git object is converted once
 * (cached by its git id), so a blob or directory shared by many commits is
 * hashed and stored once.
 *
 * Every converted tree is checked against git: its git tree id, recomputed
 * from the new objects, must equal the id git gave (K2). A tree git can hold
 * but the code profile cannot (a gitlink, a non-UTF-8 name, a
 * non-canonical mode) stops the mirror with that tree's error; nothing is
 * silently dropped.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import type { MirrorCommit } from "./branch.js";
import { codeError } from "./errors.js";
import { encodeTree, gitCommitId, gitTreeIdOf, objectDigestAsync, parseGitCommit, type Mode, type Tree } from "./objects.js";
import type { ObjectStore } from "./store.js";
import type { CommitSource } from "./workspace.js";

const run = promisify(execFile);
const utf8 = new TextDecoder("utf-8", { fatal: true });

interface GitObject {
  type: string;
  bytes: Uint8Array;
}

/** A `git cat-file --batch` session. Requests are answered in order. */
class CatFile {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buffer: Buffer = Buffer.alloc(0);
  private readonly waiting: Array<{ resolve: (o: GitObject) => void; reject: (e: Error) => void; id: string }> = [];
  private failed: Error | undefined;

  constructor(dir: string) {
    this.proc = spawn("git", ["-C", dir, "cat-file", "--batch"], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    const fail = (e: Error) => {
      this.failed = e;
      for (const w of this.waiting.splice(0)) w.reject(e);
    };
    this.proc.on("error", fail);
    this.proc.on("exit", (code) => {
      if (this.waiting.length > 0) fail(new Error(`git cat-file exited (${code})`));
    });
  }

  private drain(): void {
    while (this.waiting.length > 0) {
      const nl = this.buffer.indexOf(10);
      if (nl < 0) return;
      const header = this.buffer.subarray(0, nl).toString("utf8");
      const parts = header.split(" ");
      const w = this.waiting[0];
      if (parts[1] === "missing") {
        this.waiting.shift();
        this.buffer = this.buffer.subarray(nl + 1);
        w.reject(Object.assign(new Error(`git object ${w.id} is missing`), { code: "GIT_OBJECT_MISSING" }));
        continue;
      }
      const size = Number(parts[2]);
      if (this.buffer.length < nl + 1 + size + 1) return;
      const bytes = new Uint8Array(this.buffer.subarray(nl + 1, nl + 1 + size));
      this.buffer = this.buffer.subarray(nl + 1 + size + 1);
      this.waiting.shift();
      w.resolve({ type: parts[1], bytes });
    }
  }

  read(id: string): Promise<GitObject> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject, id });
      this.proc.stdin.write(`${id}\n`);
    });
  }

  close(): void {
    this.proc.stdin.end();
  }
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Parse git's binary tree format: `<mode> <name>\0<20-byte id>` repeated. */
function parseGitTree(bytes: Uint8Array): Array<{ mode: string; name: string; id: string }> {
  const out: Array<{ mode: string; name: string; id: string }> = [];
  let at = 0;
  while (at < bytes.length) {
    const sp = bytes.indexOf(32, at);
    const nul = bytes.indexOf(0, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > bytes.length) codeError("invalid-evidence", "GIT_TREE_PARSE", "malformed git tree object");
    const mode = Buffer.from(bytes.subarray(at, sp)).toString("latin1");
    let name: string;
    try {
      name = utf8.decode(bytes.subarray(sp + 1, nul));
    } catch {
      return codeError("unsupported-profile", "TREE_NAME", "a git tree entry name is not UTF-8; originals-code names are UTF-8 (PROVISIONAL, K2)");
    }
    out.push({ mode, name, id: hex(bytes.subarray(nul + 1, nul + 21)) });
    at = nul + 21;
  }
  return out;
}

export interface GitSourceStats {
  commits: number;
  /** Raw commit objects mirrored (K12) and their bytes. */
  commitObjects: number;
  commitBytes: number;
  trees: number;
  blobs: number;
  blobBytes: number;
}

/** A git repository as a `CommitSource`. Close it when done. */
export class GitSource implements CommitSource {
  private readonly cat: CatFile;
  /** git id → object digest, for trees and blobs already converted. */
  private readonly converted = new Map<string, string>();
  /** For checking converted trees against git: `t:`/`b:` digest → git id. */
  private readonly memo = new Map<string, string>();
  readonly stats: GitSourceStats = { commits: 0, commitObjects: 0, commitBytes: 0, trees: 0, blobs: 0, blobBytes: 0 };

  /**
   * `revisions` maps a ref to the git revision to read for it, so a
   * remote-tracking branch can be mirrored as `refs/heads/<name>`
   * (`{ "refs/heads/main": "origin/main" }`). Unmapped refs are read as named.
   */
  constructor(
    readonly dir: string,
    private readonly options: { revisions?: Record<string, string> } = {},
  ) {
    this.cat = new CatFile(dir);
  }

  async firstParent(ref: string): Promise<string[]> {
    const rev = this.options.revisions?.[ref] ?? ref;
    if (rev.startsWith("-")) codeError("invalid-evidence", "GIT_REVISION", `${rev} is not a revision`);
    const { stdout } = await run("git", ["-C", this.dir, "rev-list", "--first-parent", "--reverse", rev, "--"], { maxBuffer: 256 * 1024 * 1024 });
    return stdout.split("\n").filter((l) => l.length > 0);
  }

  async convert(commit: string, objects: ObjectStore, options: { commitObject?: boolean } = {}): Promise<MirrorCommit> {
    const c = await this.cat.read(commit);
    if (c.type !== "commit") codeError("invalid-evidence", "GIT_NOT_COMMIT", `${commit} is a ${c.type}, not a commit`);
    const { tree } = parseGitCommit(c.bytes);
    const digest = await this.tree(tree, objects);
    const bytes = await objects.get(digest);
    this.stats.commits++;
    const out: MirrorCommit = { commit, tree, root: { digest, size: bytes!.length } };
    if (options.commitObject) {
      // K12: the commit object verbatim; its git id must be the commit's own.
      if (gitCommitId(c.bytes) !== commit) codeError("invalid-evidence", "MIRROR_COMMIT_MISMATCH", `git commit ${commit} does not hash to its own id`);
      out.object = await objectDigestAsync(c.bytes);
      await objects.put(out.object, c.bytes);
      this.stats.commitObjects++;
      this.stats.commitBytes += c.bytes.length;
    }
    return out;
  }

  private async tree(id: string, objects: ObjectStore): Promise<string> {
    const known = this.converted.get(id);
    if (known) return known;
    const o = await this.cat.read(id);
    if (o.type !== "tree") codeError("invalid-evidence", "GIT_NOT_TREE", `${id} is a ${o.type}, not a tree`);
    const entries: Tree["entries"] = {};
    for (const e of parseGitTree(o.bytes)) {
      if (e.mode === "40000") entries[e.name] = { mode: "40000", digest: await this.tree(e.id, objects) };
      else if (e.mode === "160000") codeError("unsupported-profile", "GITLINK_UNSUPPORTED", `${e.name} is a gitlink (submodule); the code profile does not mirror them (PROVISIONAL, K9)`);
      else entries[e.name] = { mode: e.mode as Mode, digest: await this.blob(e.id, objects) };
    }
    const bytes = encodeTree({ entries });
    const digest = await objectDigestAsync(bytes);
    await objects.put(digest, bytes);
    // The converted tree must give git's own tree id back (K2).
    const again = await gitTreeIdOf(digest, (d) => objects.get(d), this.memo);
    if (again !== id) codeError("invalid-evidence", "MIRROR_TREE_MISMATCH", `git tree ${id} converts to a tree whose git id is ${again}`);
    this.converted.set(id, digest);
    this.stats.trees++;
    return digest;
  }

  private async blob(id: string, objects: ObjectStore): Promise<string> {
    const known = this.converted.get(id);
    if (known) return known;
    const o = await this.cat.read(id);
    if (o.type !== "blob") codeError("invalid-evidence", "GIT_NOT_BLOB", `${id} is a ${o.type}, not a blob`);
    const digest = await objectDigestAsync(o.bytes);
    await objects.put(digest, o.bytes);
    this.converted.set(id, digest);
    this.memo.set(`b:${digest}`, id);
    this.stats.blobs++;
    this.stats.blobBytes += o.bytes.length;
    return digest;
  }

  close(): void {
    this.cat.close();
  }
}
