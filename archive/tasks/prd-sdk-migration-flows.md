# PRD: SDK Migration Flows and Utilities

**Status:** 🔴 Critical  
**Timeline:** End of week (5 days)  
**Team:** 2 engineers (AI + Developer)  
**Created:** 2025-10-16  
**Repository:** https://github.com/onionoriginals/sdk/tree/main/src/migration

---

## Introduction

The SDK Migration Flows system enables seamless transitions of digital assets between different DID methods across three architectural layers: did:peer (Private), did:webvh (Public), and did:btco (Tradable). This is a **critical capability** that allows assets to evolve through their lifecycle—from private creation to public discovery to blockchain-anchored trading—while preserving cryptographic integrity, ownership proofs, and complete audit trails. Without this system, assets are permanently locked to their initial visibility layer, eliminating flexibility for collectors, creators, and platforms.

This PRD defines the MigrationManager orchestration layer, validation pipelines, rollback mechanisms, state tracking, and comprehensive testing requirements to support millions of web migrations and thousands of blockchain migrations with guaranteed data integrity.

---

## Goals

1. **Enable Asset Lifecycle Flexibility:** Provide seamless migration paths between all three DID layers (peer → webvh, webvh → btco, peer → btco) with <1s for web migrations and <10min for blockchain migrations
2. **Guarantee Data Integrity:** Ensure 100% cryptographic proof continuity, ownership verification, and audit trail preservation across all migration paths with atomic rollback on failure
3. **Scale Operations:** Support millions of web migrations and thousands of blockchain migrations with batch processing and partial migration capabilities for large files
4. **Developer Experience:** Provide clear APIs, comprehensive documentation, and reusable patterns that make migrations straightforward for SDK consumers

---

## User Stories

**Story 1: Private Collector Makes Asset Public**
```
As a collector who privately imported family photos,
I want to migrate selected images from did:peer to did:webvh,
So that I can share them publicly while keeping others private.

Acceptance: Migration completes in <1s, original private DIDs remain valid, 
new public DIDs are discoverable, credentials carry over, audit trail preserved.
```

**Story 2: Platform Prepares Asset for Trading**
```
As a platform operator,
I want to migrate a publicly-visible asset from did:webvh to did:btco,
So that it becomes tradable on marketplaces with blockchain proof of ownership.

Acceptance: Migration completes in <10min, Bitcoin anchoring succeeds on signet,
ownership transfer capability enabled, all metadata preserved, cost estimated upfront.
```

**Story 3: Direct Private-to-Tradable Migration**
```
As a creator with high-value original works,
I want to migrate directly from did:peer to did:btco,
So that I can list for sale immediately without intermediate public exposure.

Acceptance: Single atomic operation, Bitcoin anchoring with all proofs,
skips public layer entirely, rollback restores private state on failure.
```

**Story 4: Batch Migration for Albums**
```
As a user with 500 photos in an album,
I want to migrate the entire album from did:peer to did:webvh in one operation,
So that I don't have to manually migrate each photo individually.

Acceptance: Batch operation completes efficiently, progress tracking available,
partial failures don't corrupt batch, individual rollback per asset.
```

**Story 5: Large File Partial Migration**
```
As a platform handling 4K video assets (500MB+),
I want to migrate large files in chunks to avoid timeouts,
So that migrations complete reliably without memory exhaustion.

Acceptance: Chunked upload/download, progress reporting, resumable on network failure,
storage adapter compatibility across layers, integrity verification on completion.
```

**Story 6: Migration Failure Recovery**
```
As a developer integrating the SDK,
I want automatic rollback when migrations fail,
So that assets aren't left in corrupted or intermediate states.

Acceptance: Pre-migration checkpoints created, rollback triggers on any error,
state restoration verified, original DID fully functional post-rollback, audit log updated.
```

---

## Functional Requirements

### MigrationManager Core (FR-1)

**FR-1.1:** The MigrationManager MUST expose a singleton instance via `MigrationManager.getInstance()` that orchestrates all migration operations  
**FR-1.2:** The system MUST support three migration paths: `peer→webvh`, `webvh→btco`, and `peer→btco`  
**FR-1.3:** The MigrationManager MUST validate cross-layer compatibility before initiating any migration  
**FR-1.4:** The system MUST create immutable checkpoints before starting migrations for rollback capability  
**FR-1.5:** The MigrationManager MUST emit lifecycle events at each migration stage: `migration:started`, `migration:validated`, `migration:checkpointed`, `migration:completed`, `migration:failed`, `migration:rolledback`

### Migration API (FR-2)

