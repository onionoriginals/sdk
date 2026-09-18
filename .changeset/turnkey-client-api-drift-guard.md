---
'@originals/auth': patch
---

**Added a compile-time guard against the positional-argument doc drift #716 found in the low-level Turnkey client helpers.**

No published code changed — `@originals/auth/client`'s `fetchUser`, `fetchWallets`, `createWalletWithAccounts`, and `ensureWalletWithAccounts` already require an explicit `subOrgId` argument. The package had no test that compiled the documented usage against the installed export map, so a future signature change (or a doc correction that silently regresses) could recur unnoticed, exactly as it did for #716.

`typecheck:public` now compiles `tests/types/public-client-api.ts` against `@originals/auth`'s built `dist` — exercising every low-level Turnkey client function's documented call shape, plus `@ts-expect-error` assertions that the previously-documented `(client, onExpired?)` shape must not type-check. Wired into CI's `esm-importable` job alongside the SDK's equivalent `typecheck:public` step.
