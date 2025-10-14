# PRD: Port Bitcoin Transaction Infrastructure from Legacy

**Status:** 🔴 CRITICAL - Immediate Priority  
**Timeline:** 2-4 weeks  
**Team:** 1 engineer + AI assistance  
**Created:** October 14, 2025

---

## Introduction/Overview

The current Originals SDK lacks the core Bitcoin transaction infrastructure needed to properly inscribe Ordinals on Bitcoin. While the SDK has a high-level `BitcoinManager` and basic PSBT builder (~400 lines), it is missing the production-proven commit/reveal transaction logic that exists in the legacy codebase (~42,000 lines).

**The Problem:** 
- SDK cannot properly create commit transactions for Ordinals inscriptions
- SDK lacks reveal transaction logic for completing inscriptions
- Current UTXO selection is too simple and risks destroying inscriptions
- No transaction broadcasting with retry logic
- No confirmation tracking

**The Solution:**
Port the working, production-proven transaction infrastructure from `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/` directly into the current SDK. This code has been battle-tested in the ordinalsplus explorer and works reliably.

**Why Direct Port (Not Rewrite):**
The legacy transaction code was hard-won after significant struggles. It works in production. Rewriting from scratch would risk re-introducing bugs and edge cases that have already been solved.

---

## Goals

1. **Enable proper Bitcoin inscription** - SDK can inscribe Ordinals on signet and mainnet
2. **Protect inscriptions** - Advanced UTXO selection prevents accidental destruction of existing inscriptions
3. **Production reliability** - Transaction broadcasting with retry logic and confirmation tracking
4. **Maintain compatibility** - Keep existing `BitcoinManager` API surface where possible
5. **Speed to market** - Complete in 2-4 weeks by direct porting (not rewriting)

---

## User Stories

### As a Developer
**Story 1:** Inscribe on Signet
```
As a developer using the Originals SDK,
I want to inscribe Ordinals on Bitcoin signet,
So that I can test inscription functionality before mainnet deployment.
```

**Story 2:** Inscribe on Mainnet
```
As a developer deploying to production,
I want to inscribe Ordinals on Bitcoin mainnet,
So that I can create permanent, verifiable digital assets for my users.
```

**Story 3:** Batch Inscriptions
```
As a developer working with multiple assets,
I want to batch inscribe multiple Ordinals in a single commit,
So that I can save on transaction fees and improve efficiency.
```

**Story 4:** Safe UTXO Selection
```
As a developer managing a wallet with inscriptions,
I want the SDK to never use inscription-bearing UTXOs as inputs,
So that I don't accidentally destroy existing inscriptions.
```

**Story 5:** Transaction Tracking
```
As a developer waiting for inscription confirmation,
I want to track transaction status and confirmations,
So that I know when my inscription is finalized on-chain.
```

---

## Functional Requirements

### 1. Commit Transaction Logic

**FR-1.1:** The SDK MUST implement commit transaction creation using the logic from `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/commit-transaction.ts`

**FR-1.2:** Commit transactions MUST create a P2TR (Pay-to-Taproot) output that encodes the reveal script

**FR-1.3:** Commit transactions MUST calculate accurate fees based on:
- Number of inputs
- Number of outputs (recipient + change)
- Fee rate (sat/vB)
- Inscription data size

**FR-1.4:** The system MUST return commit transaction details including:
- PSBT (Partially Signed Bitcoin Transaction)
- Reveal address (P2TR address for next step)
- Total fees (commit + estimated reveal)
- Change amount

### 2. Reveal Transaction Logic

**FR-2.1:** The SDK MUST implement reveal transaction creation using the logic from `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/reveal-transaction.ts`

**FR-2.2:** Reveal transactions MUST properly encode inscription data in the witness script

**FR-2.3:** Reveal transactions MUST use the commit transaction output as input

**FR-2.4:** The system MUST support inscription content types:
- Text (text/plain, text/html)
- JSON (application/json)
- Images (image/png, image/jpeg, image/svg+xml)
- Binary data (application/octet-stream)

**FR-2.5:** Reveal transactions MUST target specific satoshis when specified

### 3. UTXO Selection

**FR-3.1:** The SDK MUST implement resource-aware UTXO selection from `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/utxo-selection.ts`

**FR-3.2:** UTXO selection MUST support multiple strategies:
- `minimize_change` - Minimize change output
- `minimize_inputs` - Use fewest inputs possible
- `optimize_size` - Balance between change and input count

