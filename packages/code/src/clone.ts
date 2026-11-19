/**
 * What a git clone of a verified repo bundle holds (plan 049 phase 5;
 * PROVISIONAL K16). Browser-safe: it plans the clone and yields git's own
 * objects, rebuilt from the mirrored objects; `git-remote-originals` writes
 * them into a repository.
 *
 * A ref is clonable only when its canonical head is agreed (K6) and the
 * branch it is cloned from verifies completely: both reports valid, content
 * complete, every git tree id and every commit id recomputed from the
 * objects (`gitBinding` and `commitBinding` both `matches`). Otherwise the
 * ref is refused, with the reason; nothing is guessed or rebuilt
 * approximately.
 *
 * Commits are the mirrored raw commit objects (K12), byte for byte, so their
 * ids are the original repository's. Trees are rebuilt as git's tree objects
 * (K2) and blobs are the exact bytes. Only first-parent history is mirrored
 * (K9): a merge commit names second parents the clone does not hold. Those
 * are listed as grafts (`info/grafts`: the merge and its first parent), and a
 * chain that starts mid-history (its first commit has a parent) is marked
 * shallow at that commit (`shallow`). Every object stays byte-identical; the
 * omissions are stated in those two files (K16).
 */
import { metadataOf } from "./branch.js";
import { codeError } from "./errors.js";
import { gitBlobId, gitObjectId, gitTreeBody, parseGitCommit, readTree } from "./objects.js";
import type { OpenedRepository } from "./verify.js";

export interface ClonePlan {
  ref: string;
  /** The agreed canonical head. */
  head: string;
  /** The branch Original (newest segment) the clone is rebuilt from: the first voter's. */
  branch: string;
  /** First-parent commits through the head, oldest first, with each one's commit object and root tree. */
  commits: Array<{ commit: string; tree: string; commitObject: string; root: string }>;
  /** Merge commits and their first parents: second parents are not mirrored (K9). */
  grafts: Array<[string, string]>;
  /** The first commit, when it has a parent the bundle does not hold (a chain starting mid-history). */
  shallow: string | null;
}

export interface GitObject {
  type: "commit" | "tree" | "blob";
  id: string;
  bytes: Uint8Array;
}

/** The refs a clone can hold, and those refused with the reason. */
export async function planClone(opened: OpenedRepository): Promise<{ plans: ClonePlan[]; refused: Array<{ ref: string; reason: string }> }> {
  const { report } = opened;
  const plans: ClonePlan[] = [];
  const refused: Array<{ ref: string; reason: string }> = [];
  if (report.canonicalStatus !== "computed") {
    return { plans, refused: [{ ref: "*", reason: `the repo Original does not verify (canonical heads ${report.canonicalStatus})` }] };
  }
  for (const c of report.canonical) {
    if (c.status !== "agreed" || !c.head) {
      refused.push({ ref: c.ref, reason: `canonical head ${c.status}${c.reason ? `: ${c.reason}` : ""}` });
      continue;
    }
    const voter = [...c.head.votes].sort()[0];
    const listed = c.delegates.find((d) => d.delegate === voter)!;
    const b = report.branches.find((x) => x.original === listed.branch);
    const code = b?.code;
    const why = !code
      ? "the voting branch has no code report"
      : code.content.status !== "complete"
        ? `content ${code.content.status}`
        : code.gitBinding.status !== "matches"
          ? `git trees ${code.gitBinding.status}`
          : code.commitBinding.status !== "matches"
            ? `commit ids ${code.commitBinding.status}: commits are rebuilt only from mirrored commit objects (K12)`
            : null;
    if (why || !code) {
      refused.push({ ref: c.ref, reason: why ?? "no code report" });
      continue;
    }
    const at = code.chain.findIndex((l) => l.commit === c.head!.commit);
    const commits: ClonePlan["commits"] = [];
    for (const link of code.chain.slice(0, at + 1)) {
      const entry = opened.entries.get(link.original)?.find((e) => e.versionId === link.versionId);
      const m = entry ? metadataOf(entry) : undefined;
      if (!m?.commitObject) return codeError("incomplete-evidence", "CLONE_COMMIT_OBJECT", `commit ${link.commit} has no commit object`);
      commits.push({ commit: link.commit, tree: m.tree, commitObject: m.commitObject, root: link.root });
    }
    const grafts: Array<[string, string]> = [];
    let shallow: string | null = null;
    for (let i = 0; i < commits.length; i++) {
      const bytes = await opened.objects(commits[i].commitObject);
      if (!bytes) return codeError("unavailable-bytes", "OBJECT_MISSING", `commit object ${commits[i].commitObject} is missing`);
      const { parents } = parseGitCommit(bytes);
      if (i === 0 && parents.length > 0) shallow = commits[0].commit;
      if (parents.length > 1) grafts.push([commits[i].commit, parents[0]]);
    }
    plans.push({ ref: c.ref, head: c.head.commit, branch: listed.branch, commits, grafts, shallow });
  }
  return { plans, refused };
}

/**
 * git's objects for `plan`, each once (`seen` holds git ids already given),
 * every id recomputed and checked: a commit object must hash to its commit
 * and name its tree; a rebuilt tree must hash to the tree its commit names.
 */
export async function* gitObjectsOf(opened: OpenedRepository, plan: ClonePlan, seen: Set<string> = new Set(), memo: Map<string, string> = new Map()): AsyncGenerator<GitObject> {
  const get = opened.objects;
  const need = async (digest: string) => {
    const b = await get(digest);
    if (!b) return codeError("unavailable-bytes", "OBJECT_MISSING", `object ${digest} is missing`);
    return b;
  };
  async function* tree(digest: string): AsyncGenerator<GitObject> {
    const body = await gitTreeBody(digest, get, memo);
    const id = gitObjectId("tree", body);
    memo.set(`t:${digest}`, id);
    if (seen.has(id)) return;
    seen.add(id);
    for (const entry of Object.values((await readTree(digest, get)).entries)) {
      if (entry.mode === "40000") yield* tree(entry.digest);
      else {
        const bytes = await need(entry.digest);
        const blobId = memo.get(`b:${entry.digest}`) ?? gitBlobId(bytes);
        memo.set(`b:${entry.digest}`, blobId);
        if (seen.has(blobId)) continue;
        seen.add(blobId);
        yield { type: "blob", id: blobId, bytes };
      }
    }
    yield { type: "tree", id, bytes: body };
  }
  for (const c of plan.commits) {
    const bytes = await need(c.commitObject);
    if (gitObjectId("commit", bytes) !== c.commit) codeError("invalid-evidence", "GIT_COMMIT_MISMATCH", `commit object ${c.commitObject} is not commit ${c.commit}`);
    if (parseGitCommit(bytes).tree !== c.tree) codeError("invalid-evidence", "COMMIT_TREE_MISMATCH", `commit ${c.commit} names another tree`);
    yield* tree(c.root);
    if (memo.get(`t:${c.root}`) !== c.tree) codeError("invalid-evidence", "GIT_TREE_MISMATCH", `the root tree of ${c.commit} rebuilds to ${memo.get(`t:${c.root}`)}, not ${c.tree}`);
    if (seen.has(c.commit)) continue;
    seen.add(c.commit);
    yield { type: "commit", id: c.commit, bytes };
  }
}
