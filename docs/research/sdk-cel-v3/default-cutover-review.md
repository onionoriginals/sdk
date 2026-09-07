# Default CEL 3 SDK cutover

Snapshot: September 6, 2026. This supersedes the default-routing gap in the
[earlier opt-in review](implementation-review.md); that report and its receipt
remain a historical snapshot.

The package-root SDK now creates, mutates, serializes and fresh-loads CEL 3
assets through the shared core. This satisfies the **local routing** acceptance
criterion in [#562](https://github.com/onionoriginals/sdk/issues/562). It does not
establish new-format network publication or readiness for production issuance.

## Revisions and coverage

Branch `codex/sdk-cel-v3`, fixed base
`08a9981e22fbcb16e31495bd35344cd0016a11d7`. The changes are local and uncommitted,
not part of PR #574. [The validation receipt](default-cutover-validation.json)
identifies the exact working diff, individual files, commands and log hashes.
This branch predates PR #574's later changeset and downloader/CI fixes.

Review covers the new local asset implementation, default SDK composition,
public exports/types, CLI, shared identity helper extraction, and caller routing.
It does not re-audit the unchanged cryptographic core or preceding network
implementation. No deployment, package publication or public-chain writes occurred.

## Architecture and trust boundaries

- `packages/sdk/src/index.ts:8` selects the new default facade in
  `src/core/OriginalsSDK3.ts`. It composes the shared CEL 3 lifecycle rather than
  constructing the preceding SDK. `/types` describes the same public asset API;
  `/cel` exports the selected core verifier. `/v3` remains a smaller local entry.
- `src/v3/OriginalsSDK.ts:19` creates history with explicit custody and copied
  bytes. `src/v3/OriginalsAsset.ts` serializes each instance's read/sign/verify/
  commit work. Fresh loading authenticates the same state and historical byte
  attachments. Local drafts remain explicitly unverified until signed.
- Identity helpers used by auth have one implementation in
  `src/did/identity-operations.ts`. Independent identity, credential and low-level
  Bitcoin utilities remain available; they are not proof of asset publication.
- `src/did/DIDManager.ts:427` refuses default `did:cel`/`did:btco` resolution
  before looking in the old cache. The new resolver belongs to #563. There is
  no input-dependent fallback to an earlier asset processor.
- `apps/landing/src/sdk/previous-sdk.ts:1` is the private application boundary
  preserving the preceding landing/regtest journey. It is not a public SDK
  compatibility subpath. Remove it from the release journey when #563–565 are
  integrated, before claiming a new-format end-to-end gate.
- The installed CLI creates and verifies the same version-3 local envelope.
  Custody requires an explicit algorithm and raw key file. Network commands are
  unavailable. History-only verification does not claim checked media or Bitcoin
  acceptance.

The [API guide](../../../packages/sdk/V3.md) explains bytes, custody, mutation
results, partial loading, limits and removed APIs. Separate loaded instances can
form separate local histories; the per-instance queue is not a publication lock.

## Review results and resolved defects

Independent standards and specification reviews found no remaining actionable
issue within the local cutover scope after rechecks. These are bounded reviews,
not a security certification or endorsement of deployment readiness.

Two additional demonstrated defects were fixed during this cutover:

1. **Installed CLI symlinks did not execute the command.** Comparing the module
   URL with the invocation path treated an installed-style symlink as an import,
   so Node exited without doing work. `src/v3/cli.ts:179` now compares resolved
   paths. `tests/integration/CelV3Cli.test.ts` runs the packaged command through
   a temporary symlink and checks its version, in addition to byte-exact create
   and fresh recovery. High confidence, reproduced and rechecked.
2. **Negative public-type tests failed for the wrong reason.** A formatter moved
   `@ts-expect-error` above multiline declarations instead of the offending
   properties. The directives now target those properties, and the public type
   command passes. CI runs it after the built ESM check. High confidence;
   validation-only impact, no runtime authorization impact.

Earlier local recovery/budget findings and their regressions are documented in
the historical report. The previously reported opt-in-only completion gap is
resolved by the default export, caller and installed CLI cutover.

## Validation

Local macOS arm64, Bun 1.3.5, Node 25.2.1; no Linux CI run for this working diff.

| Check | Result |
| --- | --- |
| Full SDK `bun test tests/` | 3,205 pass; 245 skip; 0 fail; 242 files |
| New CEL 3 tests through the public root/CLI | 42 pass; included in the SDK total |
| Final focused recheck including shared identity helpers | 69 pass; 0 fail |
| Auth tests after shared helper cleanup | 249 pass; 3 skip; 0 fail |
| Landing tests | 986 pass; 0 fail |
| Root package build | Three package tasks pass |
| `bun run landing:check` | Typecheck, 986 tests and production build pass |
| SDK `bun run typecheck:public` against compiled export maps | Pass; also wired into CI |
| Node ESM imports | 24 entry points pass |
| Browser safety guard | Pass; existing Buffer advisories remain |
| Scoped SDK ESLint | Zero errors; eight unresolved dependency-type warnings in the extracted `createDID` helper |
| SDK package dry run | 313 files; default facade, public declarations, CLI and guide included; tests excluded |
| Diff whitespace check | Pass |

The full SDK suite passed before the final unsupported-identity error formatting
cleanup; the final focused SDK and auth rechecks passed after it. The retained
preceding-format test suites explicitly import a test-only previous SDK barrel;
their counts must not be presented as new-format network coverage.

The landing build still reports crypto-shim and ineffective-dynamic-import
warnings. No new browser E2E or remote custody provider test was performed.
The earlier browser-target Node smoke belongs to the smaller opt-in snapshot,
not fresh evidence for this default facade.

## Real regtest baseline

All three scenarios passed with real Bitcoin Core **31.1.0** and ord **0.29.0**:
normal publication, rejected reveal, and lost commit response. Each exercises
fresh resolution, exact PNG bytes, persisted recovery, restart of application
state, a one-block reorganization/reconfirmation and six-confirmation retention.
The selected PNG is 68 bytes with SHA-256
`5e3d382db4dd83d59aa5742793ad6b7903409e865c83bcbc54835049f043bc15`.

Receipts are retained in [baseline-regtest](baseline-regtest/README.md). They
explicitly include **v2 JSON reload**: this is evidence that the private adapter
preserved the preceding journey, not that CEL 3 was inscribed. An initial tool
download stalled at the already-known downloader issue; that attempt was stopped,
and the successful run used the previously verified pinned binaries. No skipped
connectivity test or failed attempt is counted as a pass.

## Next work

1. #563: connect public asset and DID resolution to the same accepted on-sat
   history, including fresh-consumer resource recovery and honest incomplete
   provider evidence.
2. #564 and #565: connect WebVH publication/restoration and Bitcoin boundary/delta
   writing without treating signed offline proposals as accepted publications.
3. Replace the private landing adapter and rerun the **new-format** journey on
   real regtest, including failure recovery, rotation and reorganizations.
4. Carry the exact release revision through the existing freeze and release
   gates. No current result establishes mainnet readiness or a release artifact.
