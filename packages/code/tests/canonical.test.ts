/**
 * CODE-10: the canonical head per ref (plan 049 phase 2, K6, after Radicle
 * 1.3.0's canonical reference rules). Never chosen by timestamp, branch length
 * or signer count (P2.1); a missing branch is incomplete, never a pass
 * (section 7).
 */
import { describe, expect, test } from "bun:test";
import { canonicalHead, type DelegateHead } from "../src/index.js";

const A = "did:vh:A";
const B = "did:vh:B";
const C = "did:vh:C";
const c = (n: string) => n.repeat(40).slice(0, 40);
const chain = (...commits: string[]) => commits.map((x) => ({ commit: c(x), root: `zRoot${x}` }));
const head = (delegate: string, commits: string[] | null, status: DelegateHead["status"] = "valid"): DelegateHead => ({
  delegate,
  branch: `did:vh:branch${delegate.slice(-1)}`,
  status,
  ...(commits ? { chain: chain(...commits) } : {}),
});

describe("CODE-10 canonical head", () => {
  test("threshold 1, one delegate: its head is canonical", () => {
    const r = canonicalHead("refs/heads/main", 1, [head(A, ["1", "2", "3"])]);
    expect(r.status).toBe("agreed");
    expect(r.head).toEqual({ commit: c("3"), root: "zRoot3", votes: [A] });
  });

  test("threshold 2 of 3: the newest commit two delegates' chains contain", () => {
    const r = canonicalHead("refs/heads/main", 2, [head(A, ["1", "2", "3", "4"]), head(B, ["1", "2", "3"]), head(C, ["1", "2"])]);
    expect(r.status).toBe("agreed");
    expect(r.head?.commit).toBe(c("3"));
    expect(r.head?.votes).toEqual([A, B]);
  });

  test("no commit reaches the threshold: no-quorum, no head", () => {
    const r = canonicalHead("refs/heads/main", 2, [head(A, ["1", "2"]), head(B, ["5", "6"])]);
    expect(r.status).toBe("no-quorum");
    expect(r.head).toBeNull();
  });

  test("two delegates diverge at threshold 1: diverged, no head, both tips listed", () => {
    const r = canonicalHead("refs/heads/main", 1, [head(A, ["1", "2", "a"]), head(B, ["1", "2", "b", "b2", "b3"])]);
    expect(r.status).toBe("diverged");
    expect(r.head).toBeNull();
    // The longer branch is not chosen (P2.1): both maximal candidates are reported.
    expect(r.tips?.map((t) => t.commit).sort()).toEqual([c("a"), c("b3")].sort());
  });

  test("a missing branch is incomplete even when the others agree", () => {
    const r = canonicalHead("refs/heads/main", 1, [head(A, ["1"]), head(B, null, "missing")]);
    expect(r.status).toBe("incomplete");
    expect(r.head).toBeNull();
    expect(r.delegates.find((d) => d.delegate === B)?.status).toBe("missing");
  });

  test("a branch whose code history is incomplete makes the result incomplete", () => {
    const r = canonicalHead("refs/heads/main", 1, [head(A, ["1"]), head(B, ["1"], "incomplete")]);
    expect(r.status).toBe("incomplete");
  });

  test("an invalid or forked branch does not vote; the rest decide (K6)", () => {
    const r = canonicalHead("refs/heads/main", 1, [head(A, ["1", "2"]), head(B, ["1", "9"], "invalid"), head(C, null, "forked")]);
    expect(r.status).toBe("agreed");
    expect(r.head?.commit).toBe(c("2"));
    expect(r.delegates.map((d) => [d.delegate, d.status, d.head])).toEqual([
      [A, "valid", c("2")],
      [B, "invalid", null],
      [C, "forked", null],
    ]);
  });

  test("the same commit with two different trees is inconsistent", () => {
    const a = head(A, ["1", "2"]);
    const b = head(B, ["1", "2"]);
    b.chain![1] = { commit: c("2"), root: "zOther" };
    const r = canonicalHead("refs/heads/main", 2, [a, b]);
    expect(r.status).toBe("inconsistent");
    expect(r.head).toBeNull();
  });

  test("two chains ordering the same commits oppositely are inconsistent", () => {
    const r = canonicalHead("refs/heads/main", 2, [head(A, ["1", "2"]), head(B, ["2", "1"])]);
    expect(r.status).toBe("inconsistent");
  });

  test("a delegate with no branch listed does not vote and is not missing", () => {
    const r = canonicalHead("refs/heads/main", 1, [head(A, ["1"])]);
    expect(r.delegates).toHaveLength(1);
    expect(r.status).toBe("agreed");
  });
});
