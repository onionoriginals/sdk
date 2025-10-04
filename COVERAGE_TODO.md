# Code Coverage TODO - Path to 100%

## Overview
This document outlines the work needed to achieve 100% code coverage in the Originals SDK.

## Priority Issues

### 1. 🔴 **Signer.ts** - Utility Injection Coverage (CRITICAL)

**File:** `src/crypto/Signer.ts` (lines 20-27)

**Issue:** The utility injection code for `@noble/secp256k1` and `@noble/ed25519` is not properly covered by tests.

**Current State:**
- Lines 20-27 inject `hmacSha256Sync` and `sha512Sync` when missing
- Test file has placeholder tests (lines 312-339) that are skipped because "Bun doesn't support jest.resetModules()"
- These are currently not providing actual coverage

**What needs to be done:**
```typescript
// Lines 20-27 in Signer.ts need coverage:
if (sAny && sAny.utils && typeof sAny.utils.hmacSha256Sync !== 'function') {
  sAny.utils.hmacSha256Sync = (key: Uint8Array, ...msgs: Uint8Array[]) =>
    hmac(sha256, key, concatBytes(...msgs));
}

if (eAny && eAny.utils && typeof eAny.utils.sha512Sync !== 'function') {
  eAny.utils.sha512Sync = (...msgs: Uint8Array[]) => sha512(concatBytes(...msgs));
}
```

**Solution Approaches:**
1. **Option A:** Create a separate test file that imports Signer.ts in a fresh module context
2. **Option B:** Mock the noble libraries to simulate the missing function scenario
3. **Option C:** Use dynamic imports with module reloading if testing framework supports it
4. **Option D:** Create integration tests that verify the behavior works in both scenarios

### 2. 🔴 **Signer.ts** - Error Handling Coverage

**Issue:** Error handling in all signer classes when `multikey.decode*` throws non-Error objects

**Current Coverage:** Tests only verify `Error` instances in catch blocks

**What needs testing:**
```typescript
// Lines like 38-43, 100-107, etc.
try {
  decoded = multikey.decodePrivateKey(privateKeyMultibase);
} catch (error) {
  throw new Error(
    `Invalid multibase key format. Keys must use multicodec headers. ${
      error instanceof Error ? error.message : String(error)
    }`
  );
}
```

**Solution:** Add tests where mock throws:
- String values
- Numbers
- null/undefined
- Objects without Error prototype

---

## Missing Test Files

### 3. 🟡 **OrdHttpProvider.ts**

**File:** `src/adapters/providers/OrdHttpProvider.ts`

**Status:** Currently marked with `/* istanbul ignore file */` but should be tested

**What needs testing:**
- Constructor validation (baseUrl required)
- `getInscriptionById()` - success and null cases
- `getInscriptionsBySatoshi()` - empty array handling
- `broadcastTransaction()` - placeholder behavior
- `getTransactionStatus()` - return structure
- `estimateFee()` - calculation logic
- `createInscription()` - mock response generation
- `transferInscription()` - validation and response
- `createOrdinalsProviderFromEnv()` - environment variable handling

**Required Mocks:**
- `globalThis.fetch` for HTTP calls
- `globalThis.process.env` for environment variables
- `globalThis.Buffer` for Buffer operations

### 4. 🟡 **LocalStorageAdapter.ts**

**File:** `src/storage/LocalStorageAdapter.ts`

**Status:** No test file exists

**What needs testing:**
- Constructor initialization
- `resolvePath()` - path sanitization and joining
- `toUrl()` - URL generation with and without baseUrl
- `putObject()` - file writing, directory creation
- `getObject()` - file reading, null on ENOENT, error re-throwing
- `exists()` - true/false cases

**Required Mocks:**
- `fs/promises` module (mkdir, writeFile, readFile, access)
- Path operations

**Edge Cases:**
- Non-ASCII characters in domain
- Leading slashes in objectPath
- ENOENT vs other errors in getObject
- File system permissions errors

### 5. 🟡 **jsonld.ts Utils**

