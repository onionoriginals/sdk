# Plan 016: Wire DIDCache, DID metrics, and statusList into the SDK (fix the 16 standing test failures)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 2b86eaa..HEAD -- packages/sdk/src/did/DIDManager.ts packages/sdk/src/core/OriginalsSDK.ts packages/sdk/src/vc/CredentialManager.ts`
> If these changed since this plan was written, compare the "Current state"
> excerpts against the live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tests / bug
- **Planned at**: commit `2b86eaa`, 2026-06-11

## Why this matters

The SDK's test suite has had the same 16 failing tests across two audit cycles
(documented in `plans/README.md` since the 2026-06-11 run). They are not
flaky: the tests describe an API surface that was specified but never wired —
a DID resolution cache, metrics tracking for DID operations, and a
`sdk.statusList` manager for credential revocation. Until they pass, the CI
`tests` job is permanently red, which means the gate added in plan 010
protects nothing: a real regression looks identical to the status quo. All the
hard parts already exist as tested, standalone classes (`DIDCache`,
`MetricsCollector`, `StatusListManager`); this plan is constructor plumbing.

## Current state

The 16 failing tests (run `cd packages/sdk && bun test tests/unit 2>&1 | grep -a '(fail)'` to reproduce):

- 4× `tests/unit/did/DIDCache.test.ts` — "DIDManager integration" +
  "OriginalsSDK config passthrough"
- 8× `tests/unit/utils/MetricsIntegration.test.ts` — "DIDManager metrics
  tracking" (6), "OriginalsSDK shared metrics" (2), plus
  "CredentialManager metrics tracking > should track credential signing
  operation" (1 of these 8)
- 4× `tests/unit/vc/StatusListManager.test.ts` — "integration with
  CredentialManager"

What the tests expect (these tests ARE the spec — read them first):

- `tests/unit/utils/MetricsIntegration.test.ts:90-96`:
  `new DIDManager(testConfig, metrics)` — second constructor arg is a
  `MetricsCollector`. Operations recorded under names `did.createDIDPeer`,
  `did.migrateToDIDWebVH`, `did.migrateToDIDBTCO`, `did.resolveDID`, with
  `count`, `totalTime > 0`, and `errorCount` on failures. SDK-level tests
  expect `sdk.metrics.getMetrics()` to aggregate ops from all managers and
  `export('prometheus')` to include them.
- `tests/unit/did/DIDCache.test.ts:425-505`:
  `didManager.cache.has(did)`, `didManager.cache.pin(did)`,
  `didManager.cache.isPinned(did)`, `didManager.cache.listPinned()`;
  `resolveDID(did, { skipCache: true })`; cache hits recorded into metrics
  (`metrics.getMetrics().cacheStats.hits >= 1`); and OriginalsSDK passes
  `config.storageAdapter` through to the DIDCache.
- `tests/unit/vc/StatusListManager.test.ts:609-653`:
  `sdk.statusList.createStatusListCredential(...)`,
  `sdk.statusList.allocateStatusEntry(...)`, `sdk.statusList.setStatus(...)`,
  and `sdk.credentials.verifyCredentialWithStatus(credential, statusListVC)`.

What already exists:

- `src/did/DIDCache.ts` — complete LRU cache: `constructor(config?: DIDCacheConfig)`
  (line 66), `pin` (148), `unpin` (176), `isPinned` (188), `listPinned` (195),
  `has` (244). Fully unit-tested standalone.
- `src/utils/MetricsCollector.ts` — `track(op, fn)` pattern,
  `recordCacheHit()` (179), `recordCacheMiss()` (186), `getMetrics()` with
  `cacheStats` (218–230), `getOperationMetrics(op)` (239),
  `export('prometheus')` (272) incl. cache lines (349–362).
- `src/vc/StatusListManager.ts:70` — `class StatusListManager` exists with the
  methods the tests call; `CredentialManager.verifyCredentialWithStatus`
  exists at `src/vc/CredentialManager.ts:354`.
