# AI Agent Execution Guide - Originals SDK Asset Layer

## Overview

This guide provides **exact prompts and workflows** for coordinating AI agents to build the asset layer enhancements. Each section includes the specific prompt to give the agent, pre-requisites, and success validation.

---

## Quick Start: Running Your First Agent

### Prerequisites Setup

Before starting any agent, ensure:
1. Repository is cloned and dependencies installed
2. Tests pass: `bun test`
3. Branch created from main: `git checkout -b phase-X/task-X.X-description`

### Agent Execution Template

```bash
# 1. Provide context files to the agent
# 2. Give the specific prompt below
# 3. Agent implements the feature
# 4. Validate with provided tests
# 5. Create PR
```

---

## Phase 1: Foundation Tasks

### TASK 1.1: Event System Implementation

**Agent Role**: Backend Infrastructure Developer

**Context Files to Provide**:
```
- src/lifecycle/OriginalsAsset.ts
- src/lifecycle/LifecycleManager.ts
- src/core/OriginalsSDK.ts
- tests/integration/CompleteLifecycle.e2e.test.ts
```

**Exact Prompt**:
```
You are implementing an event system for the Originals SDK asset layer.

OBJECTIVE:
Create a type-safe, performant event system that emits events during all asset lifecycle operations.

REQUIREMENTS:

1. Create src/events/EventEmitter.ts with:
   - TypeScript EventEmitter class
   - Support for sync and async handlers
   - Error isolation (one failing handler doesn't affect others)
   - Event namespacing
   - Type-safe event definitions

2. Define all event types in src/events/types.ts:
   - AssetCreatedEvent
   - AssetMigratedEvent
   - AssetTransferredEvent
   - ResourcePublishedEvent
   - CredentialIssuedEvent
   - VerificationCompletedEvent

3. Integrate into OriginalsAsset class:
   - Add private eventEmitter property
   - Emit events in migrate() method
   - Emit events in recordTransfer() method
   - Add public on(), once(), off() methods for subscriptions

4. Integrate into LifecycleManager class:
   - Emit events in createAsset()
   - Emit events in publishToWeb()
   - Emit events in inscribeOnBitcoin()
   - Emit events in transferOwnership()

5. Add configuration to OriginalsConfig:
   - enableEvents?: boolean (default: true)
   - eventHandlers?: Record<string, Function[]>

6. Tests required in tests/unit/events/EventEmitter.test.ts:
   - Test event emission and subscription
   - Test multiple handlers for same event
   - Test handler error isolation
   - Test unsubscribe functionality
   - Test async handlers
   - Test event data completeness

7. Integration tests in tests/integration/Events.test.ts:
   - Create asset and verify 'asset:created' event
   - Publish and verify 'asset:migrated' event
   - Inscribe and verify all related events
   - Transfer and verify 'asset:transferred' event
   - Test event ordering

8. Documentation in EVENTS.md:
   - List all event types with examples
   - Show how to subscribe to events
   - Show how to handle events
   - Performance notes

CONSTRAINTS:
- Event emission should add <1ms overhead
- Events must be fire-and-forget (non-blocking)
- Must be backward compatible (no breaking changes)
- All public APIs must have JSDoc comments

VALIDATION:
After implementation, run:
1. bun test tests/unit/events/
2. bun test tests/integration/Events.test.ts
3. All tests must pass
4. No TypeScript errors: bun run type-check

OUTPUT:
Provide a summary of:
1. Files created/modified
2. Event types added
3. Integration points
4. Test coverage percentage
5. Any deviations from requirements
```

**Success Criteria**:
- [ ] All tests pass
- [ ] Type checking passes
- [ ] Events emitted at all lifecycle points
- [ ] Performance overhead <1ms per event
- [ ] Documentation complete

---

### TASK 1.2: Validation Framework Enhancement

**Agent Role**: Backend Developer

**Context Files to Provide**:
```
- src/utils/validation.ts
- src/lifecycle/LifecycleManager.ts
- src/types/common.ts
- tests/unit/lifecycle/LifecycleManager.test.ts
```