**FR-3.3:** UTXO selection MUST tag UTXOs as resource-bearing or regular

**FR-3.4:** The system MUST NEVER use inscription-bearing UTXOs as transaction inputs (unless explicitly allowed)

**FR-3.5:** UTXO selection MUST respect locked UTXOs (configurable)

**FR-3.6:** The system MUST handle dust outputs properly:
- If change < 546 sats, add to fee instead of creating dust output
- Ensure all outputs meet minimum dust threshold

**FR-3.7:** UTXO selection MUST calculate accurate transaction fees including:
- Input count × bytes per input
- Output count × bytes per output
- Base transaction overhead
- Fee rate in sat/vB

### 4. Transaction Broadcasting

**FR-4.1:** The SDK MUST implement transaction broadcasting with retry logic from `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/transaction-broadcasting.ts`

**FR-4.2:** Broadcasting MUST support multiple retry attempts (configurable, default: 3)

**FR-4.3:** Broadcasting MUST implement exponential backoff between retries:
- Retry 1: immediate
- Retry 2: 2 seconds
- Retry 3: 4 seconds

**FR-4.4:** Broadcasting errors MUST be categorized:
- Temporary (retry): Network errors, timeouts
- Permanent (fail): Invalid transaction, double-spend

**FR-4.5:** The system MUST return broadcast result including:
- Transaction ID (txid)
- Success/failure status
- Error message if failed
- Retry count

### 5. Transaction Confirmation Tracking

**FR-5.1:** The SDK MUST implement confirmation tracking from `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/transaction-confirmation.ts`

**FR-5.2:** Tracking MUST poll for transaction status at configurable intervals (default: 10 seconds)

**FR-5.3:** Tracking MUST stop when:
- Transaction reaches target confirmations (default: 1)
- Maximum polling time exceeded (default: 30 minutes)
- Transaction fails/is rejected

**FR-5.4:** The system MUST emit events for:
- Transaction seen in mempool
- First confirmation
- Target confirmations reached
- Transaction failed

**FR-5.5:** Tracking MUST return final status including:
- Confirmation count
- Block height
- Block hash
- Timestamp

### 6. Fee Estimation

**FR-6.1:** The SDK MUST implement fee calculation from `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/fee-calculation.ts`

**FR-6.2:** Fee estimation MUST support:
- Dynamic fee rates (from oracle or manual)
- Custom bytes per input (default: 148 for P2WPKH)
- Custom bytes per output (default: 34)
- Base transaction bytes (default: 10)

**FR-6.3:** The system MUST calculate total inscription cost:
- Commit transaction fee
- Reveal transaction fee
- Total fee in satoshis
- Fee rate in sat/vB

### 7. Multi-Inscription Support (Batch)

**FR-7.1:** The SDK MUST support multi-inscription in a single commit from `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/multi-inscription-commit-transaction.ts`

**FR-7.2:** Batch inscriptions MUST share commit transaction overhead

**FR-7.3:** Each inscription in batch MUST have individual reveal transaction

**FR-7.4:** The system MUST calculate fee split proportionally by inscription size

### 8. Integration with Existing SDK

**FR-8.1:** The `BitcoinManager` class MUST be updated to use new transaction logic

**FR-8.2:** The `inscribeData()` method MUST:
- Create commit transaction
- Broadcast commit transaction
- Wait for commit confirmation
- Create reveal transaction
- Broadcast reveal transaction
- Track reveal confirmation
- Return inscription result

**FR-8.3:** Existing method signatures MUST remain backward compatible:
```typescript
async inscribeData(
  data: Buffer, 
  contentType: string, 
  feeRate?: number
): Promise<OrdinalsInscription>
```

**FR-8.4:** The system MUST support both signet and mainnet networks

**FR-8.5:** Network configuration MUST come from `OriginalsConfig.network`

### 9. Error Handling

**FR-9.1:** All transaction operations MUST use structured errors with codes:
- `UTXO_INSUFFICIENT_FUNDS`
- `UTXO_DUST_OUTPUT`
- `TX_BROADCAST_FAILED`
- `TX_CONFIRMATION_TIMEOUT`
- `FEE_ESTIMATION_FAILED`

**FR-9.2:** Errors MUST include actionable messages for developers

**FR-9.3:** The system MUST log all transaction operations for debugging

---

## Non-Goals (Out of Scope)

