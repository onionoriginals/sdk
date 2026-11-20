# 049 — Originals for code: signed, offline-verifiable version control on Originals

Status: **phases 0–3 merged (#1064); the owner's 2026-11-19 follow-ups built: O3 commit objects (K12), O1 segments (K13), O7 contributions (K14), the release Original (K15) and phase 5, `git-remote-originals` (K16). Phase 4 was decided on 2026-11-19 as a core spec change (§6, plan 050, W1–W3 merged as #1071–#1073), and the code profile now runs on it: `originals-code/0.2` (§1.5, revised K4, K5, K7, K15, new K17 and K18); §8 has the results.** Written 2026-11-18 against `main` at `e5a3e3d4`. Rule IDs refer to
the pinned Originals Protocol (`aviarytech/originals-spec@45ed1dc`, see
[`specs/README.md`](../specs/README.md)); terms follow
[`CONTEXT.md`](../CONTEXT.md) and the consumer contract
[`packages/sdk/ORIGINALS.md`](../packages/sdk/ORIGINALS.md).

## 0. Goal and constraints

A git-like version-control layer whose history is signed, verifies offline,
and is built from ordinary Originals. The test case is this repository: 1,537
commits on `main` (675 on its first-parent chain), 2,031 files at `main`, and
a 114 MiB git pack.

Constraints, set by the owner:

- **No change to `originals:1.0` from this plan.** (Phase 4's signer sets,
  parent Originals and scoped grants were added to `originals:1.0` itself by
  plan 050; profile 0.2 uses them, §1.5.) Every log this layer writes is an ordinary
  Original under `originals:1.0`. A plain Originals verifier accepts it and
  reports exactly what it reports for any other Original. The code rules are a
  separate profile, `originals-code/0.1` (PROVISIONAL name), checked on top of
  a valid Originals report, never instead of one (P3.5 by analogy: generic
  Originals verification is never reported as code verification, and code
  verification never replaces Originals verification).
- **No Bitcoin.** No anchoring, sats or fees. Every Original here is
  unanchored, so it is never current (P7.10) and its ordering is claimed only
  (P7.6, Q14). The code reports say "valid as of" a checkpoint, never "current".
- **Limits.** `ORIGINALS_LIMITS` holds: 10,000 entries per log, 65,536 bytes
  per entry, 32 editor grants (P7.7, P14.13).
- **A new package**, `packages/code` (`@originals/code`, PROVISIONAL name), on
  top of `@originals/vh` and `@originals/sdk`. No `originals:1.0` code changes.

## 1. Model (after Radicle)

Radicle's model: a repository identity document names delegates and a
threshold; each delegate publishes refs in its own namespace; a canonical ref
is computed from the delegates' refs when enough of them agree (Radicle 1.3.0
canonical reference rules). Nobody merges inside one person's history.

Mapped onto Originals:

| Radicle | Originals for code | Rules |
|---|---|---|
| Delegate namespace `refs/namespaces/<nid>/refs/heads/main` | A **branch Original**: one per (delegate, ref), authored by that delegate alone | P5.2, P5.8 |
| Commit | One branch Original entry per **first-parent** commit; the entry's resource version is the commit's tree manifest, its metadata names the commit | P4.1, P4.4 |
| Blobs and trees | Content-addressed objects named by their sha2-256 multihash, outside the asset log, deduplicated by digest; the root tree is the Original's resource | P4.3 |
| Identity document (`rad/id`) | A **repo Original** whose resource is the repo document: name, delegates, refs with thresholds, the branch Original of each delegate per ref, and path grants | P4.1 |
| Canonical ref | The **canonical head**, computed from threshold agreement across the branch Originals; a separate report | P2.1, section 7 |
| Divergent delegates | Separate Originals; disagreement is reported, never merged | P6.6, P9.16 |

Consequences:

- A fork **inside one delegate's branch Original** is an ordinary Originals
  fork: an unresolved conflict with no current branch (P6.6, P9.16). That
  delegate's branch then has no head and does not vote (PROVISIONAL, §3.2).
- Divergence **between delegates** is the normal state of a repository. It is
  reported by the canonical-head computation as `diverged` and never resolved
  by timestamp, branch length or signer count (P2.1).
- **Nothing is merged inside a log.** A delegate that adopts another's work
  appends an ordinary single-parent entry naming the merged commit (P6.6: an
  entry bringing content from another branch is an ordinary entry).
- **Ownership is not authority.** There is no owner: nothing is anchored (P9.11).

### 1.1 Objects (PROVISIONAL; unchanged in `originals-code/0.2`)

Digests are sha2-256 multihashes, multibase base58btc (`zQm…`), exactly the
Originals resource digest (P4.3, P14.7), computed over the exact bytes.

- **Blob**: the exact bytes of a file (for a symlink, its target), as git
  stores them.
- **Tree**: the JCS (RFC 8785) bytes of
  `{"entries":{"<name>":{"mode":"<git mode>","digest":"z…"}},"format":"originals-code-tree/0.1"}`.
  A tree is one directory, as in git; a subtree's entry has mode `40000` and
  names the subtree's digest. Modes are git's raw tree modes: `100644`,
  `100755`, `120000` and `40000`. Gitlinks (`160000`, submodules) are refused
  (`GITLINK_UNSUPPORTED`, PROVISIONAL). Names are non-empty, contain no `/` or
  NUL, and are not `.` or `..`. A tree's bytes must equal the JCS of their
  parse (no second encoding of the same tree).
- **Root tree**: the Original's resource at each version, media type
  `application/vnd.originals.code-tree+json` (PROVISIONAL; RFC 6838
  `type/subtype`, no parameters, as the descriptor rules require).

**Why a tree per directory, not one flat `path → digest, mode` manifest.**
A flat manifest of this repository is about 240 KB per version, so 675
versions would store about 160 MB of manifests alone. Splitting it by
directory, as git does, stores a directory again only when something under it
changed, and makes the per-path grant check (phase 3) skip unchanged
subtrees by digest. The flat view (`path → {mode, digest}`) is still what the
API exposes (`flattenTree`), and what diffs and grants are defined over. The
manifest stays out of the asset state: the state carries only its descriptor,
so a large tree never meets the 65,536-byte entry limit (P7.7).

