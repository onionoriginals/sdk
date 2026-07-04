/**
 * MigrationManager - Main orchestrator for DID layer migrations
 * Coordinates validation, checkpoints, rollbacks, state tracking, and audit logging
 */

import {
  MigrationOptions,
  MigrationResult,
  MigrationStateEnum,
  MigrationError,
  MigrationErrorType,
  BatchMigrationOptions,
  BatchMigrationResult,
  CostEstimate
} from './types.js';
import { OriginalsConfig } from '../types/index.js';
import { DIDManager } from '../did/DIDManager.js';
import { CredentialManager } from '../vc/CredentialManager.js';
import { BitcoinManager } from '../bitcoin/BitcoinManager.js';
import { ValidationPipeline } from './validation/ValidationPipeline.js';
import { CheckpointManager } from './checkpoint/CheckpointManager.js';
import { RollbackManager } from './rollback/RollbackManager.js';
import { StateTracker } from './state/StateTracker.js';
import { AuditLogger, AuditSignerConfig } from './audit/AuditLogger.js';
import { PeerToWebvhMigration } from './operations/PeerToWebvhMigration.js';
import { WebvhToBtcoMigration } from './operations/WebvhToBtcoMigration.js';
import { PeerToBtcoMigration } from './operations/PeerToBtcoMigration.js';
import { EventEmitter } from '../events/EventEmitter.js';

export class MigrationManager {
  private static instance: MigrationManager | null = null;

  /**
   * DIDs with a migration currently in flight. Set synchronously before the
   * first await in migrate() so two concurrent migrate() calls for the same
   * sourceDid cannot both pass the guard and double-pay for two inscriptions
   * (issue #255).
   */
  private inFlightSourceDids = new Set<string>();

  private validationPipeline: ValidationPipeline;
  private checkpointManager: CheckpointManager;
  private rollbackManager: RollbackManager;
  private stateTracker: StateTracker;
  private auditLogger: AuditLogger;
  private eventEmitter: EventEmitter;

  // Migration operation handlers
  private peerToWebvh: PeerToWebvhMigration;
  private webvhToBtco: WebvhToBtcoMigration;
  private peerToBtco: PeerToBtcoMigration;

  private constructor(
    private config: OriginalsConfig,
    private didManager: DIDManager,
    private credentialManager: CredentialManager,
    private bitcoinManager?: BitcoinManager
  ) {
    // Initialize components
    this.validationPipeline = new ValidationPipeline(
      config,
      didManager,
      credentialManager,
      bitcoinManager
    );
    this.checkpointManager = new CheckpointManager(config, didManager, credentialManager);
    this.stateTracker = new StateTracker(config);
    this.rollbackManager = new RollbackManager(config, this.checkpointManager, didManager);
    // Sign audit records with Ed25519 when the config supplies signer material;
    // otherwise the AuditLogger falls back to a keyless SHA-256 integrity hash.
    const auditSigner = (config as { auditSigner?: AuditSignerConfig }).auditSigner;
    this.auditLogger = new AuditLogger(config, auditSigner);
    this.eventEmitter = new EventEmitter();

    // Initialize migration operations
    this.peerToWebvh = new PeerToWebvhMigration(config, didManager, credentialManager, this.stateTracker);

    if (bitcoinManager) {
      this.webvhToBtco = new WebvhToBtcoMigration(config, didManager, credentialManager, this.stateTracker, bitcoinManager);
      this.peerToBtco = new PeerToBtcoMigration(config, didManager, credentialManager, this.stateTracker, bitcoinManager);
    } else {
      // Create stub implementations that throw errors
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
      this.webvhToBtco = null as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
      this.peerToBtco = null as any;
    }
  }

  /**
   * Get singleton instance
   */
  static getInstance(
    config?: OriginalsConfig,
    didManager?: DIDManager,
    credentialManager?: CredentialManager,
    bitcoinManager?: BitcoinManager
  ): MigrationManager {
    if (!MigrationManager.instance) {
      if (!config || !didManager || !credentialManager) {
        throw new Error('Configuration and managers required for first initialization');
      }
      MigrationManager.instance = new MigrationManager(config, didManager, credentialManager, bitcoinManager);
    }
    return MigrationManager.instance;
  }

  /**
   * Reset singleton instance (primarily for testing)
   */
  static resetInstance(): void {
    MigrationManager.instance = null;
  }

