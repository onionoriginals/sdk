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
} from './types';
import { OriginalsConfig } from '../types';
import { DIDManager } from '../did/DIDManager';
import { CredentialManager } from '../vc/CredentialManager';
import { BitcoinManager } from '../bitcoin/BitcoinManager';
import { ValidationPipeline } from './validation/ValidationPipeline';
import { CheckpointManager } from './checkpoint/CheckpointManager';
import { RollbackManager } from './rollback/RollbackManager';
import { StateTracker } from './state/StateTracker';
// TODO: AuditLogger temporarily disabled for v1.0 release
// Will be re-enabled in v1.1 with proper Ed25519 digital signatures
// import { AuditLogger } from './audit/AuditLogger';
import { PeerToWebvhMigration } from './operations/PeerToWebvhMigration';
import { WebvhToBtcoMigration } from './operations/WebvhToBtcoMigration';
import { PeerToBtcoMigration } from './operations/PeerToBtcoMigration';
import { EventEmitter } from '../events/EventEmitter';

export class MigrationManager {
  private static instance: MigrationManager | null = null;

  private validationPipeline: ValidationPipeline;
  private checkpointManager: CheckpointManager;
  private rollbackManager: RollbackManager;
  private stateTracker: StateTracker;
  // TODO: AuditLogger temporarily disabled for v1.0 release
  // private auditLogger: AuditLogger;
  private eventEmitter: EventEmitter;

  // Temporary in-memory audit storage for v1.0 (unsigned records)
  // Will be replaced by proper AuditLogger with signatures in v1.1
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private inMemoryAuditRecords: Map<string, any[]>;

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
    // TODO: AuditLogger temporarily disabled for v1.0 release
    // this.auditLogger = new AuditLogger(config);
    this.eventEmitter = new EventEmitter();

    // Initialize in-memory audit storage for v1.0
    this.inMemoryAuditRecords = new Map();

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

    try {
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

      // TODO: AuditLogger temporarily disabled for v1.0 release
      // Store in-memory for v1.0 (unsigned, will be replaced with signed records in v1.1)
      this.storeAuditRecordInMemory(auditRecord);

      // Clean up checkpoint after successful migration
      setTimeout(() => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-floating-promises
        this.checkpointManager.deleteCheckpoint(checkpoint.checkpointId);
      }, 24 * 60 * 60 * 1000); // Delete after 24 hours

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
        auditRecord
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
   * Rollback a migration
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async rollback(migrationId: string): Promise<any> {
    const state = await this.stateTracker.getState(migrationId);
    if (!state || !state.checkpointId) {
      throw new Error(`Migration ${migrationId} not found or has no checkpoint`);
    }

    const rollbackResult = await this.rollbackManager.rollback(migrationId, state.checkpointId);

    await this.emitEvent('migration:rolledback', { migrationId, rollbackResult });

    return rollbackResult;
  }

  /**
   * Get migration history for a DID
   * TODO: AuditLogger temporarily disabled for v1.0 release
   * Returns in-memory audit records (unsigned) - will use proper AuditLogger in v1.1
   */
  // eslint-disable-next-line @typescript-eslint/require-await, @typescript-eslint/no-explicit-any
  async getMigrationHistory(did: string): Promise<any[]> {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return this.inMemoryAuditRecords.get(did) || [];
  }

  /**
   * Batch migration
   */
  async migrateBatch(dids: string[], targetLayer: string, options?: BatchMigrationOptions): Promise<BatchMigrationResult> {
    const batchId = `batch_${Date.now()}`;
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
      startTime: Date.now(),
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

    // Attempt rollback if checkpoint exists
    let rollbackSuccess = false;
    if (checkpoint) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
        const rollbackResult = await this.rollbackManager.rollback(migrationId, checkpoint.checkpointId);
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        rollbackSuccess = rollbackResult.success;

        if (!rollbackSuccess) {
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
      finalState: rollbackSuccess ? MigrationStateEnum.ROLLED_BACK : MigrationStateEnum.FAILED,
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

    // TODO: AuditLogger temporarily disabled for v1.0 release
    // Store in-memory for v1.0 (unsigned, will be replaced with signed records in v1.1)
    this.storeAuditRecordInMemory(auditRecord);

    return {
      migrationId,
      success: false,
      sourceDid: options.sourceDid,
      sourceLayer: this.extractLayer(options.sourceDid),
      targetLayer: options.targetLayer,
      state: rollbackSuccess ? MigrationStateEnum.ROLLED_BACK : MigrationStateEnum.FAILED,
      duration,
      cost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' },
      auditRecord,
      error: migrationError
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
   * Store audit record in memory for v1.0
   * Stores by both source and target DID for easy lookup
   * TODO: Remove in v1.1 when AuditLogger is re-enabled with signatures
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private storeAuditRecordInMemory(record: any): void {
    // Store by source DID
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
    const sourceRecords = this.inMemoryAuditRecords.get(record.sourceDid) || [];
    sourceRecords.push(record);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
    this.inMemoryAuditRecords.set(record.sourceDid, sourceRecords);

    // Also store by target DID if available
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (record.targetDid) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
      const targetRecords = this.inMemoryAuditRecords.get(record.targetDid) || [];
      targetRecords.push(record);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
      this.inMemoryAuditRecords.set(record.targetDid, targetRecords);
    }
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
