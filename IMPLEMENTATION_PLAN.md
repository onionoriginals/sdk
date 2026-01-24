# Implementation Plan

## Working Context (For Ralph)

_No active task. Ready for new work._

---

## Next Up (Priority Order)

_No pending tasks_

## Backlog (Lower Priority)

- Fix pre-existing lint errors in packages/auth (turnkey-client.ts, middleware.ts, turnkey-signer.ts)

## Recently Completed

- ✅ Add server-proxied auth client helpers (`sendOtp`, `verifyOtp`) to `@originals/auth/client`
  - Created `packages/auth/src/client/server-auth.ts`
  - Updated `packages/auth/src/client/index.ts` with exports
  - Created `packages/auth/tests/server-auth.test.ts` with 10 test cases
  - Added ESLint v9 flat config (`eslint.config.js`) to auth package
  - Build passes, all 14 tests pass
  - Commit: `feat(auth): add server-proxied auth client helpers`