Because trees mirror git's tree structure and modes exactly, a verifier holding
the objects can recompute the **git tree SHA-1** of every version and compare it
with the one the entry's metadata claims (`gitBinding` report).

- **Commit object** (K12, O3, PROVISIONAL): the raw git commit object, byte for
  byte (`tree`, `parent`s, author, committer, any signature and the message),
  held as an object like a blob. A verifier holding it recomputes the commit
  id as git does (SHA-1 of `commit <size>\0` and the bytes), and reads its
  `tree` and first `parent` lines (`commitBinding` report, §2). Second parents
  stay named in the object, but their commits are not mirrored (K9). Without a
  commit object, the commit id is reported as **claimed** by the signer.

### 1.2 Branch Original (PROVISIONAL)

- `name`: the ref, `refs/heads/<branch>`.
- `metadata.code`: exactly
  `{ "profile": "originals-code/0.2", "repo": "<repo did:vh>", "ref": "<ref>", "commit": "<40 hex>", "tree": "<40 hex>" }`
  (0.1 also had `"repoVersion"`, replaced in 0.2 by the core pin, §1.5),
  plus `"commitObject": "z…"` (K12), the digest of the raw commit object, when
  it is mirrored. Mirroring is public by default: the writer includes commit
  objects unless the source is marked private, where it needs an explicit
  opt-in (`commits: true`, CLI `--include-commits`), since a commit object
  carries author and committer emails and Originals give no confidentiality
  (P8.2). An entry that repeats its parent's commit repeats its `commitObject`.
  `repoVersion` names the repo Original's version the entry was made under, so
  path grants are judged against a named version, as an entry names its
  author DID version (P5.1, P5.3). It never goes backwards within a branch
  (as signer versionIds never do, P5.8).
- `resource`: the root tree of the commit (P4.1). A commit whose tree is
  unchanged leaves the version unchanged (P4.4); its entry still records the
  commit.
- Author: the delegate (P5.2, P5.8). Contributors who are not delegates write
  to a branch as **editors** (P5.15–P5.18) with `metadata: true` and
  `resource: true`, bounded by path grants (phase 3).
- **Segments** (K13, O1, PROVISIONAL): a branch Original holds at most
  `ORIGINALS_LIMITS.entries` entries (P7.7). When a mirror would exceed it,
  the writer fills the current segment and starts a new segment Original
  whose genesis metadata carries `"previous": { "did", "versionId" }`: the
  previous segment's did:vh and its last versionId. Only a genesis carries
  `previous`, and only the branch's author starts a segment (an editor that
  reaches the limit is refused, `SEGMENT_AUTHOR_ONLY`). The repo document
  lists the **current** (newest) segment for each delegate and ref; bundles
  carry every segment. The verifier walks the chain from the listed segment:
  each previous segment must be in the evidence (else `incomplete`), valid
  under both reports, by the same author, and end exactly at the named
  versionId (a closed segment that continues is `SEGMENT_CONTINUED`,
  invalid). Commits continue across segments: no commit repeats, the
  genesis's commit object's first parent is the previous segment's last
  commit (K12), path grants diff against the previous segment's last root,
  and `repoVersion` never goes backwards. Each segment is reported with its
  own Originals report and `segment` position; earlier segments of a
  confirmed branch have binding `superseded`. The listed segment's `chain`
  is the whole branch's, and is what votes for canonical heads.
- One entry per first-parent commit, oldest first. A merge commit is one
  entry; its second parents are not mirrored. `versionTime` is the time the
  mirror signs, never the commit time (git commit times are not monotonic
  along a branch; VH-Log requires increasing `versionTime`).

### 1.3 Repo Original (PROVISIONAL; 0.1 as first built, revised in §1.5)

- `name`: the repository name.
- `resource`: the repo document, JCS bytes, media type
  `application/vnd.originals.code-repo+json`:

```jsonc
{
  "format": "originals-code-repo/0.1",
  "delegates": ["did:vh:…alice", "did:vh:…bob"],
  "refs": {
    "refs/heads/main": {
      "threshold": 1,
      "branches": { "did:vh:…alice": "did:vh:…(alice's branch Original)" }
    }
  },
  "grants": [ { "did": "did:vh:…carol", "paths": ["packages/vh/**"] } ]
}
```

- The repo Original's author is the founding delegate. Today only that one
  author changes the repo document (P5.2; owner decision S8). Changing
  delegates or thresholds with several delegates' agreement is phase 4, a
  protocol change, not implemented.
- `threshold` is an integer from 1 to the number of delegates. `branches`
  keys are delegates. Each listed branch Original must name this repo and ref
  in its metadata and be authored by that delegate: the binding counts only in
  both directions (as an alias does, P3.6).
- **Contributions** (K14, O7, PROVISIONAL): anyone may publish their own
  branch Original for a ref, with the same metadata (naming this repo, the
  ref and a repo version), authored by themselves and not listed in the repo
  document. The verifier checks it like any branch (both reports, segments,
  trees, commit objects) and reports it under `contributions` with binding
  `contribution`: verified, **never voting**; canonical heads read only listed
  branches. A failing contribution is reported and does not fail the repo
  (`originals-code verify` exits 0 for the repo). A contributor takes a
  repo bundle into a workspace (`originals-code import`, which verifies it
  offline first and refuses a bundle whose repo Original fails), mirrors with
  `--contribute`, and packages: bundles carry the contributions their
  workspace holds. The second role stays: a trusted contributor writes into a
  delegate's branch as an editor with a path grant (phase 3).
- `grants` lists path grants (phase 3). A branch's own author is
  unrestricted in that branch; every other signer of it, another delegate
  included, needs a path grant.

### 1.4 Release Original (K15, PROVISIONAL; owner decision 2026-11-19)

- The repo document gains an optional `releases` member: the release
  Original's did:vh. The repo's author creates it with the first release and
  names it (plan 050 W1 later makes its author the delegate set, signing by
  threshold).
