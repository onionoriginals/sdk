# @originals/code (PROVISIONAL)

Git-like version control on ordinary `originals:1.0` Originals: signed,
offline-verifiable, no Bitcoin. Design, rules and open questions:
[plan 049](../../plans/049-originals-for-code.md). The package is private and
unpublished; every name and format in it is PROVISIONAL.

- A **branch Original** per (delegate, ref): one entry per first-parent
  commit. Its resource is the commit's root tree; its metadata names the commit.
- Trees and blobs are **content-addressed objects** (sha2-256 multihash),
  stored once however many versions share them. Trees mirror git's, so a
  verifier recomputes each commit's git tree id from them.
- Each commit's **raw git commit object** is mirrored verbatim too (K12), so
  a verifier recomputes the commit id, its tree and its first parent
  (`commitBinding`). Public by default; for a workspace marked `--private`
  only with `--include-commits`, since commit objects carry author emails.
  Without one, a commit id is reported as claimed.
- A branch longer than one Original's entry limit (10,000, P7.7) is a **chain
  of segments** (K13): each segment's genesis names the previous one's did and
  last versionId; the repo document lists the newest, and the verifier walks
  the chain, checking that commits continue across segments.
- A **repo Original** lists delegates, per-ref thresholds, each delegate's
  branch and per-path grants.
- Anyone may publish a **contribution**: their own branch Original for a ref,
  naming the repo but not listed in it (K14). It is verified and reported on
  its own, and never votes.
- A **release Original** named by the repo document records releases: tag,
  commit, branch entry and the canonical result at the time (K15). It can be
  anchored on Bitcoin with the SDK's own flow; branches stay unanchored.
- The **canonical head** of a ref is computed from threshold agreement across
  delegates' branches, never by timestamp (P2.1), and is reported on its own.

```sh
originals-code identity new me.json
originals-code init    --dir ws --identity me.json --name my-repo   # --private: commit objects need --include-commits
originals-code mirror  --dir ws --identity me.json --git . --ref refs/heads/main
originals-code package --dir ws --out repo.zip
# a contributor: take the bundle, mirror your own branch, package with it
originals-code import  repo.zip --dir mine
originals-code mirror  --dir mine --identity bob.json --git ../fork --contribute
originals-code package --dir mine --out with-contribution.zip
originals-code release v1.0.0 --dir ws --identity me.json   # the repo's author records a release
originals-code verify  repo.zip           # no key, no network
originals-code serve   repo.zip --port 4180  # browse it, GitHub-style, at http://127.0.0.1:4180/
```

```ts
import { verifyRepository } from "@originals/code";
const report = await verifyRepository(bundleBytes);
report.repo;        // the repo Original: SDK report + code checks
report.branches;    // per branch: SDK report, code history, content, git trees, commit ids, grants
report.canonical;   // per ref: agreed | no-quorum | diverged | incomplete | inconsistent
report.contributions; // contributor branches: verified, never voting
report.releases;    // the release Original: SDK report + each release checked against its branch chain
report.current;     // always false: nothing here is anchored (P7.10)
```

Entry points: `@originals/code` (browser-safe), `@originals/code/fs` (a
workspace on disk), `@originals/code/git` (reads a git repository).

Acceptance on this repository: `bun run acceptance` (in this package).
Anchoring a release Original on disposable regtest: `bun run release:regtest`.
