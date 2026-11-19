# 049 — Originals for code: signed, offline-verifiable version control on Originals

Status: **phases 0–3 implemented on `feat/originals-for-code` (§8 has the
results); phase 4 is a proposed spec change waiting for the owner's
decision (§6); phase 5 is a plan item, not built.** Written 2026-11-18 against `main` at `e5a3e3d4`. Rule IDs refer to
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

- **No change to `originals:1.0`.** Every log this layer writes is an ordinary
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

### 1.1 Objects (PROVISIONAL, `originals-code/0.1`)

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
with the one the entry's metadata claims (`gitBinding` report). It cannot check
the commit hash itself (the commit object, its message and parents are not
mirrored), so the commit hash is reported as **claimed** by the signer.

### 1.2 Branch Original (PROVISIONAL)

- `name`: the ref, `refs/heads/<branch>`.
- `metadata.code`: exactly
  `{ "profile": "originals-code/0.1", "repo": "<repo did:vh>", "ref": "<ref>", "commit": "<40 hex>", "tree": "<40 hex>", "repoVersion": "<repo versionId>" }`.
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
- One entry per first-parent commit, oldest first. A merge commit is one
  entry; its second parents are not mirrored. `versionTime` is the time the
  mirror signs, never the commit time (git commit times are not monotonic
  along a branch; VH-Log requires increasing `versionTime`).

### 1.3 Repo Original (PROVISIONAL)

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
- `grants` lists path grants (phase 3). A branch's own author is
  unrestricted in that branch; every other signer of it, another delegate
  included, needs a path grant.

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
  - `grants`: per entry by a non-delegate signer, `allowed` or `outside-grant`
    with the paths outside it; `historicallyAuthorizedOnly` for entries allowed
    by the named repo version but not by the latest (P7.9 by analogy).
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

### Phase 4 — Multi-delegate repo identity changes (PROPOSED SPEC CHANGE; not implemented)

See §6. Waits for the owner's decision.

### Phase 5 — `git-remote-originals` (plan item)

Not built in this pass: phases 0–3 already make a large PR, and the helper
depends on O3 (whether commit objects are mirrored), which is the owner's
call. The design:

A git remote helper (`git-remote-originals`, gitremote-helpers(7)) so that
`git clone originals::<bundle or host URL>` works: `capabilities`, `list`
(the canonical heads and each delegate's head, verified), `import` through
`git fast-import` rebuilding trees and blobs from objects. The commits cannot
be rebuilt byte for byte (messages, authors and second parents are not
mirrored), so a clone gets new commit ids unless commit objects are mirrored
too; that is open question O3. `push` maps to `mirror` plus a shared-host
`submit` (P6.7). Not built in this pass.

## 4. PROVISIONAL choices (marked in code)

| ID | Choice |
|---|---|
| K1 | Package name `@originals/code`; profile `originals-code/0.1` |
| K2 | Tree object format, git modes, JCS bytes; tree per directory |
| K3 | Media types `application/vnd.originals.code-tree+json`, `…code-repo+json` |
| K4 | Branch metadata `code` members; `versionTime` = signing time |
| K5 | Repo document members; repo author = founding delegate |
| K6 | Canonical-head rule (§3, phase 2), including invalid/forked branches not voting |
| K7 | Path-grant pattern grammar (a final `**` matches one or more segments, as in gitignore); a branch's author unrestricted in its own branch, every other signer needs a grant; an invalid entry makes the whole branch invalid for canonical heads |
| K8 | Bundle layout and object pack; deflate-raw per object |
| K9 | Gitlinks refused; first-parent only; second parents not mirrored |
| K10 | Local did:vh identities and key files for the CLI (development only) |
| K11 | A read-only, GitHub-like viewer (`originals-code serve`): server-rendered pages over `openRepository`, showing only verified entries with each result beside the content, separately. Commits are shown by id, signing DID and claimed versionTime, since messages are not mirrored (O3) |

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
| CODE-12 | Path grant allows a covered change |
| CODE-13 | Path grant refuses a change outside it (verifier and writer); removing and renaming count |
| CODE-14 | Entry by an editor with no path grant is refused |
| CODE-15 | Grant revoked later: historically authorized only, not invalid |
| CODE-16 | `repoVersion` going backwards is refused |
| CODE-17 | Bundle reader bounds: oversize object, bad index, inflate bomb |
| CODE-18 | The viewer: files, README, commits, line diffs, verification page; repository content never rendered as markup; unknown routes 404 |
| CODE-ACC | Mirror `main` of this repository and verify it with no network (script, timings, store size vs. pack) |

## 6. Proposed spec change for phase 4: threshold-signed repo identity (STOP for decision)

**Need.** With several delegates, changing the delegate set, a threshold or
path grants should need agreement of a threshold of current delegates, as in
Radicle. Today one author signs every author entry of the repo Original.

**Rules it would relax.**

- **P5.2 / owner decision S8** — one author, one signature per entry. A
  repo-identity entry would carry `k` proofs, one per signing delegate.
- **P5.3** — the proof's key is an `assertionMethod` key of the author DID at
  the named version. Each proof would be bound to its own delegate DID and
  version.
- **P5.8** — the author is fixed at genesis and never transfers. Delegate
  membership would change by a threshold entry; the genesis "author" becomes
  the genesis delegate set.
- **P5.16 / P5.17** — only author entries change grants. Threshold entries
  would be the only entries allowed to change the delegate set, thresholds and
  grants.
- **P14.1, P14.8 (exact members)** — an entry carries exactly one proof
  today (ORIGINALS.md, "Exact members"); a threshold entry carries several.
  The owner should confirm which section 14 rule fixes the proof count.

**Proposal (a separate profile, not a change to `originals:1.0`).** Define
`originals-quorum:0.1` (name open), a did:vh extension alongside
`originals:1.0` for identity-like Originals only:

1. Genesis state names `delegates: [{did}]` and `threshold` (1 ≤ t ≤ n). No
   single `author`.
2. Each entry carries `signers: [{did, verificationMethod, versionId}]`, sorted
   and unique, and exactly one proof per signer, in the same order. Each proof
   is checked as P5.3 against its own delegate DID (assertionMethod, not an
   update key, P5.11), and P7.8/P7.9 apply per signer.
3. An entry is accepted only if its signers are delegates in its **parent's**
   state and number at least the parent's threshold (as VH-Log witness
   thresholds use the active set; editors are judged against the parent,
   P5.17).
4. Forks, P6.6 and P9.16 are unchanged: two threshold entries with the same
   parent are an unresolved fork.
5. `originals:1.0` is unchanged; branch Originals stay single-author.

**Questions for the owner.** (a) Separate profile vs. extending
`originals:1.0`; (b) whether VH-Log's multi-proof entries (proof array) can
carry the delegates' proofs or a new member is needed; (c) whether a quorum
Original may be anchored, and who signs the anchoring entry (P9.10, P9.12).

## 7. Open questions

- **O1 — repositories over 10,000 first-parent commits** (P7.7). One branch
  Original per ref cannot hold them. Options: segment a branch into a chain of
  Originals (each genesis naming the previous one's last entry), or a profile
  limit. Not needed for this repository (675).
- **O2 — git ancestry beyond first parents.** Canonical heads only trust
  signed first-parent chains (K6). Mirroring parents in metadata would make
  ancestry claimed, not checked.
- **O3 — commit objects.** Mirroring raw commit objects as blobs would let a
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
- **O7 — editor branches for non-delegates.** Today a contributor who is not
  a delegate writes into a delegate's branch as an editor. Radicle instead
  lets anyone publish their own namespace and only counts delegates'. Both
  fit the model; the second needs no editor grant and is closer to Radicle.

## 8. Results (2026-11-18)

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

The store is about 1.9 times git's pack of the same objects (O6) and about
0.6 times the whole repository's 114 MiB pack, which also holds every
other ref and every second-parent commit.
