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
  CostEstimate,
  MigrationValidationResult
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
import type { EventHandler, EventTypeMap } from '../events/types.js';

/**
 * @experimental Not the production migration path. `OriginalsSDK` and
 * `LifecycleManager` do NOT use `MigrationManager`; they implement their own
 * migrate/publish/inscribe flow with independent validation. This subsystem's
 * checkpoint / rollback / audit / state-machine machinery therefore protects no
 * production code path, and its validators can diverge from LifecycleManager's
 * (issue #279). It is intentionally excluded from the package's public exports.
 * Treat the API as unstable — it may change or be removed without a major bump.
 */
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

  /**
   * Guards the one-time, process-lifetime checkpoint reclaim run lazily on the
   * first migration (see maybeRunStartupReclaim). The MigrationManager is a
   * per-process singleton, so this fires once per process.
   */
  private startupReclaimDone = false;

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
      return MigrationManager.instance;
    }

    // Already initialized: passing DIFFERENT dependencies must fail loudly.
    // Silently returning the old instance discarded a newly supplied
    // bitcoinManager (every btco migration then throws "Bitcoin manager
    // required") or kept a different network's config for the process
    // lifetime (issue #280). Same-reference calls remain idempotent; call
    // resetInstance() first to deliberately reconfigure.
    const instance = MigrationManager.instance;
    const mismatches: string[] = [];
    if (config !== undefined && config !== instance.config) mismatches.push('config');
    if (didManager !== undefined && didManager !== instance.didManager) mismatches.push('didManager');
    if (credentialManager !== undefined && credentialManager !== instance.credentialManager) {
      mismatches.push('credentialManager');
    }
    if (bitcoinManager !== undefined && bitcoinManager !== instance.bitcoinManager) {
      mismatches.push('bitcoinManager');
    }
    if (mismatches.length > 0) {
      throw new Error(
        `MigrationManager is already initialized with different dependencies (${mismatches.join(', ')}); ` +
        'the new values would be silently ignored. Call MigrationManager.resetInstance() first to reconfigure.'
      );
    }
    return instance;
  }

  /**
   * Reset singleton instance (primarily for testing)
   */
  static resetInstance(): void {
    MigrationManager.instance = null;
  }

  /**
   * Subscribe to migration events (migration:started, migration:completed,
   * migration:failed, migration:quarantine, ...).
   *
   * The internal emitter used to be completely inaccessible, so every emitted
   * event — including migration:quarantine, which by definition means "manual
   * intervention required" — was dispatched into the void (issue #282).
   *
   * @returns An unsubscribe function
   */
  on<K extends keyof EventTypeMap>(
    eventType: K,
    handler: EventHandler<EventTypeMap[K]>
  ): () => void {
    return this.eventEmitter.on(eventType, handler);
  }

  /** Subscribe to a migration event for a single emission. */
  once<K extends keyof EventTypeMap>(
    eventType: K,
    handler: EventHandler<EventTypeMap[K]>
  ): () => void {
    return this.eventEmitter.once(eventType, handler);
  }

  /** Unsubscribe a handler registered with on()/once(). */
  off<K extends keyof EventTypeMap>(
    eventType: K,
    handler: EventHandler<EventTypeMap[K]>
  ): void {
    this.eventEmitter.off(eventType, handler);
  }

  /**
   * Run the checkpoint self-healing sweep once per process, lazily on the first
   * real migration. Fire-and-forget and never throws (cleanupOldCheckpoints is
   * a GC path that swallows per-key failures), so it cannot delay or fail a
   * migration. Idempotent: subsequent migrations are no-ops.
   */
  private maybeRunStartupReclaim(): void {
    if (this.startupReclaimDone) return;
    this.startupReclaimDone = true;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    void this.checkpointManager.cleanupOldCheckpoints();
  }

  /**
   * Main migration method
   */
  async migrate(options: MigrationOptions): Promise<MigrationResult> {
    const startTime = Date.now();

    // Reclaim checkpoints stranded by a previous process/crash. The per-migration
    // 24h cleanup timer (and its self-healing sweep) is lost on restart, so
    // without this a checkpoint whose durable delete AND pending-marker write
    // both failed before a restart would only be reclaimed if the application
    // called cleanupOldCheckpoints() by hand. Running it lazily on the first
    // real migration re-arms the self-healing sweep as part of normal operation.
    if (!options.estimateCostOnly) {
      this.maybeRunStartupReclaim();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let migrationState: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let checkpoint: any;
    // Captured so the failure handler can record the REAL validation results in
    // the audit trail instead of a hardcoded { valid: false, errors: [] }.
    let validationResult: MigrationValidationResult | undefined;

    // Concurrency guard (issue #255): reject a second migration of the same
    // DID while one is in flight. The set is mutated synchronously (before
    // any await), so concurrent callers cannot interleave past this check.
    // The rejected caller gets a structured MigrationResult (success: false,
    // code MIGRATION_IN_PROGRESS) — and because the guard returns here, the
    // finally block below only ever runs for the call that actually claimed
    // the lock. estimateCostOnly requests are read-only and exempt.
    //
    // The rejection is returned INLINE rather than via
    // handleMigrationFailure: no migration ever started, so routing it
    // through the failure handler emitted a migration:failed event and wrote
    // a signed audit record for a phantom migration (a mig_failed_* id with
    // no matching migration:started and nothing on disk to roll back) —
    // pure noise in the audit trail.
    if (!options.estimateCostOnly) {
      if (this.inFlightSourceDids.has(options.sourceDid)) {
        let sourceLayer: 'peer' | 'webvh' | 'btco';
        try {
          sourceLayer = this.extractLayer(options.sourceDid);
        } catch {
          sourceLayer = 'peer';
        }
        return {
          migrationId: `mig_rejected_${Date.now()}`,
          success: false,
          sourceDid: options.sourceDid,
          sourceLayer,
          targetLayer: options.targetLayer,
          state: MigrationStateEnum.FAILED,
          duration: Date.now() - startTime,
          cost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' },
          error: {
            type: MigrationErrorType.VALIDATION_ERROR,
            code: 'MIGRATION_IN_PROGRESS',
            message: `A migration for ${options.sourceDid} is already in progress; concurrent migrations of the same DID would double-pay for duplicate inscriptions`,
            sourceDid: options.sourceDid,
            timestamp: Date.now()
          }
        };
      }
      this.inFlightSourceDids.add(options.sourceDid);
    }

    try {
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

      validationResult = await this.validationPipeline.validate(options);

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
        await this.auditLogger.logMigration(auditRecord);
      } catch (auditError) {
        auditPersisted = false;
        auditErrorMessage = auditError instanceof Error ? auditError.message : String(auditError);
        console.error('Failed to record audit for completed migration:', auditError);
      }

      // Clean up checkpoint after successful migration. unref() the timer so
      // a successful migration does not pin the process alive for 24 hours
      // (CLI scripts and tests would otherwise hang until the timer fired).
      const cleanupTimer = setTimeout(() => {
        // Run the full cleanup sweep rather than a one-shot delete of only this
        // checkpoint. cleanupOldCheckpoints() reclaims this migration's
        // checkpoint via the retention GC AND runs the self-healing paths
        // (retryPendingDeletions + storage-truth enumeration sweep), so a
        // checkpoint stranded by a delete whose tombstone and pending-marker
        // writes both failed is reclaimed here too. Fire-and-forget; never throws.
        // eslint-disable-next-line @typescript-eslint/no-floating-promises
        void this.checkpointManager.cleanupOldCheckpoints();
      }, 24 * 60 * 60 * 1000); // Sweep after 24 hours
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
        startTime,
        validationResult
      );
    } finally {
      if (!options.estimateCostOnly) {
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

    // Deduplicate: the same DID twice would overwrite its results-Map entry
    // while both iterations bumped the counters, so results.size drifted from
    // completed + failed. One migration per distinct DID.
    const uniqueDids = Array.from(new Set(dids));
    const total = uniqueDids.length;
    let completed = 0;
    let failed = 0;
    let stopped = false; // set on the first failure in fail-fast mode

    const runOne = async (did: string): Promise<void> => {
      try {
        // Spread the shared options FIRST so the per-item fields always win.
        // BatchMigrationOptions extends MigrationOptions, where sourceDid is
        // REQUIRED — spreading `options` last let a type-correct options
        // object clobber every item's sourceDid/targetLayer, migrating one
        // asset N times and never touching the rest.
        const migrationOptions: MigrationOptions = {
          ...options,
          sourceDid: did,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
          targetLayer: targetLayer as any
        };
        const result = await this.migrate(migrationOptions);
        results.set(did, result);
        if (result.success) {
          completed++;
        } else {
          failed++;
          // Fail-fast (item: continueOnError=false didn't stop): migrate()
          // converts operational failures into a RETURNED unsuccessful result
          // via handleMigrationFailure and almost never rejects, so the catch
          // below was effectively dead and the batch kept spending through
          // every remaining item. Treat a returned failure as a stop trigger.
          if (!options?.continueOnError) {
            stopped = true;
            if (result.error) {
              errors.push(result.error);
            } else {
              errors.push({
                type: MigrationErrorType.UNKNOWN_ERROR,
                code: 'BATCH_MIGRATION_ERROR',
                message: `Migration of ${did} failed; stopping batch (continueOnError is not set)`,
                sourceDid: did,
                timestamp: Date.now()
              });
            }
          }
        }
      } catch (error) {
        failed++;
        errors.push({
          type: MigrationErrorType.UNKNOWN_ERROR,
          code: 'BATCH_MIGRATION_ERROR',
          message: error instanceof Error ? error.message : String(error),
          sourceDid: did,
          timestamp: Date.now()
        });
        if (!options?.continueOnError) {
          stopped = true; // stop scheduling further migrations
        }
      }
    };

    // Honor maxConcurrent with a bounded worker pool (was accepted but ignored,
    // so the loop always ran strictly sequentially). Distinct DIDs are safe to
    // run in parallel — migrate() guards against concurrent migrations of the
    // same source DID internally.
    const requestedConcurrency = options?.maxConcurrent;
    const concurrency = Math.max(
      1,
      Math.min(
        Number.isFinite(requestedConcurrency) ? Math.floor(requestedConcurrency as number) : 1,
        total || 1
      )
    );
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (!stopped) {
        const i = cursor++;
        if (i >= uniqueDids.length) return;
        await runOne(uniqueDids[i]);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    return {
      batchId,
      total,
      completed,
      failed,
      inProgress: 0,
      results,
      // Guard against total === 0 (empty input) which otherwise yields NaN.
      overallProgress: total === 0 ? 0 : ((completed + failed) / total) * 100,
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
    startTime: number,
    validationResult?: MigrationValidationResult
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
      // Record the REAL validation results when they were computed (threaded in
      // from migrate()): a validation failure keeps its actual errors, and a
      // post-validation failure is no longer misrecorded as valid:false. Only
      // fall back to the empty placeholder when the failure occurred before
      // validation ran (validationResult is undefined).
      validationResults: validationResult ?? {
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
      await this.auditLogger.logMigration(auditRecord);
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