**FR-2.1:** The system MUST provide `migrate(options: MigrationOptions): Promise<MigrationResult>` method with the following options:
```typescript
interface MigrationOptions {
  sourceDid: string;           // Source DID to migrate from
  targetLayer: 'peer' | 'webvh' | 'btco'; // Target layer
  credentialIssuance?: boolean; // Require VC issuance (default: true)
  batchMode?: boolean;          // Batch operation flag
  partialMode?: {               // For large files
    chunkSize: number;          // Bytes per chunk
    resumable: boolean;         // Support resume
  };
  estimateCostOnly?: boolean;   // Return cost estimate without migrating
  metadata?: Record<string, any>; // Additional migration metadata
}
```

**FR-2.2:** The system MUST provide `migrateBatch(dids: string[], targetLayer, options): Promise<BatchMigrationResult>` for batch operations  
**FR-2.3:** The system MUST provide `estimateMigrationCost(sourceDid, targetLayer): Promise<CostEstimate>` that returns:
- Storage cost on target layer (negligible for webvh, significant for btco)
- Bitcoin network fees for btco migrations
- Estimated time to completion

**FR-2.4:** The system MUST provide `getMigrationStatus(migrationId): Promise<MigrationState>` for progress tracking  
**FR-2.5:** The system MUST provide `rollback(migrationId): Promise<RollbackResult>` for manual rollback requests  
**FR-2.6:** The system MUST provide `getMigrationHistory(did): Promise<MigrationAuditRecord[]>` to retrieve complete migration history

### Validation Pipeline (FR-3)

**FR-3.1:** The system MUST validate DID document compatibility between source and target layers before migration:
- Key types supported on target layer
- Service endpoint requirements
- Verification method compatibility

**FR-3.2:** The system MUST validate credential compatibility:
- All credentials associated with source DID can be re-issued for target DID
- Credential schemas supported on target layer
- Issuer authority carries over

**FR-3.3:** The system MUST validate storage adapter compatibility:
- Target layer storage adapter available and accessible
- Sufficient storage quota on target layer
- Large file support (if partialMode enabled)

**FR-3.4:** The system MUST validate lifecycle state transitions:
- Source asset lifecycle state compatible with target layer
- No pending operations on source DID
- Target layer supports required lifecycle operations

**FR-3.5:** The system MUST validate Bitcoin network requirements for btco migrations:
- Sufficient funds for network fees
- Signet connection available (did:btco:sig)
- Anchoring service operational

**FR-3.6:** Validation failures MUST return detailed `ValidationResult` with:
```typescript
interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];  // Blocking errors
  warnings: ValidationWarning[]; // Non-blocking issues
  estimatedCost: CostEstimate;
  estimatedDuration: number; // milliseconds
}
```

### Cross-Layer Compatibility (FR-4)

**FR-4.1:** The system MUST preserve cryptographic proof continuity:
- Original creation proof carried forward
- Ownership chain unbroken
- All signatures remain verifiable

**FR-4.2:** The system MUST maintain complete audit trail:
- Migration timestamp and initiator
- Source and target DIDs linked
- Pre and post-migration states captured
- All validation results logged

**FR-4.3:** The system MUST ensure event system continuity:
- Event history migrated to target DID
- Event subscriptions transferred
- New events reference migration history

**FR-4.4:** The system MUST guarantee lifecycle state integrity:
- Current lifecycle state preserved
- State machine transitions valid on target layer
- Lifecycle history migrated

**FR-4.5:** The system MUST verify ownership across migrations:
- Original owner remains owner post-migration
- Ownership proofs re-generated for target DID
- Access control policies migrated

### Rollback Mechanisms (FR-5)

**FR-5.1:** The system MUST create pre-migration checkpoints containing:
- Complete DID document snapshot
- All associated credentials
- Storage adapter references
- Lifecycle state snapshot
- Ownership proofs

**FR-5.2:** Rollback MUST trigger automatically on:
- Validation failure after checkpoint creation
- Storage adapter failure during migration
- Bitcoin anchoring failure (btco migrations)
- Credential re-issuance failure
- Any unhandled error during migration

**FR-5.3:** Rollback MUST restore to exact pre-migration state:
- Original DID fully functional
- All credentials valid
- Storage references intact
- Lifecycle state restored
- No orphaned data on target layer

**FR-5.4:** Rollback operations MUST complete within:
- <500ms for peer/webvh migrations
- <30s for btco migrations

**FR-5.5:** Rollback MUST be idempotent (can be called multiple times safely)

**FR-5.6:** Failed rollbacks MUST enter quarantine state and emit `migration:quarantine` event with manual recovery instructions

### State Tracking (FR-6)

**FR-6.1:** Each migration MUST generate unique `migrationId` (UUID v4)

