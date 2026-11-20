/**
 * Rebuild a workspace's objects from git (plan 049 §6 milestone 1;
 * PROVISIONAL K22). Objects are content-addressed conversions of git's trees,
 * blobs and commit objects (K2, K12), so a workspace that keeps only its
 * signed logs (the dogfood mirror branch) can get every object back from the
 * repository itself. Each converted root tree and commit object must have the
 * digest the entry names, or nothing is trusted: the logs and git disagree.
 */
import { metadataOf } from "./branch.js";
import { codeError } from "./errors.js";
import type { CodeWorkspace, CommitSource } from "./workspace.js";

export interface RehydrateResult {
  /** Branch Originals (segments included) walked. */
  branches: number;
  /** Distinct commits converted. */
  commits: number;
}

/** Convert, from `source`, every commit a listed branch of `repo` names, storing its objects in the workspace. */
export async function rehydrateObjects(ws: CodeWorkspace, repo: string, source: CommitSource, options: { onProgress?: (done: number) => void } = {}): Promise<RehydrateResult> {
  const { document } = await ws.repoState(repo);
  const listed = [...new Set(Object.values(document.refs).flatMap((r) => Object.values(r.branches)))].sort();
  const done = new Set<string>();
  let branches = 0;
  for (const did of listed) {
    for (const segment of await ws.segments(did)) {
      branches++;
      for (const e of segment) {
        const m = metadataOf(e);
        if (done.has(m.commit)) continue;
        const root = (e.state as { asset: { resource: { digest: string } } }).asset.resource.digest;
        const c = await source.convert(m.commit, ws.objects, { commitObject: m.commitObject !== undefined });
        if (c.root.digest !== root || c.tree !== m.tree) codeError("invalid-evidence", "REHYDRATE_MISMATCH", `commit ${m.commit} converts to root ${c.root.digest}, but entry ${e.versionId} names ${root}`);
        if (m.commitObject !== undefined && c.object !== m.commitObject) codeError("invalid-evidence", "REHYDRATE_MISMATCH", `commit ${m.commit}'s object is ${c.object ?? "absent"}, but entry ${e.versionId} names ${m.commitObject} (K12)`);
        done.add(m.commit);
        options.onProgress?.(done.size);
      }
    }
  }
  return { branches, commits: done.size };
}
