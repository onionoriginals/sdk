# GitHub Actions Workflows

## Release Workflow (`release.yml`)

Publishing of `@originals/sdk` and `@originals/auth` to npm is handled by the
`release.yml` workflow using [Changesets](https://github.com/changesets/changesets),
gated by two human-in-the-loop steps. It triggers on every push to `main`.

### Required Secrets

Configure these in **Settings → Secrets and variables → Actions**:

#### `NPM_TOKEN` (required to publish)
An npm **Automation** access token used to publish packages (also used as
`NODE_AUTH_TOKEN`). npm provenance is enabled via `NPM_CONFIG_PROVENANCE` and the
workflow's `id-token: write` permission.

**How to create it:**

1. Log in to [npmjs.com](https://www.npmjs.com).
2. Profile icon → "Access Tokens" → "Generate New Token" → "Classic Token".
3. Select **"Automation"** (for CI/CD publishing) and copy the token.

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
3. **Gate 2 — Publish.** The `publish` job runs under the `npm-publish` GitHub
   Environment, which carries a **required reviewer** — a human must approve in the
   GitHub UI before anything reaches npm. It builds, runs `scripts/verify-esm.mjs`
   (refusing to publish a dist Node ESM consumers can't import), then publishes via
   `changeset publish`, pushing tags and creating GitHub Releases as one step.

### Adding a Changeset

Contributors describe releasable changes with a changeset:

```bash
bun run changeset
```

This records the affected packages and the semver bump (patch/minor/major) plus a
summary that becomes the CHANGELOG entry. The Version PR aggregates pending
changesets into the next release.
