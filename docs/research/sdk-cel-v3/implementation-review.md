# CEL 3 local SDK implementation and review

Snapshot: 2026-09-05 America/Vancouver (2026-09-06 UTC).

The local CEL 3 SDK now supports creation, concurrent edits, authenticated resource
versions, controller rotation, deactivation, explicit unsigned drafts, and fresh
loading through the shared `@originals/cel/v3` verifier. The new API is available
at `@originals/sdk/v3` and as the root `v3` namespace.

This is a completed local implementation slice of [#562](https://github.com/onionoriginals/sdk/issues/562),
not completion of that issue. The default `OriginalsSDK`, landing, and network
writers/resolvers still use the prior representation. The new entry point has no
network writer and does not accept previous-format assets. Public default
cutover, WebVH integration, Bitcoin integration, and a new-format real regtest
journey remain open. The earlier regtest journey must not be cited as evidence
that CEL 3 has been inscribed.

## Revisions and scope

- Local branch: `codex/sdk-cel-v3`.
- Fixed implementation/review base: `08a9981e22fbcb16e31495bd35344cd0016a11d7`.
- The SDK snapshot is identified by the `packages/sdk` diff SHA-256 and individual
  file hashes in [validation.json](validation.json). This identifies the reviewed
  working state independently of a subsequent local commit.
- Prior work is in [PR #574](https://github.com/onionoriginals/sdk/pull/574), whose
  current head is `3efe35117fc2ebb94a04250e6110ffe58d5c685b`. The follow-on branch
  was created at `08a9981e...`; it does not yet include the PR's later changeset
  and download/CI fixes. No prior core or regtest receipt was rewritten.
- Review covers the new local SDK, its exports, documentation, and new tests.
  It does not reassess all cryptography in the unchanged core, deployed services,
  Bitcoin acceptance, custody providers, browsers, or the previous SDK.

## State and trust boundaries

`lifecycle.createAsset` copies input media, computes its digest, and signs a core
create operation. The asset derives its identity, controller, resource catalog,
layer, and activity from verified history. All mutations share one per-instance
queue across reading that history, obtaining a signature, verifying the candidate
history, binding bytes, and committing. Rejected work releases the queue without
replacing committed state. Returned logs and byte arrays are detached copies.

Custody is an explicit `CelSigner` for Ed25519, P-256, or P-384. Every returned
signature is verified before acknowledgement. Only the current controller can
mutate history; rotation is signed by the outgoing controller and later writes
need the new controller. Deactivation ends allowable mutations. Historical
verification can remain true after deactivation. Independent loaded instances
are separate local branches; there is no distributed lock or publication retry
protocol in this module.

The version-3 unsigned envelope carries the signed log, expected asset DID,
base64 byte attachments, and optional explicitly unverified drafts. Each supplied
attachment must match an exact authenticated historical id, version, and digest,
and its bytes must hash to that digest. Full local verification requires all
historical resource bytes and no drafts. Partial loading can retain missing bytes
and drafts, but never bypasses proof or supplied-byte validation. WebVH and BTC
histories remain explicitly incomplete without their external evidence. This API
does not claim current sat ownership, consensus acceptance, or global uniqueness.

See [the public API guide](../../../packages/sdk/V3.md) for custody semantics,
interchange, limits, and executable usage patterns.

## Independent review results

Two agents reviewed the fixed-base working diff separately using the repository
standards and selected specification. These reviews are bounded code reviews,
not certification. Both rechecked the relevant fixes.

### Standards axis

The review found that an acknowledged skipped edit could exceed the combined
attachment count, and that cumulative byte limits were checked after processing
later inputs. The follow-up also found that the JSON token limit rejected a
valid maximum-size collection of drafts after serialization.

Fixes reserve combined count/bytes/encoded-record budgets before retaining an
edit or decoding more attachments, enforce cumulative input bytes incrementally,
and derive the parser token limit from the same accepted container limits.
Regressions exercise exactly 100,000 attachments, failure before an additional
edit is acknowledged, JSON fresh loading, queue recovery, and rejection before a
later invalid input is processed. Final recheck found no remaining issue within
this runtime scope.

Relevant code: `packages/sdk/src/v3/envelope.ts:117`, `envelope.ts:284`,
`OriginalsAsset.ts:121`, `OriginalsAsset.ts:251`, and `resources.ts:25`.
Regression: `packages/sdk/tests/unit/v3/recovery-limits.test.ts`.

### Specification axis

A separate review demonstrated that a profile-valid 9,000-character resource ID
could produce an unsigned draft that serialization rejected. Draft validation
now uses the same core field bounds and validates its representation before
retention. The regression creates, skips, serializes, fresh-loads, retries, and
fully verifies that resource. Final recheck passed all 36 new tests and found no
remaining runtime issue within the new local API.

The completion gap remains: `packages/sdk/src/index.ts:320` only adds a `v3`
namespace; the default class still routes through the old lifecycle. This does
not satisfy a claim that the default SDK has migrated. Keep #562 open until that
cutover and its callers are verified.

Relevant code: `packages/sdk/src/v3/OriginalsAsset.ts:209` and `envelope.ts:203`.
Regression: `packages/sdk/tests/unit/v3/recovery-limits.test.ts`.

## Validation

All commands below ran in the follow-on worktree after the final runtime fixes.
Runtime: Bun 1.3.5, Node 25.2.1, Python 3.14.6, macOS 15.3.1 arm64.

| Check | Result |
| --- | --- |
| `cd packages/sdk && bun test tests/` | 3,199 pass; 245 skip; 0 fail; 240 files; includes all 36 new tests |
| Four targeted recovery regressions | 4 pass; 0 fail; includes a fresh JSON load of the accepted attachment-count boundary |
| Root `bun run build` | Pass |
| SDK `bun run typecheck` | Pass |
| ESLint on new `src/v3` sources | Pass; zero errors and warnings |
| Root `bun run verify:esm` | All 24 exported entry points import in Node |
| Root `bun run verify:browser` | Pass; existing Buffer-global advisories remain in previous SDK Bitcoin modules |
| Browser-target build of new SDK entry | Pass; 56 modules; 169.33 KB |
| Browser-target bundle smoke in Node without Buffer/process globals | Create, concurrent edits, and byte-exact fresh load pass; not browser E2E |
| SDK `npm pack --dry-run --json --ignore-scripts` | New compiled entry, declarations, and V3.md included; no package published |
| `git diff --check` | Pass |

Tests cover exact binary bytes and views, all three signer algorithms, failed
custody releasing the queue, overlapping metadata/resource mutations, old-key
rejection after rotation, deactivation, all historical resource versions,
verify/load parity, explicit partial loads and drafts, stale-draft retry including
same-byte version changes, invalid signatures under skip policy, malformed JSON,
duplicate decoded keys, getters, unsafe versions, duplicate/unproven attachments,
changed bytes, detached snapshots, and container recovery limits.

Passing tests do not establish Bitcoin acceptance or readiness for production
issuance. The 245 existing skipped tests were not exercised. Remote custody,
actual browser execution, multi-process concurrency, public resolution, WebVH
publishing/restoration, and new-format inscription/reorg recovery are not covered
by this slice. No performance bound is asserted for repeated full-history
verification or maximum-size attachment collections.

## Next integration steps

1. Complete #562 by promoting the new representation through the intended public
   SDK entry and its callers. Verify that every supported create/mutate/load/verify
   path shares the core state; retire the previous holder-append surface in that
   cutover. Keep the current working regtest journey usable while replacing its
   network boundaries explicitly.
2. Integrate shared resolution (#563), WebVH publish/restore (#564), and full-log
   Bitcoin boundaries plus derived delta publication (#565). An offline signed
   history must remain distinguishable from accepted on-sat state.
3. Exercise the new format end to end through disposable real regtest, including
   fresh recovery, controller rotation, failed submissions, and reorganization.
   Only that evidence can establish that the creator journey uses CEL 3 bytes.

PR #574 independently has passing CI, including all three existing real regtest
modes on Linux. [CI run](https://github.com/onionoriginals/sdk/actions/runs/34010722623),
[receipts and logs](https://github.com/onionoriginals/sdk/actions/runs/34010722623/artifacts/9982369961).
It remains open and unmerged. Its real regtest evidence covers the preceding
inscription representation, not the local SDK work documented here.