  /**
   * Main migration method
   */
  async migrate(options: MigrationOptions): Promise<MigrationResult> {
    const startTime = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let migrationState: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let checkpoint: any;

    // Tracks whether THIS call claimed the in-flight lock: the finally block
    // must not release a lock owned by a concurrent winner when this call is
    // rejected by the guard below.
    let claimedInFlightLock = false;

    try {
      // Concurrency guard (issue #255): reject a second migration of the same
      // DID while one is in flight. The set is mutated synchronously (before
      // any await), so concurrent callers cannot interleave past this check.
      // Inside the try block so the rejection flows through
      // handleMigrationFailure and resolves to a structured MigrationResult
      // (success: false, code MIGRATION_IN_PROGRESS) like every other
      // operational failure, instead of rejecting the promise.
      // estimateCostOnly requests are read-only and exempt.
      if (!options.estimateCostOnly) {
        if (this.inFlightSourceDids.has(options.sourceDid)) {
          throw this.createMigrationError(
            MigrationErrorType.VALIDATION_ERROR,
            'MIGRATION_IN_PROGRESS',
            `A migration for ${options.sourceDid} is already in progress; concurrent migrations of the same DID would double-pay for duplicate inscriptions`,
            'not-started'
          );
        }
        this.inFlightSourceDids.add(options.sourceDid);
        claimedInFlightLock = true;
      }

      // estimateCostOnly (issue #254): "Return cost estimate without
      // migrating". Validation only — no tracked migration state, no events,
      // no checkpoint. Creating a state entry here would leave a phantom
      // non-terminal migration that getMigrationStatus reports as in-progress
      // forever and cleanupOldStates never reclaims.
      if (options.estimateCostOnly) {
        const estimateValidation = await this.validationPipeline.validate(options);
        if (!estimateValidation.valid) {
          throw this.createMigrationError(
            MigrationErrorType.VALIDATION_ERROR,
            'VALIDATION_FAILED',
            `Migration validation failed: ${estimateValidation.errors.map(e => e.message).join(', ')}`,
            'estimate-only',
            { errors: estimateValidation.errors }
          );
        }
        return {
          migrationId: `estimate_${startTime}`,
          success: true,
          sourceDid: options.sourceDid,
          targetDid: undefined,
          sourceLayer: this.extractLayer(options.sourceDid),
          targetLayer: options.targetLayer,
          state: MigrationStateEnum.COMPLETED,
          duration: Date.now() - startTime,
          cost: estimateValidation.estimatedCost
        };
      }

      // Step 1: Create migration state
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      migrationState = await this.stateTracker.createMigration(options);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const migrationId = migrationState.migrationId;

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      await this.emitEvent('migration:started', { migrationId, options });

      // Step 2: Validate migration
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      await this.stateTracker.updateState(migrationId, {
        state: MigrationStateEnum.VALIDATING,
        currentOperation: 'Validating migration',
        progress: 10
      });

      const validationResult = await this.validationPipeline.validate(options);

      if (!validationResult.valid) {
        throw this.createMigrationError(
          MigrationErrorType.VALIDATION_ERROR,
          'VALIDATION_FAILED',
          `Migration validation failed: ${validationResult.errors.map(e => e.message).join(', ')}`,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          migrationId,
          { errors: validationResult.errors }
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      await this.emitEvent('migration:validated', { migrationId, validationResult });

      // Step 3: Create checkpoint
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      await this.stateTracker.updateState(migrationId, {
        state: MigrationStateEnum.CHECKPOINTED,
        currentOperation: 'Creating checkpoint',
        progress: 20
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment
      checkpoint = await this.checkpointManager.createCheckpoint(migrationId, options);

      // Persist checkpointId immediately so rollback can locate it
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      await this.stateTracker.updateState(migrationId, {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        checkpointId: checkpoint.checkpointId
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      await this.emitEvent('migration:checkpointed', { migrationId, checkpointId: checkpoint.checkpointId });

      // Step 4: Execute migration
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const migration = this.getMigrationOperation(options);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument
      const result = await migration.executeMigration(options, migrationId);

      // Step 5: Complete migration
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      await this.stateTracker.updateState(migrationId, {
        state: MigrationStateEnum.COMPLETED,
        currentOperation: 'Completed',
        progress: 100,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        targetDid: result.targetDid
      });

      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      await this.emitEvent('migration:completed', { migrationId, targetDid: result.targetDid });

      // Step 6: Create audit record
      const duration = Date.now() - startTime;
      const auditRecord = {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        migrationId,
        timestamp: startTime,
        initiator: 'system',
        sourceDid: options.sourceDid,
        sourceLayer: this.extractLayer(options.sourceDid),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        targetDid: result.targetDid,
        targetLayer: options.targetLayer,
        finalState: MigrationStateEnum.COMPLETED,
        validationResults: validationResult,
        costActual: validationResult.estimatedCost,
        duration,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        checkpointId: checkpoint.checkpointId,
        errors: [],
        metadata: options.metadata || {}
      };

      // Record a signed audit entry for the migration. The migration has
      // already completed and its side effects are committed, so a failure to
      // write the audit record must NOT re-enter the failure/rollback path
      // (which would roll back a successful migration and report it as failed,
      // risking a double-inscription on retry). Instead, surface the failure on
      // the result (auditPersisted/auditError) so callers can detect the lost
      // audit trail and retry the write, rather than only logging to console.
      let auditPersisted = true;
      let auditErrorMessage: string | undefined;
      try {
        await this.auditLogger.logMigration(auditRecord as any);
      } catch (auditError) {
        auditPersisted = false;
        auditErrorMessage = auditError instanceof Error ? auditError.message : String(auditError);
        console.error('Failed to record audit for completed migration:', auditError);
      }

      // Clean up checkpoint after successful migration. unref() the timer so
      // a successful migration does not pin the process alive for 24 hours
      // (CLI scripts and tests would otherwise hang until the timer fired).
      const cleanupTimer = setTimeout(() => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-floating-promises
        this.checkpointManager.deleteCheckpoint(checkpoint.checkpointId);
      }, 24 * 60 * 60 * 1000); // Delete after 24 hours
      cleanupTimer.unref?.();

      return {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        migrationId,
        success: true,
        sourceDid: options.sourceDid,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        targetDid: result.targetDid,
        sourceLayer: this.extractLayer(options.sourceDid),
        targetLayer: options.targetLayer,
        state: MigrationStateEnum.COMPLETED,
        duration,
        cost: validationResult.estimatedCost,
        auditRecord,
        auditPersisted,
        ...(auditErrorMessage ? { auditError: auditErrorMessage } : {})
      };
    } catch (error) {
      // Handle migration failure
      return await this.handleMigrationFailure(
        error,
        options,
        migrationState,
        checkpoint,
        startTime
      );
    } finally {
      if (claimedInFlightLock) {
        this.inFlightSourceDids.delete(options.sourceDid);
      }
    }
  }

  /**
   * Estimate migration cost without executing
   */
  async estimateMigrationCost(sourceDid: string, targetLayer: string, feeRate?: number): Promise<CostEstimate> {
    const options: MigrationOptions = {
      sourceDid,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
      targetLayer: targetLayer as any,
      feeRate,
      estimateCostOnly: true
    };

    const validationResult = await this.validationPipeline.validate(options);
    return validationResult.estimatedCost;
  }

  /**
   * Get migration status
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getMigrationStatus(migrationId: string): Promise<any> {
    return await this.stateTracker.getState(migrationId);
  }

  /**
   * Rollback a migration.
   *
   * Note: rolling back a migration that has already reached the terminal
   * COMPLETED state is NOT reflected in `getMigrationStatus()` — the state
   * machine treats COMPLETED as terminal (COMPLETED → ROLLED_BACK is not a
   * valid transition), and the layer-specific rollback is currently a
   * best-effort check rather than a true undo of published/inscribed
   * resources. `getMigrationStatus()` therefore continues to report COMPLETED;
   * consult the returned RollbackResult for the outcome of the rollback
   * itself. Rollback of a non-terminal (e.g. FAILED) migration IS reflected.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async rollback(migrationId: string): Promise<any> {
    const state = await this.stateTracker.getState(migrationId);
    if (!state || !state.checkpointId) {
      throw new Error(`Migration ${migrationId} not found or has no checkpoint`);
    }

    const rollbackResult = await this.rollbackManager.rollback(migrationId, state.checkpointId);

    // Reflect the rollback outcome in the tracked state when the transition is
    // permitted (e.g. FAILED → ROLLED_BACK). For a terminal COMPLETED migration
    // the transition is intentionally rejected by the state machine; that is an
    // expected, documented no-op (see the method doc), so it is not logged as
    // an error.
    if (this.stateTracker.canTransitionTo(state.state, rollbackResult.restoredState)) {
      await this.stateTracker.updateState(migrationId, { state: rollbackResult.restoredState });
    }

    await this.emitEvent('migration:rolledback', { migrationId, rollbackResult });

    return rollbackResult;
  }

  /**
   * Get migration history for a DID. Records are signed (Ed25519 when a signer
   * is configured, otherwise a keyless SHA-256 integrity hash).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getMigrationHistory(did: string): Promise<any[]> {
    return this.auditLogger.getMigrationHistory(did);
  }

  /**
   * Batch migration
   */
  async migrateBatch(dids: string[], targetLayer: string, options?: BatchMigrationOptions): Promise<BatchMigrationResult> {
    const startTime = Date.now();
    const batchId = `batch_${startTime}`;
    const results = new Map<string, MigrationResult>();
    const errors: MigrationError[] = [];

    let completed = 0;
    let failed = 0;
    const total = dids.length;

    for (const did of dids) {
      try {
        const migrationOptions: MigrationOptions = {
          sourceDid: did,
          targetLayer: targetLayer as any,
          ...options
        };

        const result = await this.migrate(migrationOptions);
        results.set(did, result);

        if (result.success) {
          completed++;
        } else {
          failed++;
        }
      } catch (error) {
        failed++;
        const migrationError: MigrationError = {
          type: MigrationErrorType.UNKNOWN_ERROR,
          code: 'BATCH_MIGRATION_ERROR',
          message: error instanceof Error ? error.message : String(error),
          sourceDid: did,
          timestamp: Date.now()
        };
        errors.push(migrationError);

        if (!options?.continueOnError) {
          break;
        }
      }
    }

    return {
      batchId,
      total,
      completed,
      failed,
      inProgress: 0,
      results,
      overallProgress: (completed + failed) / total * 100,
      startTime,
      errors
    };
  }

  /**
   * Handle migration failure with automatic rollback
   */
  private async handleMigrationFailure(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    error: any,
    options: MigrationOptions,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    migrationState: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    checkpoint: any,
    startTime: number
  ): Promise<MigrationResult> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const migrationId = migrationState?.migrationId || `mig_failed_${Date.now()}`;

    // Capture the operational state at the moment of failure (before we mark
    // it FAILED below): the rollback needs to know whether the migration had
    // reached the ANCHORING step to decide if on-chain side effects can exist.
    let stateAtFailure: MigrationStateEnum | undefined;
    if (migrationState) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        const tracked = await this.stateTracker.getState(migrationId);
        stateAtFailure = tracked?.state;
      } catch {
        stateAtFailure = undefined;
      }
    }

    const migrationError: MigrationError = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      type: error.type || MigrationErrorType.UNKNOWN_ERROR,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      code: error.code || 'MIGRATION_FAILED',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      message: error.message || String(error),
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      technicalDetails: error.stack,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      migrationId,
      sourceDid: options.sourceDid,
      timestamp: Date.now()
    };

    // Update state to failed
    if (migrationState) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        await this.stateTracker.updateState(migrationId, {
          state: MigrationStateEnum.FAILED,
          error: migrationError
        });
      } catch (updateError) {
        console.error('Failed to update migration state:', updateError);
      }
    }

