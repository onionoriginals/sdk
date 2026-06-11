# Plan 011: Reconcile the two lifecycle APIs in README and examples

> **Executor instructions**: Follow step by step; run every verification command.
> Honor STOP conditions. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 879ab0c..HEAD -- README.md packages/sdk/src/lifecycle/LifecycleManager.ts packages/sdk/src/examples/full-lifecycle-flow.ts`
> If any changed, compare excerpts; on a mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `879ab0c`, 2026-06-11

## Why this matters

The SDK exposes two parallel lifecycle APIs and the docs disagree on which to
use. The README quick-start uses `createAsset` / `publishToWeb` /
`inscribeOnBitcoin`, while the comprehensive example
(`src/examples/full-lifecycle-flow.ts`) uses `createDraft` / `publish` /
`inscribe` / `transfer`. Both sets exist on `LifecycleManager`, so a reader can't
tell which is canonical, and an LLM agent consuming this SDK (the CLAUDE.md
explicitly targets that audience) will pick inconsistently. After this plan, the
docs declare one primary API and explain the other as aliases/advanced, so the
guidance is unambiguous.

## Current state

- `README.md:44-50` — quick start:
  ```ts
  const asset = await originals.lifecycle.createAsset(resources);
  await originals.lifecycle.publishToWeb(asset, 'my-domain.com');
  await originals.lifecycle.inscribeOnBitcoin(asset);
  ```
- `packages/sdk/src/examples/full-lifecycle-flow.ts` — uses
  `sdk.lifecycle.createDraft(...)` (`:146`), `publish(...)` (`:226`),
  `inscribe(...)` (`:271`), `transfer(...)` (`:314`), `createTypedOriginal(...)`
  (`:402`).
- `packages/sdk/src/lifecycle/LifecycleManager.ts` — BOTH families exist:
  `createAsset` (`:199`), `publishToWeb` (`:553`), `inscribeOnBitcoin` (`:830`),
  AND `createDraft` (`:1617`), `publish` (`:1677`), `inscribe` (`:1757`),
  `transfer` (`:1855`).

**Decision needed (resolve from the code, not by guessing):** determine which
family is the intended primary. Signals to check: which one the README leads
with, which has richer JSDoc, which the newer code (`createDraft` block, higher
line numbers, likely added later) treats as the headline, and whether the
`createDraft`/`publish`/`inscribe` methods simply delegate to
`createAsset`/`publishToWeb`/`inscribeOnBitcoin` (read their bodies — if they're
thin wrappers, they're the ergonomic front door).

**Convention to follow:** docs live in `README.md` and `docs/`. The CLAUDE.md
points agents at `docs/LLM_AGENT_GUIDE.md` and `docs/LLM_QUICK_REFERENCE.md` —
those must agree with whatever this plan declares primary.

## Commands you will need

| Purpose | Command (from repo root) | Expected |
|---------|--------------------------|----------|
| Verify methods exist | `grep -n "async createAsset\|async publishToWeb\|async createDraft\|async publish\b" packages/sdk/src/lifecycle/LifecycleManager.ts` | both families present |
| Doc example compiles | (see Step 3) | the documented snippet typechecks against real signatures |
| Typecheck | `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 \| grep -c "error TS"` | not increased |

## Scope

**In scope:**
- `README.md`
- `docs/LLM_AGENT_GUIDE.md`, `docs/LLM_QUICK_REFERENCE.md` (only the lifecycle-API
  sections, to make them consistent with the chosen primary)
- `packages/sdk/src/examples/full-lifecycle-flow.ts` (only if it uses a method
  that does NOT exist or has the wrong signature — otherwise leave it; both APIs
  are valid)
- Optionally: JSDoc on `LifecycleManager` methods to mark primary vs alias

**Out of scope:**
- Removing or merging either API family — that's a breaking change requiring its
  own decision/plan. This plan only documents.
- Behavior changes to any lifecycle method.

## Git workflow

- Branch: `advisor/011-reconcile-readme-api`
- Conventional Commits, e.g. `docs: clarify primary lifecycle API`.
- No push/PR unless instructed.

## Steps

### Step 1: Determine the primary API from the code

Read the bodies of `createDraft`/`publish`/`inscribe`/`transfer` and
`createAsset`/`publishToWeb`/`inscribeOnBitcoin` in `LifecycleManager.ts`.
Establish: do the newer-named methods delegate to the older ones (or vice
versa)? Pick the primary = the ergonomic front door the codebase converged on
(usually the wrappers). Record the rationale in the PR description.

**STOP if** the two families have genuinely different behavior (not
wrapper/wrapped) — then "which is primary" is a maintainer decision, not a docs
fix; report with the behavioral differences.

### Step 2: Make the docs consistent

- Update `README.md` quick-start to use the chosen primary API.
- Add a short note: "The SDK also exposes `<other family>` as
  <aliases / lower-level methods>; prefer `<primary>` for new code."
- Update the lifecycle sections of `docs/LLM_AGENT_GUIDE.md` and
  `docs/LLM_QUICK_REFERENCE.md` to match.

### Step 3: Verify every documented snippet matches a real signature

For each code snippet you touched, confirm the method names and argument shapes
match `LifecycleManager`'s actual signatures (read them; don't trust the old
docs). A quick way: copy each documented call into a scratch `.ts` file that
imports the SDK and run `bunx tsc --noEmit` on it, or manually diff each call
against the method signature.

**Verify**: every documented lifecycle call corresponds to an existing method
with matching arity. `grep` each documented method name in
`LifecycleManager.ts` and confirm it exists.

## Test plan

- No unit tests; docs change. The gate is: every documented call maps to a real
  method signature (Step 3).
- If the repo has a docs-example compile check, run it. (Search for any
  `examples` test: `ls packages/sdk/tests | grep -i example`.) If present, it
  must pass.

## Done criteria

ALL must hold:

- [ ] README quick-start and `docs/LLM_*` use ONE consistent primary API
- [ ] Every documented lifecycle method name exists in `LifecycleManager.ts` (grep-verified)
- [ ] A note explains the secondary API family
- [ ] `tsc` error count not increased vs baseline
- [ ] No out-of-scope files modified (`git status`)
- [ ] `plans/README.md` row updated

## STOP conditions

- The two API families differ behaviorally (not wrapper/wrapped) — report; needs
  a maintainer decision.
- A documented method or signature does not exist in the current code in a way
  that can't be fixed by choosing the right name — report (may indicate the
  example is testing an unshipped API).

## Maintenance notes

- Reviewer: confirm the LLM guide docs match the README — the agent audience
  reads those, and drift there is the costlier version of this bug.
- Follow-up candidate: if one family is purely aliases, consider `@deprecated`
  JSDoc on the non-primary names (non-breaking) to steer new code.
