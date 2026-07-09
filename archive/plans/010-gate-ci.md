# Plan 010: Make CI gate on typecheck, lint, and test exit code

> **Executor instructions**: Follow step by step; run every verification command.
> Honor STOP conditions. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 879ab0c..HEAD -- .github/workflows/ci.yml packages/sdk/package.json package.json`
> If any changed, compare excerpts; on a mismatch, STOP.

## Status

- **Priority**: P1 (but gated by dependencies — see below)
- **Effort**: S
- **Risk**: LOW (config only) / MED (turning on the gate will make a currently-red repo's CI fail until the fix plans land)
- **Depends on**: 003 (build green), 004 (audit tests), 005 (rotation tests), and the rest of the failing-test fixes. Do this LAST, once `bun test` and `tsc` are green locally.
- **Category**: dx
- **Planned at**: commit `879ab0c`, 2026-06-11

## Why this matters

CI runs `bun run test` but does not fail the job on a non-zero test exit code in a
way that blocks merges, and there is no `tsc`/typecheck step at all. That is the
root cause the audit kept hitting: `main` has a broken build and ~43 failing
tests, yet PRs merged green. Every other plan is wasted effort if the gate that
should have caught these stays open. After this plan, a broken build, a lint
error, or a failing test fails CI and blocks the merge.

This plan is ordered LAST because turning the gate on while the repo is red just
makes CI red. Land the fix plans (003, 004, 005, and any remaining failing-test
fixes) first, confirm `tsc` and `bun test` are green locally, THEN gate.

## Current state

- `.github/workflows/ci.yml` — two jobs: `tests` runs `bun run test`; `coverage`
  runs `bun run test:ci`. No typecheck step, no explicit lint gate. Excerpt:
  ```yaml
      - name: Run tests
        run: bun run test
  ```
  `bun run test` → `turbo run test --filter='./packages/*'`. Turbo propagates the
  underlying command's exit code, but there is no typecheck job and lint is not
  run in CI.
- Root `package.json` scripts: `build`, `test`, `test:ci`, `lint`, `format`,
  `check` (all `turbo run <x>`). There is a `check` script
  (`turbo run check --filter='./packages/*'`) — confirm what each package's
  `check` task does (likely typecheck); if it runs `tsc --noEmit`, wire that.
- `packages/sdk/package.json` — `build: tsc && tsc-alias`. No standalone
  `typecheck` script (confirm). `lint` exists but currently exits non-zero
  (pre-existing lint errors).

**Convention to follow:** CI uses `oven-sh/setup-bun@v2` with `bun-version:
1.2.22` and `bun install`. Add steps in that same style.

## Commands you will need

| Purpose | Command (from repo root) | Expected |
|---------|--------------------------|----------|
| Local typecheck | `cd packages/sdk && bunx tsc --noEmit -p .` | exit 0 (after 003) |
| Local tests | `bun run test` | exit 0 (after fix plans) |
| Local lint | `bun run lint` | see Step 3 — may still warn |
| YAML sanity | `cat .github/workflows/ci.yml` | well-formed |

## Scope

**In scope:**
- `.github/workflows/ci.yml`
- `packages/sdk/package.json` (add a `typecheck` script if none exists)
- Root `package.json` (add a root `typecheck` passthrough if helpful)

**Out of scope:**
- Fixing the actual type/test/lint failures — those are plans 003/004/005 and
  others. This plan ONLY adds the gates and assumes the repo is green.
- Pre-commit hooks (a nice follow-up, but keep this plan to CI).

## Git workflow

- Branch: `advisor/010-gate-ci`
- Conventional Commits, e.g. `ci: gate on typecheck and test exit code`.
- No push/PR unless instructed.

## Steps

### Step 0: Confirm the repo is green locally (prerequisite)

Run `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 | grep -c "error TS"` → must
be `0`. Run `bun run test` → must exit 0. **If either is not green, STOP** — the
dependency plans (003, 004, 005, …) are not done; gating now only makes CI red.

### Step 1: Add a `typecheck` script

In `packages/sdk/package.json` scripts, add:
```json
"typecheck": "tsc --noEmit -p ."
```
Optionally add a root passthrough in `package.json`:
```json
"typecheck": "turbo run typecheck --filter='./packages/*'"
```
(and a `typecheck` task entry in `turbo.json` if Turbo requires task
registration — check `turbo.json` and mirror how `lint`/`build` are declared).

**Verify**: `cd packages/sdk && bun run typecheck` → exit 0.

### Step 2: Add a typecheck job/step to CI

In `.github/workflows/ci.yml`, add a `typecheck` job mirroring the existing job
structure (checkout → setup-bun 1.2.22 → `bun install` → run). Run
`bun run typecheck`. A failing typecheck must fail the job.

**Verify**: `cat .github/workflows/ci.yml` shows the new job; YAML is valid
(no tabs, consistent indentation).

### Step 3: Ensure tests actually gate, and decide on lint

- **Tests gate:** confirm the `tests` job fails on a failing test. `turbo`
  forwards the non-zero exit; if there's any `|| true` or `continue-on-error`,
  remove it. (Grep the workflow for `continue-on-error` and `|| true`.)
- **Lint:** `bun run lint` currently exits non-zero due to pre-existing errors.
  Do NOT block CI on the full lint until those are fixed. Instead, add a lint
  step with `continue-on-error: true` (visible but non-blocking) OR scope lint
  to `--max-warnings` such that only ERRORS block. Pick the non-blocking step now
  and leave a TODO to make it blocking once lint is clean. Document this choice
  in the PR.

**Verify**: `grep -n "continue-on-error\|max-warnings" .github/workflows/ci.yml`
reflects the chosen lint policy; the `tests` and `typecheck` jobs have no
`continue-on-error`.

## Test plan

- This is CI config; validation is by inspection + a real CI run on the branch.
- If the operator allows pushing the branch, confirm the new `typecheck` job runs
  and that a deliberately-introduced type error fails it (then revert the error).
  If pushing is not allowed, note that the gate is unverified-on-CI and inspect
  the YAML carefully.

## Done criteria

ALL must hold:

- [ ] `cd packages/sdk && bun run typecheck` → exit 0
- [ ] `.github/workflows/ci.yml` has a typecheck job running `bun run typecheck`
- [ ] No `continue-on-error: true` or `|| true` on the `tests` or `typecheck` jobs
- [ ] Lint policy is explicit (blocking on errors or a documented non-blocking step)
- [ ] `bun run test` exits 0 locally (prerequisite was met)
- [ ] No out-of-scope files modified (`git status`)
- [ ] `plans/README.md` row updated

## STOP conditions

- Step 0 shows the repo is not green — the dependency plans aren't done. STOP.
- `turbo.json` requires task wiring you can't determine — read it and mirror the
  `build` task; if still unclear, report.
- Making lint blocking would fail CI on the 16 pre-existing lint errors — keep it
  non-blocking and note the follow-up.

## Maintenance notes

- Follow-up: once lint errors are fixed, flip the lint step to blocking and add a
  `.husky/pre-commit` running `bun run typecheck` for fast local feedback.
- Reviewer: the point of this plan is that it can NEVER be green while the build
  is broken — verify by confirming a type error fails the typecheck job.
- This plan is the keystone: with it in place, plans 003/004/005 stay fixed
  because regressions now fail CI.
