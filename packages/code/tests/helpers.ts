/** Test helpers: fixture git repositories and in-memory workspaces. */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MemoryStore } from "@originals/sdk/originals";
import { serializeLog, type LogEntry } from "@originals/vh/log";
import { writeEvidence } from "@originals/sdk/originals";
import { CodeWorkspace, MemoryObjectStore, createLocalIdentity, identityEvidence, type LocalIdentity } from "../src/index.js";

export const NOW = Date.parse("2026-11-18T12:00:00Z");

/** A clock that advances one second per call, from NOW. */
export function ticking(start = NOW) {
  let t = start;
  return () => (t += 1000);
}

export async function identity(seed: number): Promise<LocalIdentity> {
  return createLocalIdentity({ updateSecret: new Uint8Array(32).fill(seed), signingSecret: new Uint8Array(32).fill(seed + 100), now: NOW - 3_600_000 });
}

export function workspace(clock = ticking()) {
  return CodeWorkspace.create({ originals: new MemoryStore(), objects: new MemoryObjectStore(), clock });
}

/** A throwaway git repository driven through the git CLI. */
export class FixtureRepo {
  readonly dir: string;
  private n = 0;

  constructor(from?: FixtureRepo) {
    this.dir = mkdtempSync(join(tmpdir(), "originals-code-git-"));
    if (from) execFileSync("git", ["clone", "-q", from.dir, this.dir]);
    else this.git("init", "-q", "-b", "main");
  }

  git(...args: string[]): string {
    return execFileSync("git", ["-C", this.dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: `2026-01-01T00:00:${String(this.n % 60).padStart(2, "0")}Z`, GIT_COMMITTER_DATE: `2026-01-01T00:00:${String(this.n % 60).padStart(2, "0")}Z` },
    }).trim();
  }

  /** Write files (null deletes; `{ link }` makes a symlink; `{ exec }` an executable) and commit. */
  commit(files: Record<string, string | null | { link: string } | { exec: string }>, message = `commit ${this.n}`): string {
    this.n++;
    for (const [path, content] of Object.entries(files)) {
      const full = join(this.dir, path);
      if (content === null) {
        unlinkSync(full);
        continue;
      }
      mkdirSync(dirname(full), { recursive: true });
      try {
        unlinkSync(full);
      } catch {
        /* absent */
      }
      if (typeof content === "string") writeFileSync(full, content);
      else if ("link" in content) symlinkSync(content.link, full);
      else {
        writeFileSync(full, content.exec);
        chmodSync(full, 0o755);
      }
    }
    this.git("add", "-A");
    this.git("commit", "-q", "--allow-empty", "-m", message);
    return this.head();
  }

  head(ref = "HEAD"): string {
    return this.git("rev-parse", ref);
  }

  treeOf(commit: string): string {
    return this.git("rev-parse", `${commit}^{tree}`);
  }

  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export async function setup() {
  const alice = await identity(1);
  const repo = new FixtureRepo();
  const ws = workspace();
  return { alice, repo, ws };
}

/**
 * Commit a log the writer would refuse, as a dishonest or buggy writer would:
 * the SDK verifies it under originals:1.0 (which it satisfies) and commits it,
 * so only the code profile's checks can catch it.
 */
export async function importRaw(ws: CodeWorkspace, entries: LogEntry[], signers: Array<Pick<LocalIdentity, "did" | "log">>, expected?: string) {
  const bytes: Record<string, Uint8Array> = {};
  for (const e of entries) {
    const d = (e.state as { asset: { resource: { digest: string } } }).asset.resource.digest;
    bytes[d] ??= ((await ws.objects.get(d)) ?? (await ws.sdk.resourceBytes(d)))!;
  }
  const last = entries[entries.length - 1].versionId;
  const did = entries[0].state.id as string;
  const zip = writeEvidence({
    manifest: { format: "originals-evidence/0.1", profile: "originals:1.0", original: did, checkpoint: last, head: last, completeness: "complete", missing: [] },
    log: serializeLog(entries),
    authors: signers.map((s) => identityEvidence(s)),
    bytes,
  });
  try {
    return { zip, result: await ws.sdk.import(zip, expected ? { original: expected } : {}) };
  } catch (e) {
    const r = (e as { details?: { report?: { history?: unknown } } }).details?.report;
    throw Object.assign(e as Error, { message: `${(e as Error).message}: ${JSON.stringify(r?.history)}` });
  }
}

export async function logOf(ws: CodeWorkspace, did: string): Promise<LogEntry[]> {
  const { parseLog } = await import("@originals/vh/log");
  return parseLog((await ws.originals.get(did))!.log) as unknown as LogEntry[];
}