### Explicitly NOT Included in This PRD:

❌ **Indexer Infrastructure** - Keep in legacy as separate service, do not port to SDK

❌ **Explorer App Code** - Keep as reference only, do not port to SDK

❌ **Advanced VC Features** - Selective disclosure (BBS+) not needed for transaction porting

❌ **VC v1.x Full Support** - Focus on transaction logic first, VC improvements separate PRD

❌ **JWE Encryption** - Not needed for basic inscription functionality

❌ **Transaction Status Tracker** - Advanced status tracking can be follow-up PRD

❌ **Satpoint-Specific Inscription** - `inscribe-with-satpoint.ts` is advanced feature, defer

❌ **Resource Creation Helpers** - `resource-creation.ts` is helper, not core requirement

❌ **API Changes** - Do not change existing `BitcoinManager` API surface unless absolutely necessary

❌ **New Dependencies** - Use existing dependencies where possible, minimize additions

❌ **Rewrite/Refactor** - Direct port, not rewrite. Preserve working logic.

---

## Technical Considerations

### Source Files to Port (Priority Order)

**Phase 1 - Core Transaction Logic (Week 1-2):**
1. `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/utxo-selection.ts` (~315 lines)
   - **Destination:** `src/bitcoin/utxo-selection.ts`
   - **Changes needed:** Minimal - adapt to SDK types

2. `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/fee-calculation.ts` (~80 lines)
   - **Destination:** `src/bitcoin/fee-calculation.ts`
   - **Changes needed:** None - pure logic

3. `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/commit-transaction.ts` (~400 lines of core logic)
   - **Destination:** `src/bitcoin/transactions/commit.ts`
   - **Changes needed:** Adapt to SDK's OrdinalsClient, remove ordinalsplus-specific types

4. `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/reveal-transaction.ts` (~600 lines of core logic)
   - **Destination:** `src/bitcoin/transactions/reveal.ts`
   - **Changes needed:** Adapt to SDK types, remove ordinalsplus dependencies

**Phase 2 - Broadcasting & Confirmation (Week 2-3):**
5. `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/transaction-broadcasting.ts` (~300 lines core)
   - **Destination:** `src/bitcoin/broadcasting.ts`
   - **Changes needed:** Adapt to SDK's OrdinalsClient

6. `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/transaction-confirmation.ts` (~250 lines core)
   - **Destination:** `src/bitcoin/confirmation.ts`
   - **Changes needed:** Integrate with SDK event system

**Phase 3 - Integration & Batch (Week 3-4):**
7. `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/multi-inscription-commit-transaction.ts` (~200 lines core)
   - **Destination:** `src/bitcoin/transactions/batch-commit.ts`
   - **Changes needed:** Integrate with existing BatchOperations

8. Update `src/bitcoin/BitcoinManager.ts` - Wire everything together

### Dependencies

**Current SDK Dependencies (Already Available):**
- `bitcoinjs-lib` - Bitcoin transaction construction ✅
- `@noble/secp256k1` - Cryptography ✅
- `@scure/base` - Base encoding ✅

**May Need to Add:**
- `@bitcoinerlab/secp256k1` - For taproot operations (check if already covered)
- `tiny-secp256k1` - Bitcoin signature operations (check if already covered)

**Check Legacy Dependencies:**
Review `legacy/ordinalsplus/package.json` for any critical dependencies not in current SDK

### Type Compatibility

**Legacy Types to Port:**
- `ResourceUtxo` (with `hasResource` flag)
- `UtxoSelectionOptions`
- `CommitTransactionParams`
- `RevealTransactionParams`
- `InscriptionResult`

**Destination:** `src/types/bitcoin.ts` (already exists, extend it)

### Network Configuration

**Support Required:**
- Mainnet (`did:btco:`)
- Testnet (`did:btco:test:`) - Optional
- Signet (`did:btco:sig:`)

**Configuration Source:** `OriginalsConfig.network`

**Ord Node URLs:**
- Mainnet: `MAINNET_ORD_NODE_URL` env var
- Signet: `SIGNET_ORD_NODE_URL` env var

### Testing Strategy

**Unit Tests Required:**
1. UTXO selection algorithm tests
   - Test minimize_change strategy
   - Test minimize_inputs strategy
   - Test resource-aware selection (never use inscription UTXOs)
   - Test dust handling
   - Test locked UTXO handling