**Exact Prompt**:
```
You are enhancing the validation framework to provide detailed feedback and dry-run capabilities.

OBJECTIVE:
Replace the current throw-based validation with a comprehensive ValidationResult system that provides detailed, actionable feedback.

REQUIREMENTS:

1. Create src/validation/ValidationResult.ts:
   ```typescript
   export type ValidationSeverity = 'error' | 'warning' | 'info';
   
   export interface ValidationIssue {
     severity: ValidationSeverity;
     code: string;
     message: string;
     path?: string; // e.g., 'resources[0].hash'
     context?: Record<string, any>;
   }
   
   export class ValidationResult {
     private issues: ValidationIssue[] = [];
     
     addError(code: string, message: string, path?: string, context?: any): void;
     addWarning(code: string, message: string, path?: string, context?: any): void;
     addInfo(code: string, message: string, path?: string, context?: any): void;
     
     hasErrors(): boolean;
     hasWarnings(): boolean;
     getErrors(): ValidationIssue[];
     getWarnings(): ValidationIssue[];
     getAllIssues(): ValidationIssue[];
     isValid(): boolean; // true if no errors
     
     toJSON(): object;
     toString(): string; // Human-readable
   }
   ```

2. Create src/validation/AssetValidator.ts with methods:
   - validateAssetResource(resource: AssetResource): ValidationResult
   - validateAssetStructure(asset: OriginalsAsset): ValidationResult
   - validateMigrationPath(from: LayerType, to: LayerType): ValidationResult
   - validateBitcoinAddress(address: string, network: string): ValidationResult
   - validateDomain(domain: string): ValidationResult

3. Add dry-run methods to LifecycleManager:
   ```typescript
   async validateCreateAsset(resources: AssetResource[]): Promise<ValidationResult>
   async validatePublishToWeb(asset: OriginalsAsset, domain: string): Promise<ValidationResult>
   async validateInscribeOnBitcoin(asset: OriginalsAsset, feeRate?: number): Promise<ValidationResult>
   async validateTransferOwnership(asset: OriginalsAsset, newOwner: string): Promise<ValidationResult>
   ```

4. Add cost estimation methods to LifecycleManager:
   ```typescript
   async estimatePublishCost(asset: OriginalsAsset, domain: string): Promise<CostEstimate>
   async estimateInscribeCost(asset: OriginalsAsset, feeRate?: number): Promise<CostEstimate>
   ```

5. Update existing validation in LifecycleManager:
   - Replace all throw statements with ValidationResult collection
   - Add comprehensive error codes (e.g., 'INVALID_HASH_FORMAT', 'INVALID_DOMAIN')
   - Include context in all issues
   - Add warnings for non-critical issues

6. Create VALIDATION_CODES.md:
   - Document all error codes
   - Provide examples and solutions

7. Tests in tests/unit/validation/:
   - Test ValidationResult class
   - Test AssetValidator methods
   - Test dry-run methods (no side effects)
   - Test cost estimation
   - Test all error codes are unique

CONSTRAINTS:
- Maintain backward compatibility for existing error behavior
- Validation should be fast (<50ms for typical asset)
- All validation must be deterministic

VALIDATION:
1. Run: bun test tests/unit/validation/
2. Run: bun test tests/integration/
3. All existing tests must still pass
4. New dry-run methods must not modify state

OUTPUT:
Provide:
1. List of all error codes added
2. Summary of validation improvements
3. Performance comparison (before/after)
4. Breaking changes (should be none)
```

**Success Criteria**:
- [ ] All tests pass
- [ ] No breaking changes
- [ ] All error codes documented
- [ ] Dry-run methods work correctly
- [ ] Cost estimation within 10% accuracy

---

### TASK 1.3: Logging and Telemetry Enhancement

**Agent Role**: DevOps/Observability Engineer

**Context Files to Provide**:
```
- src/utils/telemetry.ts
- src/core/OriginalsSDK.ts
- tests/unit/utils/telemetry.test.ts
- Task 1.1 output (Event System)
```

