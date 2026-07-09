# Plan 030: Validate changeAddress against network in createCommitTransaction

> **Executor instructions**: Follow step by step. Run every verification command
> and confirm the expected result before moving on. Touch only in-scope files.
> If a STOP condition occurs, stop and report. Commit on the worktree branch
> (conventional commit; `--no-verify` if the commitlint hook lacks deps — note it).
> SKIP updating `plans/README.md` — the reviewer maintains the index.

## Worktree setup (REQUIRED FIRST)

Worktree branches from `origin/main` (`correctness/round1-2-commit-changeaddr`).
At the worktree root:
1. `bun install --frozen-lockfile || bun install`.
2. Baseline: `bunx tsc --noEmit` → exit 0; `bun run test` → existing suites pass.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Category**: correctness / fail-fast validation
- **Planned at**: `origin/main` @ `bb8a1f3`, 2026-06-23

## Why this matters

`createCommitTransaction` in
`packages/sdk/src/bitcoin/transactions/commit.ts` accepts a `changeAddress`
parameter but only checks that it is non-empty (line ~187, `if (!changeAddress)`).
It does NOT validate the address against the configured `network`. The address
is only implicitly validated late at `tx.addOutputAddress(changeAddress, ...)`
(line ~480), which decodes it via `@scure/btc-signer`.

Consequences of the missing fail-fast validation:

1. A wrong-network address (e.g. a mainnet `bc1...` address passed on a
   `testnet`/`signet`/`regtest` flow, or vice versa) is not rejected until after
   the expensive work — UTXO filtering, iterative UTXO selection, and repeated
   fee calculation — has already run. This is wasted computation and a
   resource-exhaustion lever for an attacker who can supply addresses.
2. The eventual error from `@scure/btc-signer`'s address decoder is cryptic and
   does not clearly state that the address is wrong for the network.
3. It is inconsistent with `buildTransferTransaction` in
   `packages/sdk/src/bitcoin/transfer.ts` (lines 97-98), which validates the
   `changeAddress` at function entry using `validateBitcoinAddress()`. This
   inconsistency is a maintenance hazard.

## Scope (files to change)

- `packages/sdk/src/bitcoin/transactions/commit.ts` — import
  `validateBitcoinAddress` and call it at function entry, mapping the
  `BitcoinNetwork` (`mainnet | testnet | regtest | signet`) to the
  `validateBitcoinAddress` network type (`mainnet | regtest | signet`) exactly
  as `transfer.ts` does (`testnet` → `signet`).
- `packages/sdk/tests/unit/bitcoin/transactions/commit.test.ts` — add a
  regression test asserting a wrong-network `changeAddress` is rejected early
  with a clear error, plus a test confirming a correctly-networked address still
  succeeds (already covered by existing tests, but add an explicit assertion).

## Implementation

1. Add the import at the top of `commit.ts`:
   ```ts
   import { validateBitcoinAddress } from '../../utils/bitcoin-address.js';
   ```
2. Immediately after the existing `if (!changeAddress) { ... }` presence check,
   validate against the network (mirroring `transfer.ts`):
   ```ts
   // Fail fast: validate the change address for the target network BEFORE any
   // expensive UTXO selection / fee calculation. validateBitcoinAddress accepts
   // 'mainnet' | 'regtest' | 'signet'; testnet shares signet's prefix.
   const validateNetwork: 'mainnet' | 'regtest' | 'signet' =
     network === 'testnet' ? 'signet' : network;
   validateBitcoinAddress(changeAddress, validateNetwork);
   ```
   Place it after the `feeRate` check (keep all input validation together,
   before UTXO filtering).

## Verification (must all pass)

From the worktree checkout root:

```
bun install --frozen-lockfile || bun install
bunx tsc --noEmit            # 0 errors
bun run build                # succeeds
bun run test                 # SDK + auth suites 0-fail
```

Regression-specific: the new "rejects a wrong-network changeAddress before UTXO
selection" test fails on pre-fix code (the wrong-network address slips past the
presence check and only fails later, or with a cryptic `@scure` error) and
passes after (clear `Invalid ... address` error thrown at entry).

## STOP conditions

- If `createCommitTransaction` already calls `validateBitcoinAddress` (or
  otherwise validates `changeAddress` against the network) at function entry on
  `origin/main`, STOP — already resolved.