**FR-6.2:** The system MUST track migration through states:
```typescript
enum MigrationStateEnum {
  PENDING = 'pending',           // Migration queued
  VALIDATING = 'validating',     // Running validation pipeline
  CHECKPOINTED = 'checkpointed', // Checkpoint created
  IN_PROGRESS = 'in_progress',   // Active migration
  ANCHORING = 'anchoring',       // Bitcoin anchoring (btco only)
  COMPLETED = 'completed',       // Successfully completed
  FAILED = 'failed',             // Failed, rollback initiated
  ROLLED_BACK = 'rolled_back',   // Rolled back successfully
  QUARANTINED = 'quarantined'    // Rollback failed, needs manual intervention
}
```

**FR-6.3:** The system MUST persist migration state to storage adapter with:
- State transitions timestamp
- Progress percentage (0-100)
- Current operation description
- Error details (if any)

**FR-6.4:** The system MUST provide real-time state updates via event system

**FR-6.5:** Migration state MUST be queryable by:
- migrationId
- sourceDid
- targetDid (once created)
- dateRange
- state status

### Audit Logging (FR-7)

**FR-7.1:** The system MUST create immutable audit records for each migration containing:
```typescript
interface MigrationAuditRecord {
  migrationId: string;
  timestamp: number;
  initiator: string;              // User/system identifier
  sourceDid: string;
  sourceLayer: 'peer' | 'webvh' | 'btco';
  targetDid: string | null;       // null if failed before creation
  targetLayer: 'peer' | 'webvh' | 'btco';
  finalState: MigrationStateEnum;
  validationResults: ValidationResult;
  costActual: CostEstimate;       // Actual costs incurred
  duration: number;               // milliseconds
  checkpointId: string;           // For rollback reference
  errors: Error[];                // Any errors encountered
  metadata: Record<string, any>;  // Custom metadata
}
```

**FR-7.2:** Audit records MUST be stored on the target layer storage (or source if migration failed)

**FR-7.3:** Audit records MUST be cryptographically signed by the system

**FR-7.4:** Audit records MUST be queryable via `getMigrationHistory(did)` and `getSystemMigrationLogs(filters)`

**FR-7.5:** The system SHOULD retain audit logs for minimum 7 years for compliance

### Batch Operations (FR-8)

**FR-8.1:** Batch migrations MUST process assets concurrently with:
- Max 10 concurrent peer→webvh migrations
- Max 3 concurrent webvh→btco migrations (Bitcoin rate limiting)
- Max 2 concurrent peer→btco migrations

**FR-8.2:** Batch operations MUST provide aggregate progress:
```typescript
interface BatchMigrationResult {
  batchId: string;
  total: number;
  completed: number;
  failed: number;
  inProgress: number;
  results: Map<string, MigrationResult>; // sourceDid → result
  overallProgress: number; // 0-100
}
```

**FR-8.3:** Individual migration failures in batch MUST NOT halt entire batch

**FR-8.4:** Batch operations MUST support cancellation via `cancelBatch(batchId)`

**FR-8.5:** The system MUST emit `batch:progress` events every 5 seconds during batch operations

### Partial Migrations (FR-9)

**FR-9.1:** Large file migrations MUST support chunking with configurable chunk size (default: 10MB)

**FR-9.2:** Partial migrations MUST be resumable on network failure:
- Track completed chunks
- Resume from last successful chunk
- Verify chunk integrity via checksums

**FR-9.3:** Partial migrations MUST provide detailed progress:
```typescript
interface PartialMigrationProgress {
  totalChunks: number;
  completedChunks: number;
  currentChunk: number;
  bytesTransferred: number;
  totalBytes: number;
  percentComplete: number;
  estimatedTimeRemaining: number; // milliseconds
}
```

**FR-9.4:** Partial migrations MUST verify file integrity after completion using SHA-256 hash comparison

**FR-9.5:** Failed partial migrations MUST clean up incomplete chunks on target layer

### Bitcoin Integration (FR-10)

**FR-10.1:** The system MUST use Bitcoin Signet for did:btco migrations (did:btco:sig:...)

**FR-10.2:** Bitcoin anchoring MUST include:
- DID document hash
- Migration metadata hash
- Timestamp
- Source DID reference (in OP_RETURN)

**FR-10.3:** The system MUST wait for 1 confirmation on Signet before marking migration complete

**FR-10.4:** Bitcoin anchoring failures MUST trigger automatic rollback

**FR-10.5:** The system MUST estimate Bitcoin network fees before migration and require confirmation if >threshold (default: 1000 sats)

**FR-10.6:** Bitcoin transaction IDs MUST be stored in migration audit records

### Performance (FR-11)

**FR-11.1:** peer→webvh migrations MUST complete in <1 second (excluding large file transfers)

