# Task List: Port Bitcoin Transaction Infrastructure

**PRD:** [prd-port-bitcoin-transaction-infrastructure.md](./prd-port-bitcoin-transaction-infrastructure.md)  
**Status:** 🟡 In Progress  
**Started:** October 14, 2025  
**Target Completion:** November 11, 2025 (4 weeks)

## 📊 Current Status

**Last Updated:** October 14, 2025  
**Completed:** 2/42 parent tasks (5% complete)  
**Current Task:** Task 1.3: Port Fee Calculation  
**Blocked:** No  

**Quick Verification:**
- Build status: ✅ Passing
- Tests status: All existing tests passing
- Coverage: 96.86%

---

## 📊 Task Breakdown

| Week | Parent Tasks | Sub-tasks | Estimated Hours |
|------|--------------|-----------|-----------------|
| **Week 1** | 9 | 57 | 60-80 hours |
| **Week 2** | 10 | 48 | 60-80 hours |
| **Week 3** | 10 | 36 | 50-70 hours |
| **Week 4** | 13 | 41 | 60-80 hours |
| **Total** | **42** | **182** | **230-310 hours** |

**Average per sub-task:** 15-30 minutes  
**Progress:** 0/42 parent tasks, 0/182 sub-tasks complete

### 🎯 How to Use This List

**Enhanced Granularity:**
- Parent tasks (e.g., **Task 1.2**) are high-level objectives
- Sub-tasks (e.g., **1.2a, 1.2b**) are specific implementation steps
- Leaf tasks (indented checkboxes) are atomic actions (~15-30 min each)

**Example Structure:**
```
- [ ] **Task 1.2: Port UTXO Selection** ← Parent (stop here for approval)
  - [ ] **1.2a: Copy Source File** ← Sub-task group
    - [ ] Copy file ← Atomic action
    - [ ] Remove imports ← Atomic action
    - [ ] Comment out code ← Atomic action
```

**Completion Protocol:**
1. Complete atomic action → mark `[x]`
2. All actions in sub-task done → mark sub-task `[x]`
3. All sub-tasks in parent done → mark parent `[x]` and ⏸️ **PAUSE**

---

## Week 1: Core Transaction Logic

### Days 1-2: Setup & UTXO Selection
- [x] **Task 1.1: Create Directory Structure**
  - [x] Run `mkdir -p src/bitcoin/transactions`
  - [x] Create `src/bitcoin/transactions/index.ts` with empty export
  - [x] Add export line to `src/bitcoin/index.ts`: `export * from './transactions'` (not needed - exports via main index)
  - [x] Run `bun run build` to verify structure compiles
  - [x] Commit changes with message "chore: create transactions directory structure"

- [x] **Task 1.2: Port UTXO Selection**
  - [x] **1.2a: Copy Source File**
    - [x] Copy `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/utxo-selection.ts` to `src/bitcoin/utxo-selection.ts`
    - [x] Remove all imports from ordinalsplus packages
    - [x] Comment out all function bodies temporarily (to see what types are needed)
  - [x] **1.2b: Add Required Types**
    - [x] Open `src/types/bitcoin.ts`
    - [x] Add `ResourceUtxo` interface extending `Utxo` with `hasResource?: boolean`
    - [x] Add `UtxoSelectionStrategy` type: `'minimize_change' | 'minimize_inputs' | 'optimize_size'`
    - [x] Add `SimpleUtxoSelectionOptions` interface
    - [x] Add `SimpleUtxoSelectionResult` interface
    - [x] Add `ResourceUtxoSelectionOptions` interface
    - [x] Add `ResourceUtxoSelectionResult` interface
    - [x] Export all new types from `src/types/index.ts` (already exported via bitcoin.ts)
  - [x] **1.2c: Update Imports**
    - [x] Import `Utxo`, `DUST_LIMIT_SATS` from `../types`
    - [x] Import all new types from `../types/bitcoin`
    - [x] Remove any ordinalsplus-specific imports
    - [x] Uncomment function bodies
  - [x] **1.2d: Fix Type References**
    - [x] Replace any `ordinalsplus.Type` with SDK types
    - [x] Update function signatures to use SDK types
    - [x] Fix any type errors shown by TypeScript
  - [x] **1.2e: Verify Compilation**
    - [x] Run `bun run build` and check for errors in utxo-selection.ts
    - [x] Fix any remaining compilation errors
    - [x] Export functions from `src/index.ts`

