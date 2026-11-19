/**
 * Writing a branch Original (plan 049 phase 1): one `originals:1.0` entry per
 * first-parent commit, built with the `@originals/vh/originals` builders, so
 * the state rules are the verifier's own (P4.1, P4.4, P4.6, P5.16). The
 * resource is the commit's root tree (K2, K3); the metadata names the commit
 * (K4). Nothing here changes an Originals rule.
 */
import { signEntry, type EntrySigner, type LogEntry, type UnsignedEntry } from "@originals/vh/log";
import { ORIGINALS_LIMITS, prepareCreateOriginal, prepareUpdateOriginal, type AuthorRef, type EditorGrant, type EntryState } from "@originals/vh/originals";
import { branchMetadata, checkBranchMetadata, type BranchMetadata } from "./documents.js";
import { TREE_MEDIA_TYPE } from "./objects.js";
import { codeError } from "./errors.js";

/** One first-parent commit, converted: its ids and its root tree object. */
export interface MirrorCommit {
  commit: string;
  /** git's tree id of the commit. */
  tree: string;
  /** The root tree object: its digest and size in bytes. */
  root: { digest: string; size: number };
  /**
   * The raw git commit object, stored as an object: its digest (K12, O3).
   * Absent when commit objects are not mirrored.
   */
  object?: string;
}

export interface AppendCommitsInput {
  /** The branch's entries so far, oldest first; empty to start the branch. */
  log: readonly LogEntry[];
  /** The commits to append, oldest first. */
  commits: readonly MirrorCommit[];
  repo: string;
  ref: string;
  /** The repo Original's versionId these entries are made under (K4). */
  repoVersion: string;
  /**
   * Who signs: the branch's author (the delegate), or a granted editor of the
   * branch (P5.15, P5.16). Only the author starts a branch.
   */
  signer: { role: "author" | "editor"; ref: AuthorRef; sign: EntrySigner };
  /** Editor grants at genesis (P5.15). */
  editors?: EditorGrant[];
  /** Milliseconds since the epoch; entries get strictly increasing versionTimes from it. */
  clock?: () => number;
  /**
   * Called before each entry is signed, with the parent's root tree (null at
   * genesis) and the new one. It throws (`outside-grant`) to refuse a change
   * outside the signer's path grant before anything is signed (phase 3).
   */
  check?: (before: string | null, after: string) => Promise<void>;
}

const stateOf = (entry: UnsignedEntry | LogEntry) => entry.state as unknown as EntryState;

/** The code metadata of a branch entry. */
export function metadataOf(entry: UnsignedEntry | LogEntry): BranchMetadata {
  return checkBranchMetadata(stateOf(entry).asset.metadata);
}

/**
 * Append commits to a branch Original. Each entry is signed once and returned;
 * the caller verifies the whole log and commits it (the SDK's import does both,
 * P6.2). The entry limit is checked first (P7.7, P14.13).
 */
export async function appendCommits(input: AppendCommitsInput): Promise<LogEntry[]> {
  if (input.log.length + input.commits.length > ORIGINALS_LIMITS.entries) {
    codeError("limit-exceeded", "BRANCH_TOO_LONG", `a branch Original holds at most ${ORIGINALS_LIMITS.entries} entries (P7.7); ${input.log.length + input.commits.length} needed (plan 049, O1)`);
  }
  if (input.log.length === 0 && input.signer.role !== "author") {
    codeError("outside-grant", "EDITOR_AUTHOR_ONLY", "only the branch's author starts a branch Original (P5.16)");
  }
  const clock = input.clock ?? Date.now;
  let previous: UnsignedEntry | LogEntry | undefined = input.log[input.log.length - 1];
  let lastTime = previous ? Date.parse(previous.versionTime) : -Infinity;
  const out: LogEntry[] = [];
  for (const c of input.commits) {
    const time = Math.max(clock(), lastTime + 1);
    lastTime = time;
    const versionTime = new Date(time).toISOString();
    const metadata = branchMetadata({ repo: input.repo, ref: input.ref, commit: c.commit, tree: c.tree, repoVersion: input.repoVersion, ...(c.object ? { commitObject: c.object } : {}) });
    const resource = { mediaType: TREE_MEDIA_TYPE, size: c.root.size, digest: c.root.digest };
    await input.check?.(previous ? stateOf(previous).asset.resource.digest : null, c.root.digest);
    const unsigned: UnsignedEntry = previous
      ? prepareUpdateOriginal(previous, {
          versionTime,
          metadata,
          resource,
          ...(input.signer.role === "author" ? { author: input.signer.ref } : { editor: input.signer.ref }),
        })
      : prepareCreateOriginal({ versionTime, name: input.ref, metadata, resource, author: input.signer.ref, ...(input.editors ? { editors: input.editors } : {}) });
    const entry = await signEntry(unsigned, input.signer.sign);
    out.push(entry);
    previous = entry;
  }
  return out;
}

/**
 * The commits a branch's entries name, with each one's root tree, oldest
 * first. An entry that repeats its parent's commit (an author entry changing
 * only grants, say) is folded into it, as the verifier folds it.
 */
export function branchChain(entries: readonly LogEntry[]): Array<{ commit: string; root: string; versionId: string }> {
  const out: Array<{ commit: string; root: string; versionId: string }> = [];
  for (const e of entries) {
    const commit = metadataOf(e).commit;
    if (out.length > 0 && out[out.length - 1].commit === commit) continue;
    out.push({ commit, root: stateOf(e).asset.resource.digest, versionId: e.versionId });
  }
  return out;
}