**FR-11.2:** webvh→btco migrations MUST complete in <10 minutes (including Bitcoin confirmation)

**FR-11.3:** peer→btco migrations MUST complete in <10 minutes

**FR-11.4:** Validation pipeline MUST complete in <200ms for standard assets

**FR-11.5:** Rollback operations MUST complete in <500ms for web layers, <30s for btco

**FR-11.6:** The system MUST handle:
- Millions of concurrent peer/webvh migrations
- Thousands of concurrent btco migrations
- 100+ concurrent batch operations

**FR-11.7:** Migration state queries MUST return in <100ms

**FR-11.8:** Large file partial migrations MUST maintain >1MB/s transfer rate

### Error Handling (FR-12)

**FR-12.1:** All errors MUST be categorized:
```typescript
enum MigrationErrorType {
  VALIDATION_ERROR = 'validation_error',     // Pre-migration validation failed
  STORAGE_ERROR = 'storage_error',           // Storage adapter failure
  BITCOIN_ERROR = 'bitcoin_error',           // Bitcoin anchoring failed
  CREDENTIAL_ERROR = 'credential_error',     // Credential re-issuance failed
  NETWORK_ERROR = 'network_error',           // Network/connectivity failure
  ROLLBACK_ERROR = 'rollback_error',         // Rollback failed (critical)
  TIMEOUT_ERROR = 'timeout_error',           // Operation timeout
  UNKNOWN_ERROR = 'unknown_error'            // Unexpected error
}
```

**FR-12.2:** The system MUST provide detailed error context:
- Error type and code
- Human-readable message
- Technical details for debugging
- Suggested recovery actions
- Related migrationId and DIDs

**FR-12.3:** Transient errors (network, timeout) MUST trigger automatic retry:
- Max 3 retries with exponential backoff
- 2s, 4s, 8s retry delays
- After exhaustion, trigger rollback

**FR-12.4:** Critical errors (rollback failure) MUST:
- Enter quarantine state
- Emit alert event
- Log detailed recovery instructions
- Provide manual recovery tools

**FR-12.5:** All errors MUST be logged to audit system

---

## Non-Goals (Out of Scope)

❌ **Explicitly NOT included:**

- **Reverse Migrations (btco→webvh, webvh→peer):** Once assets move to higher layers, they cannot migrate backward. Assets stay on their highest layer. *(Reason: Architectural constraint, blockchain immutability)*
- **Legacy DID Format Support:** No backward compatibility with previous SDK versions or old DID formats. *(Reason: Clean slate, time constraint)*
- **Multi-signature Authorization:** No multi-user approval workflows for migrations. *(Reason: Single-user context, added complexity)*
- **Cross-Chain Bitcoin Support:** Only Signet for testnet, eventually mainnet. No support for other chains (Litecoin, etc.). *(Reason: Focus on Bitcoin only)*
- **Migration Scheduling:** No cron-style scheduled migrations or automated triggers. *(Reason: User-initiated only, can add later)*
- **Cost Optimization Algorithms:** No automatic selection of cheapest migration path or fee optimization. *(Reason: Time constraint, straightforward pricing)*
- **Third-Party Storage Adapters:** Only support built-in storage adapters (local, IPFS, cloud). *(Reason: Scope management)*
- **Real-time Collaboration:** No support for concurrent multi-user migrations of same asset. *(Reason: Single-user model)*
- **Migration Templates/Presets:** No saved migration configuration templates. *(Reason: API is straightforward enough)*
- **Cross-SDK Compatibility:** No migration compatibility with other DID SDK implementations. *(Reason: Internal tool only)*

---

## Success Metrics

**Primary:**

- **Migration Success Rate:** ≥99.9% for peer→webvh migrations, ≥99% for btco migrations
- **Performance Compliance:** 100% of web migrations <1s, 95% of btco migrations <10min
- **Rollback Success Rate:** 100% rollback success for web layers, ≥99% for btco layer
- **Audit Completeness:** 100% of migrations have complete audit records
- **Test Coverage:** ≥95% code coverage for migration module
- **Zero Data Loss:** 0% data loss or corruption across all migration paths

**Secondary:**

- **Developer Adoption:** Clear API docs enable integration in <1 hour
- **Batch Efficiency:** Batch operations 5x faster than sequential individual migrations
- **Large File Reliability:** 100% success rate for files up to 1GB with partial migration
- **Bitcoin Cost Predictability:** Fee estimates within 10% of actual costs

---

