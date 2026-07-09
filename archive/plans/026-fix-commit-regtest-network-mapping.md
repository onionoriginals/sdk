# Plan 026: Fix regtest network mapping in commit transaction creation

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before moving on. Touch only in-scope files.
> If a STOP condition occurs, stop and report. Commit on the worktree branch
> (conventional commit; `--no-verify` if the commitlint hook lacks deps — note it).
> SKIP updating `plans/README.md` — the reviewer maintains the index.

## Worktree setup (REQUIRED FIRST)

Worktree branches from `origin/main` (`correctness/round1-2`). At the worktree root:
1. `bun install --frozen-lockfile || bun install`.
2. Baseline: `bunx tsc --noEmit` → exit 0; `bun run test` → existing suites pass.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Category**: bug (network mapping) / correctness
- **Planned at**: `origin/main` @ `b865f3f`, 2026-06-22

## Why this matters

`getScureNetwork()` in `packages/sdk/src/bitcoin/transactions/commit.ts`
(lines 31-42) maps the `regtest` network to `btc.TEST_NETWORK`, which uses the
testnet bech32 prefix `tb`. Regtest uses the bech32 prefix `bcrt`. As a result,
`createCommitTransaction` on `regtest`:

1. Generates a P2TR **commit address** with the wrong prefix (`tb1p...` instead
   of `bcrt1p...`), which is invalid on a real regtest network.
2. Cannot decode a real regtest `changeAddress` (which starts with `bcrt1`)
   because `tx.addOutputAddress(changeAddress, ..., scureNetwork)` decodes the
   address against `TEST_NETWORK` and throws on a `bcrt` prefix.

This breaks the entire commit-reveal inscription flow on regtest. The correct
pattern already exists in `packages/sdk/src/bitcoin/transfer.ts:10-15`, which
defines a `REGTEST_NETWORK` constant with `bech32: 'bcrt'` (and the matching
`pubKeyHash`/`scriptHash`/`wif` values) and selects it for `regtest`.

## Scope (files to change)

- `packages/sdk/src/bitcoin/transactions/commit.ts` — add a `REGTEST_NETWORK`
  constant (mirroring `transfer.ts`) and return it from `getScureNetwork` for
  the `regtest` case.
- `packages/sdk/tests/unit/bitcoin/transactions/commit.test.ts` — add/adjust a
  regression test that asserts a `bcrt1p...` commit address on regtest and that
  a real `bcrt1` change address is accepted. Fix the existing regtest test
  helpers/assertions that encode the buggy behavior.

## Implementation

1. In `commit.ts`, above `getScureNetwork`, add:

   ```ts
   // Regtest uses the bech32 prefix 'bcrt', which is not covered by
   // @scure/btc-signer's built-in TEST_NETWORK (which uses 'tb').
   const REGTEST_NETWORK: typeof btc.NETWORK = {
     bech32: 'bcrt',
     pubKeyHash: 0x6f,
     scriptHash: 0xc4,
     wif: 0xef,
   };
   ```

2. Change the `regtest` case to `return REGTEST_NETWORK;` (separate it from the
   `testnet`/`signet` cases which keep `btc.TEST_NETWORK`).

3. Update the test: regtest fixtures use a real `bcrt1q...` address; the
   `creates regtest commit address` test asserts `/^bcrt1p/`.

## Verification (must all pass)

From the worktree root `/Users/brian/Projects/onionoriginals/sdk`-equivalent
(i.e. the worktree checkout):

```
bun install --frozen-lockfile || bun install
bunx tsc --noEmit            # 0 errors
bun run build                # succeeds
bun run test                 # SDK + auth suites 0-fail
```

Regression-specific: the new/updated `creates regtest commit address` test
fails on the pre-fix code (asserts `bcrt1p` but gets `tb1p`) and passes after.

## STOP conditions

- If `getScureNetwork` already returns a `bcrt`-prefixed network for regtest on
  `origin/main`, STOP — already resolved.