- [ ] **Task 1.3: Port Fee Calculation**
  - [ ] **1.3a: Copy and Clean**
    - [ ] Copy `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/fee-calculation.ts` to `src/bitcoin/fee-calculation.ts`
    - [ ] Remove ordinalsplus imports
    - [ ] Check if any new types are needed in `src/types/bitcoin.ts`
  - [ ] **1.3b: Update and Verify**
    - [ ] Update imports to use SDK types
    - [ ] Run `bun run build` to check compilation
    - [ ] Export from `src/bitcoin/index.ts`

- [ ] **Task 1.4: Write UTXO Selection Tests**
  - [ ] **1.4a: Test Setup**
    - [ ] Run `mkdir -p tests/unit/bitcoin`
    - [ ] Create `tests/unit/bitcoin/utxo-selection.test.ts`
    - [ ] Add imports: `selectUtxos`, `selectResourceUtxos`, test utilities
    - [ ] Create mock UTXO fixtures (regular and inscription-bearing)
  - [ ] **1.4b: Strategy Tests**
    - [ ] Write test: "minimize_change strategy selects optimal UTXOs"
    - [ ] Write test: "minimize_inputs strategy uses fewest UTXOs"
    - [ ] Write test: "optimize_size strategy balances inputs and change"
  - [ ] **1.4c: Safety Tests**
    - [ ] Write test: "NEVER selects inscription-bearing UTXOs (hasResource=true)"
    - [ ] Write test: "respects locked UTXO flag when allowLocked=false"
    - [ ] Write test: "can use locked UTXOs when allowLocked=true"
  - [ ] **1.4d: Edge Case Tests**
    - [ ] Write test: "handles dust by adding to fee instead of creating dust output"
    - [ ] Write test: "throws INSUFFICIENT_FUNDS when not enough UTXOs"
    - [ ] Write test: "handles empty UTXO array gracefully"
  - [ ] **1.4e: Coverage Check**
    - [ ] Run `bun test tests/unit/bitcoin/utxo-selection.test.ts --coverage`
    - [ ] Check coverage report for utxo-selection.ts
    - [ ] Add tests for any uncovered branches (target 90%+)

- [ ] **Task 1.5: Write Fee Calculation Tests**
  - [ ] **1.5a: Test Setup**
    - [ ] Create `tests/unit/bitcoin/fee-calculation.test.ts`
    - [ ] Import fee calculation functions
    - [ ] Set up test fixtures for various tx sizes
  - [ ] **1.5b: Basic Fee Tests**
    - [ ] Write test: "calculates fee for 1 input, 2 outputs"
    - [ ] Write test: "calculates fee for 3 inputs, 1 output"
    - [ ] Write test: "fee scales linearly with fee rate"
  - [ ] **1.5c: Edge Cases**
    - [ ] Write test: "handles zero fee rate (throws or returns 0)"
    - [ ] Write test: "handles large input/output counts"
    - [ ] Write test: "rounds up fractional satoshis"
  - [ ] **1.5d: Coverage Check**
    - [ ] Run `bun test tests/unit/bitcoin/fee-calculation.test.ts --coverage`
    - [ ] Verify 90%+ coverage for fee-calculation.ts

### Days 3-5: Commit Transaction
- [ ] **Task 1.6: Port Commit Transaction**
  - [ ] **1.6a: Initial Copy**
    - [ ] Copy `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/commit-transaction.ts` to `src/bitcoin/transactions/commit.ts`
    - [ ] Read through the file to identify core logic vs ordinalsplus-specific code
    - [ ] Add comments marking sections to keep vs remove
  - [ ] **1.6b: Extract Core Logic**
    - [ ] Remove ordinalsplus provider calls (replace with OrdinalsClient calls)
    - [ ] Remove ordinalsplus-specific type imports
    - [ ] Identify what types need to be created in SDK
    - [ ] Keep: P2TR address generation, fee calculation, PSBT construction
  - [ ] **1.6c: Define Types** (see Task 1.7)
  - [ ] **1.6d: Update Imports**
    - [ ] Import `PSBTBuilder` from `../PSBTBuilder`
    - [ ] Import `selectUtxos` from `../utxo-selection`
    - [ ] Import `estimateTransactionSize` from `../fee-calculation`
    - [ ] Import types from `../../types/bitcoin`
  - [ ] **1.6e: Integrate with PSBTBuilder**
    - [ ] Review existing `PSBTBuilder` class
    - [ ] Use PSBTBuilder where appropriate or extend if needed
    - [ ] Ensure P2TR outputs are correctly created
  - [ ] **1.6f: Verify Compilation**
    - [ ] Run `bun run build` and fix type errors
    - [ ] Export `createCommitTransaction` from `src/bitcoin/transactions/index.ts`
    - [ ] Export from `src/bitcoin/index.ts`

