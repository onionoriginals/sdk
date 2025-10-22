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
import { AuditLogger } from './audit/AuditLogger';
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
    this.auditLogger = new AuditLogger(config);
    this.eventEmitter = new EventEmitter();

    // Initialize migration operations
    this.peerToWebvh = new PeerToWebvhMigration(config, didManager, credentialManager, this.stateTracker);

    if (bitcoinManager) {
      this.webvhToBtco = new WebvhToBtcoMigration(config, didManager, credentialManager, this.stateTracker, bitcoinManager);
      this.peerToBtco = new PeerToBtcoMigration(config, didManager, credentialManager, this.stateTracker, bitcoinManager);
    } else {
      // Create stub implementations that throw errors
      this.webvhToBtco = null as any;
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
    let migrationState: any;
    let checkpoint: any;

    try {
      // Step 1: Create migration state
      migrationState = await this.stateTracker.createMigration(options);
      const migrationId = migrationState.migrationId;

      await this.emitEvent('migration:started', { migrationId, options });

      // Step 2: Validate migration
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
          migrationId,
          { errors: validationResult.errors }
        );
      }

      await this.emitEvent('migration:validated', { migrationId, validationResult });

      // Step 3: Create checkpoint
      await this.stateTracker.updateState(migrationId, {
        state: MigrationStateEnum.CHECKPOINTED,
        currentOperation: 'Creating checkpoint',
        progress: 20
      });

      checkpoint = await this.checkpointManager.createCheckpoint(migrationId, options);

      // Persist checkpointId immediately so rollback can locate it
      await this.stateTracker.updateState(migrationId, {
        checkpointId: checkpoint.checkpointId
      });

      await this.emitEvent('migration:checkpointed', { migrationId, checkpointId: checkpoint.checkpointId });

      // Step 4: Execute migration
      const migration = this.getMigrationOperation(options);
      const result = await migration.executeMigration(options, migrationId);

      // Step 5: Complete migration
      await this.stateTracker.updateState(migrationId, {
        state: MigrationStateEnum.COMPLETED,
        currentOperation: 'Completed',
        progress: 100,
        targetDid: result.targetDid
      });

      await this.emitEvent('migration:completed', { migrationId, targetDid: result.targetDid });

      // Step 6: Create audit record
      const duration = Date.now() - startTime;
      const auditRecord = {
        migrationId,
        timestamp: startTime,
        initiator: 'system',
        sourceDid: options.sourceDid,
        sourceLayer: this.extractLayer(options.sourceDid),
        targetDid: result.targetDid,
        targetLayer: options.targetLayer,
        finalState: MigrationStateEnum.COMPLETED,
        validationResults: validationResult,
        costActual: validationResult.estimatedCost,
        duration,
        checkpointId: checkpoint.checkpointId,
        errors: [],
        metadata: options.metadata || {}
      };

      await this.auditLogger.logMigration(auditRecord);

      // Clean up checkpoint after successful migration
      setTimeout(() => {
        this.checkpointManager.deleteCheckpoint(checkpoint.checkpointId);
      }, 24 * 60 * 60 * 1000); // Delete after 24 hours

      return {
        migrationId,
        success: true,
        sourceDid: options.sourceDid,
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
  async getMigrationStatus(migrationId: string): Promise<any> {
    return await this.stateTracker.getState(migrationId);
  }

  /**
   * Rollback a migration
   */
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
   */
  async getMigrationHistory(did: string): Promise<any[]> {
    return await this.auditLogger.getMigrationHistory(did);
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
    error: any,
    options: MigrationOptions,
    migrationState: any,
    checkpoint: any,
    startTime: number
  ): Promise<MigrationResult> {
    const migrationId = migrationState?.migrationId || `mig_failed_${Date.now()}`;

    const migrationError: MigrationError = {
      type: error.type || MigrationErrorType.UNKNOWN_ERROR,
      code: error.code || 'MIGRATION_FAILED',
      message: error.message || String(error),
      technicalDetails: error.stack,
      migrationId,
      sourceDid: options.sourceDid,
      timestamp: Date.now()
    };

    // Update state to failed
    if (migrationState) {
      try {
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
        const rollbackResult = await this.rollbackManager.rollback(migrationId, checkpoint.checkpointId);
        rollbackSuccess = rollbackResult.success;

        if (!rollbackSuccess) {
          await this.emitEvent('migration:quarantine', {
            migrationId,
            checkpointId: checkpoint.checkpointId,
            reason: 'Rollback failed'
          });
        }
      } catch (rollbackError) {
        console.error('Rollback failed:', rollbackError);
        await this.emitEvent('migration:quarantine', {
          migrationId,
          checkpointId: checkpoint.checkpointId,
          reason: rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        });
      }
    }

    // Create audit record
    const duration = Date.now() - startTime;
    const auditRecord = {
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
      checkpointId: checkpoint?.checkpointId || '',
      errors: [migrationError],
      metadata: options.metadata || {}
    };

    await this.auditLogger.logMigration(auditRecord);

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
  private async emitEvent(type: string, data: any): Promise<void> {
    try {
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
