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

## Dist-tags: what a consumer actually installs

`changeset publish` picks the tag; nobody checks the result. That gap shipped a
launch-blocking bug: every doc described 3.x while `npm install @originals/sdk`
returned **2.1.0**, a major behind, with a different lifecycle API and no
`./testing` subpath. `bun run check:install-docs` (a CI job) now asks the
registry what each shipped install command resolves to and fails if it is not
the major this repo documents.

**The standing decision: a prerelease never goes on `latest`.** 3.0.0-next.N is
not the build we want a stranger installing by default — it is a prerelease, and
`latest` is the tag that means "the supported release". So `latest` stays on
2.1.0 and every install command in the docs and on the site names `@next`. When
3.0.0 is ready, `bunx changeset pre exit` ships it to `latest` and the `@next`
tags come back out of the docs (the honesty tests in
`apps/landing/src/components/install-line-honesty.test.ts` say the same thing).

### The first-publish trap

A package with no prior normal release publishes to `latest` even in prerelease
mode, and npm additionally forces `latest` on the very first publish of any
package. `@originals/cel` hit both: `0.2.0-next.0` went out as the first publish
(so npm set `latest` **and** `next`), then `0.2.0-next.1` went to `latest` by the
no-prior-normal-release rule — leaving `next` pointing at the **older** build.

That is registry state, not repo state, so no merge fixes it. Correct it with a
token that can publish:

```bash
# @originals/cel: move `next` forward off the stale 0.2.0-next.0.
npm dist-tag add @originals/cel@0.2.0-next.1 next

# Confirm both packages afterwards.
npm view @originals/cel dist-tags
npm view @originals/sdk dist-tags   # expect latest=2.1.0 (stable), next=3.0.0-next.1
npm view @originals/auth dist-tags  # expect latest=2.0.0 (stable), next=3.0.0-next.0
```

`@originals/cel` has no stable release at all, so its `latest` stays on a
prerelease until 0.2.0 ships — there is nothing better to point it at, and it is
a transitive dependency resolved by the range in `packages/sdk/package.json`, not
something the docs tell anyone to install directly.

After any dist-tag change, run `bun run check:install-docs` locally: it is the
same check CI runs, and it reads the live registry.

## Credentials

Publishing uses the repo secret `NPM_TOKEN`. See
[RELEASE_TOKEN_ROTATION.md](./RELEASE_TOKEN_ROTATION.md) for rotation steps and
the status of the OIDC trusted-publishing migration.