- [ ] **Task 1.7: Add Commit Types to bitcoin.ts**
  - [ ] **1.7a: Define CommitTransactionParams**
    - [ ] Add interface with fields: `utxos`, `feeRate`, `inscriptionData`, `changeAddress`, `network`
    - [ ] Add JSDoc comments explaining each field
  - [ ] **1.7b: Define CommitTransactionResult**
    - [ ] Add interface with fields: `psbt`, `revealAddress`, `fee`, `changeAmount`
    - [ ] Add JSDoc comments
  - [ ] **1.7c: Define Supporting Types**
    - [ ] Add `P2TRAddress` type if needed
    - [ ] Add `RevealScriptData` type if needed
    - [ ] Add `CommitTransactionFee` breakdown type
  - [ ] **1.7d: Export Types**
    - [ ] Export all new interfaces from `src/types/bitcoin.ts`
    - [ ] Export from `src/types/index.ts`

- [ ] **Task 1.8: Write Commit Transaction Tests**
  - [ ] **1.8a: Test Setup**
    - [ ] Run `mkdir -p tests/unit/bitcoin/transactions`
    - [ ] Create `tests/unit/bitcoin/transactions/commit.test.ts`
    - [ ] Import `createCommitTransaction` and types
    - [ ] Create mock UTXO fixtures
    - [ ] Create mock inscription data fixtures
  - [ ] **1.8b: Address Generation Tests**
    - [ ] Write test: "generates valid P2TR reveal address"
    - [ ] Write test: "P2TR address matches expected format for network"
    - [ ] Write test: "generates different addresses for different inscription data"
  - [ ] **1.8c: Fee Calculation Tests**
    - [ ] Write test: "calculates correct fee for 1 input commit"
    - [ ] Write test: "calculates correct fee for multiple inputs"
    - [ ] Write test: "fee increases with inscription size"
    - [ ] Write test: "respects custom fee rate parameter"
  - [ ] **1.8d: PSBT Construction Tests**
    - [ ] Write test: "PSBT has correct number of inputs"
    - [ ] Write test: "PSBT has correct outputs (reveal + change if needed)"
    - [ ] Write test: "PSBT input values match selected UTXOs"
    - [ ] Write test: "change output created when needed"
    - [ ] Write test: "no change output when would be dust"
  - [ ] **1.8e: Inscription Size Tests**
    - [ ] Write test: "handles small inscription (100 bytes)"
    - [ ] Write test: "handles medium inscription (1KB)"
    - [ ] Write test: "handles large inscription (10KB)"
  - [ ] **1.8f: Coverage Check**
    - [ ] Run `bun test tests/unit/bitcoin/transactions/commit.test.ts --coverage`
    - [ ] Verify 90%+ coverage for commit.ts

- [ ] **Task 1.9: Manual Commit Test (No Broadcast)**
  - [ ] **1.9a: Create Test Script**
    - [ ] Run `mkdir -p tests/manual`
    - [ ] Create `tests/manual/test-commit-creation.ts`
    - [ ] Import commit transaction functions
    - [ ] Set up with test data (not real keys)
  - [ ] **1.9b: Generate Commit TX**
    - [ ] Create test inscription data (simple "Hello" text)
    - [ ] Generate mock UTXOs
    - [ ] Call `createCommitTransaction()`
    - [ ] Log PSBT hex to console
  - [ ] **1.9c: Manual Verification**
    - [ ] Decode PSBT using bitcoinjs-lib
    - [ ] Verify input count matches expected
    - [ ] Verify output count (reveal + optional change)
    - [ ] Verify P2TR output is at index 0
    - [ ] Log verification results
  - [ ] **1.9d: Document**
    - [ ] Add comments explaining what each part does
    - [ ] Document expected output in script header
    - [ ] Add to README section about manual testing

---

## Week 2: Reveal & Broadcasting

### Days 6-7: Reveal Transaction
- [ ] **Task 2.1: Port Reveal Transaction**
  - [ ] **2.1a: Initial Copy**
    - [ ] Copy `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/reveal-transaction.ts` to `src/bitcoin/transactions/reveal.ts`
    - [ ] Identify core reveal logic (inscription encoding, witness script, PSBT)
    - [ ] Mark ordinalsplus-specific sections for removal
  - [ ] **2.1b: Extract Core Logic**
    - [ ] Keep: Inscription witness script generation
    - [ ] Keep: Content encoding (text, JSON, binary)
    - [ ] Keep: P2TR input spending logic
    - [ ] Remove: ordinalsplus provider dependencies
    - [ ] Remove: ordinalsplus-specific error types
  - [ ] **2.1c: Update Imports**
    - [ ] Import from `bitcoinjs-lib` (Psbt, script, etc.)
    - [ ] Import types from `../../types/bitcoin`
    - [ ] Import `PSBTBuilder` if needed
    - [ ] Remove all ordinalsplus imports
  - [ ] **2.1d: Verify Compilation**
    - [ ] Run `bun run build` and fix type errors
    - [ ] Export `createRevealTransaction` from `src/bitcoin/transactions/index.ts`

