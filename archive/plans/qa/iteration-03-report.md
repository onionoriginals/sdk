# QA Iteration 03 — Lower-Risk Coverage + Defect Surfacing

**Date:** 2026-06-22
**Scope:** the ~73 lower-risk uncovered scenarios from iteration 01 — Migration/Events (49), DID (13), Utils (11).
**Delivery:** PR **#179** → `main` — test files only, no source changes; +8 test files (~3,735 lines).

## Batches (4 reviewed executors, parallel)

| Batch | Commit | Result |
|---|---|---|
| Migration/Events #1 (state machine, checkpoints, rollback, events, lifecycle integration) | `0f7ccc6` | covered; no defects |
| Migration validation #2 (validator pipeline, migration paths, cost) | `267ac08` | covered; **2 findings** (stub validators) |
| DID (key gen/rotation/recovery, ES256, webvh update, btco regtest) | `651b24c` | covered; **1 High defect** (rotation) |
| Utils/Adapters (StructuredError, metrics, encoding/multikey, circuit-breaker/retry, Ord provider) | `ab1e4c0` | covered; no defects |

## Findings (implementation gaps — NOT fixed here; gated remediation)

1. **DEF-018 — HIGH — `rotateDIDWebVHKeys` fails on the 3rd sequential rotation.** `WebVHManager.appendKeyChange` doesn't propagate the authorized update-key to `didwebvh-ts` past 2 rotations; the 3rd throws "Key … is not authorized to update." The existing `WebVHManager.rotation.test.ts` only exercised 2 rotations, so it never surfaced. Security-relevant (key rotation was a run-1 deliverable). The 10-rotation test is `.skip` with a root-cause writeup; a companion test pins the working 2-rotation boundary.
2. **DEF-019 — MEDIUM — `LifecycleValidator` is a pass-through stub.** Always returns `valid: true`; does not reject migrating a deactivated asset. `.skip` w/ MISSING-API note.
3. **DEF-020 — MEDIUM — `CredentialValidator` is a stub.** No real credential-compatibility checking; `credentialIssuance:false` short-circuits to valid.
4. **DEF-021 — LOW — `StorageValidator` missing-adapter is a warning, not a blocking error** (possibly intentional — confirm).

All four were surfaced because the executors asserted *actual* behavior and were instructed to STOP-and-report rather than invent passing behavior. None were patched (test-only rule).

## Verification
- SDK suite: **2729 pass / 0 fail** (`tsc` clean)
- 2 documented `.skip`s (point at DEF-018 and DEF-019)
- No vacuous assertions
- PR #179 CI: Tests/Typecheck/Coverage expected to pass; Macroscope Correctness skips (test-only); Lint non-blocking.

## Recommended remediation (gated, reviewed-executor)
1. **DEF-018 first** (security): fix `appendKeyChange` key-authorization chaining so N-sequential rotations work; un-skip the 10-rotation test as the regression gate.
2. DEF-019 / DEF-020: implement real `LifecycleValidator` (reject deactivated) and `CredentialValidator` checks, or explicitly document them as intentional no-ops; un-skip the deactivated-asset test.
3. DEF-021: confirm whether missing-adapter should block; adjust severity accordingly.

## Loop status
Exit criteria **not** met: 1 High defect open (DEF-018) + 122 partial-coverage features still lack adversarial depth. Next: remediate DEF-018, then a partials-deepening iteration, then re-run discovery to refresh the matrix and re-score.