## Technical Considerations

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                      MigrationManager                            │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Public API (migrate, migrateBatch, estimateCost, ...)  │  │
│  └────────────────────┬─────────────────────────────────────┘  │
│                       │                                          │
│  ┌────────────────────▼─────────────────────────────────────┐  │
│  │         Validation Pipeline                              │  │
│  │  - DID Compatibility  - Credential Validation            │  │
│  │  - Storage Check      - Lifecycle Validation             │  │
│  │  - Bitcoin Readiness  - Cost Estimation                  │  │
│  └────────────────────┬─────────────────────────────────────┘  │
│                       │                                          │
│  ┌────────────────────▼─────────────────────────────────────┐  │
│  │         Checkpoint Creation                              │  │
│  │  - Snapshot DID Document  - Backup Credentials           │  │
│  │  - Save Storage Refs      - Capture Lifecycle State      │  │
│  └────────────────────┬─────────────────────────────────────┘  │
│                       │                                          │
│  ┌────────────────────▼─────────────────────────────────────┐  │
│  │         Migration Orchestration                          │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │  │
│  │  │ DIDManager  │  │ Lifecycle    │  │  Credential    │  │  │
│  │  │             │  │ Manager      │  │  Manager       │  │  │
│  │  └─────────────┘  └──────────────┘  └────────────────┘  │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │  │
│  │  │ Bitcoin     │  │ Storage      │  │  Event         │  │  │
│  │  │ Manager     │  │ Adapters     │  │  System        │  │  │
│  │  └─────────────┘  └──────────────┘  └────────────────┘  │  │
│  └────────────────────┬─────────────────────────────────────┘  │
│                       │                                          │
│  ┌────────────────────▼─────────────────────────────────────┐  │
│  │         State Tracking & Audit Logging                   │  │
│  │  - Migration State Machine  - Audit Record Creation      │  │
│  │  - Event Emission          - Progress Tracking           │  │
│  └────────────────────┬─────────────────────────────────────┘  │
│                       │                                          │
│                ┌──────┴───────┐                                 │
│                │              │                                 │
│        ┌───────▼────┐  ┌──────▼────────┐                       │
│        │  Success   │  │  Failure +    │                       │
│        │  Complete  │  │  Rollback     │                       │
│        └────────────┘  └───────────────┘                       │
└─────────────────────────────────────────────────────────────────┘
```

### Migration State Machine

```
┌─────────┐
│ PENDING │
└────┬────┘
     │
     ▼
┌────────────┐
│ VALIDATING │───────┐
└─────┬──────┘       │ Validation
      │              │ Failure
      │ Valid        │
      ▼              │
┌──────────────┐     │
│ CHECKPOINTED │     │
└──────┬───────┘     │
       │             │
       ▼             │
┌─────────────┐      │
│ IN_PROGRESS │──────┤
└──────┬──────┘      │ Migration
       │             │ Failure
       │ (btco only) │
       ▼             │
┌────────────┐       │
│ ANCHORING  │───────┤
└─────┬──────┘       │
      │              │
      │ Success      │
      ▼              ▼
┌───────────┐   ┌─────────┐
│ COMPLETED │   │ FAILED  │
└───────────┘   └────┬────┘
                     │
                     ▼
              ┌──────────────┐
              │ ROLLED_BACK  │
              └──────┬───────┘
                     │
                     │ Rollback
                     │ Failure
                     ▼
              ┌──────────────┐
              │ QUARANTINED  │
              └──────────────┘
```

### Data Flow During Migration

```
Source DID (did:peer:abc123)
        │
        ▼
┌───────────────────────────┐
│ 1. Read Source Data       │
│   - DID Document          │
│   - Credentials           │
│   - Storage References    │
│   - Lifecycle State       │
└───────┬───────────────────┘
        │
        ▼
┌───────────────────────────┐
│ 2. Validate Compatibility │
│   - DID Doc Structure     │
│   - Key Types             │
│   - Credential Schemas    │
│   - Storage Adapters      │
└───────┬───────────────────┘
        │
        ▼
┌───────────────────────────┐
│ 3. Create Checkpoint      │
│   - Snapshot All Data     │
│   - Generate checkpointId │
│   - Store for Rollback    │
└───────┬───────────────────┘
        │
        ▼
┌───────────────────────────┐
│ 4. Create Target DID      │
│   - Generate new DID      │
│   - Migrate DID Document  │
│   - Update References     │
└───────┬───────────────────┘
        │
        ▼
┌───────────────────────────┐
│ 5. Migrate Storage        │
│   - Copy/Move Assets      │
│   - Update Storage Refs   │
│   - Verify Integrity      │
└───────┬───────────────────┘
        │
        ▼
┌───────────────────────────┐
│ 6. Re-issue Credentials   │
│   - Validate Ownership    │
│   - Issue New VCs         │
│   - Maintain Chain        │
└───────┬───────────────────┘
        │
        ▼