- [ ] **Task 2.2: Add Reveal Types to bitcoin.ts**
  - [ ] Add `RevealTransactionParams` interface (fields: `commitTxId`, `commitVout`, `inscriptionData`, `revealAddress`, `feeRate`, `network`)
  - [ ] Add `RevealTransactionResult` interface (fields: `psbt`, `fee`, `inscriptionSize`)
  - [ ] Add `InscriptionData` interface (fields: `content`, `contentType`, `metadata?`)
  - [ ] Export all from `src/types/index.ts`

- [ ] **Task 2.3: Handle Inscription Encoding**
  - [ ] **2.3a: Text Content**
    - [ ] Test `text/plain` encoding (UTF-8)
    - [ ] Test `text/html` encoding
    - [ ] Verify witness script structure for text
  - [ ] **2.3b: JSON Content**
    - [ ] Test `application/json` encoding
    - [ ] Verify JSON is stringified correctly
  - [ ] **2.3c: Image Content**
    - [ ] Test `image/png` encoding (binary)
    - [ ] Test `image/jpeg` encoding (binary)
    - [ ] Test `image/svg+xml` encoding (text)
  - [ ] **2.3d: Binary Content**
    - [ ] Test `application/octet-stream` encoding
    - [ ] Verify Buffer handling

- [ ] **Task 2.4: Write Reveal Transaction Tests**
  - [ ] **2.4a: Test Setup**
    - [ ] Create `tests/unit/bitcoin/transactions/reveal.test.ts`
    - [ ] Import `createRevealTransaction` and types
    - [ ] Create mock commit transaction data
    - [ ] Create fixtures for different content types
  - [ ] **2.4b: Content Encoding Tests**
    - [ ] Write test: "encodes text/plain correctly"
    - [ ] Write test: "encodes application/json with valid JSON"
    - [ ] Write test: "encodes image/png as binary"
    - [ ] Write test: "handles empty content gracefully"
  - [ ] **2.4c: PSBT Tests**
    - [ ] Write test: "creates PSBT with commit output as input"
    - [ ] Write test: "includes inscription in witness script"
    - [ ] Write test: "calculates correct reveal fees"
  - [ ] **2.4d: Satoshi Targeting**
    - [ ] Write test: "targets specific satoshi when provided"
    - [ ] Write test: "uses default satoshi when not specified"
  - [ ] **2.4e: Coverage**
    - [ ] Run coverage and verify 90%+ for reveal.ts

### Days 8-10: Broadcasting & Confirmation
- [ ] **Task 2.5: Port Transaction Broadcasting**
  - [ ] Copy `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/transaction-broadcasting.ts` to `src/bitcoin/broadcasting.ts`
  - [ ] Extract core broadcasting logic
  - [ ] Update imports to use SDK's `OrdinalsClient`
  - [ ] Implement retry logic with exponential backoff
  - [ ] Adapt types: `BroadcastOptions`, `BroadcastResult`
  - [ ] Test that file compiles without errors

- [ ] **Task 2.6: Port Transaction Confirmation**
  - [ ] Copy `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/transaction-confirmation.ts` to `src/bitcoin/confirmation.ts`
  - [ ] Extract core confirmation tracking logic
  - [ ] Integrate with SDK event system (`EventEmitter`)
  - [ ] Implement polling logic with configurable intervals
  - [ ] Adapt types: `ConfirmationOptions`, `ConfirmationResult`
  - [ ] Test that file compiles without errors

- [ ] **Task 2.7: Add Broadcasting Types**
  - [ ] Add `BroadcastOptions` interface to `src/types/bitcoin.ts`
  - [ ] Add `BroadcastResult` interface
  - [ ] Add `BroadcastError` class/type
  - [ ] Export from `src/types/index.ts`

- [ ] **Task 2.8: Add Confirmation Types**
  - [ ] Add `ConfirmationOptions` interface to `src/types/bitcoin.ts`
  - [ ] Add `ConfirmationResult` interface
  - [ ] Add `ConfirmationStatus` enum
  - [ ] Export from `src/types/index.ts`

