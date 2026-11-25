# @originals/code

## 0.2.0

### Minor Changes

- 222c9c8: Mirror raw git commit objects verbatim (plan 049 O3, K12): the verifier recomputes each commit id, its tree and first parent and reports `commitBinding` separately. Public by default; a workspace marked private mirrors them only with `--include-commits` / `commits: true`. Bundles without commit objects verify as before, with commit ids claimed. The viewer shows commit messages from verified commit objects.
- 85aa358: Contributor branches (plan 049 O7, K14): anyone may publish their own branch Original for a ref. The verifier reports it under `contributions` (verified, never voting) and canonical heads ignore it. New `originals-code import <bundle>` (verifies first) and `mirror --contribute`; bundles carry the workspace's contributions.
- 9d564cc: Dogfood CI pieces (plan 049 §6, milestone 1). Remote identities (K21): a did:vh whose signing key is held in Turnkey; the identity file holds no secret, and `originals-code identity new-remote` creates one. `@originals/code/turnkey` signs entries through `@originals/auth`'s `turnkeySignBytes` and checks each signature before use; `workspace.mirror` takes a `sign` option for it. `originals-code rehydrate` (K22) rebuilds a workspace's objects from git, checked against its signed logs. `mirror --branch` writes into a named branch as an editor.
- 102d240: Code profile `originals-code/0.2` (PROVISIONAL), on the core's signer sets,
  parent Originals and scoped grants (plan 050 §5 step 3; P5.19–P5.28). 0.1
  bundles are no longer read; nothing was published under 0.1, so there is no
  migration.

  - The repo Original is a set Original whose members are the delegates, with a
    threshold (K5): every delegate signs its genesis, and each change is signed
    by the threshold and by any delegate it adds. `initRepo({ delegates,
threshold })`, `proposeRepo` → `cosignRepo` → `commitRepo`, `changeRepo`,
    `updateRepo` and `listBranch` take one signer or several; proposal files
    (`serializeProposal`, `parseProposal`) and the CLI's `repo propose|cosign|commit`
    let delegates sign in turn. `identity public|add` share public identities.
    The repo document drops `grants`, and its `delegates` must equal the signer
    set. `SIGNER_SET_UNSUPPORTED` is gone.
  - Branch Originals are children of the repo, pinning the newest repo version
    their writer holds; the pin replaces `metadata.code.repoVersion`.
  - Path grants are `paths`-scoped grants in the repo's `editors`
    (`grantPaths`, `pathGrant`), inherited by every branch. The core checks
    them; `BranchCodeReport.grants` and `historicallyAuthorizedOnly` restate the
    Originals report (source, pin, scope, P5.26 reasons), and `pins` lists the
    repo versions a branch pins. `grantEditors` and per-branch grants are gone.
  - The release Original is a set Original with the repo's members and
    threshold, and a child of the repo (K17): `release(repo, signers, …)` and
    `prepareRelease`.
  - `RepoCodeReport` gains `authors` and `grants`; the viewer shows the signer
    set, the repo's path grants, pins and inherited grants.