- `src/vc/CredentialManager.ts:166-176` — the exemplar metrics pattern to copy
  into DIDManager:

  ```typescript
  private readonly metrics?: MetricsCollector;

  constructor(private config: OriginalsConfig, private didManager?: DIDManager, metrics?: MetricsCollector) {
    this.metrics = metrics;
  }
  // line ~175:
  private track<T>(op: string, fn: () => Promise<T>): Promise<T> {
    return this.metrics ? this.metrics.track(op, fn) : fn();
  }
  ```

What is missing:

- `src/did/DIDManager.ts:24` — `constructor(private config: OriginalsConfig) {}`
  — no metrics, no cache. `resolveDID(did: string)` (line 193) — no options
  param.
- `src/core/OriginalsSDK.ts` — has `public readonly metrics: MetricsCollector`
  (line 108, constructed line 128) but does not pass it to DIDManager, and has
  no `statusList` property.
- `CredentialManager.signCredential` (line 196) — the metrics test
  "should track credential signing operation" fails: signing is either not
  wrapped in `this.track('credential.sign', ...)` or the wrapper is bypassed
  on the legacy path the test exercises (`signCredential(credential,
  'z'+'a'.repeat(64), 'zVM123')`, which throws on key format — the test
  expects the op recorded even when it throws). Investigate and fix so the
  track wrapper surrounds the whole method body.

## Commands you will need

| Purpose    | Command (from repo root)                                       | Expected on success |
|------------|----------------------------------------------------------------|---------------------|
| Typecheck  | `cd packages/sdk && bunx tsc --noEmit -p .`                     | exit 0              |
| Target tests | `cd packages/sdk && bun test tests/unit/did/DIDCache.test.ts tests/unit/utils/MetricsIntegration.test.ts tests/unit/vc/StatusListManager.test.ts` | 0 fail |
| Full suite | `cd packages/sdk && bun test tests/integration tests/unit tests/security` | **0 fail** (these 16 were the only failures at planning time) |

## Scope

**In scope**:
- `packages/sdk/src/did/DIDManager.ts`
- `packages/sdk/src/core/OriginalsSDK.ts`
- `packages/sdk/src/vc/CredentialManager.ts` (only the `credential.sign`
  tracking fix)
- `packages/sdk/src/types/` (only if `resolveDID` options need a type export)
- `plans/README.md` (status row only)

**Out of scope**:
- `src/did/DIDCache.ts`, `src/utils/MetricsCollector.ts`,
  `src/vc/StatusListManager.ts` — already correct and unit-tested; consume,
  don't modify. If a test failure seems to require changing one of these,
  STOP — the failure analysis is probably wrong.
- The failing tests themselves — they are the spec. Do not edit them to pass
  (exception: an objectively wrong assertion is a STOP condition, not an edit).
- `LifecycleManager`/`BitcoinManager` metrics — not asserted by these tests;
  do not gold-plate.

## Git workflow

- Branch: `advisor/016-wire-didcache-metrics-statuslist`
- Conventional commits, e.g. `feat(sdk): wire DIDCache and metrics into DIDManager`,
  `feat(sdk): expose statusList on OriginalsSDK`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Read the three test files end-to-end

