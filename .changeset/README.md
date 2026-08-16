# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets). It
is how versions and changelogs are produced for `@originals/sdk` and `@originals/auth`.

## Adding a changeset (do this in every PR that changes published code)

```bash
bun run changeset
```

Pick the affected package(s), choose the bump type (`patch` / `minor` / `major`),
and write a one-line summary aimed at consumers. Commit the generated
`.changeset/*.md` file with your PR.

- `patch` — bug fixes, internal changes with no API impact
- `minor` — new, backwards-compatible API
- `major` — breaking changes

The two packages are versioned **independently** — a change to one does not bump
the other (Changesets only updates `@originals/auth`'s dependency range on
`@originals/sdk` when the SDK is published, per `updateInternalDependencies`).

If a PR genuinely needs no release (docs, CI, tests only), add an empty changeset:

```bash
bun run changeset --empty
```

## How releases happen

1. Merging PRs accumulates changesets on `main`.
2. A GitHub Action opens/updates a **"Version Packages"** PR that applies the
   pending changesets (bumps versions, writes CHANGELOGs) and comments a publish
   plan on it. Reviewing and merging that PR is the **only** approval gate.
3. Merging the Version PR publishes immediately — no second approval. The publish
   job only runs the automated build gates (Node-ESM import + browser safety)
   before `changeset publish`. See [docs/RELEASING.md](../docs/RELEASING.md).
