/**
 * The canonical head of a ref (plan 049 phase 2; PROVISIONAL K6, after
 * Radicle 1.3.0's canonical reference rules).
 *
 * Each delegate whose branch Original verifies has a chain: the commits its
 * signed entries name, oldest first. A commit's votes are the delegates whose
 * chain contains it. Agreement is judged over signed chains only; git
 * ancestry outside them (merge second parents) is not trusted, because a
 * verifier cannot check it (plan 049, O2). Candidates are commits with at
 * least `threshold` votes; the head is the one candidate no other follows.
 * Several such candidates are a divergence with no head: nothing is chosen
 * by timestamp, branch length or count (P2.1). A listed branch whose evidence
 * is missing or incomplete makes the whole result incomplete, never a pass
 * (section 7). An invalid or forked branch does not vote (K6; a fork in one
 * delegate's log stays unresolved, P9.16).
 */

export interface ChainLink {
  commit: string;
  /** The root tree digest the entry names. */
  root: string;
}

export interface DelegateHead {
  delegate: string;
  branch: string;
  /**
   * valid: the Originals report is valid as of its checkpoint and the code
   * history is valid. missing: no evidence for the listed branch. incomplete:
   * evidence the code history needs is missing. invalid: either history fails,
   * or the branch is not bound to this repo, ref and delegate. forked: an
   * unresolved fork of the branch Original (P6.6, P9.16).
   */
  status: "valid" | "missing" | "incomplete" | "invalid" | "forked";
  chain?: ChainLink[];
}

export interface CanonicalResult {
  ref: string;
  threshold: number;
  status: "agreed" | "no-quorum" | "diverged" | "incomplete" | "inconsistent";
  head: { commit: string; root: string; votes: string[] } | null;
  /** For `diverged`: each candidate no other candidate follows. */
  tips?: Array<{ commit: string; root: string; votes: string[] }>;
  delegates: Array<{ delegate: string; branch: string; status: DelegateHead["status"]; head: string | null }>;
  reason?: string;
}

export function canonicalHead(ref: string, threshold: number, heads: readonly DelegateHead[]): CanonicalResult {
  const delegates = heads.map((h) => ({
    delegate: h.delegate,
    branch: h.branch,
    status: h.status,
    head: h.status === "valid" && h.chain && h.chain.length > 0 ? h.chain[h.chain.length - 1].commit : null,
  }));
  const result = (status: CanonicalResult["status"], extra: Partial<CanonicalResult> = {}): CanonicalResult => ({ ref, threshold, status, head: null, delegates, ...extra });

  const unknown = heads.filter((h) => h.status === "missing" || h.status === "incomplete");
  if (unknown.length > 0) return result("incomplete", { reason: `evidence missing or incomplete for ${unknown.map((h) => h.delegate).join(", ")}` });

  const voting = heads.filter((h) => h.status === "valid" && h.chain);
  // One root per commit across every voting chain; otherwise the claims contradict each other.
  const rootOf = new Map<string, string>();
  const position = new Map<string, Map<string, number>>(); // delegate -> commit -> index
  for (const h of voting) {
    const at = new Map<string, number>();
    h.chain!.forEach((link, i) => {
      const known = rootOf.get(link.commit);
      if (known !== undefined && known !== link.root) return;
      rootOf.set(link.commit, link.root);
      if (!at.has(link.commit)) at.set(link.commit, i);
    });
    for (const link of h.chain!) {
      if (rootOf.get(link.commit) !== link.root) return result("inconsistent", { reason: `commit ${link.commit} names different trees in different branches` });
    }
    position.set(h.delegate, at);
  }

  const votes = new Map<string, string[]>();
  for (const h of voting) for (const commit of position.get(h.delegate)!.keys()) votes.set(commit, [...(votes.get(commit) ?? []), h.delegate]);
  const candidates = [...votes.entries()].filter(([, v]) => v.length >= threshold).map(([commit]) => commit);
  if (candidates.length === 0) return result("no-quorum");

  // Order the candidates by the chains: an edge from each candidate to the next one in each chain.
  // A cycle means chains order commits both ways; a candidate with a later candidate in any chain is not a tip.
  const isCandidate = new Set(candidates);
  const next = new Map<string, Set<string>>(candidates.map((x) => [x, new Set<string>()]));
  const followed = new Set<string>();
  for (const h of voting) {
    const seq = [...position.get(h.delegate)!.keys()].filter((x) => isCandidate.has(x));
    for (let i = 0; i + 1 < seq.length; i++) {
      next.get(seq[i])!.add(seq[i + 1]);
      followed.add(seq[i]);
    }
  }
  const indegree = new Map<string, number>(candidates.map((x) => [x, 0]));
  for (const targets of next.values()) for (const t of targets) indegree.set(t, indegree.get(t)! + 1);
  const ready = candidates.filter((x) => indegree.get(x) === 0);
  let seen = 0;
  while (ready.length > 0) {
    const x = ready.pop()!;
    seen++;
    for (const t of next.get(x)!) {
      indegree.set(t, indegree.get(t)! - 1);
      if (indegree.get(t) === 0) ready.push(t);
    }
  }
  if (seen !== candidates.length) return result("inconsistent", { reason: "chains order the same commits differently" });
  const tips = candidates.filter((x) => !followed.has(x));
  const describe = (commit: string) => ({ commit, root: rootOf.get(commit)!, votes: [...votes.get(commit)!].sort() });
  if (tips.length === 1) return result("agreed", { head: describe(tips[0]) });
  return result("diverged", { tips: tips.map(describe), reason: "candidates with enough votes diverge; no head is chosen (P2.1)" });
}
