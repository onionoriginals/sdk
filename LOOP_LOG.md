# Correctness Loop Log

Branch: `claude/originals-sdk-correctness-4pn30u`

## Iteration 1 — 2026-07-02

### Ground truth
- `bun test` (fresh clone, after `bun install`): 3305 pass / 23 fail / 4 errors.
- All 23 failures + 4 errors had a single root cause: `packages/sdk/dist` did not exist.
  - `packages/auth` resolves `@originals/sdk` via the workspace package's built entry point.
  - `tests/integration/cel-cli.integration.test.ts` spawns `dist/cel/cli/index.js` as a subprocess.
  - After `bun run build`, re-ran the full suite (results below).
- `bun run lint`: 0 errors, 85 warnings.
- `bun run typecheck` (packages/sdk): clean.
- No open PR for this branch yet; branch tip == origin/main (8ac6c70).

### Work items
- Full-suite re-run after `bun run build`: **3380 pass / 0 fail / 74 skip** across 182 files. Suite is green; initial failures were environment-only (missing dist), no code change needed.
- Proactive correctness audit of vc/crypto, did, bitcoin, cel/lifecycle subsystems: in progress.

### Open items
- Audit findings triage (pending agent reports).