**File:** `src/vc/utils/jsonld.ts`

**Status:** No dedicated test file

**What needs testing:**
- `canonize()` - JSON-LD canonization with documentLoader
- `canonizeProof()` - proof canonization excluding signature fields (jws, signatureValue, proofValue)

**Note:** May already be tested indirectly through VC tests. Verify with coverage report.

### 6. 🟡 **OrdinalsClientProvider.ts**

**File:** `src/bitcoin/providers/OrdinalsProvider.ts`

**Status:** No dedicated test file

**What needs testing:**
- Constructor with options
- `getSatInfo()` - with retry logic
- `resolveInscription()` - all error paths:
  - Inscription not found
  - Missing satoshi field
  - Invalid satoshi value (NaN)
  - Missing contentType
  - Missing baseUrl
- `getMetadata()` - with retry
- `estimateFee()` - with retry

**Required Mocks:**
- `OrdinalsClient` methods
- Retry behavior

### 7. 🟢 **bbsSimple.ts**

**File:** `src/vc/cryptosuites/bbsSimple.ts`

**Status:** Stub implementations that throw errors

**What needs testing:**
- `BbsSimple.sign()` - verify it throws expected error
- `BbsSimple.verify()` - verify it throws expected error

**Note:** Low priority since these are intentional stubs. Coverage can be achieved by simply calling them and expecting errors.

---

## Files That Don't Need Tests

### Type Definition Files (Excluded from Coverage)
- `src/types/*.ts` - Pure TypeScript types/interfaces
- `src/adapters/types.ts` - Interface definitions
- `src/types/external-shims.d.ts` - Ambient declarations

### Export-Only Files (Should be istanbul-ignored)
- `src/adapters/index.ts` - Pure re-exports
- `src/storage/index.ts` - Pure re-exports
- `src/index.ts` - Already marked with `/* istanbul ignore file */`

### Example Files (Not Production Code)
- `src/examples/basic-usage.ts` - Example/documentation code
- `src/examples/run.ts` - Example runner

---

## Testing Strategy

### Immediate Actions (High Priority)

1. **Fix Signer.ts Coverage**
   - Create targeted tests for utility injection
   - Add non-Error error handling tests
   - Verify all branch paths are covered

2. **Add OrdHttpProvider Tests**
   - Remove `/* istanbul ignore file */` comment
   - Create comprehensive test suite
   - Mock fetch and environment

3. **Add LocalStorageAdapter Tests**
   - Create test suite with fs mocking
   - Cover all error paths
   - Test path sanitization

### Secondary Actions (Medium Priority)

4. **Add OrdinalsClientProvider Tests**
   - Test all error paths
   - Verify retry logic

5. **Add jsonld Utils Tests**
   - Verify not already covered indirectly
   - Add focused tests if needed

6. **Add bbsSimple Tests**
   - Simple error throw verification

### Verification Actions

7. **Run Coverage Report**
   - Execute: `bun test tests/integration tests/unit --coverage`
   - Parse coverage output
   - Identify any remaining gaps

8. **Review Edge Cases**
   - Check all catch blocks
   - Verify all conditional branches
   - Test all error handling paths

---

## Coverage Goals

**Current Thresholds (from scripts/check-coverage.ts):**
- Functions: 96% minimum
- Lines: 98% minimum

**Target:**
- Functions: 100%
- Lines: 100%

---

## Next Steps

1. Start with **Signer.ts** (user priority + critical for coverage)
2. Add tests for **OrdHttpProvider** and **LocalStorageAdapter** (biggest coverage gaps)
3. Fill in remaining gaps (**OrdinalsClientProvider**, **jsonld**, **bbsSimple**)
4. Run full coverage report to identify any missed lines
5. Update coverage thresholds to 100% once achieved

---

## Notes

- Some files use conditional logic based on environment (Bun vs Node vs Jest)
- Test files should use appropriate mocking strategies for each test runner
- Consider using `/* istanbul ignore next */` for unreachable defensive code
- May need to update jest/bun configuration for module reloading in Signer.ts tests
