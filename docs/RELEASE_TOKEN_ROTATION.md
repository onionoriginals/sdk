# NPM_TOKEN rotation runbook

**Path documented here: token rotation, not OIDC trusted publishing.** OIDC
(#450) is now *structurally* viable — the ecosystem gap that blocked it is
mostly closed — but adopting it here means two breaking upstream upgrades
(`@changesets/cli` v2→v3, `changesets/action` v1→v2) plus a workflow rewrite,
none of which should be rushed through days before a token expiry. Rotate now
(this doc); do the OIDC migration as its own reviewed PR against #450. See
["Why not OIDC yet"](#why-not-oidc-yet-evidence) below for the evidence.

## Expiry: confirmed creation date, unconfirmed exact expiry

- `gh secret list --repo onionoriginals/sdk` shows `NPM_TOKEN` last updated
  **2026-07-27T06:53:55Z** — this matches issue #449's claim that the token
  was set on 2026-07-27.
- npm caps **write-capable** granular access tokens (GATs) at a **90-day**
  maximum lifetime as of the Nov 2025 security changes ([GitHub Changelog,
  2025-11-05](https://github.blog/changelog/2025-11-05-npm-security-update-classic-token-creation-disabled-and-granular-token-changes/)).
  90 days after 2026-07-27 is **2026-10-25**.
- **What is NOT confirmed**: the *actual* expiry the token was created with.
  GitHub's secret metadata only exposes `updated_at`, not npm's token expiry,
  and we have no read access to npm's token list from here. If a shorter
  expiry was chosen at creation (the pre-Oct-2025 default was 30 days unless
  overridden), the real expiry is earlier than 2026-10-25.
- **Action**: treat 2026-10-25 as an upper bound, not a fact. Check
  npmjs.com → Access Tokens for the exact date before relying on it, and
  rotate proactively rather than waiting for that date.

## Rotation steps (~5 minutes, npmjs.com + GitHub UI)

1. Go to **npmjs.com → Access Tokens → Generate New Token → Granular Access
   Token**.
2. **Expiration**: pick **90 days** explicitly. (Since mid-October 2025,
   npm's UI *default* for write-enabled GATs is 7 days — don't accept the
   default without checking it.)
3. **Packages and scopes**: select the **`@originals`** scope (not just the
   two individual packages) with permission **Read and write**. Selecting the
   whole scope — not `@originals/sdk` + `@originals/auth` individually — is
   what lets this same token publish `@originals/cel`'s first release later
   without another token change (see the cel caveat below).
4. **Bypass 2FA**: enable it. Without this, CI publishing fails with `EOTP`
   (the account requires 2FA for writes; CI has no prompt to answer). Note:
   as of 2026-07-31, 2FA-bypass GATs no longer bypass 2FA for
   *account/management* actions (creating tokens, changing package
   settings) — you'll need to complete 2FA to create the token itself, that's
   expected and separate from the bypass working for publish operations.
5. Copy the token value (shown once).
6. Set it as the repo secret:
   ```
   gh secret set NPM_TOKEN --repo onionoriginals/sdk
   ```
   (paste the token when prompted, or pipe it in).
7. Verify (see below) — do **not** trigger a real publish to test it.
8. Record the new expiry so the scheduled guard resets (see
   ["The two CI guards"](#the-two-ci-guards) below). Set it to the expiration
   you chose in step 2, as an ISO date:
   ```
   gh variable set NPM_TOKEN_EXPIRES_AT --repo onionoriginals/sdk --body 2027-01-23
   ```
   This is a **non-secret repository variable**, not a secret; it holds only a
   date. GitHub secret metadata never exposes npm's real expiry, so this
   variable is the only place CI can learn when to nag. Leave it unset and the
   guard fails every week until it is set.

### `@originals/cel` caveat

`@originals/cel` has never been published. A granular token cannot be scoped
to a package that doesn't exist yet, so if you pick "select individual
packages" instead of the `@originals` scope in step 3, the token won't be
usable for `@originals/cel`'s first publish and you'll need a separate token
(or a scope edit) when that release happens. Selecting the scope in step 3
avoids this.

## Verifying the new token without publishing

Run locally (never commit the token; use a throwaway shell):

```bash
# 1. Confirms the token authenticates at all.
npm whoami --registry=https://registry.npmjs.org/ \
  --//registry.npmjs.org/:_authToken=<TOKEN>

# 2. Confirms write access on the actual packages, without writing anything.
npm access list packages --registry=https://registry.npmjs.org/ \
  --//registry.npmjs.org/:_authToken=<TOKEN>
# Plain-text output, one package per line. Look for:
#   @originals/sdk: read-write
#   @originals/auth: read-write
# @originals/cel won't appear (never published) — that's expected.
```

If both succeed, the secret is good. The token's first real use will be the
next `release.yml` run that has a version to publish (i.e. after a Version
Packages PR merges) — no need to force one.

## The two CI guards

Two workflow guards exist so a dead token can never again surface only as a
misleading E404 mid-release. Neither can rotate the token (that stays the
human chore above), but together they make expiry loud and early instead of
silent and late.

- **Preflight in `release.yml` (fails the release, at publish time).** The
  `publish` job runs `npm whoami` immediately before the publish step, using
  the same `NODE_AUTH_TOKEN`/`.npmrc` the publish uses. If the token is expired
  or invalid, `whoami` cannot authenticate and the job stops **before** the
  publish and before provenance signing, with an error that names the token as
  the cause, points at this runbook, and states that the misleading
  `E404 Not Found - PUT https://registry.npmjs.org/@originals%2fsdk` is what
  would have happened next. `whoami` prints only the account name, never the
  token, so nothing leaks into the logs. **What its failure means:** the token
  is dead (or was never valid); rotate it per the steps above and re-run the
  publish job (`changeset publish` is idempotent, so a re-run after a failed
  publish is safe).

- **Scheduled check in `npm-token-expiry.yml` (nags before the deadline).** A
  weekly job (Monday 08:00 UTC; also runnable via **Run workflow**) reads the
  non-secret `NPM_TOKEN_EXPIRES_AT` repository variable. It fails, and opens or
  refreshes a single tracking issue titled *"NPM_TOKEN expiry guard: rotate the
  npm publish token"* (matched by exact title so it never files duplicates),
  when the recorded expiry is **within 14 days or already past**, or when the
  variable is **unset or unparseable**. Once you rotate and set
  `NPM_TOKEN_EXPIRES_AT` to a date more than 14 days out (step 8 above), the
  next run closes that issue automatically. **What its failure means:** either
  the token is about to expire (rotate now, ahead of a release, not during
  one), or nobody recorded the expiry after the last rotation (set the
  variable). The guard reads no secret and cannot publish; it only watches the
  date you record.

## Why not OIDC yet: evidence

Issue #450 already identified the blocker: [npm/cli#8976](https://github.com/npm/cli/issues/8976)
("OIDC trusted publishing E404 when publishing scoped packages from
changesets/action"), filed 2026-02-12. Checked today via the GitHub API:

- **Still open**, unassigned, no linked PR (`state: open`, last activity
  2026-05-15).
- Its one comment (2026-05-15, from an external user who debugged the exact
  same `changesets/action` + monorepo combination) identifies the real root
  cause: `changesets/action`'s `publish:` input spawns `changeset publish` →
  `npm publish` through a process chain that does **not** propagate the
  OIDC env vars (`ACTIONS_ID_TOKEN_REQUEST_TOKEN` /
  `_URL`) down to the final `npm publish` process. Their workaround: stop
  letting `changesets/action` run the publish command; run `npm publish`
  directly in a separate step instead. This is a wrapper-chain problem, not
  strictly an unfixable npm CLI bug — which is why "still open" doesn't mean
  "still impossible."
- That workaround is now the *upstream-supported* path: `changesets/action`
  shipped new `/select-mode`, `/version`, `/publish` sub-actions in
  [PR #656](https://github.com/changesets/action/pull/656), released as part
  of **`changesets/action` v2.0.0 on 2026-08-11** (v2.1.0 followed
  2026-08-13) — resolving [changesets/action#515](https://github.com/changesets/action/issues/515),
  the feature request for OIDC-friendly split publish/version workflows.

**So OIDC is no longer blocked on an unfixed upstream bug** — but v2 is 5
days old at time of writing and is a breaking major version:

- Requires **`@changesets/cli` v3** (we're on `2.31.0`); v2 of the action
  explicitly refuses v2-CLI projects and points them at
  `changesets/action@v1`. CLI v3 is ESM-only, requires Node `^22.11 || ^24 ||
  >=26` for the tooling itself (fine — it's a dev dependency, doesn't affect
  published packages' `engines.node`), and restructures `.changeset/pre.json`
  prerelease state into a `.changeset/pre/` folder (auto-migrates on first
  `changeset version`, but is exactly the kind of change this repo's
  "never hand-edit `pre.json`" rule exists to be careful around).
- Requires rewriting `release.yml`: kebab-case renamed inputs
  (`version`→`version-script`, `publish`→`publish-script`, etc.), explicit
  `github-token` input (env var passthrough removed), `.npmrc`/`NPM_TOKEN`
  auto-handling removed by design (v2 assumes trusted publishing).
- Requires the publish job's runner to move off Node 20.10.0 to Node
  `>=22.14.0` (npm CLI `>=11.5.1`) — already noted as needed in #450.
- Requires registering a trusted publisher per package on npmjs.com (org
  `onionoriginals`, repo `sdk`, workflow filename, environment
  `npm-publish`) for `@originals/sdk` and `@originals/auth`. Confirmed via
  [npm's trusted publishing docs](https://docs.npmjs.com/trusted-publishers/):
  npm CLI `>=11.5.1` and Node `>=22.14.0` are required registry-side too.
- **`@originals/cel` blocks on the same bootstrap gap independent of OIDC
  readiness**: npm trusted publishing cannot be configured for a package
  that has never been published — there's no package settings page to attach
  it to. `@originals/cel`'s first publish must use a token regardless of
  when/whether OIDC lands for the other two packages.

None of that is a reason to avoid OIDC — it's a reason not to do it as a
docs-adjacent change three weeks before a token deadline. Recommended
follow-up: update #450 with this evidence and scope the CLI v3 + action v2
migration as its own PR, tested independently of any release deadline.

## What happens to the old `NPM_TOKEN` secret

Overwriting it via `gh secret set` (step 6 above) replaces the value in
place — no separate deletion step. The old token keeps working at npm until
it separately expires; npm has no revoke-on-overwrite behavior, so if you
want to kill it immediately rather than let it lapse, revoke it manually
from npmjs.com → Access Tokens.
