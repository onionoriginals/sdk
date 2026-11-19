---
'@originals/code': minor
---

Code profile `originals-code/0.2` (PROVISIONAL), on the core's signer sets,
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