**Exact Prompt**:
```
You are enhancing the logging and telemetry system to integrate with the new event system and provide structured logging.

OBJECTIVE:
Create a comprehensive logging and metrics system for production observability.

REQUIREMENTS:

1. Create src/utils/Logger.ts:
   ```typescript
   export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
   
   export interface LogEntry {
     timestamp: string;
     level: LogLevel;
     context: string;
     message: string;
     data?: any;
     duration?: number;
   }
   
   export class Logger {
     constructor(context: string, config: OriginalsConfig);
     
     debug(message: string, data?: any): void;
     info(message: string, data?: any): void;
     warn(message: string, data?: any): void;
     error(message: string, error?: Error, data?: any): void;
     
     startTimer(operation: string): () => void;
     child(context: string): Logger;
     
     // Output to console, file, or external service
     setOutput(output: LogOutput): void;
   }
   ```

2. Create src/utils/MetricsCollector.ts:
   ```typescript
   export interface Metrics {
     assetsCreated: number;
     assetsMigrated: Record<string, number>; // by layer
     assetsTransferred: number;
     operationTimes: Record<string, { count: number; total: number; avg: number }>;
     errors: Record<string, number>;
     cacheStats?: { hits: number; misses: number; hitRate: number };
   }
   
   export class MetricsCollector {
     recordOperation(operation: string, duration: number): void;
     recordError(code: string): void;
     recordAssetCreated(): void;
     recordMigration(from: LayerType, to: LayerType): void;
     recordTransfer(): void;
     
     getMetrics(): Metrics;
     reset(): void;
     export(): string; // JSON or Prometheus format
   }
   ```

3. Integrate with Event System:
   - Subscribe to all events
   - Auto-log events at appropriate levels
   - Collect metrics from events
   - Make subscription configurable

4. Add to OriginalsSDK:
   ```typescript
   public readonly logger: Logger;
   public readonly metrics: MetricsCollector;
   ```

5. Add throughout SDK:
   - Log start/end of major operations
   - Log performance metrics
   - Log errors with context
   - Log warnings for deprecated features

6. Configuration in OriginalsConfig:
   ```typescript
   logging?: {
     level: LogLevel;
     outputs: LogOutput[];
     includeTimestamps: boolean;
     includeContext: boolean;
   };
   ```

7. Tests in tests/unit/utils/:
   - Test Logger functionality
   - Test MetricsCollector
   - Test event integration
   - Test performance overhead (<1ms per log)

8. Documentation in TELEMETRY.md:
   - How to configure logging
   - Available metrics
   - Integration with monitoring tools
   - Examples

CONSTRAINTS:
- Logging must not impact performance (async where possible)
- No sensitive data in logs (sanitize)
- Support popular logging backends (Winston, Pino)

VALIDATION:
1. bun test tests/unit/utils/
2. Check performance overhead
3. Verify log output formatting
4. Test metrics accuracy

OUTPUT:
Provide:
1. Metrics collected
2. Log levels used
3. Performance impact
4. Integration points
```

**Success Criteria**:
- [ ] Tests pass
- [ ] Performance overhead <1ms
- [ ] Metrics accurate
- [ ] Event integration works
- [ ] Documentation complete

---

## Phase 2: Core Features

### TASK 2.1: Batch Operations

**Agent Role**: Backend Developer

**Context Files to Provide**:
```
- src/lifecycle/LifecycleManager.ts
- src/lifecycle/OriginalsAsset.ts
- tests/integration/CompleteLifecycle.e2e.test.ts
- Task 1.1 output (Event System)
- Task 1.2 output (Validation)
```

