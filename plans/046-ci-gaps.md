# Plan 046: close the CI gaps that let two shipped bugs through

> **Executor instructions**: Small, self-contained, repo-infra only — no `src/`
> changes except where a lint fix is genuinely required. Read the whole plan
> first; item 3 will surface pre-existing errors and needs a decision before you
> start fixing them.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (items 1–2, 4), MED (item 3 — surfaces 38 pre-existing errors; item 5 — needs a real diagnosis, not a suppression)
- **Category**: tech-debt / CI
- **Found while**: executing plans 034–044 (run 3). Each gap is named by a bug it
  actually failed to catch, not by inspection.

## Why this matters

Five gaps, each of which let something real through during run 3. None are
hypothetical: for each, the bug shipped to a PR and was caught by a human or a
review bot rather than by CI.

> **Item 1 is DONE** — fixed in the `@originals/cel` PR (#469), because that PR
> made the gap fatal: the SDK depends on a workspace package for the first time,
> so its own lint began failing in CI against unbuilt types. The remaining items
> are still open.

### 1. `turbo run lint` does not depend on `^build` — DONE (#469)

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

### 4. `apps/landing` is never built in CI

Every build, test and lint job filters `./packages/*`. The landing app consumes
`@originals/sdk` but is not built, so a breaking change to the SDK's public
entry lands fully green and fails only at deploy.

**What it let through**: plan 043 moved `OrdMockProvider` to
`@originals/sdk/testing`; two landing files kept importing it from the root and
the deploy build died with `MISSING_EXPORT` (fixed in #470). A third instance the
compiler could not catch — the quickstart sample *rendered on the landing page*
— was teaching visitors the same dead import.

**Fix**: add a CI job that runs `bun run build && cd apps/landing && bun run
build` (plus `bun run typecheck`). It need not gate merges, but it must run.

### 5. `bun run test` intermittently exits 1 with every suite reporting `0 fail`

Seen on at least three PRs, including a **docs-only** one that could not possibly
break tests. Signature, identical each time:

- every suite prints `0 fail`, and no `(fail)` line appears anywhere in the log;
- the run logs ~4128 passing tests — essentially the entire suite;
- `@originals/sdk#test` nonetheless exits 1;
- an unhandled `HTTP error! status: 404` from didwebvh-ts's
  `fetchLogFromIdentifier` appears nearby;
- **re-running the same commit passes.**

**Diagnosis**: not a network dependency. `tests/setup.bun.ts` installs a `fetch`
mock in `beforeEach` that returns 404 by design, to fail tests that forget to
mock. So the 404 is the mock working. The problem is that the rejection escapes
a test's lifecycle: some DID resolution is started but its promise is not
awaited (or its rejection not caught), so it settles after the test finishes and
Bun reports an unhandled rejection at exit — which is nondeterministic, hence
the flake.

**Fix**: find the floating promise rather than suppressing the symptom. Start by
running with `DEBUG_FETCH=true` (the setup already logs unmocked fetch URLs) to
identify which resolution is in flight, and check the deferred paths first —
`LifecycleManager`'s `queueMicrotask` emit and anything calling `resolveDID`
without `await`. Adding a global unhandled-rejection handler that fails the test
run loudly, with the offending stack, would make the next occurrence
self-diagnosing.

**Do NOT** "fix" this by making the suite tolerate unhandled rejections. A
provenance SDK swallowing a rejected promise is exactly the class of bug this
repo spent run 3 eliminating.

## Done criteria

1. `turbo.json`'s lint task depends on `^build`; deleting `dist` and running lint
   from the root passes.
2. The browser-safety gate covers `@originals/auth`'s browser-facing entries and
   fails on a `Buffer` reference in a guarded graph. Verify by temporarily
   reintroducing `Buffer.from` into `turnkeySignBytes` and confirming CI fails.
3. `bun run lint` in every package lints the entire `src` tree, and passes.
4. A CI job builds `apps/landing`, and fails if the SDK's public entry breaks it.
5. `bun run test` exits 0 deterministically; the floating promise is identified
   and awaited, not suppressed.

## STOP conditions

- If item 3's 38 errors turn out to include anything that looks like a real
  defect rather than a style violation, stop and report it separately — that is
  a finding, not cleanup.
