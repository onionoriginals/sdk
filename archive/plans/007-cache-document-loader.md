# Plan 007: Cache the DocumentLoader so each sign/verify stops rebuilding it

> **Executor instructions**: Follow step by step; run every verification command.
> Honor STOP conditions. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 879ab0c..HEAD -- packages/sdk/src/vc/documentLoader.ts packages/sdk/src/vc/Issuer.ts packages/sdk/src/vc/Verifier.ts packages/sdk/src/vc/CredentialManager.ts`
> If any changed, compare excerpts; on a mismatch, STOP.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (independent; light touch)
- **Category**: perf
- **Planned at**: commit `879ab0c`, 2026-06-11

## Why this matters

Every credential sign and verify allocates a brand-new `DocumentLoader` for each
IRI it resolves, and the loader is invoked multiple times per operation (document
canonicalization, proof canonicalization, verification-method resolution).
`createDocumentLoader` returns `(iri) => new DocumentLoader(didManager).load(iri)`
— a fresh instance per call. In batch flows (`LifecycleManager.batchPublishToWeb`,
`batchInscribeOnBitcoin`) this multiplies across every credential. The contexts
themselves are already in `PRELOADED_CONTEXTS`, so this is pure allocation/setup
waste, not re-fetching. Reusing one loader instance per operation (or per
manager) removes it with zero behavior change.

## Current state

- `packages/sdk/src/vc/documentLoader.ts:74-75`:
  ```ts
  export const createDocumentLoader = (didManager: DIDManager) =>
    (iri: string) => new DocumentLoader(didManager).load(iri);
  ```
  A new `DocumentLoader` is constructed on every IRI load.
- Callers that build a loader per operation:
  - `src/vc/Issuer.ts` — `issueCredential`/`issuePresentation` call
    `createDocumentLoader(this.didManager)` each invocation.
  - `src/vc/Verifier.ts:28` — `createDocumentLoader(this.didManager)` per verify.
  - `src/vc/CredentialManager.ts` — `createDocumentLoader` in `signCredential`
    and `resolveVerificationMethodMultibase`.
- `DocumentLoader` is stateless except for holding `didManager`; it reads from the
  module-level `PRELOADED_CONTEXTS` and `verificationMethodRegistry`.

**Convention to follow:** keep the public `createDocumentLoader(didManager)`
signature (tests and callers use it). The fix is internal: have it close over a
single `DocumentLoader` instance instead of allocating per call.

## Commands you will need

| Purpose | Command (from repo root) | Expected |
|---------|--------------------------|----------|
| VC tests | `cd packages/sdk && bun test tests/unit/vc` | all pass |
| Loader tests | `cd packages/sdk && bun test tests/unit/vc/documentLoader.test.ts` | all pass |
| Typecheck | `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 \| grep "documentLoader"` | empty |

## Scope

**In scope:**
- `packages/sdk/src/vc/documentLoader.ts`

**Out of scope (do not change in this plan):**
- Issuer/Verifier/CredentialManager call sites — they keep calling
  `createDocumentLoader`; the optimization is internal. (A larger refactor to
  share ONE loader across a CredentialManager lifetime is possible but riskier;
  keep this plan small.)
- The `verificationMethodRegistry` global and its mutation semantics — unchanged.

## Git workflow

- Branch: `advisor/007-cache-document-loader`
- Conventional Commits, e.g. `perf(sdk): reuse a single DocumentLoader per loader factory`.
- No push/PR unless instructed.

## Steps

### Step 1: Reuse one DocumentLoader instance per factory call

Change `createDocumentLoader` so the `DocumentLoader` is allocated once and the
returned function reuses it:

```ts
export const createDocumentLoader = (didManager: DIDManager) => {
  const loader = new DocumentLoader(didManager);
  return (iri: string) => loader.load(iri);
};
```

This is behavior-identical (the loader holds no per-IRI state) but removes the
per-IRI allocation.

**Verify**: `cd packages/sdk && bun test tests/unit/vc/documentLoader.test.ts` → all pass.

### Step 2: Confirm no caller relied on a fresh instance per call

`grep -rn "createDocumentLoader" packages/sdk/src packages/sdk/tests` and confirm
no caller mutates loader-instance state expecting it reset per IRI (it doesn't —
state lives in module-level maps). If any test constructs a loader and asserts
per-call freshness, STOP and report.

**Verify**: `cd packages/sdk && bun test tests/unit/vc` → all pass.

## Test plan

- Existing `tests/unit/vc/documentLoader.test.ts` plus the full `tests/unit/vc`
  suite are the regression gate (behavior must be identical).
- Optionally add a micro-assertion in `documentLoader.test.ts`: two `load` calls
  via the same factory resolve the same context content (proves reuse is safe).
- Verification: `cd packages/sdk && bun test tests/unit/vc` → all pass.

## Done criteria

ALL must hold:

- [ ] `cd packages/sdk && bun test tests/unit/vc` → all pass
- [ ] `grep -n "new DocumentLoader(didManager).load" packages/sdk/src/vc/documentLoader.ts` → no matches (instance now hoisted)
- [ ] `tsc` error count not increased vs baseline
- [ ] No out-of-scope files modified (`git status`)
- [ ] `plans/README.md` row updated

## STOP conditions

- A test asserts per-call loader freshness (drift from the stateless assumption).
- The full `tests/unit/vc` suite shows any behavioral change.

## Maintenance notes

- Bigger win available later (separate plan): thread ONE loader through a
  `CredentialManager` instance and pass it into Issuer/Verifier constructors, so
  a batch of N credentials shares a single loader. That requires signature
  changes to Issuer/Verifier and is intentionally deferred here.
- If contexts ever become dynamically fetched (not just `PRELOADED_CONTEXTS`),
  add an explicit cache with eviction at that point.
