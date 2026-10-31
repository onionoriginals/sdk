# Originals local/web acceptance — issue #976

Local release acceptance: **PASS**. Hosted feature enablement: **FAIL (not
yet proven; public-host/Turnkey acceptance was not run)**. This result does
not authorize publication or deployment. Hosted publication remains disabled
by default and in the production configuration.

The tested source is `cfa29326bcd9c7e2a4ace1d31b6915c1ff229d34`, with a clean
working tree when both receipts were generated. Tests ran on 30 October 2026
in America/Vancouver (31 October UTC). This documentation and its evidence
were added afterward; no implementation changes were needed. The existing
#964 repair and actual landing DID-builder regression passed on this revision.

Built versions: SDK **5.1.0**, vh **0.3.0**, auth **4.0.2**, host **0.2.0**,
landing **0.4.0**, and didwebvh-ts **2.8.0**. Package builds were forced to
execute without Turbo cache before generating the retained receipts.
No deployed revision or public test URL applies to this run.

## Retained evidence

- [Local receipt](evidence/originals-976-cfa29326/local/receipt.json): all A1–A5
  gates and process isolation PASS; 39 phase checks.
- [Hosted dry-run receipt](evidence/originals-976-cfa29326/hosted/receipt.json):
  `DRY-RUN-PASS`, 29 phase checks; real B1–B6 gates explicitly `NOT-RUN`.
- [Complete exported work](evidence/originals-976-cfa29326/local/artifacts/original-A.zip),
  [expected checkpoints and byte digests](evidence/originals-976-cfa29326/local/artifacts/expected-A.json),
  and [public author identity](evidence/originals-976-cfa29326/local/public/author-did.json).
- [SHA-256 manifest](evidence/originals-976-cfa29326/SHA256SUMS.json) covers both
  receipts and all retained artifacts. Artifact paths inside each receipt are
  relative to its retained `local/` or `hosted/` directory. Absolute temporary
  paths and loopback URLs describe the original execution, not durable services.

The Original is `did:vh:QmVRPAJTf7yemCApUb6vRzFD5mRENNjgYaZHEe9GywFcvg`.
Its exported checkpoint is
`5-Qmc6QPvXD8K7hCkkKs5ftvCrVox6ZgeZcQkLQx7abfSaCv`.
The complete archive's SHA-256 is
`5ac7ec898c5518086f9669de74385baf00f4811ea1fb06d1cef866f06ef1b5c2`.
`original-B.zip` retains continued history, `original-X.zip` the divergent
branch, and `original-A-partial.zip` the intentionally incomplete negative
fixture. Custody files, private keys, author stores and browser sessions are
not included. Retained files and decompressed archives were checked against
the generated custody key values; none were present.

## Local release result

The consumer journey creates PNG, binary and Markdown resources, revises
them, adds/removes a resource, and exports the complete evidence package.
Five distinct processes run with separate HOME/TMPDIR directories and clean
environments. macOS `sandbox-exec` denies network access, with an additional
in-process network guard. The fresh reader cannot read custody or source
stores, verifies the same identity, checkpoint, historical versions and byte
digests, and also exercises the built CLI.

Import into an empty store confers no signing authority. Missing authority,
an intruder key and the identity update key cannot edit. Supplying the
authorship key separately permits continuation from an explicit parent while
preserving identity and history. Stale parents/digests, missing historical
bytes, stale prefixes and divergent histories are exercised; forks remain
unresolved in either import order.

The signer is local Ed25519, with the landing's real did:webvh builder:
`#key-0` controls identity updates, and `#key-1` signs Originals. This is not
Turnkey evidence. The selected profile is provisional `originals:1.0`,
`eddsa-jcs-2022`, without witnesses. Valid history and current authorization
do not imply freshness: these unanchored works are never reported current,
ordering is claimed, and no global finality or preferred fork is asserted.

## Hosted gate still outstanding

