# Implementation Plan

## Working Context (For Ralph)

_No active task. Ready for new work._

---

## Next Up (Priority Order)

_No pending tasks_

## Backlog (Lower Priority)

### Spec vs Implementation Deviations (to discuss with maintainer)

These are not bugs, but deviations from the spec that should be either:
- Fixed in implementation to match spec, OR
- Updated in spec to reflect actual implementation

1. **createTurnkeySigner signature mismatch** — Spec says `createTurnkeySigner(params: { turnkeyClient, organizationId, privateKeyId }): TurnkeyWebVHSigner` but implementation is `createTurnkeySigner(subOrgId, keyId, turnkeyClient, verificationMethodId, publicKeyMultibase): Promise<TurnkeyWebVHSigner>`
   - File: `packages/auth/src/server/turnkey-signer.ts:155-169`
   - Decision needed: Update spec or implementation?

2. **Multibase encoding inconsistency** — Server uses `multikey.encodeMultibase(bytes)` while client uses `encoding.multibase.encode(bytes, 'base58btc')`
   - Server: `packages/auth/src/server/turnkey-signer.ts:102`
   - Client: `packages/auth/src/client/turnkey-did-signer.ts:75`
   - Decision needed: Standardize encoding approach

3. **Undocumented bonus features** — `createOptionalAuthMiddleware()` and `getOrCreateTurnkeySubOrg()` are implemented but not in specs
   - Either add to specs or remove

### Test Coverage Gaps

The auth package has ~30% test coverage. Missing tests for:
- Email auth flow (initiateEmailAuth, verifyEmailAuth)
- JWT handling (signToken, verifyToken, cookie config)
- Middleware integration tests
- DID signer tests
- Direct auth proxy flow tests

## Recently Completed

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
