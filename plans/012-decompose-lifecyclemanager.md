# Plan 012: Decompose the LifecycleManager god module (characterization-tests first)

> **Executor instructions**: This is an L-effort, HIGH-risk refactor. Read the
> ENTIRE plan before starting. The first phase (characterization tests) is
> mandatory and must be complete and green before ANY extraction. Honor STOP
> conditions. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 879ab0c..HEAD -- packages/sdk/src/lifecycle/`
> If `LifecycleManager.ts` changed materially, re-map responsibilities (Step 1)
> before proceeding.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: 003 (must compile), and ideally 010 (CI gate) so the refactor
  is protected by a real test gate
- **Category**: tech-debt
- **Planned at**: commit `879ab0c`, 2026-06-11

## Why this matters

`LifecycleManager.ts` is 2178 lines with ~16 imported dependencies and a dozen-plus
responsibilities (create, publish, inscribe, migrate, transfer, batch variants,
rollback/recovery, resource versioning, credential issuance, event tracking). It
is the core of the SDK, so a bug anywhere in it risks every asset operation, it
is hard to test in isolation (mocking 16 dependencies), and it is the riskiest
file to change. Breaking it into focused collaborators behind the same public
`LifecycleManager` facade reduces blast radius and makes each concern testable.
This is debt reduction, not a feature — so the bar is "zero behavior change,
proven by tests."

## Current state

- `packages/sdk/src/lifecycle/LifecycleManager.ts` — 2178 lines. Key public
  methods (line numbers approximate, confirm by reading): `createAsset` (`:199`),
  `publishToWeb` (`:553`), `inscribeOnBitcoin` (`:830`), batch variants
  (`batchCreateAssets`, `batchPublishToWeb`, `batchInscribeOnBitcoin`,
  `batchTransferOwnership`), `createDraft`/`publish`/`inscribe`/`transfer`
  wrappers (`:1617`+), plus migration/rollback/credential helpers.
- Existing infrastructure to lean on (the SDK already has these — extractions
  should move logic TOWARD them, not invent new structure):
  - `src/migration/` — `StateMachine`, `ValidationPipeline`, `CheckpointManager`,
    `RollbackManager`.
  - `src/lifecycle/BatchOperations.ts` — batch execution.
  - `src/lifecycle/OriginalsAsset.ts` — asset representation.
  - `src/vc/CredentialManager.ts` — credential issuance.

**Convention to follow:** the `src/migration/` package already demonstrates the
target shape (focused classes behind a manager). Extracted collaborators should
match that style and live under `src/lifecycle/` or `src/migration/`. The public
`LifecycleManager` API and its method signatures MUST NOT change — it stays as a
thin orchestrator.

## Commands you will need

| Purpose | Command (from repo root) | Expected |
|---------|--------------------------|----------|
| Lifecycle tests | `cd packages/sdk && bun test tests/unit/lifecycle tests/integration` | all pass, unchanged |
| Full suite | `cd packages/sdk && bun test` | no NEW failures vs the pre-refactor baseline |
| Typecheck | `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 \| grep -c "error TS"` | not increased |
| Line count | `wc -l packages/sdk/src/lifecycle/LifecycleManager.ts` | drops substantially (target < ~800) |

## Scope

**In scope:**
- `packages/sdk/src/lifecycle/LifecycleManager.ts` (slims to an orchestrator)
- New collaborator files under `packages/sdk/src/lifecycle/` (e.g.
  `PublishService.ts`, `InscribeService.ts`, `ResourceVersioning.ts` — names per
  the responsibility map from Step 1)
- New characterization tests under `packages/sdk/tests/unit/lifecycle/`

**Out of scope:**
- The public `LifecycleManager` method names and signatures — unchanged.
- Behavior — this is a pure refactor; any behavior change is a bug.
- `src/migration/` internals (you may call into them; don't rewrite them).
- Touching CredentialManager / DID / Bitcoin managers.

## Git workflow

- Branch: `advisor/012-decompose-lifecyclemanager`
- Conventional Commits, one commit per extracted collaborator, e.g.
  `refactor(sdk): extract PublishService from LifecycleManager`.
- No push/PR unless instructed.

## Steps

### Step 1: Map responsibilities (no code change)

Read `LifecycleManager.ts` fully. Produce a written responsibility map: group its
methods into 4–6 cohesive concerns (e.g. "publish-to-web flow", "bitcoin
inscription flow", "resource versioning", "batch orchestration", "credential
issuance glue"). For each group, list the methods, the private helpers they use,
and the dependencies they touch. Put this map in the PR description. Do NOT
extract yet.

### Step 2: Characterization tests FIRST (mandatory gate)

Before any extraction, ensure each public method group has tests that pin current
behavior. Check existing coverage in `tests/unit/lifecycle/` and
`tests/integration/`. For any group that is thinly covered, add characterization
tests that capture present input→output (including event emissions and error
cases) using the existing `OrdMockProvider` and `MemoryStorageAdapter` patterns
already used in the suite.

**Verify**: `cd packages/sdk && bun test tests/unit/lifecycle tests/integration`
→ all pass. Record the exact pass count as your baseline. **If a group cannot be
characterized without real Bitcoin/network, STOP** and report — don't refactor
code you can't pin.

### Step 3: Extract ONE collaborator at a time

For each group from Step 1, in its own commit:
1. Create the collaborator class (constructor takes the dependencies that group
   needs).
2. Move the group's logic into it.
3. In `LifecycleManager`, instantiate the collaborator and delegate the public
   method to it — the public signature is unchanged.
4. Run the full lifecycle + integration suite.

**Verify after EACH extraction**: `cd packages/sdk && bun test tests/unit/lifecycle tests/integration`
→ same pass count as the Step 2 baseline. If any test changes result, revert that
extraction and report.

### Step 4: Confirm slimming and no regressions

**Verify**:
- `wc -l packages/sdk/src/lifecycle/LifecycleManager.ts` → substantially smaller
  (aim < ~800 lines; this is a target, not a hard gate).
- `cd packages/sdk && bun test` → no NEW failures vs the pre-refactor full-suite
  baseline (capture that baseline before starting: the count of pass/fail on this
  branch's starting commit).
- `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 | grep -c "error TS"` → not
  increased.

## Test plan

- Characterization tests (Step 2) are the safety net — they must exist and be
  green BEFORE extraction and remain green after each step.
- No assertions should be weakened to make a refactor pass; a changed assertion
  means behavior changed (a bug).
- Verification: `cd packages/sdk && bun test tests/unit/lifecycle tests/integration`
  → identical results before and after.

## Done criteria

ALL must hold:

- [ ] Responsibility map exists (PR description)
- [ ] `cd packages/sdk && bun test tests/unit/lifecycle tests/integration` → pass count identical to pre-refactor baseline
- [ ] `cd packages/sdk && bun test` → no new failures vs baseline
- [ ] `wc -l packages/sdk/src/lifecycle/LifecycleManager.ts` → materially reduced
- [ ] Public `LifecycleManager` method signatures unchanged (`grep "async createAsset\|async publishToWeb\|async inscribeOnBitcoin\|async createDraft\|async publish\b\|async inscribe\b\|async transfer\b" packages/sdk/src/lifecycle/LifecycleManager.ts` shows them still present)
- [ ] `tsc` error count not increased
- [ ] `plans/README.md` row updated

## STOP conditions

- A method group can't be characterized with the existing mock infrastructure
  (needs real Bitcoin/network) — STOP; don't refactor unpinned code.
- Any extraction changes a test result — revert it and report.
- An extraction would require changing a public `LifecycleManager` signature —
  STOP; that's a breaking change outside this plan's scope.
- The full-suite baseline isn't reproducible (flaky tests) — report; flakiness
  must be resolved before a large refactor.

## Maintenance notes

- This is deliberately incremental and reversible — each collaborator is its own
  commit so a problematic one can be dropped without losing the others.
- Reviewer: the ONLY thing to verify is "no behavior changed" — same public API,
  same test results. Read the diff for any altered logic vs pure moves.
- Defer: do not also try to fix `any`-typing or lint debt inside the moved code
  in this plan; keep the refactor a pure move to keep the diff reviewable.