The local dry run uses the real hosting routes and durable server store on
loopback, local Ed25519 custody in place of Turnkey, fresh Bun clients with
FileStore, and independent signed-out Node readers. It passes reopen/edit,
restore on another client, stale-parent rejection, and interruptions after
the alias entry and during resource uploads. Resume preserves the alias and
checkpoint without a second publication entry; incomplete snapshots fail
reader verification before successful resume.

This does not establish deployed behavior, real browser restart persistence,
or real client-held Turnkey signing. No account, public host or deployment was
used or changed. The source feature-flag check passed; production was not
queried. Follow the [hosted runbook](../../scripts/acceptance/hosted-README.md)
only with separately authorized staging host and test-account access, and
retain a passing deployed receipt before enabling hosted publication.

Unpublished work does not automatically sync between clients; evidence import
is the supported transfer path. The current guest implementation persists an
unencrypted key in this browser with an explicit warning (the later #992
decision documented in the runbook). It is not portable account recovery,
and guest private keys are never exported in evidence. Bitcoin acceptance is
outside this result.

## Verification commands

All commands below succeeded on the candidate. The landing build emitted
dynamic-import warnings, and the browser-safety check reported existing
Buffer advisories in three unrelated SDK modules; neither failed its check.

```sh
bun install --frozen-lockfile
bunx turbo run build --filter='./packages/*' --force
node scripts/acceptance/local-release.mjs --require-os-sandbox --out /tmp/976-final-local
node scripts/acceptance/hosted-release.mjs --target local --out /tmp/976-final-hosted
bun run --cwd packages/sdk typecheck:public
bun test packages/sdk/tests/unit/originals
bun run landing:check
node scripts/verify-esm.mjs
node scripts/check-browser-safety.mjs
node --test scripts/acceptance/lib/phase-result.test.mjs scripts/acceptance/hosted/did-domain.test.mjs
```

SDK: **256 tests passed**. Landing: **1,095 tests passed**, app/server
typechecks, production build and chunk-cycle check passed. Harness regressions:
**7 tests passed**. ESM: **28 exported entry points** imported successfully.
Browser-safety and public API typechecks passed. These checks are local
release evidence, not deployment or public-host proof.

## Production preflight follow-up — 31 October 2026

The earlier directory-app deployment blocker is resolved. A fresh signed-out
browser checked `https://originals.build/`, `/api/version`, `/api/health` and
`/context`; all returned 200 with the expected content types. The landing
title is “Originals — Give your work a history”. Both server and SPA report
`ef629500b620f9133a9df081c5168e436a2ffa98` from **aviarytech/originals.build**.
See the [new preflight receipt](evidence/originals-976-production-preflight-ef62950.json)
for response digests and observations. The earlier preflight remains a
historical observation, not the current deployment status.

The owner reports that the deployed landing is equivalent to SDK `cfa2932`
plus migration packaging changes: npm packages in place of workspaces, a
seeded lockfile, npm-aware chunk matching, three fixture adjustments and the
`/example/first-light.originals.zip` link. Its reported installed packages
match the local acceptance versions. Independently, the deployed revision's
`features.ts` is byte-identical to this SDK candidate, and its package manifest
declares landing 0.4.0 and the corresponding npm dependency ranges. A full
source-equivalence audit was not performed. The app SHA and SDK SHA are
separate provenance facts; the local receipt does not establish deployed
acceptance simply because the app was copied from that revision.

**Deployment preflight: PASS. Hosted journey: still blocked.** The live UI
shows publishing as “Coming back”, and `window.__originalsDemo` is absent,
as expected for production. The unchanged feature resolver excludes
`originals.build` from acceptance builds. The production-off check passes;
Turnkey creation/publication, independent published-work verification,
browser restart and interrupted publication remain NOT-RUN. The current
harness also assumes app and SDK source SHAs are identical and must account
for the split repositories before it can issue an accurate hosted receipt.
No deployment settings, environment, accounts or public data were changed,
and no spending occurred.