2. Fee calculation tests
   - Test various input/output combinations
   - Test different fee rates
   - Test edge cases (dust, single output)

3. Commit transaction tests
   - Test P2TR address generation
   - Test fee calculation
   - Test PSBT construction

4. Reveal transaction tests
   - Test inscription encoding
   - Test various content types
   - Test satoshi targeting

**Integration Tests Required:**
1. End-to-end inscription on signet
   - Create commit tx
   - Broadcast commit
   - Wait for confirmation
   - Create reveal tx
   - Broadcast reveal
   - Verify inscription

2. Batch inscription test on signet

**Manual Testing Required:**
1. Inscription on mainnet (small test inscription)
2. Verify inscription appears in explorers (ordiscan.com, ordinals.com)

### Migration Path

**Backward Compatibility:**
- Existing `BitcoinManager.inscribeData()` API MUST work unchanged
- Existing tests MUST pass
- New features are internal implementation details

**Feature Flag (Optional):**
```typescript
// In OriginalsConfig
interface OriginalsConfig {
  useLegacyTransactionLogic?: boolean; // Default: false (use new)
}
```

This allows gradual rollout and rollback if issues found.

---

## Success Metrics

### Primary Success Criteria

✅ **Working Inscriptions on Signet**
- At least 5 successful test inscriptions on signet
- Verified in ordinals explorer
- No inscription loss or destruction

✅ **Working Inscriptions on Mainnet**  
- At least 1 successful test inscription on mainnet
- Verified in ordinals explorer
- No funds lost

✅ **UTXO Protection**
- Zero instances of accidentally spending inscription-bearing UTXOs
- All tests pass for resource-aware selection

✅ **Test Coverage**
- Unit tests: 90%+ coverage for new transaction code
- Integration tests: All critical paths covered
- No regression in existing tests

✅ **Performance**
- Commit transaction creation: <2 seconds
- Reveal transaction creation: <2 seconds
- UTXO selection: <1 second for 100 UTXOs

### Secondary Success Criteria

✅ **Batch Inscriptions**
- Successfully create multi-inscription commit
- Fee savings demonstrated (30%+ as per BatchOperations feature)

✅ **Documentation**
- Transaction flow documented
- Code comments for complex logic
- Migration notes from legacy

✅ **Error Handling**
- All error paths tested
- Meaningful error messages
- No uncaught exceptions

---

## Implementation Plan

### Week 1: Core Transaction Logic

**Days 1-2: Setup & UTXO Selection**
- [ ] Create directory structure: `src/bitcoin/transactions/`
- [ ] Port `utxo-selection.ts` with minimal changes
- [ ] Port `fee-calculation.ts`
- [ ] Write unit tests for UTXO selection
- [ ] Write unit tests for fee calculation

**Days 3-5: Commit Transaction**
- [ ] Port `commit-transaction.ts`
- [ ] Adapt types to SDK conventions
- [ ] Integrate with existing `PSBTBuilder`
- [ ] Write unit tests for commit logic
- [ ] Test commit transaction creation (not broadcasting yet)

### Week 2: Reveal & Broadcasting

**Days 6-7: Reveal Transaction**
- [ ] Port `reveal-transaction.ts`
- [ ] Handle inscription encoding for various content types
- [ ] Write unit tests for reveal logic
- [ ] Test reveal transaction creation

**Days 8-10: Broadcasting & Confirmation**
- [ ] Port `transaction-broadcasting.ts`
- [ ] Port `transaction-confirmation.ts`
- [ ] Integrate with SDK event system
- [ ] Write unit tests for broadcasting retry logic
- [ ] Write unit tests for confirmation tracking

### Week 3: Integration & Testing

**Days 11-12: Wire to BitcoinManager**
- [ ] Update `BitcoinManager.inscribeData()` to use new logic
- [ ] Ensure backward compatibility
- [ ] Add configuration options
- [ ] Update existing tests

**Days 13-14: Signet Testing**
- [ ] Configure signet environment
- [ ] Perform 5 test inscriptions
- [ ] Verify in explorer
- [ ] Debug any issues

**Day 15: Integration Tests**
- [ ] Write end-to-end inscription test
- [ ] Write batch inscription test
- [ ] Ensure all tests pass

### Week 4: Batch & Mainnet

**Days 16-17: Multi-Inscription**
- [ ] Port `multi-inscription-commit-transaction.ts`
- [ ] Integrate with existing `BatchOperations`
- [ ] Write unit tests
- [ ] Test batch on signet

