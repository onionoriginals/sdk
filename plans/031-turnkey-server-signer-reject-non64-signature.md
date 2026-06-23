# Plan 031: Server-side `TurnkeyWebVHSigner` must reject non-64-byte Ed25519 signatures (no silent truncation)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. Make the minimal correct change plus a regression test that
> fails before the fix and passes after.

## Status

- **Priority**: P0 (critical correctness / security)
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: origin/main commit `d2e51a4`, 2026-06-23

## Why this matters

`packages/auth/src/server/turnkey-signer.ts` (`TurnkeyWebVHSigner.sign`)
silently truncates a 65-byte signature down to 64 bytes:

```typescript
// Ed25519 signatures should be exactly 64 bytes
if (signatureBytes.length === 65) {
  signatureBytes = signatureBytes.slice(0, 64);
} else if (signatureBytes.length !== 64) {
  throw new Error(
    `Invalid Ed25519 signature length: ${signatureBytes.length} (expected 64 bytes)`
  );
}
```

An Ed25519 signature is exactly 64 bytes (32-byte `r` + 32-byte `s`). If
Turnkey ever returns 65 bytes (e.g. a recovery id / encoding flag, or a
different curve mis-routed to this signer), the value is **not** a valid
Ed25519 signature with the last byte chopped off — truncating it produces an
invalid signature that is nonetheless accepted, multibase-encoded, and stored
in the did:webvh log / credential proof. Verification (during did:webvh
resolution or credential validation) then fails on a proof that was already
committed, destroying signature provenance: the user cannot prove ownership
of their DID.

This also breaks the `createTurnkeySigner` API contract by being
**asymmetric** with the client-side signer. The client
(`packages/auth/src/client/turnkey-did-signer.ts:83-87`) rejects anything that
is not exactly 64 bytes:

```typescript
if (signatureBytes.length !== 64) {
  throw new Error(
    `Invalid Ed25519 signature length: ${signatureBytes.length} (expected 64 bytes)`
  );
}
```

Server and client paths produced by the same `createTurnkeySigner` factory
must behave identically.

## Current state

- `packages/auth/src/server/turnkey-signer.ts:96-103` — truncates 65-byte
  signatures (the bug).
- `packages/auth/src/client/turnkey-did-signer.ts:83-87` — correctly rejects
  any non-64-byte signature (reference behaviour).

## The fix

In `turnkey-signer.ts`, remove the `length === 65` truncation branch so the
server signer rejects **any** signature that is not exactly 64 bytes, matching
the client:

```typescript
// Ed25519 signatures must be exactly 64 bytes (32-byte r + 32-byte s).
// Never truncate: a 65-byte value is not a valid Ed25519 signature with a
// spare byte, and silently slicing it produces an invalid signature that
// later fails verification.
if (signatureBytes.length !== 64) {
  throw new Error(
    `Invalid Ed25519 signature length: ${signatureBytes.length} (expected 64 bytes)`
  );
}
```

`signatureBytes` can become `const`.

## Regression test

Add tests to `packages/auth/tests/turnkey-signer.test.ts` that drive `sign()`
through a mocked Turnkey client:

1. A 65-byte signature (32-byte `r` + 33-byte `s`) must cause `sign()` to
   reject with an error mentioning the invalid length (65). This FAILS before
   the fix (truncation makes it succeed) and PASSES after.
2. A valid 64-byte signature (32-byte `r` + 32-byte `s`) must still produce a
   `proofValue` — guards against over-rejection.

## Verification

```bash
cd /Users/brian/Projects/onionoriginals/sdk
bun install --frozen-lockfile || bun install
bunx tsc --noEmit            # 0 errors
bun run build                # succeeds
bun run test                 # SDK + auth suites 0-fail
```

The new 65-byte regression test must fail before the fix and pass after.

## STOP conditions

- If the `signatureBytes.length === 65` truncation branch is already gone from
  `turnkey-signer.ts` on the current base, the defect is already fixed — STOP
  and report `alreadyResolved`.
