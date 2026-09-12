# GitHub Actions Workflows

## Release Workflow (`release.yml`)

Publishing of `@originals/sdk` and `@originals/auth` to npm is handled by the
`release.yml` workflow using [Changesets](https://github.com/changesets/changesets),
gated by two human-in-the-loop steps. It triggers on every push to `main`.

### Required Secrets

Configure these in **Settings → Secrets and variables → Actions**:

#### npm authentication — OIDC trusted publishing (primary path)
The `publish` job authenticates to npm via **OIDC trusted publishing**: the
workflow's `id-token: write` permission plus `actions/setup-node`'s
`registry-url`. There is no `NODE_AUTH_TOKEN` on the publish step. npm
provenance is generated automatically for this public repo under trusted
publishing.

This requires a trusted publisher registered on npmjs.com for each published
package (`@originals/cel`, `@originals/sdk`, `@originals/auth`) — org
`onionoriginals`, repo `sdk`, workflow `release.yml`, no Environment. See
[`docs/RELEASE_TOKEN_ROTATION.md`](../../docs/RELEASE_TOKEN_ROTATION.md) for
the full setup and current migration status.

#### `NPM_TOKEN` (fallback only, not read by the automated publish step)
An npm granular access token kept configured as a manual/emergency fallback
until OIDC trusted publishing has been proven on a real release. The `release.yml`
publish step deliberately does not reference it, so it cannot silently mask an
OIDC misconfiguration. See `docs/RELEASE_TOKEN_ROTATION.md` for rotation steps.

#### `CHANGESETS_TOKEN` (optional but recommended)
A PAT (or GitHub App token) used to push the "Version Packages" PR branch. Pushes
made with the built-in `GITHUB_TOKEN` do **not** trigger other workflows, so
without this secret the Version PR opens but does not run `ci.yml` until it is
added. Falls back to `GITHUB_TOKEN` when unset.

### Built-in Tokens

`GITHUB_TOKEN` is provided automatically by GitHub Actions — you don't create it.

### How It Works

1. **Gate 1 — Version (open release PR).** While changesets are pending on `main`,
   the `version` job opens/updates a "Version Packages" PR that bumps versions and
   updates CHANGELOGs. **Merging that PR is the human approval that a release should
   happen.** No publishing occurs here.
2. **Check for unpublished versions.** After the Version PR merges, `check-publish`
   compares each package's local version against the npm registry and only proceeds
   when a version is genuinely not yet published (any other registry error fails
   loudly rather than over-publishing).
3. **Gate 2 — Publish.** The `publish` job is deliberately **not** bound to a
   GitHub Environment — merging the Version PR is the single human approval for
   a release. It builds, runs `scripts/verify-esm.mjs` and
   `scripts/check-browser-safety.mjs` (refusing to publish a dist that Node ESM
   or browser/edge consumers can't import), then publishes via `changeset
   publish` over OIDC trusted publishing, pushing tags and creating GitHub
   Releases as one step.

### Adding a Changeset

Contributors describe releasable changes with a changeset:

```bash
bun run changeset
```

This records the affected packages and the semver bump (patch/minor/major) plus a
summary that becomes the CHANGELOG entry. The Version PR aggregates pending
changesets into the next release.