**Days 18-19: Mainnet Preparation**
- [ ] Security review of transaction code
- [ ] Fee estimation validation
- [ ] Error handling review
- [ ] Documentation review

**Day 20: Mainnet Test**
- [ ] Perform 1 small test inscription on mainnet
- [ ] Verify in explorer
- [ ] Monitor for issues
- [ ] Document results

### Final Deliverables

**Code:**
- [ ] All source files ported and integrated
- [ ] 90%+ test coverage
- [ ] All tests passing
- [ ] No linter errors

**Documentation:**
- [ ] Transaction flow diagram
- [ ] Migration notes (what was ported, what changed)
- [ ] Usage examples for developers
- [ ] Known issues / limitations

**Testing:**
- [ ] Unit test suite
- [ ] Integration test suite
- [ ] Signet test results (5+ inscriptions)
- [ ] Mainnet test results (1+ inscription)

---

## Acceptance Criteria

This feature is considered **DONE** when:

1. ✅ A developer can call `sdk.bitcoin.inscribeData()` and successfully inscribe on signet
2. ✅ A developer can call `sdk.bitcoin.inscribeData()` and successfully inscribe on mainnet
3. ✅ The SDK automatically prevents spending inscription-bearing UTXOs
4. ✅ Batch inscriptions work via existing `BatchOperations` API
5. ✅ All tests pass (unit + integration)
6. ✅ Test coverage is 90%+ for transaction code
7. ✅ At least 5 successful signet inscriptions demonstrated
8. ✅ At least 1 successful mainnet inscription demonstrated
9. ✅ No regressions in existing SDK functionality
10. ✅ Documentation is complete and accurate

---

## Open Questions

### Questions for Engineering

**Q1:** Should we add a feature flag for gradual rollout?
- **Suggestion:** Yes - `useLegacyTransactionLogic` config option
- **Default:** false (use new code)
- **Allows:** Rollback if issues found in production

**Q2:** What's the priority order if we can't finish everything in 4 weeks?
- **Must Have:** commit, reveal, UTXO selection, broadcasting
- **Nice to Have:** confirmation tracking, batch support
- **Can Defer:** Advanced features, optimization

**Q3:** How should we handle environment variables for Ord node URLs?
- **Option A:** Same as legacy (`MAINNET_ORD_NODE_URL`, `SIGNET_ORD_NODE_URL`)
- **Option B:** New config in `OriginalsConfig`
- **Recommendation:** Option A for consistency with explorer

**Q4:** Should we vendor the legacy code or import it as a dependency?
- **Recommendation:** Direct port (copy files) because:
  - Legacy is not published as npm package
  - We want to adapt types to SDK conventions
  - We want full control over the code

**Q5:** What's the testing budget for mainnet inscriptions?
- Mainnet inscription costs ~$20-100 depending on fee rates
- Recommend budget for 3-5 test inscriptions (~$100-500)
- Can use small/cheap inscriptions (text only, minimal bytes)

### Questions for Product

**Q6:** After this is complete, what's next priority?
- Port Ordiscan provider for faster resolution?
- Port VC version-aware wrapper?
- Security audit of transaction code?

**Q7:** Is there a hard deadline for this feature?
- Blocks production launch?
- Needed for specific customer/partner?

---

## Risk Assessment

### High Risks

