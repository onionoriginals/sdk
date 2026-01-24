# Implementation Plan

## Working Context (For Ralph)

**Current Task: Fix SDK Package Build & Lint Errors**

⚠️ **CRITICAL: Previous lint fixes broke the build!**

Ralph's previous session reduced lint errors from 97 → 43, but introduced **24 TypeScript build errors**. The approach was incorrect:
- ❌ **WRONG**: Replacing types with `Record<string, unknown>` or `{}`
- ✅ **RIGHT**: Keep existing types, use targeted assertions like `as unknown as TargetType`

### Current State (2026-01-24)
- **Build errors**: 24 TypeScript errors
- **Lint errors**: 12 errors + 88 warnings
- **Working tree**: 40 modified files with uncommitted changes

---

## Files to Fix (Build Errors First!)

### 1. `packages/sdk/src/lifecycle/BatchOperations.ts` — Lines 279, 323, 355

**Problem**: Validator functions use `Record<string, unknown>` instead of actual types.

**Fix**: Change method signatures to use proper types. The functions validate generic objects but are called with specific types, so we should either:
- A) Make the signatures accept the specific types (`AssetResource[][]`, `OriginalsAsset[]`, etc.)
- B) Keep generic signatures but have callers cast to `Record<string, unknown>[]`

**Preferred approach (A)** - proper types:

```typescript
// Line 279 - Change from:
validateBatchCreate(resourcesList: Array<Array<Record<string, unknown>>>): ValidationResult[]
// To:
validateBatchCreate(resourcesList: AssetResource[][]): ValidationResult[]

// Line 323 - Change from:
validateBatchInscription(assets: Array<Record<string, unknown>>): ValidationResult[]
// To:
validateBatchInscription(assets: OriginalsAsset[]): ValidationResult[]

// Line 355 - Change from:
validateBatchTransfer(transfers: Array<{ asset: Record<string, unknown>; to: string }>): ValidationResult[]
// To:
validateBatchTransfer(transfers: Array<{ asset: OriginalsAsset; to: string }>): ValidationResult[]
```

**Add imports at top of file:**
```typescript
import type { AssetResource } from '../types';
import type { OriginalsAsset } from './OriginalsAsset';
```

**Inside the functions**, change type casts from `Record<string, unknown>` to actual types:
- Line 301: `const resObj: AssetResource = resource;` (instead of `Record<string, unknown>`)
- Similar changes for asset properties access in the other validators

---

### 2. `packages/sdk/src/vc/CredentialManager.ts` — Lines 171, 222, 737, 884

**Lines 171 and 222 — Missing `Promise<>` in return type:**
```typescript
// Line 171 - WRONG:
async signCredential(...): VerifiableCredential {
// CORRECT:
async signCredential(...): Promise<VerifiableCredential> {

// Line 222 - WRONG:
async signCredentialWithExternalSigner(...): VerifiableCredential {
// CORRECT:
async signCredentialWithExternalSigner(...): Promise<VerifiableCredential> {
```

**Line 737 and 884 — Cast through unknown:**
```typescript
// Line 737 - WRONG:
const canonicalized = await canonicalizeDocument(credential as Record<string, unknown>);
// CORRECT:
const canonicalized = await canonicalizeDocument(credential as unknown as Record<string, unknown>);

// Line 884 - Same pattern (check actual code at this line)
```

---

### 3. `packages/sdk/src/did/DIDManager.ts` — Lines 55, 58, 63, 65, 182, 205

**Problem**: The `resolved` variable was typed as `{}` instead of a proper type (from previous incorrect fix). Cast issues from `Record<string, unknown>` to `DIDDocument`.

**Lines 55, 58** - Find the variable declaration and fix the type annotation. The variable accessing `.length` needs to be properly typed.

**Lines 63, 65, 182, 205** - Use `as unknown as DIDDocument` pattern:
```typescript
// Line 63 - WRONG:
return { didDocument: resolved as DIDDocument, keyPair };
// CORRECT:
return { didDocument: resolved as unknown as DIDDocument, keyPair };

// Same pattern for lines 65, 182, 205
```

---

### 4. `packages/sdk/src/did/BtcoDidResolver.ts` — Line 160

**Problem**: Same `Record<string, unknown>` → `DIDDocument` cast issue.

**Fix**:
```typescript
// Line 160 - WRONG:
const didDocument = inscriptionData.metadata as DIDDocument;
// CORRECT:
const didDocument = inscriptionData.metadata as unknown as DIDDocument;
```

---

### 5. `packages/sdk/src/lifecycle/LifecycleManager.ts` — Lines 269, 297, 694, 722, 739, 807, 967, 1128, 1424

**Lines 269, 297, 694, 739** - Private property access (cast through unknown):
```typescript
// WRONG:
void (asset as { eventEmitter: EventEmitter }).eventEmitter.emit(event);
// CORRECT:
void (asset as unknown as { eventEmitter: EventEmitter }).eventEmitter.emit(event);
```