- [ ] **Task 2.9: Write Broadcasting Tests**
  - [ ] Create `tests/unit/bitcoin/broadcasting.test.ts`
  - [ ] Test retry logic (3 attempts with exponential backoff)
  - [ ] Test permanent error handling (don't retry)
  - [ ] Test temporary error handling (do retry)
  - [ ] Test successful broadcast
  - [ ] Verify 90%+ coverage for broadcasting.ts

- [ ] **Task 2.10: Write Confirmation Tests**
  - [ ] Create `tests/unit/bitcoin/confirmation.test.ts`
  - [ ] Test polling logic
  - [ ] Test confirmation threshold reached
  - [ ] Test timeout handling
  - [ ] Test event emission
  - [ ] Verify 90%+ coverage for confirmation.ts

---

## Week 3: Integration & Testing

### Days 11-12: Wire to BitcoinManager
- [ ] **Task 3.1: Update BitcoinManager.inscribeData()**
  - [ ] **3.1a: Add Imports**
    - [ ] Import `{ selectUtxos }` from `./utxo-selection`
    - [ ] Import `{ createCommitTransaction }` from `./transactions/commit`
    - [ ] Import `{ createRevealTransaction }` from `./transactions/reveal`
    - [ ] Import `{ broadcastTransaction }` from `./broadcasting`
    - [ ] Import `{ trackConfirmation }` from `./confirmation`
  - [ ] **3.1b: Get Wallet UTXOs**
    - [ ] Call `this.ord.getUtxos()` to get available UTXOs
    - [ ] Tag UTXOs as resource-bearing if needed (check for inscriptions)
    - [ ] Validate at least one UTXO available
  - [ ] **3.1c: Select UTXOs**
    - [ ] Calculate target amount (dust + fees estimate)
    - [ ] Call `selectUtxos()` with resource-aware options
    - [ ] Verify sufficient funds selected
  - [ ] **3.1d: Create Commit Transaction**
    - [ ] Prepare commit params (UTXOs, fee rate, inscription data)
    - [ ] Call `createCommitTransaction(params)`
    - [ ] Log commit details (fee, reveal address)
  - [ ] **3.1e: Broadcast Commit**
    - [ ] Sign commit PSBT using wallet
    - [ ] Call `broadcastTransaction(signedPsbt)`
    - [ ] Log commit txid
  - [ ] **3.1f: Wait for Commit Confirmation**
    - [ ] Call `trackConfirmation(commitTxId, { blocks: 1 })`
    - [ ] Wait for promise resolution
    - [ ] Log confirmation details
  - [ ] **3.1g: Create Reveal Transaction**
    - [ ] Prepare reveal params (commit txid, vout, inscription, reveal address)
    - [ ] Call `createRevealTransaction(params)`
    - [ ] Log reveal details (fee, inscription size)
  - [ ] **3.1h: Broadcast Reveal**
    - [ ] Sign reveal PSBT
    - [ ] Call `broadcastTransaction(signedPsbt)`
    - [ ] Log reveal txid
  - [ ] **3.1i: Track Reveal Confirmation**
    - [ ] Call `trackConfirmation(revealTxId, { blocks: 1 })`
    - [ ] Extract inscription ID from result
    - [ ] Extract satoshi number from result
  - [ ] **3.1j: Return Result**
    - [ ] Build `OrdinalsInscription` result object
    - [ ] Include: inscriptionId, txid, satoshi, commitTxId, revealTxId, feeRate
    - [ ] Return result

- [ ] **Task 3.2: Ensure Backward Compatibility**
  - [ ] Verify `inscribeData()` signature unchanged
  - [ ] Verify existing tests still pass
  - [ ] Update tests if needed (but keep API same)

- [ ] **Task 3.3: Add Configuration Options**
  - [ ] Add `confirmationBlocks` to `OriginalsConfig` (default: 1)
  - [ ] Add `maxBroadcastRetries` to `OriginalsConfig` (default: 3)
  - [ ] Add `confirmationPollingInterval` to `OriginalsConfig` (default: 10000ms)
  - [ ] Document new config options

- [ ] **Task 3.4: Update Existing Tests**
  - [ ] Update `tests/unit/bitcoin/BitcoinManager.test.ts`
  - [ ] Mock new transaction functions
  - [ ] Ensure all existing tests pass
  - [ ] Add tests for new commit/reveal flow

### Days 13-14: Signet Testing
- [ ] **Task 3.5: Configure Signet Environment**
  - [ ] **3.5a: Signet Node Setup**
    - [ ] Option A: Use public signet ord API (mempool.space or similar)
    - [ ] Option B: Run local signet ord node
    - [ ] Set `SIGNET_ORD_NODE_URL` in `.env` file
  - [ ] **3.5b: Get Test Coins**
    - [ ] Visit https://signetfaucet.com/
    - [ ] Generate signet wallet address
    - [ ] Request test coins (should receive ~0.01 signet BTC)
    - [ ] Wait for coins to arrive (check in explorer)
  - [ ] **3.5c: Configure SDK**
    - [ ] Create `.env.signet` file with signet config
    - [ ] Set `BITCOIN_NETWORK=signet`
    - [ ] Set wallet private key for signet
    - [ ] Test connection to ord node

- [ ] **Task 3.6: Perform Signet Inscriptions**
  - [ ] **3.6a: Create Test Script**
    - [ ] Create `tests/manual/signet-inscription-test.ts`
    - [ ] Set up SDK with signet config
    - [ ] Add logging for each step
  - [ ] **3.6b: Inscription #1 - Simple Text**
    - [ ] Prepare data: "Hello Ordinals - Test 1"
    - [ ] Call `sdk.bitcoin.inscribeData()`
    - [ ] Wait for completion
    - [ ] Log inscription ID, verify at https://signet.ordinals.com/
  - [ ] **3.6c: Inscription #2 - JSON**
    - [ ] Prepare JSON: `{ "test": 2, "type": "json" }`
    - [ ] Inscribe with content type `application/json`
    - [ ] Verify in explorer
  - [ ] **3.6d: Inscription #3 - Larger Text**
    - [ ] Prepare 1KB text file
    - [ ] Inscribe and verify fees scale with size
    - [ ] Verify in explorer
  - [ ] **3.6e: Inscription #4 - Custom Fee Rate**
    - [ ] Inscribe with fee rate of 5 sat/vB
    - [ ] Inscribe with fee rate of 50 sat/vB
    - [ ] Compare actual fees
  - [ ] **3.6f: Inscription #5 - Batch**
    - [ ] Create 2 small inscriptions
    - [ ] Use batch mode (singleTransaction: true)
    - [ ] Verify both inscriptions succeed
    - [ ] Calculate fee savings vs individual
  - [ ] **3.6g: Documentation**
    - [ ] Create table with all inscription IDs
    - [ ] Add explorer links for each
    - [ ] Document fees paid for each
    - [ ] Note any issues encountered

- [ ] **Task 3.7: Debug Any Signet Issues**
  - [ ] Review logs for any errors
  - [ ] Fix any issues found
  - [ ] Re-test failed inscriptions
  - [ ] Document solutions

### Day 15: Integration Tests
- [ ] **Task 3.8: Write End-to-End Inscription Test**
  - [ ] Create `tests/integration/bitcoin-inscription.test.ts`
  - [ ] Test complete inscription flow (commit → reveal)
  - [ ] Test with mocked Ord API
  - [ ] Test error handling (broadcast failure, confirmation timeout)
  - [ ] Verify test passes

- [ ] **Task 3.9: Write Batch Inscription Test**
  - [ ] Create `tests/integration/batch-inscription.test.ts`
  - [ ] Test batch inscription flow
  - [ ] Verify fee savings
  - [ ] Test with mocked Ord API
  - [ ] Verify test passes

- [ ] **Task 3.10: Ensure All Tests Pass**
  - [ ] Run `bun test tests/unit`
  - [ ] Run `bun test tests/integration`
  - [ ] Fix any failing tests
  - [ ] Verify 90%+ coverage overall

---

## Week 4: Batch & Mainnet

### Days 16-17: Multi-Inscription
- [ ] **Task 4.1: Port Multi-Inscription Commit**
  - [ ] Copy `legacy/ordinalsplus/packages/ordinalsplus/src/transactions/multi-inscription-commit-transaction.ts` to `src/bitcoin/transactions/batch-commit.ts`
  - [ ] Extract core batch commit logic
  - [ ] Update imports to use SDK types
  - [ ] Integrate with existing `BatchOperations` from `src/lifecycle/BatchOperations.ts`
  - [ ] Test that file compiles without errors

- [ ] **Task 4.2: Add Batch Types**
  - [ ] Add `BatchCommitParams` interface to `src/types/bitcoin.ts`
  - [ ] Add `BatchCommitResult` interface
  - [ ] Export from `src/types/index.ts`

- [ ] **Task 4.3: Wire Batch to LifecycleManager**
  - [ ] Update `LifecycleManager.batchInscribeOnBitcoin()`
  - [ ] Use new batch commit logic when `singleTransaction: true`
  - [ ] Maintain backward compatibility
  - [ ] Test that file compiles without errors

- [ ] **Task 4.4: Write Batch Commit Tests**
  - [ ] Create `tests/unit/bitcoin/transactions/batch-commit.test.ts`
  - [ ] Test batch manifest creation
  - [ ] Test fee splitting by data size
  - [ ] Test individual reveal transactions
  - [ ] Verify 90%+ coverage for batch-commit.ts

- [ ] **Task 4.5: Test Batch on Signet**
  - [ ] Create test script: `tests/manual/signet-batch-test.ts`
  - [ ] Create batch commit with 3 inscriptions
  - [ ] Broadcast and track confirmation
  - [ ] Create and broadcast 3 reveal transactions
  - [ ] Verify all 3 inscriptions in explorer
  - [ ] Calculate actual fee savings vs. individual inscriptions

### Days 18-19: Mainnet Preparation
- [ ] **Task 4.6: Security Review of Transaction Code**
  - [ ] Review UTXO selection (verify never uses inscription UTXOs)
  - [ ] Review fee calculation (verify accuracy)
  - [ ] Review commit/reveal logic (verify correctness)
  - [ ] Review broadcasting (verify retry logic safe)
  - [ ] Document security review findings

- [ ] **Task 4.7: Fee Estimation Validation**
  - [ ] Compare fee estimates with actual fees from signet
  - [ ] Adjust fee calculation if needed
  - [ ] Test with different fee rates (1, 10, 50 sat/vB)
  - [ ] Document fee accuracy

- [ ] **Task 4.8: Error Handling Review**
  - [ ] Review all error paths
  - [ ] Ensure all errors have codes
  - [ ] Ensure all errors have actionable messages
  - [ ] Test error scenarios
  - [ ] Document error handling

- [ ] **Task 4.9: Documentation Review**
  - [ ] Review all JSDoc comments
  - [ ] Ensure README updated with new features
  - [ ] Create transaction flow diagram
  - [ ] Document migration notes (what changed from legacy)
  - [ ] Create usage examples

### Day 20: Mainnet Test
- [ ] **Task 4.10: Prepare Mainnet Test**
  - [ ] **4.10a: Acquire Mainnet BTC**
    - [ ] Get ~0.001 BTC (enough for 1-2 inscriptions + fees)
    - [ ] Transfer to test wallet
    - [ ] Verify balance in wallet
  - [ ] **4.10b: Configure Mainnet**
    - [ ] Set `MAINNET_ORD_NODE_URL` in `.env.mainnet`
    - [ ] Set `BITCOIN_NETWORK=mainnet`
    - [ ] Set wallet private key (SECURE STORAGE!)
    - [ ] Test connection to mainnet ord node
  - [ ] **4.10c: Create Test Script**
    - [ ] Create `tests/manual/mainnet-inscription-test.ts`
    - [ ] Add WARNING comments about mainnet costs
    - [ ] Set up SDK with mainnet config
    - [ ] Add detailed logging for each step
  - [ ] **4.10d: Safety Review**
    - [ ] Double-check fee calculation logic
    - [ ] Verify UTXO selection won't spend inscriptions
    - [ ] Check wallet has enough funds
    - [ ] Dry-run script without actual broadcast (comment out broadcast)
  - [ ] **4.10e: Code Review**
    - [ ] Request manual code review from Brian or team
    - [ ] Address any concerns raised
    - [ ] Get explicit approval to proceed

- [ ] **Task 4.11: Perform Mainnet Inscription**
  - [ ] **4.11a: Final Checks**
    - [ ] Verify script uses small inscription (minimize cost)
    - [ ] Check current mainnet fee rates (mempool.space)
    - [ ] Calculate expected total cost
    - [ ] Get final go/no-go approval
  - [ ] **4.11b: Execute Commit**
    - [ ] Run mainnet test script
    - [ ] Monitor console for commit transaction creation
    - [ ] Note commit txid
    - [ ] Check commit in mempool: https://mempool.space/tx/[txid]
  - [ ] **4.11c: Wait for Commit Confirmation**
    - [ ] Monitor mempool for commit confirmation
    - [ ] Note block height when confirmed
    - [ ] Verify commit confirmed before proceeding
  - [ ] **4.11d: Execute Reveal**
    - [ ] Script continues to reveal transaction
    - [ ] Note reveal txid
    - [ ] Check reveal in mempool
  - [ ] **4.11e: Wait for Reveal Confirmation**
    - [ ] Monitor reveal confirmation
    - [ ] Note final inscription ID
    - [ ] Verify at https://ordinals.com/inscription/[id]

- [ ] **Task 4.12: Monitor for Issues**
  - [ ] **4.12a: Verify Inscription**
    - [ ] Check content matches what was inscribed
    - [ ] Check content type is correct
    - [ ] Check satoshi number is valid
    - [ ] Screenshot from ordinals.com
  - [ ] **4.12b: Verify Fees**
    - [ ] Calculate actual fees paid (sum of commit + reveal)
    - [ ] Compare to estimated fees
    - [ ] Note any discrepancy (should be within 5%)
  - [ ] **4.12c: Verify UTXO Safety**
    - [ ] Check wallet UTXOs after inscription
    - [ ] Verify no inscription-bearing UTXOs were spent
    - [ ] Verify change output if created
  - [ ] **4.12d: Document Issues**
    - [ ] Note any problems encountered
    - [ ] Rate severity (critical/high/medium/low)
    - [ ] Create fix plan for any issues

- [ ] **Task 4.13: Document Results**
  - [ ] **4.13a: Create Results Doc**
    - [ ] Create `MAINNET_TEST_RESULTS.md`
    - [ ] Add header with date, network, total cost
  - [ ] **4.13b: Add Transaction Data**
    - [ ] Inscription ID: [link to ordinals.com]
    - [ ] Commit txid: [link to mempool.space]
    - [ ] Reveal txid: [link to mempool.space]
    - [ ] Satoshi number
  - [ ] **4.13c: Add Fee Data**
    - [ ] Commit fee: X sats (Y sat/vB)
    - [ ] Reveal fee: X sats (Y sat/vB)
    - [ ] Total cost: X sats ($Y USD at current rate)
  - [ ] **4.13d: Add Lessons Learned**
    - [ ] What went smoothly
    - [ ] What was challenging
    - [ ] What would we do differently
    - [ ] Recommendations for production use

---

## Final Deliverables

### Code Deliverables
- [ ] **Task 5.1: All Source Files Ported**
  - [ ] `src/bitcoin/utxo-selection.ts`
  - [ ] `src/bitcoin/fee-calculation.ts`
  - [ ] `src/bitcoin/transactions/commit.ts`
  - [ ] `src/bitcoin/transactions/reveal.ts`
  - [ ] `src/bitcoin/transactions/batch-commit.ts`
  - [ ] `src/bitcoin/broadcasting.ts`
  - [ ] `src/bitcoin/confirmation.ts`
  - [ ] `src/bitcoin/BitcoinManager.ts` (updated)
  - [ ] `src/types/bitcoin.ts` (updated)

- [ ] **Task 5.2: All Tests Written**
  - [ ] Unit tests for all transaction code
  - [ ] Integration tests for inscription flow
  - [ ] Manual test scripts for signet/mainnet
  - [ ] All tests passing

- [ ] **Task 5.3: Code Quality**
  - [ ] 90%+ test coverage
  - [ ] No linter errors
  - [ ] No TypeScript errors
  - [ ] All tests passing

### Documentation Deliverables
- [ ] **Task 5.4: Documentation Complete**
  - [ ] Transaction flow diagram created
  - [ ] Migration notes written
  - [ ] Usage examples created
  - [ ] API documentation updated
  - [ ] README updated

- [ ] **Task 5.5: Test Results Documented**
  - [ ] Signet test results (5+ inscriptions)
  - [ ] Mainnet test results (1+ inscription)
  - [ ] Known issues / limitations documented

### Final Checks
- [ ] **Task 5.6: Acceptance Criteria Met**
  - [ ] ✅ Can inscribe on signet
  - [ ] ✅ Can inscribe on mainnet
  - [ ] ✅ SDK prevents spending inscription UTXOs
  - [ ] ✅ Batch inscriptions work
  - [ ] ✅ All tests pass
  - [ ] ✅ 90%+ test coverage
  - [ ] ✅ 5+ signet inscriptions demonstrated
  - [ ] ✅ 1+ mainnet inscription demonstrated
  - [ ] ✅ No regressions
  - [ ] ✅ Documentation complete

---

## Relevant Files

### Created Files
*Files will be listed here as they are created during implementation*

### Modified Files
*Files will be listed here as they are modified during implementation*

---

## Notes

*Add notes here during implementation about challenges, decisions, or important findings*

---

## Daily Progress Log

### Day 1 (Date: _______)
*Log what was accomplished*

### Day 2 (Date: _______)
*Log what was accomplished*

*(Continue for each day)*

---

**Status Legend:**
- [ ] Not started
- [x] Completed
- 🟡 In progress
- ⚠️ Blocked
- ❌ Failed/needs rework