**Exact Prompt**:
```
You are implementing batch operations for the Originals SDK to enable efficient processing of multiple assets.

OBJECTIVE:
Add batch operation support with proper error handling, atomicity options, and significant cost savings for batch inscriptions.

REQUIREMENTS:

1. Create src/lifecycle/BatchOperations.ts:
   ```typescript
   export interface BatchResult<T> {
     successful: Array<{ index: number; result: T; duration: number }>;
     failed: Array<{ index: number; error: Error; duration: number }>;
     totalProcessed: number;
     totalDuration: number;
   }
   
   export interface BatchOperationOptions {
     continueOnError?: boolean; // Default: false (fail fast)
     maxConcurrent?: number; // Default: 1 (sequential)
     retryCount?: number; // Default: 0
     retryDelay?: number; // Default: 1000ms
   }
   
   export class BatchOperationExecutor {
     constructor(private config: BatchOperationOptions);
     
     async execute<T>(
       items: any[],
       operation: (item: any, index: number) => Promise<T>
     ): Promise<BatchResult<T>>;
   }
   ```

2. Add batch methods to LifecycleManager:
   ```typescript
   async batchCreateAssets(
     resourcesList: AssetResource[][],
     options?: BatchOperationOptions
   ): Promise<BatchResult<OriginalsAsset>>
   
   async batchPublishToWeb(
     assets: OriginalsAsset[],
     domain: string,
     options?: BatchOperationOptions
   ): Promise<BatchResult<OriginalsAsset>>
   
   async batchInscribeOnBitcoin(
     assets: OriginalsAsset[],
     feeRate?: number,
     options?: BatchOperationOptions & { 
       singleTransaction?: boolean; // KEY FEATURE
     }
   ): Promise<BatchResult<OriginalsAsset>>
   
   async batchTransferOwnership(
     transfers: Array<{ asset: OriginalsAsset; to: string }>,
     options?: BatchOperationOptions
   ): Promise<BatchResult<BitcoinTransaction>>
   ```

3. Special handling for batchInscribeOnBitcoin with singleTransaction:
   - Create ONE Bitcoin transaction with multiple inscriptions
   - Split fees proportionally among assets
   - Use batch inscription ID in provenance
   - All inscriptions succeed or all fail (atomic)
   - Should save 30%+ on fees vs individual inscriptions

4. Event emissions:
   - Emit 'batch:started' event
   - Emit individual operation events
   - Emit 'batch:completed' or 'batch:failed'
   - Include batch metadata (ID, count, duration)

5. Error handling:
   - Detailed error per failed item
   - Partial success tracking
   - Rollback capability for atomic operations
   - Preserve individual provenance even in batch

6. Validation:
   - Pre-validate all items before starting
   - Return ValidationResult for each item
   - Support dry-run for entire batch

7. Tests in tests/unit/lifecycle/BatchOperations.test.ts:
   - Batch create (all succeed)
   - Batch create (some fail, continueOnError: true)
   - Batch create (some fail, continueOnError: false)
   - Batch publish with storage errors
   - Batch inscribe single transaction mode
   - Batch inscribe individual transaction mode
   - Concurrent execution limits
   - Retry logic
   - Event emissions

8. Integration tests in tests/integration/BatchOperations.test.ts:
   - Complete batch lifecycle
   - Cost comparison (batch vs individual)
   - Performance benchmarks

9. Documentation in BATCH_OPERATIONS.md:
   - Usage examples
   - Cost savings comparison
   - Error handling patterns
   - Performance guidelines

CONSTRAINTS:
- Batch operations must not break individual operations
- Single transaction mode must be Bitcoin-specific
- Performance should scale linearly
- Memory usage must be bounded (don't load all in memory)

VALIDATION:
1. bun test tests/unit/lifecycle/BatchOperations.test.ts
2. bun test tests/integration/BatchOperations.test.ts
3. Verify cost savings (30%+ for batch inscriptions)
4. Check memory usage with large batches (1000+ items)

OUTPUT:
Provide:
1. Cost savings analysis (batch vs individual)
2. Performance benchmarks
3. Memory usage profile
4. Error handling examples
```

**Success Criteria**:
- [ ] All tests pass
- [ ] Batch inscription saves 30%+ on fees
- [ ] Error handling works correctly
- [ ] Events emitted properly
- [ ] Documentation complete with cost analysis

---

### TASK 2.2: Resource Versioning System

**Agent Role**: Backend Developer

**Context Files to Provide**:
```
- src/lifecycle/OriginalsAsset.ts
- src/lifecycle/LifecycleManager.ts
- src/types/common.ts
- tests/unit/lifecycle/OriginalsAsset.test.ts
```