    await this.emitEvent('migration:failed', { migrationId, error: migrationError });

    // Attempt rollback if checkpoint exists. `finalState` is the single source
    // of truth for the tracked state, the returned MigrationResult.state, and
    // the audit record's finalState, so all three agree. It defaults to FAILED
    // (no checkpoint → nothing was rolled back) and is advanced to the
    // rollback's restoredState (ROLLED_BACK on success, QUARANTINED on failure).
    let rollbackSuccess = false;
    let finalState: MigrationStateEnum = MigrationStateEnum.FAILED;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rollbackOutcome: any;
    if (checkpoint) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
        const rollbackResult = await this.rollbackManager.rollback(migrationId, checkpoint.checkpointId, { error, stateAtFailure });
        rollbackOutcome = rollbackResult;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        rollbackSuccess = rollbackResult.success;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        finalState = rollbackResult.restoredState;

        // Advance the tracked state to reflect the rollback outcome
        // (FAILED -> ROLLED_BACK | QUARANTINED, both valid transitions), so
        // getMigrationStatus agrees with the audit record and cleanup can
        // reclaim the entry. Guarded: the current state may already be terminal.
        try {
          await this.stateTracker.updateState(migrationId, { state: finalState });
        } catch (stateError) {
          console.error('Failed to update migration state after rollback:', stateError);
        }