┌───────────────────────────┐
│ 7. Migrate Lifecycle      │
│   - Transfer State        │
│   - Update Event History  │
│   - Maintain Continuity   │
└───────┬───────────────────┘
        │
        ▼ (btco only)
┌───────────────────────────┐
│ 8. Bitcoin Anchoring      │
│   - Create Anchor TX      │
│   - Wait for Confirmation │
│   - Store TX ID           │
└───────┬───────────────────┘
        │
        ▼
┌───────────────────────────┐
│ 9. Create Audit Record    │
│   - Log All Operations    │
│   - Sign Record           │
│   - Store on Target       │
└───────┬───────────────────┘
        │
        ▼
Target DID (did:webvh:xyz789)
```

### Source Files Structure

```
/src/migration/
├── MigrationManager.ts          # Main orchestrator class
├── types.ts                     # TypeScript interfaces and types
├── validation/
│   ├── ValidationPipeline.ts    # Validation orchestration
│   ├── DIDCompatibilityValidator.ts
│   ├── CredentialValidator.ts
│   ├── StorageValidator.ts
│   ├── LifecycleValidator.ts
│   └── BitcoinValidator.ts
├── checkpoint/
│   ├── CheckpointManager.ts     # Checkpoint creation/restoration
│   └── CheckpointStorage.ts     # Checkpoint persistence
├── rollback/
│   ├── RollbackManager.ts       # Rollback orchestration
│   └── RollbackHandlers.ts      # Layer-specific rollback logic
├── state/
│   ├── StateTracker.ts          # Migration state management
│   └── StateMachine.ts          # State transition logic
├── audit/
│   ├── AuditLogger.ts           # Audit record creation
│   └── AuditQuerier.ts          # Audit record retrieval
├── operations/
│   ├── PeerToWebvhMigration.ts  # peer→webvh implementation
│   ├── WebvhToBtcoMigration.ts  # webvh→btco implementation
│   ├── PeerToBtcoMigration.ts   # peer→btco implementation
│   └── BaseMigration.ts         # Shared migration logic
├── batch/
│   ├── BatchProcessor.ts        # Batch operation handling
│   └── ConcurrencyManager.ts    # Concurrent migration limits
├── partial/
│   ├── ChunkedTransfer.ts       # Large file chunking
│   └── ResumableUpload.ts       # Resumable upload logic
└── utils/
    ├── CostEstimator.ts         # Migration cost calculation
    ├── ProgressTracker.ts       # Progress reporting
    └── ErrorHandler.ts          # Error categorization & recovery
