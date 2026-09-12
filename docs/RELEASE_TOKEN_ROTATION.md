# npm publishing credential runbook

The release workflow now publishes via npm **OIDC trusted publishing**: the
`publish` job's `id-token: write` permission plus `actions/setup-node`'s
`registry-url` let npm authenticate the run without any token in the workflow.
Changesets CLI v3 and action v2 are configured with Node 24 for publishing
(required by trusted publishing: npm >= 11.5.1 / Node >= 22.9); the Node 20.10
consumer checks run before that runtime switch. Merging the stable Version
Packages PR is the publication gate. Do not run a real publish to test a
credential.

## Trusted publisher setup (manual, npm-side, required once per package)

Trusted publishing requires a publisher registered on npmjs.com for **each**
published package — this is npm account configuration, not something a
workflow change can do. For every package (`@originals/cel`, `@originals/sdk`,
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
4. This account/management action falls under npm's 2FA-bypass restrictions
   (see below) and needs an interactive session with 2FA, same as rotating a
   token.
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

## 2FA-bypass deprecation timeline (why this migration exists)

Per npm's [install-time security and GAT bypass2FA deprecation
announcement](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/):

- **Early August 2026** — 2FA-bypass granular tokens stop bypassing 2FA for
  account/management operations (creating tokens, changing package access,
  configuring trusted publishing). Publishing itself was unaffected by this
  phase.
- **~January 2027** — 2FA-bypass granular tokens lose direct publishing
  entirely, restricted to reading private packages and staging a publish.

The token-based release path (`NPM_TOKEN`) therefore breaks again around
January 2027 even after a fresh rotation, independent of the 90-day expiry
below. OIDC trusted publishing has no token to expire or rotate.

## Current observations

At the September 7, 2026 pre-release audit, GitHub reported `NPM_TOKEN` last
updated on **2026-07-27T06:53:55Z** and no `NPM_TOKEN_EXPIRES_AT` variable.
A GitHub secret update is not the npm token's creation or expiry date. Under
npm's 90-day maximum for write-capable granular tokens, October 25 is an upper
bound for a token created no later than that update, not a confirmed expiry.
Verify the actual date in npm before relying on it.

All three packages already exist in the registry: `@originals/sdk`,
`@originals/cel`, and `@originals/auth`. Earlier instructions saying CEL needed
its first package publication are obsolete. Grant access to the `@originals`
scope or explicitly include all three packages.

The subsequent read-only runner check confirmed the stored token expires at
**2026-10-25T06:53:28.982Z**, has package-write permission for `@originals`, and
has 2FA bypass enabled. `NPM_TOKEN_EXPIRES_AT` is now set to `2026-10-25`.
See [the sanitized receipt](release/evidence/final-npm-credential.json).

## Read-only checks

`.github/workflows/npm-release-check.yml` runs on pushes to the trusted release
integration/candidate branches. Once present on the default branch it can also
be dispatched manually. It has read-only GitHub permissions, installs no package
dependencies, and makes only authenticated GET requests to `registry.npmjs.org`.
It never copies the publishing credential out of the runner, logs token values
or identifiers, writes registry state, or publishes.

The report distinguishes:

- **Authentication:** whether the stored GitHub credential passes `/-/whoami`.
- **Account package access:** rights returned by the user/package endpoint.
  Account rights alone do not prove the granular token permits publication.
- **Token metadata:** exact expiry, read-only flag, 2FA bypass, permissions and
  Originals scope, only if the token-list API allows the request and one masked
  token matches in a complete response. Missing, ambiguous or paginated metadata
  remains unconfirmed; inspect the account in npm instead.

A failed credential, observed expiry or observed read-only token fails the job.
A successful observations job is not by itself proof that every publishing
permission is configured. Check the reported scope and bypass settings before
release. npm may require an interactive account session to view token metadata.

The publish job no longer runs `npm whoami` or references `NPM_TOKEN` at all —
it authenticates via OIDC trusted publishing instead (see above). `npm whoami`
only exercises the long-lived token path and cannot validate a trusted-publisher
configuration, so it stopped being a useful preflight once the publish step
switched auth methods. The weekly expiry guard still uses `NPM_TOKEN_EXPIRES_AT`
and still runs — the token stays configured as an emergency fallback (see
"Fallback: rotating the token" below) until OIDC has been proven on a real
release, at which point the token and this rotation chore can be retired.

## Fallback: rotating the token (only if OIDC is not yet proven)

1. Sign into npm and open Access Tokens. Inspect the existing credential's expiry
   and permissions, or create a replacement granular token when needed.
2. Select an explicit expiry within npm's current limit. Grant read/write package
   access to `@originals` or all three packages. For unattended publishing on a
   2FA-protected account, configure the publishing bypass setting as required by
   npm. Account/token-management operations may still require interactive 2FA.
3. Set the new value with the hidden prompt; never put it in a command argument,
   commit, chat message or log:

   ```sh
   gh secret set NPM_TOKEN --repo onionoriginals/sdk
   ```

4. Record the actual chosen expiry using the non-secret repository variable
   `NPM_TOKEN_EXPIRES_AT` (ISO date). Do not substitute the secret-update date or
   the 90-day upper bound.
5. Run the read-only credential observations. Inspect account and token scope
   independently; confirm SDK, CEL and auth are all covered.
6. Revoke the superseded token in npm after validating the replacement. Replacing
   a GitHub secret does not revoke the old npm credential.

Local `npm whoami` uses the local npm configuration; it does not validate the
credential stored in GitHub unless that same credential was deliberately
configured. Prefer the runner observation for release evidence.

Rotating the token no longer restores the automated publish path by itself:
`release.yml`'s publish step does not read `NPM_TOKEN`/`NODE_AUTH_TOKEN`, by
design (see "why: not exposing it to the OIDC step" above). A rotated token is
kept only as a manual/emergency fallback (e.g. `npm publish` from a trusted
machine) if OIDC trusted publishing is ever unavailable; it is not consulted
by CI.

## Status: OIDC migration

The CLI/action upgrades (`@changesets/cli` v3, `changesets/action@v2`, Node 24
release runtime) are complete, and `release.yml`'s publish step now
authenticates purely via OIDC — it has no code path back to `NPM_TOKEN`. The
`publish` job additionally refuses to run at all until the
`NPM_TRUSTED_PUBLISHING_READY` repository variable is set (see "Trusted
publisher setup" above), so an incomplete migration fails the job immediately
with instructions rather than reaching npm unauthenticated. What remains is
the npm-side trusted-publisher registration itself, which only an account
owner with 2FA can do, setting that variable once it's done, and then one real
release to prove the end-to-end flow. Once that release succeeds,
delete/revoke `NPM_TOKEN`, retire `npm-token-expiry.yml`'s tracking issue, and
close the corresponding rotation issue — there is nothing left to rotate.

Sources: [npm token permissions](https://docs.npmjs.com/about-access-tokens/),
[token creation and inspection](https://docs.npmjs.com/creating-and-viewing-access-tokens/),
[registry token API](https://api-docs.npmjs.com/),
[Changesets v2 action contract](https://github.com/changesets/action/blob/v2/action.yml).