        // PARTIALLY_ROLLED_BACK is an accurate report of irreversible
        // artifacts (e.g. a paid Bitcoin inscription), not a rollback
        // machinery failure — only genuine QUARANTINED outcomes raise the
        // quarantine event.
        if (!rollbackSuccess && finalState === MigrationStateEnum.QUARANTINED) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          await this.emitEvent('migration:quarantine', {
            migrationId,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            checkpointId: checkpoint.checkpointId,
            reason: 'Rollback failed'
          });
        }
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError);
        // The rollback itself threw: the migration needs manual intervention.
        // Mark it QUARANTINED consistently across tracked state, result, and
        // audit (matching the migration:quarantine event emitted below).
        finalState = MigrationStateEnum.QUARANTINED;
        try {
          await this.stateTracker.updateState(migrationId, { state: finalState });
        } catch (stateError) {
          console.error('Failed to update migration state after rollback failure:', stateError);
        }
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        await this.emitEvent('migration:quarantine', {
          migrationId,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
          checkpointId: checkpoint.checkpointId,
          reason: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        });
      }
    }

    // Create audit record
    const duration = Date.now() - startTime;
    const auditRecord = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      migrationId,
      timestamp: startTime,
      initiator: 'system',
      sourceDid: options.sourceDid,
      sourceLayer: this.extractLayer(options.sourceDid),
      targetDid: null,
      targetLayer: options.targetLayer,
      finalState,
      validationResults: {
        valid: false,
        errors: [],
        warnings: [],
        estimatedCost: { storageCost: 0, networkFees: 0, totalCost: 0, estimatedDuration: 0, currency: 'sats' },
        estimatedDuration: 0
      },
      costActual: { storageCost: 0, networkFees: 0, totalCost: 0, estimatedDuration: duration, currency: 'sats' },
      duration,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      checkpointId: checkpoint?.checkpointId || '',
      errors: [migrationError],
      metadata: options.metadata || {}
    };

    // Record a signed audit entry for the failed/rolled-back migration. A
    // logging failure here must not throw out of the failure handler (which
    // would make migrate() reject instead of returning a MigrationResult); it
    // is surfaced on the result instead.
    let auditPersisted = true;
    let auditErrorMessage: string | undefined;
    try {
      await this.auditLogger.logMigration(auditRecord as any);
    } catch (auditError) {
      auditPersisted = false;
      auditErrorMessage = auditError instanceof Error ? auditError.message : String(auditError);
      console.error('Failed to record audit for failed migration:', auditError);
    }

    return {
      migrationId,
      success: false,
      sourceDid: options.sourceDid,
      sourceLayer: this.extractLayer(options.sourceDid),
      targetLayer: options.targetLayer,
      state: finalState,
      duration,
      cost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' },
      auditRecord,
      error: migrationError,
      auditPersisted,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      ...(rollbackOutcome ? { rollback: rollbackOutcome } : {}),
      ...(auditErrorMessage ? { auditError: auditErrorMessage } : {})
    };
  }

  /**
   * Get appropriate migration operation handler
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getMigrationOperation(options: MigrationOptions): any {
    const sourceLayer = this.extractLayer(options.sourceDid);

    if (sourceLayer === 'peer' && options.targetLayer === 'webvh') {
      return this.peerToWebvh;
    }

    if (sourceLayer === 'webvh' && options.targetLayer === 'btco') {
      if (!this.webvhToBtco) {
        throw new Error('Bitcoin manager required for btco migrations');
      }
      return this.webvhToBtco;
    }

    if (sourceLayer === 'peer' && options.targetLayer === 'btco') {
      if (!this.peerToBtco) {
        throw new Error('Bitcoin manager required for btco migrations');
      }
      return this.peerToBtco;
    }

    throw new Error(`Unsupported migration path: ${sourceLayer} → ${options.targetLayer}`);
  }

  /**
   * Extract layer from DID
   */
  private extractLayer(did: string): 'peer' | 'webvh' | 'btco' {
    if (did.startsWith('did:peer:')) return 'peer';
    if (did.startsWith('did:webvh:')) return 'webvh';
    if (did.startsWith('did:btco:')) return 'btco';
    throw new Error(`Unsupported DID method: ${did}`);
  }

  /**
   * Create migration error
   */
  private createMigrationError(
    type: MigrationErrorType,
    code: string,
    message: string,
    migrationId?: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    details?: any
  ): Error & { type: MigrationErrorType; code: string } {
    const error = new Error(message) as any;
    error.type = type;
    error.code = code;
    error.migrationId = migrationId;
    error.details = details;
    return error;
  }

  /**
   * Emit event
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
  private async emitEvent(type: string, data: any): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      await this.eventEmitter.emit({
        type,
        timestamp: new Date().toISOString(),
        ...data
      });
    } catch (error) {
      console.error(`Error emitting event ${type}:`, error);
    }
  }
}
