# npm publishing credential runbook

The release workflow uses the repository's `NPM_TOKEN` through setup-node's
`NODE_AUTH_TOKEN` registry configuration. Changesets CLI v3 and action v2 are
configured with Node 24 for publishing; the Node 20.10 consumer checks run before
that runtime switch. Merging the stable Version Packages PR is the publication
gate. Do not run a real publish to test a credential.

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

The publish workflow separately runs `npm whoami` immediately before publishing,
so an invalid token stops before provenance signing or registry writes. The weekly
expiry guard uses `NPM_TOKEN_EXPIRES_AT`; it cannot recover the actual expiry from
GitHub secret metadata and must not be given a guessed date.

## Rotate when necessary

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

Trusted publishing remains a separate migration requiring npm-side publisher
configuration and verification. The CLI/action upgrades are now complete; they
do not establish an OIDC trust relationship by themselves.

Sources: [npm token permissions](https://docs.npmjs.com/about-access-tokens/),
[token creation and inspection](https://docs.npmjs.com/creating-and-viewing-access-tokens/),
[registry token API](https://api-docs.npmjs.com/),
[Changesets v2 action contract](https://github.com/changesets/action/blob/v2/action.yml).
