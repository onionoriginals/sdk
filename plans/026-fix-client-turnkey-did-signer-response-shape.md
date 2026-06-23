# Plan 026: Fix client `TurnkeyDIDSigner` reading wrong Turnkey `signRawPayload` response shape

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. Make the minimal correct change plus a regression test that
> fails before the fix and passes after.

## Status

- **Priority**: P1 (critical correctness)
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: origin/main commit `b03e50d`, 2026-06-22

## Why this matters

`packages/auth/src/client/turnkey-did-signer.ts` (`TurnkeyDIDSigner.sign`)
reads the Turnkey signature directly off the top level of the
`signRawPayload` response:

```typescript
const r = result.r;
const s = result.s;
if (!r || !s) {
  throw new Error('Invalid signature response from Turnkey');
}
```

But the real `@turnkey/sdk-server` `apiClient().signRawPayload` response wraps
`r`/`s` under `result.activity.result.signRawPayloadResult.{r, s}`. The
server-side signer (`packages/auth/src/server/turnkey-signer.ts:81`) reads
this nested shape correctly:

```typescript
const signRawResult = result.activity?.result?.signRawPayloadResult;
if (!signRawResult?.r || !signRawResult?.s) { ... }
```

Because `result.r`/`result.s` are `undefined` for every real Turnkey
response, the client signer always throws `'Invalid signature response from
Turnkey'`. This breaks **all** client-side DID creation via
`createDIDWithTurnkey`, violating the documented API contract.

### Why the existing tests didn't catch it

The `[AUTH-028]` / `[AUTH-029]` tests in
`packages/auth/tests/uncovered-scenarios.test.ts` mock `signRawPayload`
returning the **flat** shape `{ r, s }`, which matches the buggy code rather
than the real API. The authoritative shape is confirmed by the server-side
test in `packages/auth/tests/turnkey-signer.test.ts`, which mocks
`{ activity: { result: { signRawPayloadResult: { r, s } } } }`.

## Current state

- `packages/auth/src/client/turnkey-did-signer.ts:64-69` — flat access (bug).
- `packages/auth/src/server/turnkey-signer.ts:80-83` — correct nested access (reference).
- `packages/auth/tests/uncovered-scenarios.test.ts:603-611, 730-731` — mocks
  use the flat (wrong) shape and so mask the defect.

## The fix

1. In `turnkey-did-signer.ts`, read `r`/`s` from
   `result.activity?.result?.signRawPayloadResult`, mirroring the server
   signer. Keep the existing `if (!r || !s)` guard and the rest of the logic
   (0x-strip, 64-byte combine, multibase encode) unchanged.
2. Update the masking test mocks in `uncovered-scenarios.test.ts` (AUTH-028
   and AUTH-029) to return the real nested shape.
3. Add a regression test that:
   - asserts the realistic **nested** response produces a `proofValue`, and
   - asserts that a legacy **flat** `{ r, s }` response (the shape the old
     buggy code expected) now throws `'Invalid signature response from
     Turnkey'` — proving the signer reads the correct path.

## Verification

```bash
cd /Users/brian/Projects/onionoriginals/sdk
bun install --frozen-lockfile || bun install
bunx tsc --noEmit            # 0 errors
bun run build                # succeeds
bun run test                 # SDK + auth suites 0-fail
```

The new regression test must fail before step 1 and pass after.

## STOP conditions

- If `result.r`/`result.s` flat access is already gone from
  `turnkey-did-signer.ts` on the current base, the defect is already fixed —
  STOP and report `alreadyResolved`.
