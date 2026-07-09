# Plan 023: Fix CLI transfer signed-payload mismatch (transferred logs fail verification)

## Status

- **State**: DONE (branch `correctness/round1-1`)
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Category**: correctness
- **Planned at**: commit `29bda1e` (branch `correctness/round1-1`, atop `origin/main`@`0b8cd11`), 2026-06-22

## Why this matters

PR #170 fixed the hash-chain digest part of the CLI transfer command, so
`chainValid` is `true` on transferred logs. But a second, independent
correctness defect remained: the *signed payload* the CLI transfer command
produced did not match the payload `verifyEventLog` reconstructs and verifies
against, so every CLI-transferred log failed cryptographic proof verification
(`proofValid: false`), breaking the provenance chain via the proof.

### Root cause

`updateEventLog` (the SDK path) signs over the full event base
`{ type: 'update', data, previousEvent }` (updateEventLog.ts lines 57-64), and
`verifyEventLog` reconstructs the same payload to verify
`{ type, data, ...(previousEvent ? { previousEvent } : {}) }`
(verifyEventLog.ts lines 276-280).

The CLI transfer command instead signed over only the inner `transferData`
object (`transfer.ts` previously: `proof = await signer(transferData)`), so the
signed bytes differed from the verified bytes and `verifyAsync` returned false.

## The fix

In `packages/sdk/src/cel/cli/transfer.ts`, compute `previousEvent` *before*
signing (reorder), build the event base
`{ type: 'update', data: transferData, previousEvent }`, and sign that base so
the signed payload matches what `verifyEventLog` reconstructs. `createSigner`
already canonicalizes whatever object it is handed via `canonicalizeEvent`, so
signing the base object is sufficient. No other files change; the pushed event
shape (`data` / `proof` / `previousEvent`) is unchanged.

## Regression test

Added to `packages/sdk/tests/unit/cel/cli-transfer.test.ts` (describe block
"cryptographic verification of transferred logs (plan 014/023)"):

1. Generate one real Ed25519 key; sign a `create` event with the matching
   `did:key` verificationMethod so the create event itself verifies offline.
2. Write that same key as the wallet, transfer via `transferCommand`.
3. Parse the transferred log and call `verifyEventLog(transferredLog)`.
4. Assert `verified === true`, and the transfer event reports `proofValid: true`
   and `chainValid: true`.

Confirmed: this test fails before the fix (`verified: false`) and passes after.

## Verification (this branch)

- `bun run typecheck` (tsc 5.9.3): 0 errors
- `bun run build`: succeeds
- `bun run test`: SDK 2217/0 + 104/0 (68 skip), auth 140/0 — 0 failures
