/**
 * RollbackManager - Handles migration rollbacks
 */

import {
  MigrationStateEnum,
  RollbackResult,
  MigrationError,
  MigrationErrorType,
  IRollbackManager
} from '../types.js';
import { OriginalsConfig } from '../../types/index.js';
import { CheckpointManager } from '../checkpoint/CheckpointManager.js';
import { DIDManager } from '../../did/DIDManager.js';

/** Optional context passed by the failure handler so rollback can report on-chain artifacts. */
export interface RollbackContext {
  /** The error that caused the migration to fail (may carry inscription details). */
  error?: unknown;
}

export class RollbackManager implements IRollbackManager {
  constructor(
    private config: OriginalsConfig,
    private checkpointManager: CheckpointManager,
    private didManager: DIDManager
  ) {}

  /**
   * Rollback a migration to its checkpoint state
   */
  async rollback(
    migrationId: string,
    checkpointId: string,
    context?: RollbackContext
  ): Promise<RollbackResult> {
    const startTime = Date.now();
    const errors: MigrationError[] = [];

    try {
      // Retrieve checkpoint
      const checkpoint = await this.checkpointManager.getCheckpoint(checkpointId);
      if (!checkpoint) {
        const error: MigrationError = {
          type: MigrationErrorType.ROLLBACK_ERROR,
          code: 'CHECKPOINT_NOT_FOUND',
          message: `Checkpoint ${checkpointId} not found`,
          migrationId,
          timestamp: Date.now()
        };
        errors.push(error);

        return {
          success: false,
          migrationId,
          checkpointId,
          restoredState: MigrationStateEnum.QUARANTINED,
          duration: Date.now() - startTime,
          errors
        };
      }

      // Verify checkpoint belongs to this migration
      if (checkpoint.migrationId !== migrationId) {
        const error: MigrationError = {
          type: MigrationErrorType.ROLLBACK_ERROR,
          code: 'CHECKPOINT_MISMATCH',
          message: `Checkpoint ${checkpointId} does not belong to migration ${migrationId}`,
          migrationId,
          timestamp: Date.now()
        };
        errors.push(error);

        return {
          success: false,
          migrationId,
          checkpointId,
          restoredState: MigrationStateEnum.QUARANTINED,
          duration: Date.now() - startTime,
          errors
        };
      }

      // Perform rollback based on source layer
      await this.performLayerSpecificRollback(checkpoint);

      // Clean up any partial migration artifacts
      await this.cleanupMigrationArtifacts(migrationId);

      const duration = Date.now() - startTime;

      // Bitcoin-anchored migrations are NOT fully reversible: a failure after
      // the commit/reveal broadcast leaves a paid inscription on-chain that no
      // rollback can undo. Reporting unqualified success here previously led
      // callers to retry and pay for a second inscription (issue #237).
      // Report PARTIALLY_ROLLED_BACK and enumerate what could not be undone.
      if (checkpoint.targetLayer === 'btco') {
        const artifactDetails = this.extractBitcoinArtifacts(context);
        return {
          success: false,
          migrationId,
          checkpointId,
          restoredState: MigrationStateEnum.PARTIALLY_ROLLED_BACK,
          duration,
          errors: [],
          irreversibleArtifacts: [
            {
              type: 'bitcoin-inscription',
              description:
                'The migration targeted Bitcoin (did:btco). Any commit/reveal transactions broadcast ' +
                'before the failure are irreversible: fees were spent and an inscription may exist ' +
                'on-chain. Verify on-chain state before retrying — a blind retry pays for a second inscription.',
              ...(artifactDetails ? { details: artifactDetails } : {})
            }
          ]
        };
      }

      // Non-Bitcoin targets: the only durable state the checkpoint captures
      // (the source DID document) was verified intact above, and no
      // irreversible side effects exist for peer→webvh migrations.
      return {
        success: true,
        migrationId,
        checkpointId,
        restoredState: MigrationStateEnum.ROLLED_BACK,
        duration,
        errors: []
      };
    } catch (error) {
      const rollbackError: MigrationError = {
        type: MigrationErrorType.ROLLBACK_ERROR,
        code: 'ROLLBACK_FAILED',
        message: 'Rollback operation failed',
        technicalDetails: error instanceof Error ? error.message : String(error),
        migrationId,
        timestamp: Date.now()
      };
      errors.push(rollbackError);

      return {
        success: false,
        migrationId,
        checkpointId,
        restoredState: MigrationStateEnum.QUARANTINED,
        duration: Date.now() - startTime,
        errors
      };
    }
  }

  /**
   * Extract on-chain artifact identifiers (inscriptionId/txids/fees) from the
   * failure context when the failing error carried them (e.g. a
   * StructuredError from BitcoinManager.inscribeData with details).
   */
  private extractBitcoinArtifacts(context?: RollbackContext): Record<string, unknown> | undefined {
    const details = (context?.error as { details?: Record<string, unknown> } | undefined)?.details;
    if (details && typeof details === 'object') {
      const keys = ['inscriptionId', 'txid', 'commitTxId', 'revealTxId', 'satoshi', 'feePaid'];
      const picked: Record<string, unknown> = {};
      for (const k of keys) {
        if (details[k] !== undefined) picked[k] = details[k];
      }
      if (Object.keys(picked).length > 0) return picked;
    }
    return undefined;
  }

  /**
   * Perform layer-specific rollback operations.
   *
   * What this can honestly do today: verify the source DID (the only durable
   * state captured by checkpoints) is intact. Checkpoints do not capture
   * credentials, storage references, or lifecycle state (see
   * CheckpointManager.createCheckpoint), so there is nothing further to
   * restore — and Bitcoin transactions can never be reversed. The rollback
   * result reflects those limits instead of claiming full restoration.
   */
  private async performLayerSpecificRollback(checkpoint: any): Promise<void> {
    // Verify source DID still resolves
    const sourceDid = await this.didManager.resolveDID(checkpoint.sourceDid);
    if (!sourceDid) {
      throw new Error(`Source DID ${checkpoint.sourceDid} could not be resolved during rollback`);
    }
  }

  /**
   * Clean up migration artifacts. No temporary artifacts are produced by the
   * current migration operations, so this is intentionally a no-op — kept as
   * a seam for operations that do produce cleanable artifacts.
   */
  private async cleanupMigrationArtifacts(_migrationId: string): Promise<void> {}

  /**
   * Check if a rollback is possible
   */
  async canRollback(migrationId: string, checkpointId: string): Promise<boolean> {
    try {
      const checkpoint = await this.checkpointManager.getCheckpoint(checkpointId);
      if (!checkpoint || checkpoint.migrationId !== migrationId) {
        return false;
      }

      // Bitcoin transactions cannot be rolled back
      // But we can still restore the source DID to working state
      return true;
    } catch (error) {
      return false;
    }
  }
}
