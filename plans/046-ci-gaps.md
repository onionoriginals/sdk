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

Four gaps, each of which let something real through during run 3. None are
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

> **Note (from implementing this):** `eslint --fix` removes disable directives
> for rules that are no longer enabled, but replaces each comment with a line of
> leftover indentation rather than deleting it. Sweep those up, and check what
> the directives were suppressing before accepting their removal.

**Fix**: quote the glob (`eslint "src/**/*.ts"`) in both packages. Then decide,
and record the decision in the PR:

- fix all 38 (most are `no-unnecessary-type-assertion` and unused caught errors —
  mechanical), or
- quote the glob and add targeted `eslint-disable` comments with reasons, or
- quote it and downgrade the specific rules to warnings for the newly-covered
  directories, with a follow-up issue.

**Do NOT** leave the glob unquoted to keep CI green. A lint job that silently
skips two thirds of the source tree is worse than one that fails.

### 4. `apps/landing` is never built in CI — FIXED

Every job filters `./packages/*`, so the landing app was never typechecked,
tested or built. A breaking change to the SDK's public entry landed fully green
and failed only at deploy.

**What it let through**: three times. (a) Plan 043 moved `OrdMockProvider` off
the root entry; `engine.ts`/`verify-example.ts` kept importing it from
`@originals/sdk` (#470). (b) The quickstart sample *rendered on the page* taught
visitors the same dead import. (c) PR #455 shipped two silent-render bugs — the
accent map and gloss keyed off `updateResource`, not a member of `EventType`,
and the two migrate shapes differ (`targetDid` on webvh, `to` on btco) so a
btco entry rendered with no identifier. #455 added tests pinning both, but those
tests live in `apps/landing` and therefore never ran.

**Fix**: a `landing` job running `bun run landing:check` — packages build, then
`tsc` (client + server), the 196-test landing suite, and `vite build`. Replaces
the build-only step previously bolted onto `esm-importable`.

**Scope**: the headless page-drive (`bun run landing:ci`) stays OUT. It is red on
unmodified `main` — it needs the standalone API server plus `TURNKEY_*` and
`JWT_SECRET`, unavailable on fork PRs, and gates on zero console errors, which
the auth 401s alone trip. A gate that is red on arrival gets disabled.

**Verified red-then-green** by reintroducing each real regression: the dead
`OrdMockProvider` import fails `tsc` (`TS2614`); the `updateResource` key fails
`CEL entry glosses > no event type renders as its own bare name`; the dead
import in the rendered snippet fails the new `content.quickstart.test.ts`, which
resolves every specifier the snippet names and fails closed if its parser does
not account for every import statement. Runs in parallel with the existing
jobs and finishes in ~25s, so wall-clock CI time is unchanged.

### 5. A GC-sensitive stress test flaked under CI load — FIXED

`Batch Operations Stress Tests > should not leak memory during repeated batch
operations` failed intermittently with `[STRESS] Memory window never stabilised`,
taking ~43s to do so, on PRs that could not possibly have caused it.

**Root cause**: `process.memoryUsage().heapUsed` is not a usable signal in Bun
without forcing collection first — holding 300k live `Uint8Array`s reports
~0.2MB, and the same measurement after a synchronous collection reports ~38MB.
The test called `Bun.gc(false)`, the INCREMENTAL collector, which cannot force a
full collection, so major GCs fired at arbitrary points and produced 80MB → 14MB
cliffs mid-window. It coped by discarding the measurement window on any >30%
drop and restarting, requiring 10 consecutive GC-free readings; under CI memory
pressure the resets fire repeatedly and the run exhausts its iteration cap.

**Fix**: `Bun.gc(true)` performs a synchronous full collection, so every reading
comes from a settled heap. Collection stops being a random event to detect and
becomes a step in the measurement, which removed the reset machinery, the
iteration cap and the throw path. Halves are now compared by median rather than
mean, so one unusually large iteration cannot move the result. Verified the
detection still works: a steadily rising series yields 100% growth and fails,
while a GC sawtooth yields −67% and passes.

> **This was originally misdiagnosed as an escaped promise rejection.** Every
> suite appeared to print `0 fail` with no `(fail)` line anywhere — but that came
> from reading truncated `gh run view --log-failed` output; the `(fail)` was in
> the stress section, which is last. Read the tail of the log before theorising
> about the middle.
>
> One finding from that investigation is worth keeping: an `unhandledRejection`
> listener MUST set a non-zero exit code, because registering one REPLACES the
> runtime's default handling. Measured in Bun 1.3 — no listener: exit 1;
> log-only listener: exit **0**; log + `process.exitCode = 1`: exit 1. A
> logging-only reporter silently turns a red run green.

## Done criteria

1. `turbo.json`'s lint task depends on `^build`; deleting `dist` and running lint
   from the root passes.
2. The browser-safety gate covers `@originals/auth`'s browser-facing entries and
   fails on a `Buffer` reference in a guarded graph. Verify by temporarily
   reintroducing `Buffer.from` into `turnkeySignBytes` and confirming CI fails.
3. `bun run lint` in both packages lints the entire `src` tree, and passes.
4. CI typechecks, tests and builds `apps/landing` on every PR, and is green on
   `main`. Verify by reintroducing the `OrdMockProvider` root import or the
   `updateResource` key and confirming the job fails.

## STOP conditions

- If item 3's 38 errors turn out to include anything that looks like a real
  defect rather than a style violation, stop and report it separately — that is
  a finding, not cleanup.