**Exact Prompt**:
```
You are implementing resource versioning to track changes to resources while maintaining immutability guarantees.

OBJECTIVE:
Add version tracking for resources with the constraint that updates are only allowed in the did:peer layer (before publication).

REQUIREMENTS:

1. Update AssetResource in src/types/common.ts:
   ```typescript
   export interface AssetResource {
     id: string;
     type: string;
     url?: string;
     content?: string;
     contentType: string;
     hash: string;
     size?: number;
     version?: number; // NEW: Default 1
     previousVersionHash?: string; // NEW: Hash of previous version
   }
   ```

2. Create src/lifecycle/ResourceVersioning.ts:
   ```typescript
   export interface ResourceVersion {
     version: number;
     hash: string;
     timestamp: string;
     changes?: string;
     contentType: string;
   }
   
   export interface ResourceHistory {
     resourceId: string;
     versions: ResourceVersion[];
     currentVersion: ResourceVersion;
   }
   
   export class ResourceVersionManager {
     addVersion(
       resourceId: string,
       hash: string,
       contentType: string,
       changes?: string
     ): void;
     
     getHistory(resourceId: string): ResourceHistory | null;
     getVersion(resourceId: string, version: number): ResourceVersion | null;
     getCurrentVersion(resourceId: string): ResourceVersion | null;
     
     toJSON(): object;
   }
   ```

3. Add to OriginalsAsset:
   ```typescript
   private versionManager: ResourceVersionManager;
   
   updateResource(
     resourceId: string,
     newContent: string | Buffer,
     changes?: string
   ): void {
     // 1. Validate asset is in did:peer layer
     if (this.currentLayer !== 'did:peer') {
       throw new Error('Resource updates only allowed in did:peer layer');
     }
     
     // 2. Find resource
     // 3. Compute new hash
     // 4. Update resource with new version
     // 5. Track in version manager
     // 6. Emit 'resource:updated' event
   }
   
   getResourceHistory(resourceId: string): ResourceHistory | null;
   
   rollbackResource(resourceId: string, toVersion: number): void {
     // Only in did:peer layer
   }
   ```

4. Add to ProvenanceChain:
   ```typescript
   resourceUpdates: Array<{
     resourceId: string;
     fromVersion: number;
     toVersion: number;
     timestamp: string;
     changes?: string;
   }>;
   ```

5. Update CredentialManager to issue update credentials:
   ```typescript
   async createResourceUpdatedCredential(
     resourceId: string,
     fromVersion: number,
     toVersion: number,
     changes: string,
     issuer: string
   ): Promise<VerifiableCredential>
   ```

6. Validation rules:
   - Prevent updates after migration to webvh/btco
   - Ensure version numbers are sequential
   - Verify previousVersionHash matches actual previous
   - Validate new hash differs from old hash

7. Tests in tests/unit/lifecycle/ResourceVersioning.test.ts:
   - Create asset and update resource (should work)
   - Publish asset and attempt update (should fail)
   - Inscribe asset and attempt update (should fail)
   - Version history tracking
   - Rollback functionality
   - Credential issuance
   - Provenance tracking

8. Documentation in RESOURCE_VERSIONING.md:
   - When to use versioning
   - Version control best practices
   - Migration considerations
   - API examples

CONSTRAINTS:
- Updates ONLY in did:peer layer
- Version numbers must be sequential
- Hash must change between versions
- Immutability preserved after migration

VALIDATION:
1. bun test tests/unit/lifecycle/ResourceVersioning.test.ts
2. Verify updates blocked after migration
3. Check version history integrity
4. Test rollback functionality

OUTPUT:
Provide:
1. Version tracking implementation summary
2. Layer restriction validation
3. Provenance integration
4. Example use cases
```

**Success Criteria**:
- [ ] Tests pass
- [ ] Updates only work in did:peer
- [ ] Version history complete
- [ ] Rollback works
- [ ] Provenance tracks changes
- [ ] Documentation clear

---

## Prompt Templates for Quick Use

### Template: New Feature Implementation

```
You are implementing [FEATURE NAME] for the Originals SDK.

CONTEXT:
[Provide 2-3 sentences about why this feature is needed]

OBJECTIVE:
[Single clear objective statement]

REQUIREMENTS:
1. [First requirement with code example if applicable]
2. [Second requirement]
...

CONSTRAINTS:
- [Performance constraint]
- [Compatibility constraint]
- [Security constraint]

TESTS REQUIRED:
- [Unit test requirements]
- [Integration test requirements]

DOCUMENTATION:
- [What needs to be documented]

VALIDATION:
1. Run: [test command]
2. Verify: [specific checks]

OUTPUT:
Provide summary of:
1. Files created/modified
2. Key decisions made
3. Test coverage
4. Any deviations from requirements
```

