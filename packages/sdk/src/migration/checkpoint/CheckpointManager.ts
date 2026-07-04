/**
 * CheckpointManager - Creates and manages migration checkpoints for rollback
 */

import { v4 as uuidv4 } from 'uuid';
import {
  MigrationOptions,
  MigrationCheckpoint,
  ICheckpointManager
} from '../types.js';
import { OriginalsConfig } from '../../types/index.js';
import { DIDManager } from '../../did/DIDManager.js';
import { CredentialManager } from '../../vc/CredentialManager.js';
import { CheckpointStorage } from './CheckpointStorage.js';

export class CheckpointManager implements ICheckpointManager {
  private storage: CheckpointStorage;

  constructor(
    private config: OriginalsConfig,
    private didManager: DIDManager,
    private credentialManager: CredentialManager
  ) {
    this.storage = new CheckpointStorage(config);
  }

  /**
   * Create a checkpoint before migration
   */
  async createCheckpoint(migrationId: string, options: MigrationOptions): Promise<MigrationCheckpoint> {
    try {
      const checkpointId = `chk_${uuidv4()}`;

      // Resolve source DID document
      const didDocument = await this.didManager.resolveDID(options.sourceDid);
      if (!didDocument) {
        throw new Error(`Could not resolve source DID: ${options.sourceDid}`);
      }

      // Extract source layer
      const sourceLayer = this.extractLayer(options.sourceDid);
      if (!sourceLayer) {
        throw new Error(`Invalid source DID format: ${options.sourceDid}`);
      }

      // Create checkpoint
      // HONESTY NOTE (issue #237): this checkpoint captures the resolved DID
      // document, the migration's layers, and caller metadata — nothing more.
      // credentials/storageReferences/lifecycleState/ownershipProofs are NOT
      // captured in this version, so rollback cannot restore them and must
      // not claim to. RollbackManager reports partial results accordingly.
      const checkpoint: MigrationCheckpoint = {
        checkpointId,
        migrationId,
        timestamp: Date.now(),
        sourceDid: options.sourceDid,
        sourceLayer,
        targetLayer: options.targetLayer,
        didDocument,
        credentials: [],
        storageReferences: {},
        lifecycleState: {},
        ownershipProofs: [],
        metadata: options.metadata || {}
      };

      // Store checkpoint
      await this.storage.save(checkpoint);

      return checkpoint;
    } catch (error) {
      throw new Error(`Failed to create checkpoint: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Retrieve a checkpoint by ID
   */
  async getCheckpoint(checkpointId: string): Promise<MigrationCheckpoint | null> {
    try {
      return await this.storage.get(checkpointId);
    } catch (error) {
      console.error(`Error retrieving checkpoint ${checkpointId}:`, error);
      return null;
    }
  }

  /**
   * Delete a checkpoint (after successful migration or cleanup)
   */
  async deleteCheckpoint(checkpointId: string): Promise<void> {
    try {
      await this.storage.delete(checkpointId);
    } catch (error) {
      console.error(`Error deleting checkpoint ${checkpointId}:`, error);
      // Don't throw - deletion failures shouldn't break migrations
    }
  }

  /**
   * Clean up old checkpoints (older than 24 hours for successful migrations)
   */
  async cleanupOldCheckpoints(): Promise<void> {
    try {
      const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours
      await this.storage.deleteOlderThan(cutoffTime);
    } catch (error) {
      console.error('Error cleaning up old checkpoints:', error);
    }
  }

  private extractLayer(did: string): 'peer' | 'webvh' | 'btco' | null {
    if (did.startsWith('did:peer:')) return 'peer';
    if (did.startsWith('did:webvh:')) return 'webvh';
    if (did.startsWith('did:btco:')) return 'btco';
    return null;
  }
}
