# Plan 003: Make `tsc` pass — fix the 12 TypeScript build errors

> **Executor instructions**: Follow step by step; run every verification command
> and confirm the expected result before moving on. Honor STOP conditions. When
> done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 879ab0c..HEAD -- packages/sdk/src`
> If the listed in-scope files changed, re-run the error census in Step 1 and
> compare against the list below; on a large mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none (do before 010)
- **Category**: bug / dx
- **Planned at**: commit `879ab0c`, 2026-06-11

## Why this matters

`packages/sdk` does not compile. `bun run build` (which is `tsc && tsc-alias`)
fails with 12 type errors, and `prepublishOnly` runs `npm run build` — so the
package cannot be published cleanly and `dist/` is stale/wrong. Bun runs tests
without typechecking, so CI stayed green while the build rotted. One of the
errors (`MetricsCollector.track` missing) is also a **runtime** crash: every
`signCredential`/`verifyCredential` is wrapped in `this.metrics.track(...)`, so
enabling metrics throws `this.metrics.track is not a function`. After this plan,
`bunx tsc --noEmit -p packages/sdk` exits 0.

## Current state

Exact error census (from `cd packages/sdk && bunx tsc --noEmit -p .`):

```
src/index.ts(152,8): TS2724: '"./utils/MetricsCollector.js"' has no exported member named 'FeeMetrics'. Did you mean 'Metrics'?
src/playground/repl.ts(231,16): TS2352: Conversion of type 'DIDDocument' to type 'Record<string, unknown>' ...
src/vc/CredentialManager.ts(10,3): TS2305: Module '"../types"' has no exported member 'BitstringStatusListEntry'.
src/vc/CredentialManager.ts(174,40): TS2339: Property 'track' does not exist on type 'MetricsCollector'.
src/vc/cryptosuites/bbsCryptosuite.ts(108,28): TS2339: Property 'generateKeyPair' does not exist on type 'typeof BbsSimple'.
src/vc/cryptosuites/bbsCryptosuite.ts(251,38): TS2339: Property 'createProof' does not exist on type 'typeof BbsSimple'.
src/vc/cryptosuites/bbsCryptosuite.ts(326,37): TS2339: Property 'verifyProof' does not exist on type 'typeof BbsSimple'.
src/vc/StatusListManager.ts(3,3): TS2305: ... no exported member 'BitstringStatusListEntry'.
src/vc/StatusListManager.ts(4,3): TS2305: ... no exported member 'BitstringStatusListSubject'.
src/vc/StatusListManager.ts(5,3): TS2305: ... no exported member 'StatusPurpose'.
src/vc/Verifier.ts(1,56): TS2305: ... no exported member 'BitstringStatusListEntry'.
src/vc/Verifier.ts(1,82): TS2305: ... no exported member 'BitstringStatusListSubject'.
```

They group into four fixes:

1. **Bitstring status-list types not exported.** `src/vc/StatusListManager.ts:3-5`,
   `CredentialManager.ts:10`, and `Verifier.ts:1` import
   `BitstringStatusListEntry`, `BitstringStatusListSubject`, `StatusPurpose`
   from `'../types'`, but these are defined nowhere in `src/types/`
   (`grep -rn "BitstringStatusListEntry" packages/sdk/src/types/` returns
   nothing). The barrel is `src/types/index.ts`:
   ```ts
   export * from './common';
   export * from './did';
   export * from './credentials';
   export * from './bitcoin';
   export * from './network';
   export * from './multisig';
   ```
2. **`MetricsCollector` has no `track` method.** `CredentialManager.ts:173-175`:
   ```ts
   private tracked<T>(op: string, fn: () => Promise<T>): Promise<T> {
     return this.metrics ? this.metrics.track(op, fn) : fn();
   }
   ```
   `src/utils/MetricsCollector.ts` exports `recordOperation(operation, duration,
   success)` but no `track`. It also does NOT export `FeeMetrics` — but
   `src/index.ts:148-154` re-exports `type FeeMetrics`.
3. **`FeeMetrics` export.** `src/index.ts:152` exports a type that doesn't exist.
4. **`BbsSimple` missing methods.** `src/vc/cryptosuites/bbsCryptosuite.ts:108,
   251,326` call `BbsSimple.generateKeyPair/createProof/verifyProof`;
   `src/vc/cryptosuites/bbsSimple.ts` only has `static sign` and `static verify`.
5. **`repl.ts` cast.** `src/playground/repl.ts:231` casts `DIDDocument` to
   `Record<string, unknown>` directly (needs `as unknown as`).

**Convention to follow:** type definitions live in `src/types/*.ts` and are
re-exported via `src/types/index.ts`. The W3C Bitstring Status List shapes are
also pinned by the existing tests in `tests/unit/vc/StatusListManager.test.ts`
and `tests/unit/vc/BitstringStatusList.test.ts` — those tests are the contract
for the exact field names.

## Commands you will need

| Purpose   | Command (from repo root)                                  | Expected |
|-----------|-----------------------------------------------------------|----------|
| Error census | `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 \| grep "error TS"` | list shrinks to empty |
| Error count | `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 \| grep -c "error TS"` | `0` at the end |
| Status tests | `cd packages/sdk && bun test tests/unit/vc/StatusListManager.test.ts tests/unit/vc/BitstringStatusList.test.ts` | all pass |
| Metrics tests | `cd packages/sdk && bun test tests/unit/utils tests/integration -t Metrics` | pass |

## Scope

**In scope:**
- `packages/sdk/src/types/credentials.ts` (add the three status-list types)
- `packages/sdk/src/types/index.ts` (no change expected — `credentials` is
  already re-exported; verify)
- `packages/sdk/src/utils/MetricsCollector.ts` (add `track`)
- `packages/sdk/src/index.ts` (fix/remove `FeeMetrics` export)
- `packages/sdk/src/vc/cryptosuites/bbsSimple.ts` and/or
  `packages/sdk/src/vc/cryptosuites/bbsCryptosuite.ts` (resolve the missing-method
  calls)
- `packages/sdk/src/playground/repl.ts` (cast fix)

**Out of scope:**
- Any behavioral change to credential signing/verification (plan 001 owns that).
- Implementing real BBS+ crypto — see Step 4; the goal here is "compiles and
  doesn't silently claim to work," not a full BBS implementation.

## Git workflow

- Branch: `advisor/003-fix-typescript-build`
- Conventional Commits, one per fix group is fine.
- No push/PR unless instructed.

## Steps

### Step 1: Census the errors

`cd packages/sdk && bunx tsc --noEmit -p . 2>&1 | grep "error TS"` and confirm
the 12 errors match the list above. If they differ materially, STOP and report.

### Step 2: Define and export the Bitstring status-list types

Add to `src/types/credentials.ts` the three types, matching the field names used
in `src/vc/StatusListManager.ts` and the two status-list test files. Derive the
exact shape from those usages (read them first). Expected approximate shape (W3C
Bitstring Status List v1):

```ts
export type StatusPurpose = 'revocation' | 'suspension';

export interface BitstringStatusListEntry {
  id?: string;
  type: 'BitstringStatusListEntry';
  statusPurpose: StatusPurpose;
  statusListIndex: string;        // confirm string vs number against StatusListManager usage
  statusListCredential: string;
}

export interface BitstringStatusListSubject {
  id?: string;
  type: 'BitstringStatusList';
  statusPurpose: StatusPurpose;
  encodedList: string;
}
```

`src/types/index.ts` already does `export * from './credentials';`, so no barrel
change is needed — but verify the new types aren't also defined elsewhere (which
would cause a duplicate-export error). `grep -rn "BitstringStatusListEntry" packages/sdk/src/types`.

**Verify**: the four TS2305 errors disappear:
`cd packages/sdk && bunx tsc --noEmit -p . 2>&1 | grep "BitstringStatusList\|StatusPurpose"` → empty.
Then `cd packages/sdk && bun test tests/unit/vc/StatusListManager.test.ts tests/unit/vc/BitstringStatusList.test.ts` → all pass (this confirms the shapes are right, not just compiling).

### Step 3: Add `MetricsCollector.track` and fix the `FeeMetrics` export

Add a `track` method to `MetricsCollector` that times the callback and records it
via the existing `recordOperation`:

```ts
async track<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  let success = true;
  try {
    return await fn();
  } catch (e) {
    success = false;
    throw e;
  } finally {
    this.recordOperation(operation, Date.now() - start, success);
  }
}
```

(Match the exact `recordOperation` signature in `MetricsCollector.ts` — read it
first; it is `recordOperation(operation: string, duration: number, success: boolean)`.)

Then fix `src/index.ts:152`: remove `type FeeMetrics,` from the
`MetricsCollector.js` re-export block (it does not exist). Only do this if
`grep -n "FeeMetrics" packages/sdk/src/utils/MetricsCollector.ts` returns
nothing — if it actually exists, leave the export.

**Verify**: `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 | grep -E "track|FeeMetrics"` → empty.

### Step 4: Resolve the `BbsSimple` missing-method calls

`bbsCryptosuite.ts` calls three static methods that don't exist on `BbsSimple`.
The existing `BbsSimple.sign/verify` are stubs (read them — confirm whether they
throw "not implemented" or return a placeholder).

Choose the **minimal honest** fix:
- If `BbsSimple.sign/verify` are stubs that throw, add the three missing static
  methods (`generateKeyPair`, `createProof`, `verifyProof`) as stubs that throw
  a clear `Error('BBS+ not implemented')` too, so the code compiles and any
  caller fails loudly rather than silently producing fake proofs.
- Match the call signatures used at `bbsCryptosuite.ts:108,251,326` (read those
  lines for the exact argument shapes and return types).

Do NOT implement real BBS+ crypto here — that is a separate effort with its own
test plan. The goal is: compiles, and unimplemented paths throw explicitly.

**Verify**: `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 | grep "BbsSimple\|bbsCryptosuite"` → empty.

### Step 5: Fix the `repl.ts` cast

`src/playground/repl.ts:231` — change the direct
`doc as Record<string, unknown>` to `doc as unknown as Record<string, unknown>`
(the two-step cast TypeScript suggests).

**Verify**: `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 | grep "repl.ts"` → empty.

### Step 6: Full typecheck

**Verify**: `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 | grep -c "error TS"` → `0`.

## Test plan

- No new test files required; the fix is "make it compile + don't break runtime."
- Regression coverage comes from existing status-list and metrics tests, which
  now actually run against compiling code.
- If you added BBS stubs that throw, add one tiny test asserting they throw a
  clear error (so nobody mistakes the stub for a working implementation):
  `tests/unit/vc/cryptosuites/bbsSimple.test.ts` (create) — call
  `BbsSimple.createProof` and `expect(...).rejects.toThrow('not implemented')`
  (or matching message).
- Verification: `cd packages/sdk && bun test tests/unit/vc` → all pass.

## Done criteria

ALL must hold:

- [ ] `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 | grep -c "error TS"` → `0`
- [ ] `cd packages/sdk && bun test tests/unit/vc tests/unit/utils` → all pass
- [ ] `grep -n "FeeMetrics" packages/sdk/src/index.ts` → no matches (unless the type was actually defined)
- [ ] `grep -n "track" packages/sdk/src/utils/MetricsCollector.ts` → method exists
- [ ] No out-of-scope files modified (`git status`)
- [ ] `plans/README.md` row updated

## STOP conditions

- The error census in Step 1 differs materially from the 12 listed (drift, or
  another plan partially landed).
- Defining the Bitstring types makes the status-list tests fail in a way that
  reveals the runtime shape differs from the W3C spec — report the mismatch
  rather than contorting the types.
- `BbsSimple.sign/verify` turn out to be real (working) implementations — then
  implementing the three missing methods is a real crypto task; STOP and report
  so it gets its own plan.

## Maintenance notes

- This unblocks plan 010 (CI typecheck gate). Until 010 lands, `tsc` can
  regress silently again.
- The BBS+ subsystem is left as explicit stubs; a follow-up should either
  implement it against a real BBS library or remove the exported surface so
  consumers don't think it works. Note this in the PR description.
- Reviewer: confirm the new status-list types are not duplicated in
  `src/vc/BitstringStatusList.ts` or `cel/types.ts` (would cause export
  conflicts under the barrel).
