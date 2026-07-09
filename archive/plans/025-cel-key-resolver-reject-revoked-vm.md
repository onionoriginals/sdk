# Plan 025: CEL key resolver must reject revoked / compromised verification methods

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. Touch
> only the files listed as in scope. If a STOP condition occurs, stop and
> report. Commit on the worktree branch. SKIP updating `plans/README.md` — the
> reviewer maintains the index.

## Status

- **Priority**: P0 (high)
- **Effort**: S
- **Risk**: LOW
- **Category**: security / correctness
- **Branch**: `correctness/round1-3` (from `origin/main`)
- **Target file**: `packages/sdk/src/cel/keyResolver.ts`

## Why this matters

`createDidManagerKeyResolver()` resolves a proof's `verificationMethod` DID URL
to a DID document, finds the matching verification method, and returns its
Ed25519 public key for CEL signature verification. CEL signatures gate
commit-reveal proofs during Bitcoin inscriptions and event-log mutations.

The `VerificationMethod` type (`src/types/did.ts`) carries optional `revoked`
and `compromised` ISO-8601 timestamps. `KeyManager` sets these when keys are
rotated (`revoked`) or recovered after compromise (`compromised`). However, the
key resolver returns the matched VM's public key **without consulting these
fields**. As a result a key that has been explicitly revoked or marked
compromised — and is still present in the DID document precisely so verifiers
can recognise it as retired — will resolve as a valid signing key. An attacker
holding an old, revoked private key could forge CEL signatures that the resolver
would accept, enabling unauthorized inscription transfers or event-log
mutations.

## The fix (minimal, correct)

In the resolver, after locating the matching verification method, fail closed
(return `null`) if the VM carries a `revoked` or `compromised` timestamp. This
makes the resolver treat retired keys as non-resolvable, exactly like an unknown
or non-Ed25519 key. The caller already fails closed on `null`.

## In scope

- `packages/sdk/src/cel/keyResolver.ts` — reject VMs with `revoked` or
  `compromised` set; update the JSDoc.
- `packages/sdk/tests/unit/cel/keyResolver.test.ts` — new regression test
  (fails before, passes after).

## Regression test

A DID document publishes an Ed25519 verification method. The resolver returns
its key when the VM is active. When the same VM carries a `revoked` (or
`compromised`) timestamp, the resolver must return `null`. The active-key case
also guards against over-rejection.

## Verification (run at repo root unless noted)

```
bun install --frozen-lockfile || bun install
bunx tsc --noEmit          # 0 errors
bun run build              # succeeds
bun run test               # SDK + auth suites 0-fail
```

STOP conditions: any tsc error, build failure, or a previously-passing test
regressing.
