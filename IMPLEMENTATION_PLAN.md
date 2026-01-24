# Implementation Plan

## Working Context (For Ralph)

**[RECOVERED] Current Task: Fix SDK Package Build & Lint Errors**

⚠️ **CRITICAL: Previous lint fixes broke the build!**

Ralph's previous session reduced lint errors from 97 → 43, but introduced **22 TypeScript build errors**. The approach was incorrect:
- ❌ **WRONG**: Replacing types with `Record<string, unknown>` or `{}`
- ✅ **RIGHT**: Keep existing types, use targeted assertions like `as unknown as TargetType`

### Current State
- **Build errors**: 22 TypeScript errors (needs fix first!)
- **Lint errors**: 25 errors + 122 warnings
- **Working tree**: 40 modified files with uncommitted changes

---

## Files to Fix (Build Errors First!)

### 1. `packages/sdk/src/lifecycle/BatchOperations.ts` — Lines 279, 323, 355

**Problem**: Validator functions use `Record<string, unknown>` instead of actual types.

**Fix**: Change method signatures to use proper types:

```typescript
// Line 279 - WRONG:
validateBatchCreate(resourcesList: Array<Array<Record<string, unknown>>>): ValidationResult[]
// CORRECT:
validateBatchCreate(resourcesList: AssetResource[][]): ValidationResult[]

// Line 323 - WRONG:
validateBatchInscription(assets: Array<Record<string, unknown>>): ValidationResult[]
// CORRECT:
validateBatchInscription(assets: OriginalsAsset[]): ValidationResult[]

// Line 355 - WRONG:
validateBatchTransfer(transfers: Array<{ asset: Record<string, unknown>; to: string }>): ValidationResult[]
// CORRECT:
validateBatchTransfer(transfers: Array<{ asset: OriginalsAsset; to: string }>): ValidationResult[]
```

**Add imports at top:**
```typescript
import type { AssetResource, OriginalsAsset } from '../types';
// Or import from where these types are actually defined
```

---

### 2. `packages/sdk/src/did/DIDManager.ts` — Lines 55, 58, 63, 65, 182, 205

**Problem**: Cast from `Record<string, unknown>` to `DIDDocument` fails because the types don't overlap.

**Fix**: Use `as unknown as DIDDocument` pattern:

```typescript
// Line 63 - WRONG:
return { didDocument: resolved as DIDDocument, keyPair };
// CORRECT:
return { didDocument: resolved as unknown as DIDDocument, keyPair };

// Line 65 - WRONG:
return resolved as DIDDocument;
// CORRECT:
return resolved as unknown as DIDDocument;
```

Also for lines 182, 205 - same pattern.

For lines 55 and 58, the issue is accessing `.length` on `{}`. Find the actual variable declaration and fix the type annotation (likely the `resolved` variable got typed as `{}` instead of a proper type).

---

### 3. `packages/sdk/src/did/BtcoDidResolver.ts` — Line 160

**Problem**: Same `Record<string, unknown>` → `DIDDocument` cast issue.

**Fix**:
```typescript
// Line 160 - WRONG:
const didDocument = inscriptionData.metadata as DIDDocument;
// CORRECT:
const didDocument = inscriptionData.metadata as unknown as DIDDocument;
```

---

### 4. `packages/sdk/src/lifecycle/LifecycleManager.ts` — Lines 269, 297, 695, 740, 808, 968, 1129, 1425

**Multiple issues:**

**Lines 269, 297, 695, 740** - Private property access:
```typescript
// WRONG:
void (asset as { eventEmitter: EventEmitter }).eventEmitter.emit(event);
// CORRECT - access via internal method or cast through unknown:
void ((asset as unknown as { eventEmitter: EventEmitter }).eventEmitter.emit(event));
// OR better - add a public method to OriginalsAsset like `emitEvent()`
```

**Line 808** - Null check needed:
```typescript
// WRONG:
privateKey = await this.keyStore.getPrivateKey(vmId);
// The vmId could be null, so add a null check before calling
if (!vmId) throw new Error('Verification method ID is null');
privateKey = await this.keyStore.getPrivateKey(vmId);
```

**Lines 968, 1129, 1425** - These errors stem from BatchOperations.ts having wrong types. After fixing BatchOperations.ts, these should resolve automatically.

---

### 5. `packages/sdk/src/utils/cbor.ts` — Lines 20, 24

**Problem**: `ArrayBufferLike` (could be SharedArrayBuffer) assigned to `ArrayBuffer`.

**Fix**:
```typescript
// Line 20 - WRONG:
arrayBuffer = bytes.buffer;
// CORRECT:
arrayBuffer = bytes.buffer.slice(0) as ArrayBuffer;

// Line 24 - WRONG:
arrayBuffer = bufferInstance.buffer.slice(...)
// CORRECT - the slice is good but needs assertion:
arrayBuffer = bufferInstance.buffer.slice(...) as ArrayBuffer;
```

---

### 6. `packages/sdk/src/vc/Verifier.ts` — Lines 21, 45