### Template: Bug Fix

```
You are fixing a bug in the Originals SDK.

BUG DESCRIPTION:
[Describe the bug behavior]

EXPECTED BEHAVIOR:
[Describe what should happen]

ROOT CAUSE:
[If known, describe the root cause]

FIX REQUIREMENTS:
1. [What needs to change]
2. [How to prevent regression]

TESTS:
- Add test that reproduces the bug
- Add regression tests

VALIDATION:
1. Reproduce bug before fix
2. Apply fix
3. Verify bug is resolved
4. Run all tests

OUTPUT:
1. Root cause analysis
2. Fix description
3. Test coverage
4. Regression prevention measures
```

### Template: Refactoring

```
You are refactoring [COMPONENT] in the Originals SDK.

CURRENT STATE:
[Describe current implementation]

PROBLEMS:
1. [Problem with current implementation]
2. [Another problem]

TARGET STATE:
[Describe desired implementation]

REQUIREMENTS:
1. Maintain 100% backward compatibility
2. Improve [metric] by [target]
3. [Other requirements]

APPROACH:
1. [Step 1]
2. [Step 2]
...

VALIDATION:
1. All existing tests must still pass
2. No breaking changes
3. Performance improvement verified
4. Code coverage maintained

OUTPUT:
1. Performance comparison
2. Code complexity metrics
3. Breaking changes (should be none)
```

---

## Agent Coordination Workflow

### Workflow 1: Sequential Dependent Tasks

```
Agent A (Task X.1)
    ↓ [completes]
    ↓ [output provided to Agent B]
Agent B (Task X.2)
    ↓ [completes]
    ↓ [output provided to Agent C]
Agent C (Task X.3)
```

**Example**: Event System → Logging Integration
1. Agent A implements event system
2. Agent A's output (event types, EventEmitter class) provided to Agent B
3. Agent B implements logging integration using events

### Workflow 2: Parallel Independent Tasks

```
Agent A (Task X.1) ─┐
Agent B (Task X.2) ─┼─→ [Integration Agent]
Agent C (Task X.3) ─┘
```

**Example**: Batch Operations + Resource Versioning + Provenance Query
1. Three agents work in parallel
2. Integration agent merges and resolves conflicts
3. Integration tests run across all features

### Workflow 3: Review and Iteration

```
Agent implements → Validation fails → Agent revises → Validation passes
```

**Process**:
1. Agent submits implementation
2. Automated tests run
3. If failures: provide test output to agent for fixes
4. If passes: move to code review

---

## Validation Checklist

### For Every Task

```markdown
## Implementation Checklist
- [ ] All required files created
- [ ] All required functions implemented
- [ ] JSDoc comments added
- [ ] No TypeScript errors
- [ ] No linter warnings

## Testing Checklist
- [ ] Unit tests written
- [ ] Unit tests pass
- [ ] Integration tests written (if applicable)
- [ ] Integration tests pass
- [ ] Test coverage ≥ 90%

## Documentation Checklist
- [ ] README updated (if applicable)
- [ ] API docs updated
- [ ] Examples provided
- [ ] Migration guide (if breaking changes)

## Quality Checklist
- [ ] Code follows existing patterns
- [ ] No code duplication
- [ ] Error handling implemented
- [ ] Performance acceptable
- [ ] Security considerations addressed

## Integration Checklist
- [ ] No breaking changes (or documented)
- [ ] Backward compatible
- [ ] Works with existing features
- [ ] Events emitted (if applicable)
```

### Automated Validation Commands

```bash
# Type checking
bun run type-check

# Linting
bun run lint

# Unit tests
bun test tests/unit/

# Integration tests
bun test tests/integration/

# Coverage
bun test --coverage

# Performance benchmarks (if applicable)
bun run benchmark

# Build
bun run build

# All checks
bun run validate-all
```

---

## Agent Communication Protocol

### Status Updates

**Format**:
```markdown
## Status Update: Task X.X

**Status**: [In Progress | Blocked | Complete | Needs Review]

**Progress**: X% complete

**Completed**:
- [Item 1]
- [Item 2]

**In Progress**:
- [Item 3]

**Next Steps**:
- [Step 1]
- [Step 2]

**Blockers** (if any):
- [Blocker description]
- [Dependency on Task Y.Y]

**Questions** (if any):
- [Question 1]
```

