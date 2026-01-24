# Implementation Plan

## Working Context (For Ralph)

_No active task. Ready for new work._

### Current State (2026-01-24)

**[COMPLETED]** All lint errors fixed!

- ✅ **Build**: Passes (0 TypeScript errors)
- ✅ **Lint**: 0 errors, 53 warnings (warnings are acceptable)
- ✅ **Tests**: 0 failing, 1969 passing, 2 skipped

---

## Next Up (Priority Order)

### 1. Resolve Spec vs Implementation Deviations

The auth package is **feature-complete** but has deviations between spec and implementation that need alignment. These are discussion items for the maintainer:

**A. `createTurnkeySigner` signature mismatch**
- Spec says: `createTurnkeySigner(params: { turnkeyClient, organizationId, privateKeyId }): TurnkeyWebVHSigner`
- Actual: `createTurnkeySigner(subOrgId, keyId, turnkeyClient, verificationMethodId, publicKeyMultibase): TurnkeyWebVHSigner`
- File: `packages/auth/src/server/turnkey-signer.ts:155-169`
- **Recommendation**: Update spec to match implementation (impl is more explicit and type-safe)

**B. Multibase encoding inconsistency**
- Server uses `multikey.encodeMultibase(bytes)` at `packages/auth/src/server/turnkey-signer.ts:102`
- Client uses `encoding.multibase.encode(bytes, 'base58btc')` at `packages/auth/src/client/turnkey-did-signer.ts:75`
- **Recommendation**: Standardize to one approach

**C. Undocumented bonus features**
- `createOptionalAuthMiddleware()` — Optional auth that doesn't fail without token
- `getOrCreateTurnkeySubOrg()` — Complex sub-org + wallet creation helper
- These are internal utilities (not exported from package index)
- **Recommendation**: Document in specs or keep as internal utilities

### 3. Improve Test Coverage (Currently ~12%)

The auth package has only 14 tests covering 2 test files. Missing coverage for critical flows:

| Area | Coverage | Priority |
|------|----------|----------|
| Email auth flow (initiateEmailAuth, verifyEmailAuth) | 0% | HIGH |
| JWT handling (signToken, verifyToken) | 0% | HIGH |
| Middleware integration | 0% | MEDIUM |
| Server Turnkey client | 0% | MEDIUM |
| Client Turnkey client | 0% | MEDIUM |
| DID signers (server + client) | 0% | LOW |

**Note**: Test coverage requires mocking Turnkey APIs which adds complexity.

---

## Backlog (Lower Priority)

### Technical Debt

- Consider adding integration tests with actual Turnkey API (requires test credentials)
- Consider adding E2E tests for full authentication flows
- Review error message consistency across all modules

---

## Recently Completed

- ✅ Fix SDK test failures (5 → 0)
  - Tests now pass (1983 passing, 0 failing)
  - Previous test failures were due to `rejects.toThrow` usage on sync methods

- ✅ Fix SDK build errors (from 17+ down to 0)
  - Fixed DIDManager.ts cast issues
  - Fixed BtcoDidResolver.ts cast issues
  - Fixed LifecycleManager.ts private property access casts
  - Fixed cbor.ts ArrayBuffer handling
  - Fixed CredentialManager.ts return types
  - Fixed Verifier.ts import
  - Fixed BatchOperations.ts type issues
  - Build passes with 0 errors

- ✅ Fix SDK lint errors (from 5 down to 0)
  - Fixed example files await-thenable
  - Fixed LifecycleManager unnecessary cast
  - Fixed MigrationManager unsafe any
  - Lint passes with 0 errors (53 warnings remain, OK)

- ✅ Fix pre-existing lint errors in packages/auth (6 errors, 4 warnings)
  - Fixed `no-unsafe-enum-comparison` in `turnkey-client.ts` (line 114) - use `String()` cast
  - Fixed `no-unsafe-assignment/member-access/argument` in `middleware.ts` - add type assertion for cookies
  - Fixed `no-unused-vars` in `turnkey-client.ts` (line 93) - remove unused catch binding
  - Fixed `await-thenable` in `turnkey-signer.ts` - use `verifyAsync` instead of sync `verify`
  - Fixed `require-await` in `turnkey-signer.ts` - make `createTurnkeySigner` synchronous
  - Build passes, lint passes, all 14 tests pass

- ✅ Add server-proxied auth client helpers (`sendOtp`, `verifyOtp`) to `@originals/auth/client`
  - Created `packages/auth/src/client/server-auth.ts`
  - Updated `packages/auth/src/client/index.ts` with exports
  - Created `packages/auth/tests/server-auth.test.ts` with 10 test cases
  - Added ESLint v9 flat config (`eslint.config.js`) to auth package
  - Build passes, all 14 tests pass
  - Commit: `feat(auth): add server-proxied auth client helpers`

---

## Status Summary

| Area | Status |
|------|--------|
| **Auth Package Implementation** | ✅ Feature complete (27/27 functions) |
| **Auth Package Lint** | ✅ Passes |
| **SDK Package Build** | ✅ Passes (0 errors) |
| **SDK Package Lint** | ✅ Passes (0 errors, 53 warnings) |
| **SDK Package Tests** | ✅ All passing (1969 tests) |
| **Spec Coverage** | ⚠️ 3 deviations to resolve |
| **Test Coverage** | ⚠️ ~12% (critical gaps) |
| **Latest Tag** | v1.5.3 |
