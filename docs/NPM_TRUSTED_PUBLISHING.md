# npm trusted publishing

The release workflow now publishes via npm **OIDC trusted publishing**: the
`publish` job's `id-token: write` permission plus `actions/setup-node`'s
`registry-url` let npm authenticate the run without any token in the workflow.
Changesets CLI v3 and action v2 are configured with Node 24 for publishing
(npm's documented requirement for trusted publishing is npm CLI >= 11.5.1 and
Node >= 22.14.0); the Node 20.10
consumer checks run before that runtime switch. Merging the stable Version
Packages PR is the publication gate. Do not run a real publish to test a
credential.

## Trusted publisher setup (manual, npm-side, required once per package)

Trusted publishing requires a publisher registered on npmjs.com for **each**
published package — this is npm account configuration, not something a
workflow change can do. For every package (`@originals/vh`, `@originals/sdk`,
`@originals/auth`):

1. Sign into npmjs.com, open the package's Settings, and add a GitHub Actions
   trusted publisher.
2. Organization or user: `onionoriginals`. Repository: `sdk`. Workflow filename:
   `release.yml`. **Leave Environment blank** — `release.yml` deliberately does
   not run the publish job under a GitHub Environment (the Version PR is the
   single approval surface), so setting an Environment on the npm side would
   make the trust tuple disagree and OIDC would fail to authenticate.
3. For a trusted publisher created after 2026-09-03, npm defaults new
   configurations to stage-only; explicitly enable direct `npm publish` as
   well, since this workflow calls `changeset publish` directly.
4. This is an npm account action: it needs an interactive session with 2FA.
5. Once all three are registered and verified, open the gate in `release.yml`
   by setting the non-secret repository variable it checks before publishing:

   ```sh
   gh variable set NPM_TRUSTED_PUBLISHING_READY --repo onionoriginals/sdk --body true
   ```

   There is no read-only API the workflow can use to confirm registration
   itself (npm whoami cannot validate OIDC trust — the exchange only happens
   during an actual publish attempt), so the `publish` job's first step fails
   loudly with a link back to these instructions until this variable reads
   `true`. It stays `true` afterward; there is no per-release reset.

Until every package has a trusted publisher configured **and**
`NPM_TRUSTED_PUBLISHING_READY` is set, `release.yml`'s `publish` job refuses to
run at all. **Configure and confirm all three before merging a Version
Packages PR** — once the gate is open, `changeset publish` publishes all
pending packages in one run, and if any package's registration was missed or
misconfigured despite the gate, it can publish the others before failing on
that one, leaving the release partially out.

**Recovery if that happens:** finish registering the remaining package(s),
then re-run the `publish` job (or push a no-op commit and let `check-publish`
re-enter it — it re-evaluates per-package, not per-run). `changeset publish`
is idempotent: it skips any package/version already on the registry and
publishes only what is still missing, so a retry after completing
registration cannot double-publish or corrupt the partially-released
version set. Nothing needs to be rolled back.

## No stored npm token

Releases authenticate only through OIDC. `release.yml` has no `NPM_TOKEN` or
`NODE_AUTH_TOKEN` path, and `scripts/release-workflow.test.mjs` asserts that the
publish step never gains one. There is no token to rotate or expire.

OIDC was proven on a real release when Version Packages (#1010) published
`@originals/sdk@6.0.0` with SLSA provenance on 2026-11-03, after the old
granular token had expired on 2026-10-25. The token, its weekly expiry guard
(`npm-token-expiry.yml`) and its read-only credential check
(`npm-release-check.yml`) were then retired. The receipt from that era stays in
[`release/evidence/final-npm-credential.json`](release/evidence/final-npm-credential.json)
as history.

A token-based publish would not be a reliable fallback anyway. Under npm's
[2FA-bypass deprecation](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/),
2FA-bypass granular tokens lose direct publishing around January 2027. If OIDC
is ever unavailable, publish manually from a trusted machine with an
interactive 2FA session.