- `metadata.code`: exactly `{ "profile", "kind": "releases", "repo" }`.
- Each entry names one release. Its resource is a small JSON release
  manifest (JCS bytes, media type
  `application/vnd.originals.code-release+json`):
  `{ "format": "originals-code-release/0.1", "tag", "ref", "commit", "branch", "versionId", "canonical": { "status", "head", "threshold", "votes" } }`.
  `branch` and `versionId` name the branch Original (any segment, K13) and
  the entry naming the commit; `canonical` records the canonical result the
  releaser's own offline verification gave at the time, as a claim.
- Writer (`originals-code release <tag>`): signed by the repo's author; the
  commit is the agreed canonical head unless `--commit` names another, which
  must be in a listed, verified branch's chain; a tag is released once.
- Verifier (`report.releases`, its own result): the release Original's
  Originals report unchanged (anchored or not), its author the repo's author,
  bound both ways, tags not repeated, and each release's commit at the named
  entry of the named branch's chain (`RELEASE_NOT_IN_CHAIN` is invalid). A
  branch missing from the evidence leaves the release `branch-missing` and
  the release history incomplete, never a pass.
- Anchoring uses the SDK's own flow (`sdk.anchor`,
  `prepareEntryInscription`, `submitEntryInscription`, `readAnchored`). Only
  the release Original (and later the repo Original) is anchored; branch
  Originals stay unanchored. Anchoring a private repo's releases needs a
  disclosure warning (§6). Tested on disposable regtest only.

### 1.5 Profile 0.2: the code profile on signer sets, parents and scoped grants (built 2026-11-19; plan 050 §5 step 3)

The owner's decisions of 2026-11-19 (§6) move what 0.1 kept in its own
documents into the core. `originals-code/0.2` (PROVISIONAL) replaces 0.1; 0.1
bundles are not read, because nothing was published under 0.1 (no migration,
as plan 011 did for earlier formats).

- **Repo Original (K5, revised).** A set Original (P5.19) whose `authors`
  are the delegates, with a threshold. Every delegate signs its genesis; each
  later change (refs, per-ref thresholds, branch listings, delegates, the
  release Original, grants) is an author entry signed by the threshold of the
  set before it and by every delegate it adds (P5.20). The repo document is
  `{ "format": "originals-code-repo/0.2", "delegates", "refs", "releases"? }`:
  `delegates` must equal `authors.dids` at every version
  (`REPO_DELEGATES_MISMATCH`), and `grants` is gone. Delegates who are not
  together sign a proposal file in turn (K18): `CodeWorkspace.proposeRepo`
  → `cosignRepo` → `commitRepo`, CLI `originals-code repo propose|cosign|commit`.
  The repo Original names no parent. `SIGNER_SET_UNSUPPORTED` is gone.
- **Branch Originals (K4, revised).** A W2 child of the repo Original
  (`parent.did` = the repo; P5.24), with one author, its delegate or
  contributor (`BRANCH_SET_AUTHOR` otherwise). Each entry pins a repo
  version; writers pin the newest repo version they hold. The pin replaces
  `metadata.code.repoVersion`. Within a log the core checks the pin
  (backwards, other branch, unknown version: P5.24, P5.25); across a segment
  boundary the code profile does (`PIN_BACKWARDS`). A branch has no `editors`
  of its own (`BRANCH_EDITORS`).
- **Path grants (K7, revised).** A path grant is an editor grant in the repo
  Original's `editors`: `{did, name: false, metadata: true, resource: true,
  scope: {type: "paths", paths}}` (P5.15, P5.28, P14.23; `metadata` because
  every branch entry names its commit there). Every branch inherits it at the
  version it pins (P5.24), so no per-branch grant is needed. The core checks
  the scope over the code tree's path view; the code report restates, per
  editor entry, the grant source, pin and scope status from the Originals
  report, and its P5.26 labels (`inherited-grant-revoked`), and computes
  nothing of its own. P5.15 makes editors and members disjoint, so a
  delegate writes only its own branch; others write by grant. A grant
  without a scope allows every path.
- **Release Original (K15 revised, K17).** A set Original with the repo's
  members and threshold, and a child of the repo: at every entry its
  `authors` equal the repo's `authors` at the entry's pin
  (`RELEASES_AUTHORS`). A child gains nothing for authorship from its parent
  (P5.24: the parent's signer set has no authority over the child), so the
  release Original carries the set itself, and the pin says which repo
  version's set that is. A delegate change reaches releases with the next
  release, which pins the new repo version and changes the release set,
  signed by the old set's threshold and every added member (P5.20). Creating
  it is a set Original's genesis, which every delegate signs (P5.19). Chosen
  over "a child only", which would leave releases to one author, and over
  "a set only", which would leave no link from a release to the repo version
  whose delegates signed it.
- **Contributions and segments.** A contribution and every segment are
  children of the repo; a segment's genesis still names its previous segment
  in `metadata.code.previous` (K13).
- **Viewer.** The repo page shows the signer set and threshold and the
  repo's path grants (inherited by every branch); commit pages show each
  entry's pin and, for an editor entry, the inherited grant and its scope
  check; the verification page shows the parent evidence status.

## 2. Verification and reports (section 7: reports stay separate)

`verifyRepository(bundle)` returns, with nothing merged into one verdict:

- `repo`: the repo Original's Originals report (`OriginalsReport`, unchanged)
  and the repo document check.
- `branches[]`: per branch Original, its Originals report, unchanged, and a
  separate `code` report:
  - `history`: valid · invalid (first failing entry, code) — the code profile
    over the entries: metadata shape, bindings, repoVersion monotonic, trees.
  - `content`: complete · partial (missing objects listed) · digest-failure.
    Missing objects are an explicit incomplete result, never a pass, and never
    a history failure (P7.3, P7.4 by analogy).
  - `gitBinding`: per entry `matches` · `mismatch` · `unchecked` (objects
    missing). A mismatch fails the code history.
  - `commitBinding` (K12): for each commit whose entry names a commit object,
    its SHA-1 must be the entry's commit, its `tree` line the entry's tree, and
    its first parent the previous entry's commit; a mismatch fails the code
    history. Status `matches` · `mismatch` · `unchecked` (a commit object is
    missing; content is then partial) · `claimed` (some commit has no commit
    object). `base` is the first parent of the branch's first commit (null for
    a root commit).
  - `grants`: per editor entry, the grant the Originals report found (source,
    pin, scope status; 0.2, K7); `historicallyAuthorizedOnly` restates the
    Originals report's P5.26 labels. In 0.1 these were computed here against
    the repo document's `grants`.
- `canonical[]`: per ref, its own result (§3.2).
- `validAsOf`: the repo checkpoint and each branch checkpoint used. Never
  `current` (P7.10).

## 3. Phases

### Phase 0 — this plan (docs only)

### Phase 1 — Mirror

- `@originals/code`: objects (blob/tree encode, decode, strict JCS check,
  flatten, diff), a content-addressed object store interface with memory and
  Node fs (deflate-compressed files, PROVISIONAL) implementations.
- `@originals/code/git` (Node only): reads a git repository with one
  `git cat-file --batch` process, walks the first-parent chain, converts trees
  and blobs once each (cached by git object id), and builds the branch
  Original's entries with the `@originals/vh/originals` builders. It signs each
  entry once and verifies the whole log once at the end, then imports it
  through `OriginalsSDK.import` (durable commit, P6.2). (The SDK's `edit`
  verifies the whole history at each commit, which is quadratic over hundreds of
  entries.) Incremental: a later mirror appends only commits after the
  branch's head commit; a head commit that is no longer on the first-parent
  chain (a force-push) is refused as `MIRROR_DIVERGED` — never a silent rebase
  (P4.5).
- `package`: a **repo bundle** (PROVISIONAL `originals-code-bundle/0.1`), a
  stored-only ZIP written with the SDK's codec:

```
originals-code.json        { format, repo, checkpoint, branches: [{original, checkpoint}],
                             objects: { count, bytes }, completeness, missing }