### Code Review Requests

**Format**:
```markdown
## Code Review Request: Task X.X

**PR Link**: [URL]

**Changes Summary**:
- [High-level change 1]
- [High-level change 2]

**Files Changed**: X files

**Tests Added**: Y tests

**Key Decisions**:
1. [Decision 1 and rationale]
2. [Decision 2 and rationale]

**Areas for Review**:
- [Specific area 1]
- [Specific area 2]

**Checklist**:
- [ ] All tests pass
- [ ] Documentation updated
- [ ] No breaking changes
- [ ] Performance acceptable
```

---

## Common Issues and Solutions

### Issue: Tests Failing

**Agent Prompt**:
```
The tests for Task X.X are failing. Here are the test results:

[Paste test output]

Please analyze the failures and provide fixes. Focus on:
1. Understanding the root cause
2. Fixing the implementation
3. Ensuring no regressions
4. Adding additional tests if the issue wasn't covered

Provide the fixed code and explanation of what was wrong.
```

### Issue: Performance Problem

**Agent Prompt**:
```
The implementation of Task X.X is working but too slow. 

Current performance: [X ms]
Target performance: [Y ms]

Benchmark results:
[Paste benchmark output]

Please optimize the implementation to meet the performance target. Consider:
1. Algorithmic improvements
2. Caching strategies
3. Lazy evaluation
4. Parallelization

Provide optimized code and performance comparison.
```

### Issue: Integration Conflict

**Agent Prompt**:
```
Task X.X conflicts with Task Y.Y in the following ways:

[Describe conflicts]

Please resolve these conflicts by:
1. Analyzing both implementations
2. Proposing a unified approach
3. Updating both tasks as needed
4. Ensuring tests for both pass

Provide conflict resolution plan and updated code.
```

---

## Quality Gates

### Gate 1: Implementation Complete
- [ ] All required files present
- [ ] Code compiles without errors
- [ ] No TODO comments remaining
- [ ] No console.log debugging statements

### Gate 2: Tests Pass
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] Test coverage ≥ 90%
- [ ] No flaky tests

### Gate 3: Documentation Complete
- [ ] All public APIs documented
- [ ] Examples provided
- [ ] README updated
- [ ] Migration guide (if needed)

### Gate 4: Code Quality
- [ ] Linter passes
- [ ] Type checking passes
- [ ] No code duplication
- [ ] Follows existing patterns

### Gate 5: Integration
- [ ] No breaking changes (or documented)
- [ ] Works with existing features
- [ ] Performance acceptable
- [ ] Security review passed

---

## Example: Complete Agent Interaction

### Initial Prompt to Agent

```
You are implementing the Event System (Task 1.1) for the Originals SDK.

I'm providing you with the following context files:
- src/lifecycle/OriginalsAsset.ts
- src/lifecycle/LifecycleManager.ts
- src/core/OriginalsSDK.ts

[Context files content]

Please implement the event system according to the requirements in AI_AGENT_BUILD_PLAN.md, Task 1.1.

Start by:
1. Reading the existing code to understand the lifecycle operations
2. Identifying all points where events should be emitted
3. Designing the event type hierarchy
4. Implementing the EventEmitter class
5. Integrating into existing classes
6. Writing comprehensive tests

Proceed with the implementation now.
```

### Agent Response

```
I'll implement the event system for the Originals SDK. Here's my approach:

1. Event Design:
   - Base Event interface with common fields
   - Specific event types for each lifecycle operation
   - Type-safe event handlers

2. Implementation Plan:
   [Agent provides detailed plan]

3. Integration Points:
   [Agent lists where events will be emitted]

Let me proceed with the implementation...

[Agent implements code]

Here's what I've created:

Files Created:
- src/events/EventEmitter.ts
- src/events/types.ts
- src/events/index.ts
- tests/unit/events/EventEmitter.test.ts
- tests/integration/Events.test.ts
- EVENTS.md

[Agent provides code snippets and explanations]

Test Results:
[Agent shows test output]

All tests passing ✓

Ready for review.
```

### Validation

