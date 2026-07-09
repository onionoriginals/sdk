# Plan 009: Keep `examples/` and `playground/` out of the published build

> **Executor instructions**: Follow step by step; run every verification command.
> Honor STOP conditions. When done, update this plan's row in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 879ab0c..HEAD -- packages/sdk/tsconfig.json packages/sdk/package.json`
> If either changed, compare excerpts; on a mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: 003 (build should compile first, so you can confirm exclusion didn't break the real build)
- **Category**: dx
- **Planned at**: commit `879ab0c`, 2026-06-11

## Why this matters

`tsc` compiles everything under `src/`, and `package.json` publishes `dist/`. But
`src/examples/` (9 files) and `src/playground/repl.ts` are demo/dev code with no
entry in the package `exports` map — yet they get compiled into `dist/` and
shipped in every npm install. That's dead weight in the consumer's
`node_modules` and extra surface that can break the build (the `repl.ts` type
error is one of the 12 build failures). Excluding them shrinks the package and
removes a category of build breakage from non-shipping code.

## Current state

- `packages/sdk/tsconfig.json:21-31`:
  ```json
  "include": [
    "src/**/*.ts",
    "src/**/*.json"
  ],
  "exclude": [
    "node_modules",
    "dist",
    "coverage",
    "tests"
  ]
  ```
  `examples/` and `playground/` are NOT excluded → compiled into `dist/`.
- `packages/sdk/package.json` — `"files": ["dist"]`, and the `exports` map lists
  core/did/vc/bitcoin/lifecycle/crypto/resources/storage/types/utils — no
  `examples` or `playground`. So they are shipped but unreachable via the public
  API.

**Convention to follow:** the build is `tsc && tsc-alias`. Excluding paths from
the tsconfig `exclude` array is the minimal, idiomatic fix and also removes those
files from the typecheck surface.

## Commands you will need

| Purpose | Command (from repo root) | Expected |
|---------|--------------------------|----------|
| Typecheck | `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 \| grep -c "error TS"` | not increased; `repl.ts` errors gone |
| Build | `cd packages/sdk && bun run build` | exit 0 (after 003) |
| Tarball check | `cd packages/sdk && npm pack --dry-run 2>&1 \| grep -E "examples/\|playground/"` | no matches |

## Scope

**In scope:**
- `packages/sdk/tsconfig.json`

**Out of scope:**
- Deleting the example/playground source — keep it in `src/` for contributors;
  just stop compiling it into `dist/`.
- Any change to the `exports` map or `files` array (already correct).
- The example code itself (a separate docs plan, 011, reconciles its API drift).

## Git workflow

- Branch: `advisor/009-exclude-examples-from-build`
- Conventional Commits, e.g. `build(sdk): exclude examples and playground from dist`.
- No push/PR unless instructed.

## Steps

### Step 1: Exclude the demo directories from compilation

Add `src/examples` and `src/playground` to the `exclude` array in
`packages/sdk/tsconfig.json`:

```json
  "exclude": [
    "node_modules",
    "dist",
    "coverage",
    "tests",
    "src/examples",
    "src/playground"
  ]
```

**Verify**: `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 | grep "repl.ts"` →
empty (the playground type error is no longer in the compile set).

### Step 2: Confirm the real build still works and the tarball is clean

**Verify**:
- `cd packages/sdk && bun run build` → exit 0 (requires plan 003 to have fixed
  the other type errors; if 003 hasn't landed, expect the OTHER 11 errors but NOT
  any `examples/`/`playground/` ones).
- `cd packages/sdk && ls dist/examples dist/playground 2>/dev/null` → both absent
  after a fresh build (`rm -rf dist && bun run build` to be sure).
- `cd packages/sdk && npm pack --dry-run 2>&1 | grep -E "examples/|playground/"` →
  no matches.

### Step 3: Make sure nothing imports the excluded code from shipping paths

`grep -rn "examples/\|playground/" packages/sdk/src --include=*.ts | grep -v "src/examples\|src/playground"`
→ no shipping module imports the demo code. If something does, STOP and report
(excluding it would break the build).

## Test plan

- No unit tests needed; the gates are: build exits 0, `dist/` lacks the demo
  dirs, tarball is clean.
- Run the existing suite once to confirm nothing referenced the excluded files:
  `cd packages/sdk && bun test tests/unit` → all pass (no new failures).

## Done criteria

ALL must hold:

- [ ] `packages/sdk/tsconfig.json` excludes `src/examples` and `src/playground`
- [ ] `cd packages/sdk && rm -rf dist && bun run build && ls dist/examples dist/playground 2>/dev/null` → both absent (build exits 0, assuming 003 landed)
- [ ] `cd packages/sdk && npm pack --dry-run 2>&1 | grep -E "examples/|playground/"` → no matches
- [ ] `cd packages/sdk && bun test tests/unit` → all pass
- [ ] No out-of-scope files modified (`git status`)
- [ ] `plans/README.md` row updated

## STOP conditions

- A shipping `src/` module imports from `src/examples` or `src/playground`
  (excluding would break the build).
- A test imports the playground/examples directly and would fail to resolve
  (adjust the test's import or report).

## Maintenance notes

- Reviewer: confirm `npm pack --dry-run` no longer lists the demo dirs.
- If examples should be runnable by contributors, document `bunx tsc` from a
  separate `tsconfig.examples.json` or run them with `bun src/examples/...` (Bun
  executes TS directly) rather than compiling them into the shipped build.