```

### Dependencies

**Required Manager Integrations:**
- **DIDManager:** Create/resolve DIDs across layers
- **LifecycleManager:** Transfer lifecycle state and history
- **CredentialManager:** Re-issue credentials for new DIDs
- **BitcoinManager:** Anchor to Bitcoin Signet for btco migrations
- **Storage Adapters:** Move/copy asset data between storage layers
- **Cryptographic Utilities:** Sign audit records, verify proofs
- **Event System:** Emit migration events for real-time updates

**External Dependencies:**
- Bitcoin Signet RPC connection
- Storage adapter implementations (IPFS, cloud, local)
- Cryptographic libraries (ed25519, secp256k1)

**Dependency Status:**
- ✅ DIDManager core complete (needs final testing)
- ✅ LifecycleManager implemented
- 🟡 CredentialManager (in progress, VCs functional)
- 🟡 BitcoinManager (basic anchoring works, needs Signet)
- ✅ Storage Adapters (interface defined, implementations ready)
- ✅ Event System (operational)

### Testing Strategy

**Unit Tests (90% coverage target):**
- Each validator independently tested with valid/invalid inputs
- Checkpoint creation and restoration logic
- Rollback handlers for each layer
- State machine transitions
- Cost estimation accuracy
- Error handler categorization
- Audit log formatting and signing

**Integration Tests (Full workflow coverage):**
- `test-peer-to-webvh.spec.ts`: Complete peer→webvh migration with validation, checkpoint, transfer, credential re-issuance, rollback on failure
- `test-webvh-to-btco.spec.ts`: Complete webvh→btco migration with Bitcoin Signet anchoring, confirmation wait, cost verification
- `test-peer-to-btco.spec.ts`: Direct peer→btco migration with full workflow
- `test-batch-operations.spec.ts`: Batch processing with partial failures, concurrency limits, cancellation
- `test-large-files.spec.ts`: Partial migration with chunking, resume after simulated network failure
- `test-rollback-scenarios.spec.ts`: Rollback triggered at each migration stage, state verification
- `test-concurrent-migrations.spec.ts`: Multiple simultaneous migrations, resource contention

**Edge Case Tests:**
- Invalid DID formats during migration
- Credential schema mismatch between layers
- Storage adapter unavailable mid-migration
- Bitcoin Signet RPC timeout/failure
- Partial migration with corrupted chunk
- Rollback failure scenarios and quarantine
- Migration of DID with no credentials
- Migration of DID with 100+ credentials
- Network failure during Bitcoin anchoring
- Concurrent batch operations hitting limits

**Performance Tests:**
- 1000 sequential peer→webvh migrations (<1s each)
- 100 parallel peer→webvh migrations (stress test)
- 10 parallel btco migrations (<10min each)
- Large file migration: 500MB, 1GB, 5GB
- Batch operation: 500 DIDs in single batch
- State query performance under 10K active migrations

**Security Tests:**
- Attempt unauthorized migration (wrong owner)
- Tampered checkpoint data
- Invalid audit log signature
- Replay attack on migration request
- Storage adapter access control bypass

### Integration Points

**MigrationManager ↔ DIDManager:**
- `DIDManager.create(layer, options)`: Create new DID on target layer
- `DIDManager.resolve(did)`: Resolve source DID document
- `DIDManager.update(did, document)`: Update DID documents during migration
- `DIDManager.validateCompatibility(sourceDoc, targetLayer)`: Pre-flight validation

**MigrationManager ↔ LifecycleManager:**
- `LifecycleManager.getState(did)`: Get current lifecycle state
- `LifecycleManager.transferState(sourceDid, targetDid, state)`: Transfer lifecycle state
- `LifecycleManager.getHistory(did)`: Get event history for migration
- `LifecycleManager.migrateHistory(sourceDid, targetDid, history)`: Copy history

**MigrationManager ↔ CredentialManager:**
- `CredentialManager.listCredentials(did)`: Get all credentials for DID
- `CredentialManager.reissueCredential(credential, newDid)`: Re-issue VC for new DID
- `CredentialManager.validateChainOfCustody(sourceDid, targetDid)`: Verify credential chain
- `CredentialManager.migrateCredentialHistory(sourceDid, targetDid)`: Transfer issuance history

**MigrationManager ↔ BitcoinManager:**
- `BitcoinManager.estimateFee(dataSize)`: Estimate Bitcoin transaction fee
- `BitcoinManager.anchor(data, options)`: Anchor data to Bitcoin Signet
- `BitcoinManager.waitForConfirmation(txId, confirmations)`: Wait for TX confirmation
- `BitcoinManager.getTransaction(txId)`: Get transaction details for audit

**MigrationManager ↔ Storage Adapters:**
- `StorageAdapter.read(did, path)`: Read asset data from source
- `StorageAdapter.write(did, path, data)`: Write asset data to target
- `StorageAdapter.copy(sourceDid, targetDid, path)`: Efficient copy between layers
- `StorageAdapter.supportsPartial()`: Check for chunked upload support
- `StorageAdapter.getQuota(did)`: Check storage limits

**MigrationManager ↔ Event System:**
- `EventSystem.emit(event, data)`: Emit migration lifecycle events
- `EventSystem.migrateSubscriptions(sourceDid, targetDid)`: Transfer event subscriptions

### Security Requirements

**Key Material Handling:**
- Private keys NEVER transmitted during migration
- Only public keys and DID documents copied
- Ownership proven via signature, not key transfer
- Credentials re-issued using proper verification methods

**Cryptographic Integrity:**
- All audit records signed with system key
- Checkpoint data integrity verified with SHA-256 hashes
- Bitcoin anchoring includes migration metadata hash
- Credential chain of custody maintained cryptographically

**Access Control:**
- Only DID owner can initiate migration
- Ownership verified via signature on migration request
- Storage adapters enforce access control independently
- Quarantined migrations require elevated permissions for recovery

**Audit Logging:**
- All migration attempts logged (success and failure)
- Audit records immutable once written
- Cryptographic signatures prevent tampering
- 7-year retention for compliance readiness

### Performance Optimizations

**Concurrent Processing:**
- Use worker pool pattern for batch operations
- Layer-specific concurrency limits prevent resource exhaustion
- Async/await patterns throughout for non-blocking I/O

**Caching:**
- Cache DID resolution results during validation (5min TTL)
- Cache storage adapter connections (reuse across migrations)
- Cache Bitcoin fee estimates (1min TTL)

**Chunked Transfers:**
- Default 10MB chunks for large files
- Parallel chunk uploads (max 3 concurrent)
- Chunk-level integrity verification (SHA-256)

**Timeout Management:**
- Validation pipeline: 5s timeout
- Web layer migrations: 60s timeout
- Bitcoin anchoring: 15min timeout
- Rollback operations: 60s timeout

**Resource Cleanup:**
- Failed migration data removed from target layer
- Checkpoint data deleted after 24h (successful migrations)
- Quarantined migrations flagged for manual cleanup

---

## Acceptance Criteria

This feature is **DONE** when:

- ✅ **All Migration Paths Implemented:** peer→webvh, webvh→btco, peer→btco fully functional with end-to-end tests passing
- ✅ **Performance Targets Met:** Web migrations <1s (95th percentile), btco migrations <10min (95th percentile), validated under load
- ✅ **Rollback Success:** 100% rollback success rate for web layers, ≥99% for btco layer, verified in integration tests
- ✅ **Batch Operations Work:** Batch migrations process concurrently, handle partial failures, provide accurate progress tracking
- ✅ **Large Files Supported:** Partial migrations handle files up to 5GB with chunking, resume capability, and integrity verification
- ✅ **Audit Trail Complete:** Every migration has detailed audit record, cryptographically signed, queryable via API
- ✅ **Bitcoin Signet Integration:** btco migrations successfully anchor to Signet (did:btco:sig:...), wait for confirmation, store TX ID
- ✅ **Test Coverage ≥95%:** Unit and integration tests cover all migration paths, edge cases, error conditions, rollback scenarios
- ✅ **Documentation Complete:**
  - API reference with TypeScript types and examples
  - Migration patterns guide (common use cases)
  - Error handling and recovery guide
  - Integration guide for SDK consumers
- ✅ **Zero Data Loss:** No data corruption or loss in any test scenario, rollback restores exact state
- ✅ **Event System Integrated:** All migration lifecycle events emitted correctly, subscriptions transferable
- ✅ **Cost Estimation Accurate:** Fee estimates within 10% of actual costs for btco migrations
- ✅ **Edge Cases Handled:** Invalid inputs, network failures, concurrent operations, storage failures all handled gracefully
- ✅ **Code Review Passed:** Architecture review, security review, performance review completed
- ✅ **Demo Ready:** Can demonstrate complete migration flow for each path with real data

---

## Open Questions

❓ **Question 1:** Should we implement migration rate limiting per user to prevent abuse (e.g., max 100 btco migrations per day)?  
- Owner: Developer  
- Due: 2025-10-17  
- Impact: Prevents malicious users from spamming expensive Bitcoin operations

❓ **Question 2:** Do we need migration history visualization/UI, or is programmatic access via API sufficient for v1?  
- Owner: Developer  
- Due: 2025-10-17  
- Impact: Affects whether we build admin tools or defer to SDK consumers

❓ **Question 3:** Should quarantined migrations auto-expire and clean up after N days, or require explicit manual resolution?  
- Owner: Developer  
- Due: 2025-10-17  
- Impact: Affects storage costs and operational burden

❓ **Question 4:** What's the threshold for "large file" that triggers partial migration mode automatically?  
- Owner: AI + Developer  
- Due: 2025-10-17  
- Recommendation: 50MB threshold (5 chunks of 10MB each)

❓ **Question 5:** Should batch operations support priority ordering (process specific DIDs first)?  
- Owner: Developer  
- Due: 2025-10-18  
- Impact: Adds complexity but may be useful for user-facing apps

---

**END OF PRD**

---

## Implementation Checklist (Reference)

**Phase 1: Core Infrastructure (Days 1-2)**
- [ ] Define all TypeScript types and interfaces
- [ ] Implement MigrationManager singleton
- [ ] Build validation pipeline orchestration
- [ ] Create checkpoint manager
- [ ] Build rollback manager skeleton
- [ ] Implement state tracker and state machine

**Phase 2: Migration Operations (Days 2-3)**
- [ ] Implement peer→webvh migration
- [ ] Implement webvh→btco migration with Bitcoin Signet
- [ ] Implement peer→btco direct migration
- [ ] Add batch processing capabilities
- [ ] Add partial migration with chunking

**Phase 3: Supporting Systems (Days 3-4)**
- [ ] Build audit logging system
- [ ] Implement cost estimator
- [ ] Add progress tracking
- [ ] Integrate event system
- [ ] Build error handler with retry logic

**Phase 4: Testing & Polish (Days 4-5)**
- [ ] Write all unit tests
- [ ] Write integration tests for each path
- [ ] Write edge case tests
- [ ] Performance testing and optimization
- [ ] Write API documentation
- [ ] Write migration patterns guide
- [ ] Code review and final fixes

**Phase 5: Validation (Day 5)**
- [ ] End-to-end demo of all migration paths
- [ ] Validate all acceptance criteria
- [ ] Security review
- [ ] Performance benchmarking
- [ ] Final documentation review
