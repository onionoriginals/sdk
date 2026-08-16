# Plan 046: close the CI gaps that let two shipped bugs through

> **Executor instructions**: Small, self-contained, repo-infra only — no `src/`
> changes except where a lint fix is genuinely required. Read the whole plan
> first; item 3 will surface pre-existing errors and needs a decision before you
> start fixing them.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (item 1–2), MED (item 3 — surfaces 38 pre-existing errors)
- **Category**: tech-debt / CI
- **Found while**: executing plans 034–044 (run 3). Each gap is named by a bug it
  actually failed to catch, not by inspection.

## Why this matters

Six gaps, each of which let something real through during run 3. None are
hypothetical: for each, the bug shipped to a PR and was caught by a human or a
review bot rather than by CI.

### 1. `turbo run lint` does not depend on `^build`

`packages/auth` imports types from `@originals/sdk`, which resolve through
`packages/sdk/dist`. The lint task has no `dependsOn: ["^build"]`, so during lint
those types are unresolved and typescript-eslint reports every value flowing from
them as `any`/`error`-typed.

**What it let through**: while implementing plan 045 the defensive narrowing in
`turnkey-signer.ts` was removed (it looked redundant — locally, with `dist` built,
it *is* redundant). CI lint then failed with two `no-unsafe-argument` errors that
made no sense locally. The original author had written that narrowing precisely
because lint runs without a build; the reason was invisible.

**Fix**: add `"dependsOn": ["^build"]` to the `lint` task in `turbo.json`. Then
the defensive `unknown` + `instanceof Uint8Array` narrowing in both Turnkey
signers can be simplified back, with a comment saying why it is no longer needed.

**Verify**: delete `packages/sdk/dist`, run `bun run lint` from the repo root, and
confirm it builds first and reports 0 errors.

### 2. `check-browser-safety.mjs` only guards the SDK

The script guards `index.js`, `lifecycle/LifecycleManager.js`,
`lifecycle/OriginalsAsset.js` and `cel/index.js` — all in `packages/sdk`. Nothing
guards `@originals/auth`, whose *client* entry runs in a browser by definition.

**What it let through**: plan 045 added `turnkeySignBytes` as a root export of
`@originals/auth`, documented as isomorphic, using `Buffer` for both hex encode
and decode. In a browser without a shim that throws `ReferenceError` on every
call — in exactly the environment the export was added for. CI was green;
Greptile caught it.

**Fix**: extend the guarded-entry list to `packages/auth`'s root and `/client`
entries. Note the script currently checks only for eager **Node builtins**; a
`Buffer` global reference is not an import, so also fail on a bare `Buffer`
identifier in a guarded graph (or assert against a `globalThis.Buffer`-free
evaluation, which is what the regression test in
`packages/auth/tests/turnkey-signbytes.test.ts` does).

### 3. The SDK lint script silently under-scans

`"lint": "eslint src/**/*.ts"` is **unquoted**, so the shell expands the glob
before eslint sees it. Without `globstar`, `src/**/*.ts` expands to `src/*/*.ts`
— exactly one directory level. Files at `src/*.ts` and `src/*/*/*.ts` (all of
`cel/algorithms/`, `cel/cli/`, `cel/layers/`, `bitcoin/transactions/`,
`migration/*/`, `vc/cryptosuites/`, …) are **never linted**.

**What it let through**: unknown — which is the point. Quoting the glob surfaces
**38 pre-existing errors** across those directories.

**Fix**: quote the glob (`eslint "src/**/*.ts"`) in both packages. Then decide,
and record the decision in the PR:

- fix all 38 (most are `no-unnecessary-type-assertion` and unused caught errors —
  mechanical), or
- quote the glob and add targeted `eslint-disable` comments with reasons, or
- quote it and downgrade the specific rules to warnings for the newly-covered
  directories, with a follow-up issue.

**Do NOT** leave the glob unquoted to keep CI green. A lint job that silently
skips two thirds of the source tree is worse than one that fails.

### 6. The SDK `test` script does not run the whole `tests` tree

> Items 4 (`apps/landing` never built in CI) and 5 (`bun run test` intermittently
> exits 1 with every suite reporting `0 fail`) are tracked in PR #471; both are
> implemented on this branch by `53d8fbc5`. This item is new.

`"test"` enumerated four directories — `tests/{integration,unit,security,stress}`
— and the split is deliberate (see item 5). But enumeration drifts: everything
outside those four was silently never run.

**What it let through**: 75 tests across 8 files — `tests/mocks/`, all six
`tests/performance/` suites, `tests/index.test.ts` and `tests/sdk.test.ts`.
**Two of them had been failing on main**, reproducibly and in isolation:
`tests/mocks/adapters/OrdMockProvider.test.ts` asserted Buffer `.toString()`
semantics on inscription content that plan 044 retyped to `Uint8Array`. Plan 044
noted it had updated the tests that asserted Buffer semantics; these two were
missed, and nothing was running them to say so.

**Fix**: extend the script with a fifth invocation covering the remainder, and —
because the next new directory would drift the same way — add
`tests/unit/test-script-covers-tree.test.ts`, which parses the `test` script out
of `package.json`, walks `tests/` for `*.test.ts`, and fails with the offending
paths if any file is unreachable from it. `packages/cel` already runs
`bun test tests/`, so it has no equivalent gap.

## Done criteria

1. `turbo.json`'s lint task depends on `^build`; deleting `dist` and running lint
   from the root passes.
2. The browser-safety gate covers `@originals/auth`'s browser-facing entries and
   fails on a `Buffer` reference in a guarded graph. Verify by temporarily
   reintroducing `Buffer.from` into `turnkeySignBytes` and confirming CI fails.
3. `bun run lint` in both packages lints the entire `src` tree, and passes.
4. `bun run test` runs every `*.test.ts` under `packages/sdk/tests`, and the
   drift guard fails when the script stops covering one.

## STOP conditions

- If item 3's 38 errors turn out to include anything that looks like a real
  defect rather than a style violation, stop and report it separately — that is
  a finding, not cleanup.
