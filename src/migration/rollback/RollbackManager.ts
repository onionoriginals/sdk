/**
 * RollbackManager - Handles migration rollbacks
 */

import {
  MigrationStateEnum,
  RollbackResult,
  MigrationError,
  MigrationErrorType,
  IRollbackManager
} from '../types';
import { OriginalsConfig } from '../../types';
import { CheckpointManager } from '../checkpoint/CheckpointManager';
import { DIDManager } from '../../did/DIDManager';

export class RollbackManager implements IRollbackManager {
  constructor(
    private config: OriginalsConfig,
    private checkpointManager: CheckpointManager,
    private didManager: DIDManager
  ) {}

  /**
   * Rollback a migration to its checkpoint state
   */
  async rollback(migrationId: string, checkpointId: string): Promise<RollbackResult> {
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

      // Verify rollback success
      if (errors.length === 0) {
        return {
          success: true,
          migrationId,
          checkpointId,
          restoredState: MigrationStateEnum.ROLLED_BACK,
          duration,
          errors: []
        };
      } else {
        return {
          success: false,
          migrationId,
          checkpointId,
          restoredState: MigrationStateEnum.QUARANTINED,
          duration,
          errors
        };
      }
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
   * Perform layer-specific rollback operations
   */
  private async performLayerSpecificRollback(checkpoint: any): Promise<void> {
    // For now, rollback mainly involves:
    // 1. Ensuring source DID is still valid (it should be, as we don't delete it)
    // 2. Cleaning up any partial artifacts on target layer
    // 3. Restoring any modified state

    // Verify source DID still resolves
    const sourceDid = await this.didManager.resolveDID(checkpoint.sourceDid);
    if (!sourceDid) {
      throw new Error(`Source DID ${checkpoint.sourceDid} could not be resolved during rollback`);
    }

    // Layer-specific cleanup would go here
    // For peer → webvh: Remove any published resources
    // For webvh → btco: Nothing to do (Bitcoin tx cannot be reversed)
    // For peer → btco: Nothing to do (Bitcoin tx cannot be reversed)
  }

  /**
   * Clean up migration artifacts
   */
  private async cleanupMigrationArtifacts(migrationId: string): Promise<void> {
    // Clean up any temporary files, partial uploads, etc.
    // This is a placeholder for actual cleanup logic
  }

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