**Problem**: `Proof` interface doesn't have `cryptosuite` property that `DataIntegrityProof` requires.

**Fix**: Cast through unknown:
```typescript
// Line 21 - WRONG:
const result = await DataIntegrityProofManager.verifyProof(vc, proof, { documentLoader: loader });
// CORRECT:
const result = await DataIntegrityProofManager.verifyProof(vc, proof as unknown as DataIntegrityProof, { documentLoader: loader });

// Line 45 - same fix
```

**Add import:**
```typescript
import type { DataIntegrityProof } from './proofs/data-integrity';
// Or wherever DataIntegrityProof is exported from
```

---

### 7. `packages/sdk/src/vc/CredentialManager.ts` — Lines 737, 884

**Line 737** - `VerifiableCredential` to `Record<string, unknown>`:
```typescript
// WRONG:
const canonicalized = await canonicalizeDocument(credential as Record<string, unknown>);
// CORRECT:
const canonicalized = await canonicalizeDocument(credential as unknown as Record<string, unknown>);
```

**Line 884** - Same pattern, cast through unknown.

---

## Lint Errors (After Build Passes)

### `require-await` errors — CredentialManager.ts lines 449, 503, 560, 622

These methods are marked `async` but don't use `await`. Fix:
```typescript
// Option A: Remove async keyword (preferred if return type is synchronous)
issueResourceCredential(...): VerifiableCredential { ... }

// Option B: Wrap return in Promise.resolve if it must be async
async issueResourceCredential(...): Promise<VerifiableCredential> {
  return Promise.resolve(this.createCredentialWithChain(...));
}
```

**Preferred**: Option A — check if callers expect a Promise. If not, just remove `async`.

### Remaining lint errors in MigrationManager.ts

The lint output shows many `no-unsafe-*` warnings in `/packages/sdk/src/migration/MigrationManager.ts`. These are mostly about accessing properties on `any` typed values. Fix with proper type assertions.

---

## Step-by-Step Fix Order

1. **Fix BatchOperations.ts first** — This fixes 3 build errors AND unblocks LifecycleManager errors
2. **Fix cbor.ts** — 2 build errors
3. **Fix DIDManager.ts** — 6 build errors
4. **Fix BtcoDidResolver.ts** — 1 build error
5. **Fix LifecycleManager.ts** — Remaining 4 build errors
6. **Fix Verifier.ts** — 2 build errors
7. **Fix CredentialManager.ts** — 2 build errors + 4 lint errors
8. **Run build** — Verify 0 errors
9. **Run lint** — Fix remaining errors
10. **Run tests** — Verify all pass
11. **Commit** — `fix(sdk): resolve lint and build errors`

---

## Correct Fix Patterns Reference

**When dealing with incompatible type casts:**
```typescript
// WRONG - types don't overlap
const doc = result as DIDDocument;

// RIGHT - cast through unknown
const doc = result as unknown as DIDDocument;
```

**When dealing with ArrayBuffer types:**
```typescript
// WRONG - SharedArrayBuffer incompatible
const buf: ArrayBuffer = uint8Array.buffer;

// RIGHT - use slice to get a real ArrayBuffer
const buf = uint8Array.buffer.slice(0) as ArrayBuffer;
```

**When accessing private properties (avoid if possible):**
```typescript
// WRONG - TypeScript complains about private access
(asset as { eventEmitter: EventEmitter }).eventEmitter

// RIGHT - cast through unknown to bypass private check
(asset as unknown as { eventEmitter: EventEmitter }).eventEmitter

// BETTER - add a public method to the class if you control it
```

**When lint says "async has no await":**
```typescript
// If function doesn't need to be async, remove async keyword
// If function must return Promise, wrap return in Promise.resolve()
```

---

## Acceptance Criteria

- [ ] `bun run build` passes (0 errors)
- [ ] `bun run lint` shows 0 errors (warnings OK)
- [ ] `bun test` — all tests pass
- [ ] No functional changes — only lint/type fixes
- [ ] Commit with message: `fix(sdk): resolve lint and build errors`

## Definition of Done

1. Run `bun run build` — should succeed
2. Run `bun run lint` — should show 0 errors
3. Run `bun test` — all tests should pass
4. Commit: `fix(sdk): resolve lint and build errors`
5. Update this section to show completion

---

## Next Up (Priority Order)

### 0. [IN PROGRESS] Fix SDK Package Build & Lint Errors

**Status**: Build broken (22 errors), 25 lint errors remain.

See Working Context above for detailed fix instructions.

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

### 2. Improve Test Coverage (Currently ~12%)

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
| **SDK Package Build** | ❌ 22 TypeScript errors (needs fix) |
| **SDK Package Lint** | ⚠️ 25 errors + 122 warnings |
| **Spec Coverage** | ⚠️ 3 deviations to resolve |
| **Test Coverage** | ⚠️ ~12% (critical gaps) |
| **Tests** | ⚠️ Unknown (build broken) |