originals/<scid>.zip       each Original's evidence package, exactly as sdk.package writes it (P7.1, P14.10)
objects/index.json         [[digest, offset, compressedLength, size], …], sorted by digest
objects/pack               the objects, each deflate-raw compressed, concatenated
```

  Objects carried are every tree and blob reachable from every packaged
  version of every branch. The reader bounds counts and sizes before
  inflating, inflates each object to at most its declared size and checks its
  digest; the index is untrusted. Each Original's package verifies with
  `sdk.load` unchanged, offline, with no key (P7.3).
- CLI `originals-code`: `identity new`, `init`, `mirror`, `package`,
  `verify` (`--json`). Local did:vh identities with an update key separate
  from the assertion key (P5.11); key custody is out of scope (#46).

### Phase 2 — Repo Original and canonical heads

Canonical head per ref (PROVISIONAL, after Radicle 1.3.0):

1. Each delegate listed for the ref with a branch Original that verifies
   (Originals report `validAsOf` non-null, code history valid) has a
   **chain**: the commits its entries name, through its checkpoint.
2. `votes(C)` = the delegates whose chain contains commit `C`. Agreement is
   judged only over signed chains: git ancestry outside them (merge second
   parents) is not trusted, because the verifier cannot check it.
3. Candidates are commits with `votes ≥ threshold`. A candidate precedes
   another if some chain contains both in that order.
4. No candidate: `no-quorum`. Exactly one maximal candidate: `agreed`, with
   that head and its voters. Several maximal candidates: `diverged`, no head
   (never chosen by timestamp, length or count, P2.1).
5. A listed branch whose evidence is missing makes the result `incomplete`,
   with no head (section 7). A branch that is invalid or forked (P9.16) does
   not vote and is listed with its status; the result is computed from the
   others (PROVISIONAL: a delegate cannot block the others by forking).
6. Two entries naming the same commit with different trees are an
   inconsistency: the result is `inconsistent`, with no head.

Threshold 1 with one delegate needs no protocol change.

### Phase 3 — Per-path grants

- Grant patterns (PROVISIONAL): `/`-separated, relative, no `.`/`..` segment;
  `*` matches within one segment, `**` matches zero or more whole segments;
  nothing else is special. `packages/vh/**` covers everything under
  `packages/vh/`.
- An entry signed by a non-delegate (an Originals editor of the branch) is
  checked against the path grants of the repo document **at the version its
  `repoVersion` names**. Every path its diff touches (added, removed, changed
  content or mode, from the parent entry's tree) must be covered, or the code
  history is invalid at that entry (`OUTSIDE_PATH_GRANT`), with the paths.
- The Originals editor grant (P5.15: `{did, name, metadata, resource}`) still
  governs whether the editor may change anything at all; path grants only
  narrow it. They live in the repo document, not in the asset state, because
  P14.5 fixes a grant's members.
- An entry allowed by its named repo version but whose signer the latest repo
  version no longer grants is reported historically authorized only, not
  invalid (P7.9 by analogy).
- The writer refuses before signing a change outside the signer's grant
  (`outside-grant`, as the SDK does for P5.16).

### Phase 4 — Multi-delegate repo identity changes (built as profile 0.2)

Decided on 2026-11-19 as a core change (§6, plan 050). The code profile moved
onto it in `originals-code/0.2` (§1.5).

### Phase 5 — `git-remote-originals` (built, K16)

A git remote helper (`git-remote-originals`, gitremote-helpers(7), a bin of
`@originals/code`) so that `git clone originals::<path, file:// or https://
URL of a repo bundle> <dir>` works.

- **Verify first.** On `list`, the helper reads the bundle and verifies it
  offline with no key (P7.3), exactly as `originals-code verify` does. It
  lists only refs whose canonical head is `agreed` (K6) and whose voting
  branch verifies completely: both reports valid, content complete, every
  git tree id (`gitBinding`) and every commit id (`commitBinding`, K12)
  recomputed. Anything else is refused with the reason on stderr, and with
  no clonable ref the clone fails. Nothing is rebuilt approximately: a bundle
  without commit objects (a private repo without opt-in) cannot be cloned.
- **Rebuild git's objects.** `fetch` writes one pack (no deltas) for
  `git index-pack`: the raw commit objects byte for byte (K12), git tree
  objects rebuilt from the mirrored trees (K2), and blobs. Every id is
  recomputed before writing and again by `index-pack`. Commit ids are
  therefore the original repository's, and `HEAD` points at the canonical
  head of `refs/heads/main`.
- **First-parent only, stated in the open (K16).** Second parents are not
  mirrored (K9). Git cannot express "this merge's second parent is absent"
  in `.git/shallow`: a shallow entry cuts *all* of a commit's parents (so
  `git log --first-parent` would stop at the first merge), and listing the
  absent parents there does not help, because git still has to read them.
  A promisor (partial clone) setup tolerates the absence but makes plain
  `git log` and `git checkout` fail on lazy fetches. `git replace --graft`
  writes new, different commit objects. The helper therefore writes
  `$GIT_DIR/info/grafts` with one line per merge commit, `<merge> <first
  parent>`: every object stays byte-identical (`git cat-file -p <merge>`
  still shows both parents), the file lists exactly what is missing, and
  `git log`, `git log --first-parent`, `git fsck` and the connectivity check
  all work. Git marks the grafts file deprecated; the helper turns that
  hint off for the cloned repository only (`advice.graftFileDeprecated`).
  Fetching the full history from another remote and deleting the file
  restores normal history; `git replace --convert-graft-file` converts it if
  a future git drops grafts. A chain whose first commit has a parent (a
  mirror that started mid-history) would be marked in `$GIT_DIR/shallow`
  at that commit, which is what shallow means; the writer always starts at
  the root, so this does not happen today.
- `git fetch` from the same remote takes a later bundle the same way.
- **Push is not supported** (`list for-push` is refused). Later item: `push`
  as a mirror plus a shared-host `submit` (P6.7), and fetching from a
  hosted repo by digest (§6, reads) instead of a whole bundle.

## 4. PROVISIONAL choices (marked in code)

| ID | Choice |
|---|---|
| K1 | Package name `@originals/code`; profile `originals-code/0.2` (0.1 dropped, not migrated: nothing was published under it) |
| K2 | Tree object format, git modes, JCS bytes; tree per directory |
| K3 | Media types `application/vnd.originals.code-tree+json`, `…code-repo+json` |
| K4 | Branch metadata `code` members (0.2: no `repoVersion`); a branch is a W2 child of the repo pinning the newest repo version its writer holds, with one author and no editors of its own; `versionTime` = signing time |
| K5 | (revised for 0.2) The repo Original is a set Original whose members are the delegates, with a threshold (W1): every delegate signs genesis, a threshold signs each change, added delegates sign too; the repo document is `{format, delegates, refs, releases?}`, `delegates` equal to `authors.dids`; per-ref thresholds and branch listings stay in the document |
| K6 | Canonical-head rule (§3, phase 2), including invalid/forked branches not voting |
| K7 | (revised for 0.2) Path grants are W3 `paths`-scoped grants in the repo Original's `editors` (`name: false, metadata: true, resource: true`), inherited by every branch at its pin (W2); the pattern grammar is P14.23's (a final `**` matches one or more segments); the core checks scopes and P5.26; a branch's author unrestricted in its own branch, every other signer needs a grant; delegates are never editors (P5.15); an invalid entry makes the whole branch invalid for canonical heads |
| K8 | Bundle layout and object pack; deflate-raw per object |
| K9 | Gitlinks refused; first-parent only; second parents not mirrored |
| K10 | Local did:vh identities and key files for the CLI (development only) |
| K11 | A read-only, GitHub-like viewer (`originals-code serve`): server-rendered pages over `openRepository`, showing only verified entries with each result beside the content, separately. Commits are shown by id, signing DID and claimed versionTime; a commit whose id was recomputed from its commit object (K12) also shows its message and git author, as text |
| K12 | Raw git commit objects mirrored verbatim as objects, named by `metadata.code.commitObject`; public by default, opt-in for a source marked private; `commitBinding` reported separately (O3) |
| K13 | A branch longer than the entry limit is a chain of segment Originals; a segment genesis names the previous segment's did and last versionId (`metadata.code.previous`); the repo document lists the newest segment; earlier segments are `superseded` (O1) |
| K14 | Contributor branches: a branch Original naming the repo but not listed is a `contribution`, verified and never voting; bundles carry the contributions a workspace holds; `import` verifies a bundle before taking it in (O7) |
| K15 | Release Original: named by the repo document (`releases`), one release manifest per entry (tag, ref, commit, branch and entry, canonical result at the time); its commit must be in the named chain. Signed as K17 says (0.1: by the repo's author) |
| K16 | `git-remote-originals`: verify the bundle offline first, list only agreed and completely verified refs, rebuild commits byte for byte from commit objects; second parents stated in `info/grafts`, a mid-history start in `shallow`; no push |
| K17 | The release Original is a set Original with the repo's members and threshold and a W2 child of the repo: at every entry its `authors` equal the repo's at the pin (`RELEASES_AUTHORS`); every delegate signs its creation (P5.19), a threshold each release, and a delegate change reaches it with the next release (P5.20) |
| K18 | Proposal files (`originals-code-proposal/0.1`): an unsigned or partly signed draft as JSON (entry, summary, display, bytes, proofs), cosigned in turn and committed once every named signer has signed; the SDK rechecks it at each step, and a moved repo makes it stale, never rebased |
| K19 | The split bundle (`package --split`): the zip bundle's manifest and evidence packages as static files, plus one pack of every tree and commit object (`objects/index.json`, `objects/pack`) and each other object deflate-raw under `objects/<digest>`, listed in `objects/loose.json`. A reader verifies with the zip's code over what it holds; a loose object is fetched when asked and checked on arrival; one not loaded is missing, never verified |
| K20 | The static viewer (`packages/code/viewer`): `createRepositoryView`'s pages rendered in a Web Worker in the visitor's browser, routed in the location hash so it works under any path prefix; the page parses each page inert, drops scripts, styles, frames, forms and event attributes, and rewrites links; CSP `default-src 'none'` with scripts, workers and styles from the site only, `connect-src 'self' https:` |
| K21 | Remote identities (`originals-code-remote-identity/0.1`): a did:vh whose `#code-1` assertion key is held in Turnkey; the file holds the DID, its log and the key reference (`signWith`, public Multikey), never a secret; the update key stays with the creator (P5.11). `@originals/code/turnkey` signs through `turnkeySignBytes` and checks each signature against the key before use |
| K22 | `rehydrate`: a workspace that keeps only its signed logs gets its objects back by converting, from git, every commit its listed branches name; each root tree and commit object must have the digest the entry names (`REHYDRATE_MISMATCH`) |

## 5. Acceptance tests (IDs cited by tests)

| ID | Test |
|---|---|
| CODE-01 | Tree encode/decode round-trips; non-JCS bytes, bad names, bad modes and gitlinks are rejected |
| CODE-02 | Objects are deduplicated: a blob shared by two versions is stored once |
| CODE-03 | Mirror a fixture git repo; every entry's git tree SHA-1 recomputes from objects |
| CODE-04 | Package and verify offline (fetch disabled, fresh store, no key) |
| CODE-05 | Missing objects: content `partial`, history still valid, never a pass |
| CODE-06 | Tampered object or tree: `digest-failure`; tampered tree claim: `gitBinding` mismatch |
| CODE-07 | Incremental mirror appends; force-pushed history is `MIRROR_DIVERGED` |
| CODE-08 | Each Original in a bundle verifies with `sdk.load` unchanged |
| CODE-09 | Repo document rules: threshold bounds, branch binding both ways |
| CODE-10 | Canonical head: agreed, no-quorum, diverged, incomplete, inconsistent; never by timestamp |
| CODE-11 | A forked branch Original does not vote; the fork is reported (P9.16) |
| CODE-12 | Path grant allows a covered change (0.2: an inherited `packages/vh/**` grant, the scope checked by the core) |
| CODE-13 | Path grant refuses a change outside it (writer before signing; the core verifier, SCOPE_OUTSIDE); removing and renaming count |
| CODE-14 | Entry by an editor with no path grant is refused (writer; core: EDITOR_NOT_GRANTED) |
| CODE-15 | Grant revoked later: historically authorized only (P5.26, from the core report), not invalid; a new entry under it is refused |
| CODE-16 | A pin going backwards is refused (0.1: `repoVersion`; core: PARENT_PIN_BACKWARDS) |
| CODE-17 | Bundle reader bounds: oversize object, bad index, inflate bomb |
| CODE-18 | The viewer: files, README, commits, line diffs, verification page; repository content never rendered as markup; unknown routes 404 |
| CODE-19 | Commit objects: mirrored by default, the verifier recomputes commit id, tree and first parent (`commitBinding`); a private source needs opt-in; bundles without them verify with ids claimed; a missing one is unchecked |
| CODE-20 | Commit binding failures: a commit object hashing to another id, naming another tree, or with another first parent fails the code history |
| CODE-21 | Segments: with an injected limit the writer starts new segments, the repo lists the newest, the verifier walks the chain and the canonical head is the whole branch's; an incremental mirror crosses a boundary |
| CODE-22 | Segment failures: a missing previous segment is incomplete; a closed segment that continues is invalid; a commit gap at a boundary is invalid; only the author starts a segment |
| CODE-23 | A contributor's own branch: mirrored from an imported bundle, verified and reported as a contribution, ignored by the canonical head, extended later |
| CODE-24 | Contributions stay outside the vote: no quorum from a contribution; an invalid contribution leaves the head alone; no contribution into a listed branch; a bundle whose repo fails is not imported |
| CODE-25 | Releases: created on the first release and named by the repo; later releases, an older commit by name, a release in an earlier segment; only the repo's author; a repeated tag refused; manifests strict JCS |
| CODE-26 | Release failures: a commit not at the named entry and a repeated tag fail the release history; a missing branch is incomplete. `bun run release:regtest`: anchoring and reinscribing the release Original on disposable regtest |
| CODE-27 | `git clone originals::<bundle>`: first-parent ids equal git's, trees and messages identical, the merge's second parent in `info/grafts`, `fsck` clean, `git fetch` takes a later bundle |
| CODE-28 | The helper refuses what it cannot rebuild exactly: no commit objects, no agreed head |
| CODE-29 | 0.2 repo governance: three delegates, threshold 2, every one signs genesis; a change signed by 2 of 3 verifies and one by 1 is refused; a delegate change adds a member who signs and drops one, refused with 1 old signature or without the added member's |
| CODE-30 | Proposal files: propose, cosign in turn, commit; commit before the last signature, and a signer the proposal does not name, are refused; a proposal whose repo moved is stale |
| CODE-31 | The release Original's set: creation needs every delegate, a release the threshold; a delegate change reaches it with the next release; a release set that differs from the repo's at the pin fails the release history |
| CODE-32 | One repo grant lets an editor write into two delegates' branches with no grant in either; a grant naming a delegate is refused (P5.15) |
| CODE-33 | The split layout verifies as the zip does: before any blob is fetched, Originals reports, code history (an editor's `**` grant checked over trees alone) and canonical heads equal the zip's, content `partial` and git trees `unchecked`; once every object is loaded, the report equals the zip's |
| CODE-34 | Objects fetched by digest, once, and checked on arrival: a tampered, unserved or wrong-length object is refused and reported failed; a network error leaves it not loaded; an unlisted digest is never fetched |
| CODE-35 | The split reader's bounds: required files, the loose index (sorted, unique, not in the pack, sizes and counts bounded), an inflate bomb; a bundle with a failing object is not split |
| CODE-36 | The static viewer's router: routes in the hash; view links resolved against the current route; anchors, raw bytes and web links; other schemes and authorities dropped; the bundle URL from `?bundle=` |
| CODE-37 | A CI identity whose key is in Turnkey: the file holds no secret and round-trips; a file with a secret, another key or a non-Ed25519 key is refused; credentials all or none |
| CODE-38 | CI mirrors as an editor through Turnkey (a local double): entries verify under the inherited `**` grant and the head is agreed; a wrong Turnkey key fails before anything is committed; a public identity with no signer is refused |
| CODE-39 | A workspace rebuilt from its logs and git: content partial before, complete with commit ids recomputed after; a git history that differs from the logs is refused |
| CODE-VIEW | `bun run smoke:viewer` (CI): the built viewer under a path prefix in Chromium verifies a split bundle, opens files by digest, shows signer set, pins, inherited grants and commit messages, never runs repository markup, with no CSP violation |
| CODE-ACC | Mirror `main` of this repository and verify it with no network (script, timings, store size vs. pack) |

## 6. Phase 4 and the owner's decisions of 2026-11-19

The owner reviewed this plan in a grilling session on 2026-11-19 and decided:

- **Phase 4 changes the core, not a separate profile.** Signer sets with a threshold (W1), authority from a parent Original pinned per entry (W2) and scoped grants (W3) become part of `originals:1.0` as an additive draft change. That reverses this plan's earlier proposal for an `originals-quorum:0.1` profile. The design contract is [plan 050](050-signer-sets-parent-authority-scoped-grants.md).
- **The code profile moves onto those mechanisms.** The repo Original becomes a set Original whose members are the delegates. Each branch Original becomes a W2 child of the repo, whose pins replace `metadata.code.repoVersion`. Path grants become W3 `paths` scopes on inherited grants.
- **Audience:** projects on GitHub first, then a decentralized GitHub, then audit and compliance.
- **Radicle is a transport only.** A bundle can ride in a Radicle repo as a custom collaborative object. Radicle's delegates and canonical refs are a different claim from Originals verification, and our verifier ignores them (P3.5 by analogy). Radicle identities are did:key, cannot rotate, and are not P5.8 methods. Still to confirm: whether arbitrary custom refs replicate.
- **Anchoring is optional and for releases only** (release Original built: §1.4, K15). The repo Original (governance) and a separate **release Original** are anchored. A release Original's entries name a release (tag, commit, branch entry) and are signed by the repo's delegates by threshold. Branch Originals stay unanchored, because an anchored Original needs an inscription for every later entry.
- **Reads** are host-enforced and specified separately (the read-authorization spec PR). For code:
  - read access covers the whole repo, and branches inherit it through W2;
  - a bundle holder reads everything in it;
  - a host serves an object by digest only to a requester who may read an Original naming it;
  - anchoring a private repo needs a disclosure warning;
  - per-path reads come later.
- **Milestone 1: dogfood this repo.**
  - CI mirrors `main` on each merge, signing as an editor with a `**` grant and its key held in Turnkey.
  - The owner signs release entries.
  - Each GitHub release attaches the bundle.
  - A static GitHub Pages viewer verifies in the visitor's browser. It loads the logs first and fetches files by digest on demand.

**Milestone 1 status.**

- *Static viewer: built* (K19, K20; CODE-33 to CODE-36, CODE-VIEW). `originals-code package --split <dir>` writes the split bundle; `packages/code/viewer` is the static viewer, deployed by `.github/workflows/pages.yml` at `/code/` of the repository's Pages site, beside the API reference at `/`. On this repository (`main` at `174d3144`, 677 entries) the split bundle is 9,121 files: 3.2 MiB of evidence packages and 4.1 MiB of trees load first; 9,115 blobs (66 MiB compressed) load one by one when opened. Before any blob is fetched the viewer reports content `partial` and git trees `unchecked`, never a pass; "Fetch and check every file" loads them all and verifies again.
- *Dogfood CI: built* (K21, K22; CODE-37 to CODE-39). `.github/workflows/originals-code-dogfood.yml` restores the workspace from the `originals-code-mirror` branch (public logs only; objects rehydrated from git), mirrors new first-parent commits as an editor with a `**` grant signing through Turnkey, pushes the logs back and deploys Pages (`pages.yml` now also publishes the split bundle at `/code/bundle/`, only if it verifies). On a published release it attaches `repo.zip` and appends verify instructions. Without `TURNKEY_*` secrets it skips mirroring with a notice and deploys the last bundle. *Not yet running:* it waits on the owner's one-time setup (packages/code/README.md, "Dogfood CI"): the Turnkey key and CI API key, the owner and CI identities, the repo with its `**` grant, the `originals-code-mirror` branch and three secrets. No real Turnkey resource or secret was created by this work.

## 7. Open questions

- **O1 — decided 2026-11-19: a chain of segments; built (K13, CODE-21, CODE-22).** A full branch Original is followed by a new one whose genesis names the previous segment's last entry. The limit stays, because it bounds a verifier's work on untrusted logs (P7.7). The original question was: **repositories over 10,000 first-parent commits** (P7.7). One branch
  Original per ref cannot hold them. Options: segment a branch into a chain of
  Originals (each genesis naming the previous one's last entry), or a profile
  limit. Not needed for this repository (675).
- **O2 — git ancestry beyond first parents.** Canonical heads only trust
  signed first-parent chains (K6). Mirroring parents in metadata would make
  ancestry claimed, not checked.
- **O3 — decided 2026-11-19: mirror commit objects verbatim for public repos; built (K12, CODE-19, CODE-20).** A private repo needs explicit opt-in, because of author emails (P8.2). The original question was: **commit objects.** Mirroring raw commit objects as blobs would let a
  verifier check the commit hash and let a remote helper rebuild identical
  commits; it exposes author emails (P8.2: no confidentiality).
- **O4 — Originals verification cost.** `verifyOriginal` hashes every
  resource version and checks every proof; 4.3 s for the whole bundle at 675
  entries (§8), to be measured near 10,000.
- **O5 — bundle size.** The bundle is one ZIP read with the SDK's codec,
  whose default bound is 512 MiB (`ZIP_LIMITS`); this repository's bundle is
  70 MiB. Larger repositories need a raised bound or a split object pack.
- **O6 — storage against git.** Objects are deflated one by one with no
  deltas: 66.1 MiB for this repository's first-parent history, against git's
  35.7 MiB pack of the same objects (§8). Delta compression inside the pack
  (K8) would close most of the gap without changing any digest.
- **O7 — decided 2026-11-19: both, by role; built (K14, CODE-23, CODE-24).** Anyone may publish their own branch Original, which never votes. Trusted contributors become editors of a delegate's branch with path-scoped grants. The original question was: **editor branches for non-delegates.** Today a contributor who is not
  a delegate writes into a delegate's branch as an editor. Radicle instead
  lets anyone publish their own namespace and only counts delegates'. Both
  fit the model; the second needs no editor grant and is closer to Radicle.

## 8. Results (2026-11-18, updated 2026-11-19 for profile 0.2)

Phases 0–3 are in `packages/code` with tests citing CODE-01 to CODE-17
(93 tests, all passing; network disabled in every test).

**CODE-ACC on this repository** (`bun run acceptance -- --rev origin/main`
in `packages/code`, `main` at `e5a3e3d4`; Apple Silicon laptop):

| | |
|---|---|
| History | 1,537 commits, 675 on the first-parent chain, 2,031 files at `main` |
| Mirror | 675 entries in 11.5 s; 6,546 trees and 9,046 blobs converted (165.6 MiB raw); every git tree id recomputed from the objects during the mirror |
| Store | 15,592 objects, 66.1 MiB compressed, plus 3.1 MiB of Originals logs and root trees |
| git packs | all refs 113.9 MiB; `main` 37.3 MiB; `main` first-parent objects only 35.7 MiB |
| Bundle | 70.2 MiB, written in 5.5 s |
| Verify | 4.3 s, offline (0 fetch attempts), no key: repo and branch valid as Originals and under the code profile, content complete, 675 of 675 git tree ids match, canonical head of `refs/heads/main` agreed at `e5a3e3d4`, equal to git's; `current: false` |

**K12 (commit objects, O3), 2026-11-19** (same command, `main` at
`174d3144`, 1,539 commits, 677 first-parent): 677 raw commit objects
mirrored (1.4 MiB raw); mirror 20.2 s; store 16,364 objects, 67.3 MiB;
bundle 71.5 MiB in 11.7 s; verify 4.7 s offline: 677 of 677 git tree ids
and 677 of 677 **commit ids recomputed from the commit objects**
(`commitBinding` matches, none claimed), canonical head agreed at
`174d3144`, equal to git's. Commit objects add about 1.2 MiB to the store
and bundle.

**K13 (segments, O1), 2026-11-19**: this repository needs one segment
(677 < 10,000), so segmenting is exercised with an injected limit
(`bun run acceptance -- --rev origin/main --segment-entries 250`): the
branch becomes 3 segments (250 + 250 + 177 entries), each a valid Original;
verify 4.9 s offline walks the chain, 677 commits in the listed segment's
chain, every git tree and commit id recomputed (the listed segment reports
its own 177; continuity at both boundaries checked from the commit
objects), canonical head agreed at `174d3144`, equal to git's.

**K15 (release Original), 2026-11-19**: `bun run release:regtest` on
disposable regtest (Bitcoin Core 31.1, ord 0.29.0, started in a temporary
directory and stopped): release v1, `sdk.anchor` and one commit/reveal
inscription carrying genesis and the anchoring entry; mined, `readAnchored`
reports the release Original anchored and current with provisional
ownership of the reveal output. Release v2 is reinscribed on the same sat
by spending that output: current again at the new head. The repo bundle
then verifies offline: release history valid, both releases in-chain,
canonical head agreed; the release Original's offline report is
`anchoring: unverified` (no Bitcoin read offline), and branches stay
unanchored (`current: false`). No mainnet or testnet.

**K16 (`git-remote-originals`), 2026-11-19**
(`bun run acceptance -- --rev origin/main --clone`, `main` at `fd15702f`,
1,544 commits, 680 first-parent, Apple Silicon laptop): mirror 680 entries in
10.7 s (680 commit objects, 1.4 MiB); bundle 72.2 MiB; verify 4.5 s offline,
680 of 680 tree ids and commit ids recomputed, canonical head agreed at
`fd15702f`. Then `git clone originals::<bundle>` in 11.2 s (verifying the
bundle again, rebuilding and indexing 16,499 objects): **the clone's 680
`git log --first-parent` ids equal `origin/main`'s**, its `HEAD` tree is
git's, `git fsck` is clean, and 199 merge commits keep only their first
parent through `info/grafts`.

**Profile 0.2 (plan 050 §5 step 3), 2026-11-19**
(`bun run acceptance -- --rev origin/main --clone`, `main` at `1aad0f30`,
1,548 commits, 686 first-parent, 2,109 files, Apple Silicon laptop): the repo
Original is a set Original (one delegate, threshold 1) and the branch a child
of it, pinning the repo version it was mirrored under. Mirror 686 entries in
19.6 s (6,705 trees, 9,279 blobs, 171.9 MiB raw; 686 commit objects,
1.4 MiB); store 16,670 objects, 68.8 MiB compressed, plus 3.2 MiB of logs
and root trees; bundle 73.1 MiB in 6.2 s; verify 4.5 s offline (0 fetches):
repo and branch valid under both reports, parent evidence verified, 686 of 686
tree ids and commit ids recomputed, canonical head agreed at `1aad0f30`,
equal to git's, `current: false`. `git clone originals::<bundle>` in 11.0 s:
686 first-parent ids equal git's, tree matches, `fsck` clean, 199 merges
grafted. The code package has 147 tests (CODE-01 to CODE-32), all passing.
`bun run release:regtest` (disposable regtest) anchors and reinscribes the
release Original, now a set child of the repo: both inscriptions accepted and
current, the bundle's release history valid offline.

The store is about 1.9 times git's pack of the same objects (O6) and about
0.6 times the whole repository's 114 MiB pack, which also holds every
other ref and every second-parent commit.
