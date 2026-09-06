# Releasing

One PR, one approval. Merging the **Version Packages** PR publishes to npm. There
is no second approval and no reason to open the Actions tab.

## The flow

1. **Land changes with a changeset.** Every PR that changes a published package
   adds one (`bun run changeset`). Repo-infra and docs PRs add an empty one
   (`bun run changeset --empty`) to satisfy the `Changeset present` gate.
2. **The bot maintains a Version Packages PR.** While changesets are pending on
   `main`, the `Release` workflow keeps `changeset-release/main` open with the
   version bumps and CHANGELOGs, and comments a **publish plan** on it — every
   package, its old and new version, and the dist-tag it will land on.
3. **Merge that PR to release.** The workflow builds, runs the Node-ESM and
   browser-safety gates, then publishes, pushes git tags, and creates GitHub
   Releases. A failed gate blocks the publish.

Read the publish plan before merging. npm publishes are effectively permanent —
unpublish is limited to 72 hours and breaks anyone who already installed.

## Prerelease mode

`.changeset/pre.json` puts the repo in prerelease mode; versions become
`X.Y.Z-next.N` and publish under the `next` dist-tag, leaving `latest` where it
is.

- Enter with `bunx changeset pre enter next`, exit with `bunx changeset pre exit`.
  **Never hand-edit `pre.json`.** Its `changesets` array records which changesets
  have already shipped in a prerelease; writing pending ones into it tells
  changesets they are already out, and the version job silently no-ops with
  `All changesets are empty; not creating PR`.
- A package with **no prior normal release** publishes to `latest` even in
  prerelease mode. That is `changeset publish`'s behaviour for a first publish —
  it is the only way a brand-new package is installable at all. The publish plan
  flags this explicitly.
- A brand-new package's packument can 404 for a few minutes after its first
  publish while the registry propagates, even though the tarball is already
  live. Re-check before assuming the publish failed.

## Credentials

Publishing uses the repo secret `NPM_TOKEN`. See
[RELEASE_TOKEN_ROTATION.md](./RELEASE_TOKEN_ROTATION.md) for rotation steps and
the status of the OIDC trusted-publishing migration.