**Line 722** - Wrong cast (trying to cast sync result as Promise):
The issue is `signCredentialWithExternalSigner` is async but returns `VerifiableCredential` instead of `Promise<VerifiableCredential>`. After fixing CredentialManager.ts lines 171/222, this cast is no longer needed:
```typescript
// Line 722 - WRONG (once CredentialManager is fixed, change to):
? await this.credentialManager.signCredentialWithExternalSigner(unsigned, signer)
// Remove the 'as Promise<VerifiableCredential>' cast entirely
```

**Line 807** - Null check needed:
```typescript
// WRONG:
privateKey = await this.keyStore.getPrivateKey(vmId);
// The vmId could be null, so add a null check before calling:
if (!vmId) throw new Error('Verification method ID is null');
privateKey = await this.keyStore.getPrivateKey(vmId);
```

**Lines 967, 1128, 1424** - These errors will resolve after fixing BatchOperations.ts type signatures.

---

### 6. `packages/sdk/src/utils/cbor.ts` — Lines 20, 24

**Problem**: `ArrayBufferLike` (could be SharedArrayBuffer) assigned to `ArrayBuffer`.

**Fix**:
```typescript
// Line 20 - WRONG:
arrayBuffer = bytes.buffer;
// CORRECT:
arrayBuffer = bytes.buffer.slice(0) as ArrayBuffer;

// Line 24 - the slice is good but needs assertion:
arrayBuffer = bufferInstance.buffer.slice(...) as ArrayBuffer;
```

---

### 7. `packages/sdk/src/vc/Verifier.ts` — Lines 21, 45

**Problem**: `Proof` interface doesn't have `cryptosuite` property that `DataIntegrityProof` requires.

**Fix**: Cast through unknown:
```typescript
// Lines 21, 45 - WRONG:
const result = await DataIntegrityProofManager.verifyProof(vc, proof, { documentLoader: loader });
// CORRECT:
const result = await DataIntegrityProofManager.verifyProof(
  vc,
  proof as unknown as DataIntegrityProof,
  { documentLoader: loader }
);
```

**Add import if not present:**
```typescript
import type { DataIntegrityProof } from '../types';
```

---

## Lint Errors to Fix (After Build Passes)

### 8. Example Files — `await-thenable` errors

**Files:**
- `packages/sdk/src/examples/create-module-original.ts:368`
- `packages/sdk/src/examples/full-lifecycle-flow.ts:171,176`

**Problem**: `validateMigration()` is synchronous but being awaited.

**Fix**: Remove `await` from these calls:
```typescript
// WRONG:
const validation = await sdk.lifecycle.validateMigration(asset, 'did:btco');
// CORRECT:
const validation = sdk.lifecycle.validateMigration(asset, 'did:btco');
```

---

### 9. MigrationManager.ts — Multiple lint errors

**Location**: `packages/sdk/src/migration/MigrationManager.ts`

Many `no-unsafe-*` warnings stem from `any` types. The main lint ERROR is:
- Line 302: `require-await` - async function `getMigrationHistory` has no await

**Fix for line 302**:
```typescript
// Option A (preferred if nothing awaits): Remove async keyword
getMigrationHistory(assetId: string): MigrationRecord[] {
  // ... implementation
}

// Option B: Wrap return in Promise.resolve
async getMigrationHistory(assetId: string): Promise<MigrationRecord[]> {
  return Promise.resolve(this.history.get(assetId) || []);
}
```

The other errors (lines 389, 404, 501, 503, 507, 509, 546) need proper type assertions for function arguments.

---

## Step-by-Step Fix Order

1. **Fix BatchOperations.ts first** — This fixes 3 build errors AND unblocks LifecycleManager errors (967, 1128, 1424)
2. **Fix CredentialManager.ts lines 171, 222** — Fixes 2 build errors AND unblocks LifecycleManager:722
3. **Fix cbor.ts** — 2 build errors
4. **Fix DIDManager.ts** — 6 build errors
5. **Fix BtcoDidResolver.ts** — 1 build error
6. **Fix LifecycleManager.ts** — Remaining ~5 build errors
7. **Fix Verifier.ts** — 2 build errors
8. **Fix CredentialManager.ts lines 737, 884** — 2 build errors
9. **Run build** — Verify 0 errors
10. **Fix example files** — Remove `await` from sync calls
11. **Fix MigrationManager.ts** — require-await and unsafe-argument errors
12. **Run lint** — Verify 0 errors
13. **Run tests** — Verify all pass
14. **Commit** — `fix(sdk): resolve lint and build errors`

---

## Correct Fix Patterns Reference

**When dealing with incompatible type casts:**
```typescript
// WRONG - types don't overlap
const doc = result as DIDDocument;

// RIGHT - cast through unknown
const doc = result as unknown as DIDDocument;
```

**When async function has wrong return type:**
```typescript
// WRONG
async signCredential(): VerifiableCredential { ... }

// RIGHT
async signCredential(): Promise<VerifiableCredential> { ... }
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

**Status**: Build broken (24 errors), 12 lint errors remain.

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
| **SDK Package Build** | ❌ 24 TypeScript errors (needs fix) |
| **SDK Package Lint** | ⚠️ 12 errors + 88 warnings |
| **Spec Coverage** | ⚠️ 3 deviations to resolve |
| **Test Coverage** | ⚠️ ~12% (critical gaps) |
| **Tests** | ⚠️ Unknown (build broken) |