```
Thank you for the implementation. Let me validate:

1. Running tests:
   $ bun test tests/unit/events/
   ✓ All tests pass

2. Running integration tests:
   $ bun test tests/integration/Events.test.ts
   ✓ All tests pass

3. Type checking:
   $ bun run type-check
   ✓ No errors

4. Performance check:
   Event emission overhead: 0.3ms ✓ (target: <1ms)

5. Documentation check:
   ✓ EVENTS.md complete
   ✓ All event types documented
   ✓ Examples provided

Implementation approved! Please create a PR with:
- Branch: phase-1/task-1.1-event-system
- Title: "feat: implement event system for asset lifecycle"
- Description: [use PR template]
```

---

## Metrics and Tracking

### Per-Task Metrics

Track for each task:
- **Time to Complete**: Actual hours vs estimated
- **Test Coverage**: Percentage covered
- **Review Iterations**: Number of revisions needed
- **Performance Impact**: Benchmarks before/after
- **Documentation Quality**: Completeness score

### Overall Project Metrics

- **Tasks Completed**: X / Y
- **Tests Passing**: X / Y
- **Code Coverage**: X%
- **Performance**: Within targets ✓/✗
- **Documentation**: X% complete
- **Bugs Found**: X (in testing)
- **Bugs in Production**: X (goal: 0)

### Weekly Dashboard

```markdown
## Week X Summary

**Phase**: [Phase number and name]

**Completed Tasks**:
- Task X.1: [Name] ✓
- Task X.2: [Name] ✓

**In Progress Tasks**:
- Task X.3: [Name] (75% complete)

**Blocked Tasks**:
- Task X.4: [Name] (waiting for Task X.3)

**Metrics**:
- Tests Passing: 145/145 (100%)
- Code Coverage: 92%
- Performance: All targets met ✓
- Documentation: 85% complete

**Next Week**:
- Complete Task X.3
- Start Tasks Y.1, Y.2, Y.3
- Integration testing for Phase X
```

---

## Emergency Procedures

### Critical Bug Found

```
URGENT: Critical bug found in [component]

Severity: [Critical | High | Medium]

Impact: [Description of impact]

Steps to Reproduce:
1. [Step 1]
2. [Step 2]

Expected vs Actual:
Expected: [Expected behavior]
Actual: [Actual behavior]

Immediate Actions Needed:
1. [Action 1]
2. [Action 2]

Assign to: [Agent with relevant expertise]

Priority: Drop all other work until resolved
```

### Integration Failure

```
Integration test failed after merging Tasks X.1 and X.2

Failed Tests:
[List of failed tests]

Error Output:
[Error messages]

Root Cause Analysis Needed:
- Identify conflicting changes
- Determine correct behavior
- Propose resolution

Agents Involved:
- Agent A (Task X.1)
- Agent B (Task X.2)
- Integration Agent

Next Steps:
1. Both agents review conflict
2. Propose resolution jointly
3. Implement fix
4. Re-run integration tests
```

---

## Success Celebration 🎉

### Task Completion

```markdown
🎉 Task X.X Complete!

Congratulations on completing [Task Name]!

**Achievement Stats**:
- Time: Completed in [X] hours (estimated: [Y] hours)
- Tests: [X] tests added, all passing ✓
- Coverage: [X]% (exceeded target!)
- Performance: [X] improvement over target
- Documentation: Complete and comprehensive ✓

**Impact**:
This task enables:
- [Impact 1]
- [Impact 2]

**Next Steps**:
Your code is merged and ready for the next phase!

Thank you for your excellent work! 🚀
```

### Phase Completion

```markdown
🏆 Phase X Complete!

All tasks in [Phase Name] are done!

**Phase Stats**:
- Tasks Completed: [X]/[X] ✓
- Total Tests: [X] tests, all passing
- Coverage: [X]%
- Performance: All targets exceeded
- Documentation: 100% complete

**Deliverables**:
- [Deliverable 1] ✓
- [Deliverable 2] ✓

**Ready for**:
- Phase [X+1]: [Next phase name]

Excellent work, team! On to the next phase! 🚀
```

---

This guide provides everything needed to execute the build plan with AI agents. Each agent receives clear instructions, knows exactly what to build, how to validate it, and how to communicate progress.