🔴 **Risk 1: Transaction Logic Complexity**
- **Probability:** Medium
- **Impact:** High
- **Mitigation:** 
  - Direct port (don't rewrite)
  - Extensive testing on signet before mainnet
  - Start with simple inscriptions, add complexity gradually

🔴 **Risk 2: Mainnet Inscription Failures**
- **Probability:** Low (code is proven)
- **Impact:** Very High (loss of funds, damaged reputation)
- **Mitigation:**
  - Thorough signet testing first (5+ inscriptions)
  - Small test inscription on mainnet
  - Manual review of every mainnet transaction before broadcast
  - Feature flag for rollback

🔴 **Risk 3: UTXO Selection Bug (Destroying Inscriptions)**
- **Probability:** Low (if port is accurate)
- **Impact:** Very High
- **Mitigation:**
  - 100% test coverage for UTXO selection
  - Explicit tests for "never use inscription UTXOs"
  - Code review focused on this specific risk
  - Integration tests with real inscription-bearing UTXOs

### Medium Risks

🟡 **Risk 4: Timeline Slip (4 weeks → 6 weeks)**
- **Probability:** Medium
- **Impact:** Medium
- **Mitigation:**
  - Clear scope definition (this PRD)
  - Daily standup progress checks
  - Defer nice-to-have features if needed
  - AI assistance for code porting

🟡 **Risk 5: Type Incompatibilities**
- **Probability:** Medium
- **Impact:** Low (just code changes)
- **Mitigation:**
  - Start with type definitions first
  - Use TypeScript strict mode
  - Port types alongside code

🟡 **Risk 6: Missing Dependencies**
- **Probability:** Low
- **Impact:** Medium
- **Mitigation:**
  - Review legacy package.json early
  - Test dependency compatibility
  - Have backup plans for any missing deps

### Low Risks

🟢 **Risk 7: Test Coverage Issues**
- **Probability:** Low
- **Impact:** Low
- **Mitigation:**
  - Write tests alongside porting
  - Use coverage tools continuously
  - Don't merge without 90% coverage

---

## Resources

### Legacy Code References

**Main Source:**
- `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/`
- `legacy/ordinalsplus/packages/ordinalsplus/src/types/`

**Documentation:**
- `legacy/index.md` - Migration guide
- `LEGACY_CODE_ANALYSIS.md` - Detailed analysis
- Legacy package README files

**Working Example:**
- Ordinalsplus explorer (uses this code in production)

### Existing SDK Code

**Current Transaction Code:**
- `src/bitcoin/BitcoinManager.ts` - High-level API
- `src/bitcoin/PSBTBuilder.ts` - PSBT construction
- `src/bitcoin/utxo.ts` - Current UTXO selection
- `src/types/bitcoin.ts` - Bitcoin types

**Integration Points:**
- `src/lifecycle/LifecycleManager.ts` - Calls BitcoinManager
- `src/lifecycle/BatchOperations.ts` - Batch inscription

### External Resources

**Bitcoin Ordinals:**
- Ordinals Theory: https://docs.ordinals.com/
- BIP-340 (Schnorr): https://github.com/bitcoin/bips/blob/master/bip-0340.mediawiki
- BIP-341 (Taproot): https://github.com/bitcoin/bips/blob/master/bip-0341.mediawiki

**Testing:**
- Signet faucet: https://signetfaucet.com/
- Ordinals explorer (signet): https://signet.ordinals.com/
- Ordinals explorer (mainnet): https://ordinals.com/

---

## Appendix: Code Port Checklist

### For Each File Ported:

- [ ] Copy source file from legacy
- [ ] Update imports to SDK paths
- [ ] Adapt types to SDK conventions
- [ ] Remove ordinalsplus-specific dependencies
- [ ] Add SDK-style JSDoc comments
- [ ] Write unit tests (90%+ coverage)
- [ ] Run linter and fix issues
- [ ] Code review focused on:
  - UTXO safety (never spend inscriptions)
  - Fee calculation accuracy
  - Error handling completeness
  - Type safety

### Integration Checklist:

- [ ] Update `BitcoinManager` to use new code
- [ ] Ensure backward compatibility
- [ ] Update integration tests
- [ ] Test on signet (5+ inscriptions)
- [ ] Test on mainnet (1+ inscription)
- [ ] Update documentation
- [ ] Add migration notes

---

## Success Definition

**This PRD is SUCCESSFUL when:**

A developer can run this code and successfully inscribe an Ordinal on Bitcoin mainnet:

```typescript
import { OriginalsSDK } from '@originals/sdk';

const sdk = OriginalsSDK.create({
  network: 'mainnet',
  ordinalsProvider: new OrdinalsClient({
    network: 'mainnet',
    apiUrl: process.env.MAINNET_ORD_NODE_URL,
    walletPrivateKey: process.env.BITCOIN_PRIVATE_KEY
  })
});

const inscription = await sdk.bitcoin.inscribeData(
  Buffer.from('Hello, Ordinals!'),
  'text/plain',
  10 // 10 sat/vB
);

console.log('Inscription ID:', inscription.inscriptionId);
console.log('Transaction ID:', inscription.txid);
console.log('Satoshi:', inscription.satoshi);
// Verified at: https://ordinals.com/inscription/{inscriptionId}
```

**And the inscription appears correctly in the Ordinals explorer.**

---

**END OF PRD**

*Next Steps: Review this PRD, get approval, then begin implementation in Week 1.*