`tests/unit/did/DIDCache.test.ts` (the integration describes, ~line 400+),
`tests/unit/utils/MetricsIntegration.test.ts` (whole file),
`tests/unit/vc/StatusListManager.test.ts` (the "integration with
CredentialManager" describe, ~line 600+). They define every signature and
operation name. Note exact metric op names and cache option shapes.

**Verify**: you can state, from the tests, the exact DIDManager constructor
signature and the four `did.*` op names. (No command — proceed.)

### Step 2: Wire metrics + cache into DIDManager

In `src/did/DIDManager.ts`:

1. Constructor → `constructor(private config: OriginalsConfig, metrics?: MetricsCollector)`;
   store `metrics`; add the same private `track` helper as
   `CredentialManager.ts:175`.
2. Add `public readonly cache: DIDCache`, constructed in the constructor.
   Pass `config.storageAdapter` into `DIDCache`'s config if `DIDCacheConfig`
   supports it (check `DIDCache.ts:66` and the "config passthrough" test for
   the expected mapping).
3. Wrap the bodies of `createDIDPeer`, `migrateToDIDWebVH`, `migrateToDIDBTCO`,
   `resolveDID` in `this.track('did.<name>', async () => { ...existing body... })`.
   Errors must propagate (MetricsCollector.track already records errorCount —
   confirm by reading `MetricsCollector.track`).
4. `resolveDID(did: string, options?: { skipCache?: boolean })`:
   - unless `options.skipCache`, consult `this.cache` first; on hit call
     `this.metrics?.recordCacheHit()` and return; on miss
     `this.metrics?.recordCacheMiss()`, resolve as today, then store in cache.
   - keep the return type `Promise<DIDDocument | null>`.

**Verify**: `cd packages/sdk && bun test tests/unit/did/DIDCache.test.ts tests/unit/utils/MetricsIntegration.test.ts` →
DIDManager-related failures drop to 0 (SDK-aggregation + credential.sign may
still fail until Steps 3–4).

### Step 3: Wire OriginalsSDK

In `src/core/OriginalsSDK.ts`:

1. Pass `this.metrics` into the `DIDManager` constructor call.
2. Construct and expose `public readonly statusList: StatusListManager`
   (import from `../vc/StatusListManager`; check its constructor for required
   args — give it whatever `CredentialManager`/tests expect).
3. Confirm the "OriginalsSDK config passthrough" test's storageAdapter
   expectation is satisfied via Step 2.2.

**Verify**: `cd packages/sdk && bun test tests/unit/vc/StatusListManager.test.ts` → 0 fail

### Step 4: Fix `credential.sign` tracking

In `src/vc/CredentialManager.ts`, find why
`metrics.getOperationMetrics('credential.sign')` is null after a failed
`signCredential` call (test at `MetricsIntegration.test.ts:25-43`). Likely the
throw happens before the `track` wrapper is entered, or sign isn't wrapped.
Make the *entire* `signCredential` body run inside
`this.track('credential.sign', ...)` so even key-format failures record a
count.

**Verify**: `cd packages/sdk && bun test tests/unit/utils/MetricsIntegration.test.ts` → 0 fail

### Step 5: Full suite + green-gate check

**Verify**: `cd packages/sdk && bun test tests/integration tests/unit tests/security`
→ `0 fail`. This is the first time the suite is fully green; note it in the
commit message (it makes the CI `tests` job a real gate).

## Test plan

The 16 existing failing tests are the test plan — no new tests strictly
required. If cache-hit metrics wiring (Step 2.4) isn't fully covered by them,
add one test to `tests/unit/did/DIDCache.test.ts`'s integration describe
asserting `cacheStats.misses` increments on first resolve.

## Done criteria

ALL must hold:

- [ ] `cd packages/sdk && bunx tsc --noEmit -p .` exits 0
- [ ] `bun test tests/integration tests/unit tests/security` → **0 fail**
- [ ] `new DIDManager(config)` (single arg) still compiles and works —
      backward compatible optional params only
- [ ] No modifications to `DIDCache.ts`, `MetricsCollector.ts`,
      `StatusListManager.ts`, or any test file (`git status` / `git diff --stat`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- A test expectation can only be met by changing `DIDCache`,
  `MetricsCollector`, or `StatusListManager` themselves — the integration
  surface may have drifted from the spec; the maintainer should arbitrate.
- `StatusListManager`'s constructor requires dependencies that don't exist on
  `OriginalsSDK` (e.g. a signer/issuer wired differently than tests assume).
- Caching `resolveDID` results breaks other integration tests (e.g. tests that
  mutate a DID and expect fresh resolution) — cache invalidation policy is a
  design decision, not an improvisation.
- A step's verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Once the suite is green, the CI `tests` job (`.github/workflows/ci.yml`)
  becomes a real gate with no further action. The companion auth-package
  failures are plan 017's job; both must land for fully green CI.
- Caching in `resolveDID` changes freshness semantics for did:webvh (logs can
  be updated remotely). The DIDCache TTL config is the knob; reviewers should
  check what TTL the tests imply and whether the default is sane for webvh.
- Follow-up explicitly deferred: metrics for LifecycleManager/BitcoinManager
  operations (no tests demand them yet).