- ebf7791: Release Original (plan 049 §1.4, K15): the repo document names a release Original whose entries each record a release (tag, commit, branch entry, canonical result at the time) as a JSON manifest. New `originals-code release <tag>`; the verifier checks each release's commit is in the named branch chain. Anchoring it with the SDK's flow is exercised on disposable regtest (`bun run release:regtest`).
- 04a2c31: `git-remote-originals` (plan 049 phase 5, K16): `git clone originals::<bundle path or URL>` verifies the bundle offline, refuses unless the canonical head is agreed and every commit id is recomputed, and rebuilds byte-identical commits (first-parent only; merges' second parents listed in `.git/info/grafts`). `git fetch` takes later bundles; push is not supported.
- addec54: Branch segments (plan 049 O1, K13): a branch longer than the entry limit becomes a chain of segment Originals, each genesis naming the previous segment's did and last versionId. The repo document lists the newest segment, bundles carry every segment, and the verifier walks the chain, checking continuity of commits and roots and reporting each segment.
- f8251e1: A static viewer that verifies repo bundles in the visitor's browser (plan 049 §6, milestone 1). `originals-code package --split <dir>` writes the split bundle (K19): the evidence packages and every tree and commit object load first, and each other object is fetched by digest when opened and checked on arrival; one not loaded is reported missing, never verified. `openSplitRepository` reads it with the zip bundle's verification code. `packages/code/viewer` renders the `serve` pages in a Web Worker with hash routing and a strict CSP, deployed at `/code/` of the Pages site.
- 174d314: Add `@originals/code` (private, plan 049): git branches mirrored as signed, offline-verifiable Originals, repo Originals with delegates and thresholds, canonical heads, per-path grants, repo bundles and a read-only viewer (`originals-code serve`).

### Patch Changes

- 1aad0f3: Scoped grants (originals-spec #66, `a2b5013`: P5.28, P5.29, P14.23). The
  member names stay PROVISIONAL (P14.5, D4).

  - `@originals/vh`: an editor grant's optional `scope`, never with
    `resource: false`. A scope-type registry with `paths` (P14.23 patterns:
    `checkPathPattern`, `matchPathPattern`) and `items` (`add`, `edit`,
    `remove`), checked over a media type's path or item view
    (`MediaTypeView`, `ScopeViews`, `checkScopeChange`). A view may read
    objects the version references and report missing ones. The defaults are
    the code tree's path view (`application/vnd.originals.code-tree+json`,
    reading only changed subtrees, digests over mode and content) and a
    reference item view (`application/vnd.originals.items+json`). An unknown
    type, a missing view or missing bytes is `SCOPE_UNCHECKED`, incomplete and
    unverifiable after the anchor; a change outside is `SCOPE_OUTSIDE`. The
    report adds `grants[].scope` and `scopeObjects`.
  - `@originals/sdk`: verification reads the objects scope checks need from
    the store. Packages carry them, or list `{ kind: "object", digest }`
    missing items.
  - `@originals/code`: path grants reuse the vh pattern matcher and code tree
    constants instead of a copy.

- 296a969: Signer sets (originals-spec #66, `a2b5013`: P5.19–P5.23, P5.30, D8; owner
  decision of 19 November 2026, reversing S8). An Original can be governed by a
  set of DIDs with a threshold instead of one author. Single-author Originals
  are unchanged, byte for byte. The member names stay PROVISIONAL (P14.5, D4).
  The conformance registry is re-pinned to `a2b5013`, with its 40 new rows
  registered as C12-382 to C12-421.

  - `@originals/vh`: the asset's optional `authors: {threshold, dids}`
    (`checkAuthors`, `ORIGINALS_LIMITS.authors` = 32). An entry's `author` is an
    array of signer references exactly when its asset has `authors`, with one
    proof per signer in the same order. Genesis is signed by every member; an
    author entry by the parent's threshold of the parent's members plus every
    added member; a single-author Original converts when the author and every
    new member sign. A member is never the Original's own did:vh, an alias or
    its anchoring sat. P5.8 holds per identity; P7.9 currency holds by
    threshold, and every signer of an inscribed set entry must pass P9.15 at
    its inscription (P5.23). The derived DID document's `controller` is
    the member array. Builders take `authors` and `sign: EntrySigner[]`;
    `cosignEntry` and `finalizeEntry` collect proofs in any order. The report
    adds `signedBy` and `identityEvidence.authors`; for a set Original the
    single-author `identityEvidence` fields are null.
    `EntryState.author` is now `AuthorRef | AuthorRef[]`: use `authorRefsOf`
    or `signersOf` to read it.
  - `@originals/sdk`: `create({ authors: { threshold, members }, signers })`,
    and `edit`, `deactivate`, `publish`, `anchor` and `reconcile` take a set
    Original's signer references and `signers`. A draft flow for signers who
    are not all present: `prepare*`, `cosign(draft, signer)`, then
    `commitDraft(draft)` (or `finalizeDraft` for a shared host). Each signer is
    shown the entry as itself, with `summary.signers` and `summary.authors`.
    Evidence packages carry every signing member's DID history.
  - `@originals/host`: shared-host saves check every signer of a set entry, and
    a member's account may save.
  - `@originals/code`: code Originals stay single-author until the code profile
    moves onto signer sets (plan 050 §5, step 3): a set Original as a repo or
    branch is refused (`SIGNER_SET_UNSUPPORTED`), never read as one author.

- Updated dependencies [fd15702]
- Updated dependencies [874555b]
- Updated dependencies [874555b]
- Updated dependencies [0d1a2b3]
- Updated dependencies [939a0d9]
- Updated dependencies [2e8c053]
- Updated dependencies [37e7ee5]
- Updated dependencies [431defb]
- Updated dependencies [4248e63]
- Updated dependencies [1fdd945]
- Updated dependencies [3edd470]
- Updated dependencies [11b25a8]
- Updated dependencies [2a41ca4]
- Updated dependencies [f5de8cd]
- Updated dependencies [b021bd3]
- Updated dependencies [b6f626e]
- Updated dependencies [037d167]
- Updated dependencies [4619848]
- Updated dependencies [1aad0f3]
- Updated dependencies [900ed2a]
- Updated dependencies [1eb52a9]
- Updated dependencies [ebc6308]
- Updated dependencies [296a969]
- Updated dependencies [e5a3e3d]
- Updated dependencies [0f4790b]
- Updated dependencies [a0153f0]
  - @originals/vh@0.5.0
  - @originals/sdk@6.2.0
