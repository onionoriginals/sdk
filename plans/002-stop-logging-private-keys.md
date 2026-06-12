# Plan 002: Stop printing private keys to stderr in the CEL CLI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report. When done, update this plan's row in
> `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 879ab0c..HEAD -- packages/sdk/src/cel/cli/create.ts packages/sdk/src/cel/cli/migrate.ts`
> If either file changed, compare the "Current state" excerpts to the live code
> before proceeding; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `879ab0c`, 2026-06-11

## Why this matters

Two CLI commands print freshly generated/loaded private keys to stderr. Anything
on stderr lands in shell history scrollback, terminal transcripts, CI job logs,
and error-reporting pipelines — so a key generated on a CI runner or a shared
machine is effectively disclosed. Key material must never be written to a
shared stream. After this plan, the CLI writes the private key only to a file
with owner-only permissions (or prints it solely when the user explicitly opts
in), and the default output never contains the secret.

## Current state

- `packages/sdk/src/cel/cli/create.ts:324` — `console.error(\`Private Key: ${privateKey}\`);`
- `packages/sdk/src/cel/cli/migrate.ts:362` — `console.error(\`Private Key: ${privateKey}\`);`

Both are inside CLI command handlers that generate or load a key and report
results to the user on stderr.

**Convention to follow:** the repo already has a file-writing storage utility and
Node `fs`. For a CLI, the standard safe pattern is `fs.writeFileSync(path, key,
{ mode: 0o600 })`. Check the top of each CLI file for how it already imports
`fs`/path and how it prints other result lines (match that style).

## Commands you will need

| Purpose   | Command (from repo root)                                          | Expected |
|-----------|-------------------------------------------------------------------|----------|
| Typecheck | `cd packages/sdk && bunx tsc --noEmit -p . 2>&1 \| grep -c "error TS"` | unchanged vs baseline (12, or 0 if plan 003 landed) |
| CLI tests | `cd packages/sdk && bun test tests/unit/cel`                       | all pass |
| Grep gate | `grep -rn "Private Key:" packages/sdk/src/cel/cli`                 | no matches after fix |

## Scope

**In scope:**
- `packages/sdk/src/cel/cli/create.ts`
- `packages/sdk/src/cel/cli/migrate.ts`
- The corresponding CLI tests under `tests/unit/cel/` if they assert on the
  private-key output line (adjust them to the new behavior).

**Out of scope:**
- Key generation logic itself — only how the key is surfaced changes.
- Any non-CLI code path.

## Git workflow

- Branch: `advisor/002-stop-logging-private-keys`
- Conventional Commits, e.g. `fix(sdk): stop printing private keys to stderr in CEL CLI`.
- Do not push/PR unless instructed.

## Steps

### Step 1: Read both call sites and their surrounding handler

Open `create.ts` around line 324 and `migrate.ts` around line 362. Note how the
private key variable is obtained and what other output lines accompany it.

### Step 2: Replace the stderr print with a secure file write

For each site, replace the `console.error(\`Private Key: ...\`)` line with:

- Write the key to a file the user controls, with `0o600` permissions, and print
  only the **path** (not the key) to stderr. Prefer an existing `--out`/output
  option if the command already has one; otherwise write to a sensible default
  (e.g. `<did-or-id>.key` in the cwd) and print where it went.
- Alternatively, if the command already supports structured (JSON) output meant
  to be redirected to a file by the user, route the key only into that
  structured output and add a one-line stderr warning that the output contains a
  secret — but do NOT print the secret as a standalone human-readable line.

Pick the file-write approach unless the command's existing design clearly favors
structured output.

Target shape (illustrative):

```ts
import * as fs from 'fs';
// ...
const keyPath = `${outBase}.key`;
fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
console.error(`Private key written to ${keyPath} (keep it secret).`);
```

**Verify**: `grep -rn "Private Key:" packages/sdk/src/cel/cli` → no matches.

### Step 3: Update any test asserting on the removed output

Run `cd packages/sdk && bun test tests/unit/cel`. If a test asserted the old
`Private Key:` line, update it to assert the new behavior (a file is written
with the key, and stdout/stderr does NOT contain the raw key).

**Verify**: `cd packages/sdk && bun test tests/unit/cel` → all pass.

## Test plan

- If a CLI test harness exists for `create`/`migrate` (look in
  `tests/unit/cel/cli-create.test.ts` and similar), add an assertion: after
  running the command, captured stderr/stdout does NOT contain the private key
  string, and the key file exists with the key.
- Model after the existing CEL CLI tests in `tests/unit/cel/`.
- Verification: `cd packages/sdk && bun test tests/unit/cel` → all pass.

## Done criteria

ALL must hold:

- [ ] `grep -rn "Private Key:" packages/sdk/src/cel/cli` → no matches
- [ ] `grep -rn "console\\.\\(log\\|error\\|info\\).*privateKey" packages/sdk/src/cel/cli` → no matches that print the raw key
- [ ] `cd packages/sdk && bun test tests/unit/cel` → all pass
- [ ] `tsc` error count unchanged vs baseline
- [ ] No out-of-scope files modified (`git status`)
- [ ] `plans/README.md` row updated

## STOP conditions

- "Current state" excerpts don't match live code (drift).
- A CLI command has no filesystem access available and structured output is also
  unavailable (then report — the maintainer must choose the delivery channel).
- Removing the print breaks a documented CLI contract relied on by a script in
  `docs/` (grep `docs/` for the command usage first; if found, report).

## Maintenance notes

- Reviewer: confirm no other code path prints key material — extend the grep to
  all of `packages/sdk/src`: `grep -rn "privateKey" packages/sdk/src | grep -i "console\\."`.
- If a `--print-key` opt-in flag is added later, gate it behind an explicit flag
  and a stderr warning; never make printing the default.
