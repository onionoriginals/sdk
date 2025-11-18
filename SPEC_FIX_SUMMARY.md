# Critical Specification Fix: DID Transfer Immutability

## Issue Summary

**Status**: ✅ FIXED AND COMMITTED
**Severity**: P1 - Critical
**Reporter**: Cursor Bot
**File**: ORIGINALS_SPECIFICATION_v1.0.md
**Commit**: 6ccd728

---

## The Bug

The specification incorrectly described the did:btco ownership transfer mechanism:

**Original (Incorrect)**:
```
// Updates DID document on Bitcoin via new inscription
// Records in transaction history
```

This violated the protocol's core constraint that **did:btco identifiers are immutable once inscribed**.

### Why This is Critical

1. **Immutability Violation**: The spec states "✅ Immutable once inscribed" (line 391)
2. **Wrong Semantics**: Creating a new inscription creates a NEW did:btco, not a transfer
3. **Implementation Failure**: Any SDK built from this spec would create duplicate DIDs
4. **Protocol Violation**: Breaks the fundamental promise of permanent ownership

---

## Root Cause Analysis

The bug stemmed from confusing two distinct operations:

### ❌ Layer Migration (Creates New DID)
- did:peer → did:webvh → did:btco
- Each transition creates NEW DID in new layer
- New satoshi number assigned
- Valid and correct

### ❌ Ownership Transfer (Transfers Existing DID)
- Transfer control within did:btco layer
- SAME satoshi number
- SAME DID identifier
- Moved UTXO to new owner

**The spec incorrectly described ownership transfer as layer migration.**

---

## The Fix

### 1. Corrected Transfer Mechanism

**Before**:
```
// Updates DID document on Bitcoin via new inscription
```

**After**:
```
// Results in:
// 1. UTXO moved to recipientAddress (ownership transferred)
// 2. did:btco identifier remains unchanged (same satoshi)
// 3. New owner controls the inscribed satoshi
// 4. DID document is NOT rewritten (immutability preserved)
// 5. Transfer recorded in ownership/transfer credentials
```

### 2. Added Critical Constraint

```
The DID identifier (did:btco:mainnet:6a8c92b1...) is permanently tied to
its satoshi number. Transferring ownership changes who controls the satoshi
via Bitcoin UTXO ownership, but does NOT change the DID identifier or
create a new inscription.
```

### 3. Marked Immutable Fields

```typescript
"id": string;                // did:btco identifier (immutable)
"satoshi": number;           // Satoshi number (immutable - DID identifier)
"inscriptionId": string;     // Bitcoin Ordinals ID (immutable)
"transactionId": string;     // Inscription reveal TXID (immutable)
```

### 4. Clarified Operations

- `inscribe()` - Creates new inscription on **new satoshi**
- `transfer()` - Moves UTXO, **no new inscription**
- `resolve()` - Reads from **immutable satoshi**
- `deactivate()` - Appends marker, **doesn't modify** original inscription

### 5. Distinguished Layer Migration from Ownership Transfer

Added explicit section explaining the difference:
- **Layer Migration**: Creates NEW DID document in target layer
- **Ownership Transfer**: Transfers control of EXISTING inscription

---

## Changes Applied

### File: ORIGINALS_SPECIFICATION_v1.0.md

**Line 350-370** (DID Structure):
- Marked all immutable fields with comments
- Clarified satoshi is the permanent identifier
- Added explicit immutability note

**Line 393-394** (Constraints):
- Strengthened immutability constraint
- Added ownership transferability clarification

**Line 410-413** (Operations):
- Specified which operations create new inscriptions
- Clarified transfer moves UTXO, no new inscription

**Line 415-432** (Ownership Transfer):
- Corrected mechanism to move UTXO
- Explicitly stated DID remains unchanged
- Added critical constraint explanation

**Line 809-821** (Layer Migration vs Transfer):
- Added explicit distinction section
- Clarified difference in DID behavior

---

## Verification

✅ **Immutability Preserved**: Satoshi numbers never change
✅ **Ownership Transferable**: UTXO can move to new owner
✅ **No New DIDs Created**: Transfer uses existing satoshi
✅ **History Preserved**: Original inscription never modified
✅ **Bitcoin Compatible**: UTXO movement is native Bitcoin operation

---

## Impact Assessment

### Fixed Issues
- ✅ Protocol immutability guarantee now correct
- ✅ Transfer mechanism now correct
- ✅ DID identifier binding clarified
- ✅ No breaking changes to protocol

### No Impact On
- ✅ Layer migration (still creates new DIDs)
- ✅ Inscription format
- ✅ Credential types
- ✅ Other protocol layers

### SDK Implementation Notes
The current SDK implementation (src/bitcoin/BitcoinManager.ts) correctly:
1. Moves UTXO to new owner (correct)
2. Does NOT create new inscription (correct)
3. Tracks ownership change in credentials (correct)

**No code changes needed - SDK was already correct!**

---

## Testing Recommendations

1. **Unit Tests**: Verify transfer maintains same satoshi number
2. **Integration Tests**: Confirm ownership change recorded in blockchain
3. **Immutability Tests**: Verify inscription data never changes
4. **Resolution Tests**: Confirm resolved DID matches original after transfer
5. **History Tests**: Verify full provenance chain maintained

---

## Documentation Updates

The specification now correctly documents:
- ✅ did:btco immutability guarantee
- ✅ Satoshi as permanent identifier
- ✅ UTXO-based ownership transfer
- ✅ Distinction from layer migration
- ✅ Critical constraints on modification

---

## Release Notes

**For v1.0 Release**:
```
FIXED: Corrected did:btco ownership transfer mechanism
- Transfer now correctly moves UTXO, not create new inscription
- Satoshi numbers and DID identifiers remain immutable
- Immutability guarantee now preserved throughout protocol
```

---

## Related Issues Checked

The following were reviewed to ensure no similar bugs:
- ✅ DID structure - correctly marked immutable
- ✅ Constraints section - correctly specifies ownership transferability
- ✅ Operations section - correctly specifies which create inscriptions
- ✅ Layer migration section - correctly describes new satoshi creation
- ✅ Use cases - correctly show layer transitions
- ✅ Bitcoin integration section - correctly describes commit-reveal

**No other immutability violations found.**

---

## Commit Details

**Hash**: 6ccd728
**Message**: fix: Correct did:btco transfer mechanism to preserve immutability
**Files Changed**: ORIGINALS_SPECIFICATION_v1.0.md
**Insertions**: +45
**Deletions**: -19
**Status**: ✅ Pushed to branch

---

## Next Steps

1. ✅ Fix applied and committed
2. ✅ Specification now correct
3. ⏳ PR ready for re-review
4. ⏳ All checks should pass
5. ⏳ Ready for merge

---

**This fix is CRITICAL for specification correctness. The protocol's immutability guarantee is now properly maintained and documented.**
