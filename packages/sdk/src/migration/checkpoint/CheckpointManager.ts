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
import { CheckpointStorage, TOMBSTONE_MARKER } from './CheckpointStorage.js';
import { resolveMigrationStorage } from '../storage/MigrationStorage.js';
import { Logger } from '../../utils/Logger.js';
import { emitTelemetry, emitError, StructuredError } from '../../utils/telemetry.js';

/**
 * Prefix under which pending-deletion markers live. Each marker is ONE
 * immutable object per checkpoint (checkpoints/pending-deletion/<id>.json) —
 * deliberately NOT a shared mutable index, which would reintroduce the
 * cross-process read-modify-write race the audit index had. Markers are
 * discovered via native enumeration (MigrationStorage.listNative), which both
 * shipped adapters support.
 */
export const PENDING_DELETION_PREFIX = 'checkpoints/pending-deletion/';

function pendingDeletionKey(checkpointId: string): string {
  return `${PENDING_DELETION_PREFIX}${checkpointId}.json`;
}

export class CheckpointManager implements ICheckpointManager {
  private storage: CheckpointStorage;
  private logger: Logger;

  constructor(
    private config: OriginalsConfig,
    private didManager: DIDManager,
    private credentialManager: CredentialManager
  ) {
    this.storage = new CheckpointStorage(config);
    this.logger = new Logger('CheckpointManager', config);
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
      this.logger.error(
        `Error retrieving checkpoint ${checkpointId}`,
        error instanceof Error ? error : new Error(String(error)),
        { checkpointId }
      );
      return null;
    }
  }

  /**
   * Delete a checkpoint (after successful migration or cleanup).
   *
   * NON-FATAL BY DESIGN: this is garbage collection of a checkpoint whose
   * migration already completed successfully (the only caller is a
   * fire-and-forget 24h timer in MigrationManager), so a failed cleanup must
   * never throw into that timer or a completed migration. Instead of hiding
   * the failure behind a bare console.error, a failed durable delete is:
   *   1. SURFACED through the structured Logger and the config.telemetry
   *      hooks (a `migration.checkpoint.cleanup_failed` event plus a
   *      CHECKPOINT_CLEANUP_FAILED StructuredError), and
   *   2. RECORDED as a durable per-checkpoint pending-deletion marker that
   *      retryPendingDeletions() (invoked from cleanupOldCheckpoints) — or a
   *      later explicit deleteCheckpoint of the same id — retries and clears
   *      on success. The leaked checkpoint is therefore bounded: it lingers
   *      only until storage recovers, not forever.
   */
  async deleteCheckpoint(checkpointId: string): Promise<void> {
    try {
      await this.storage.delete(checkpointId);
      // Durable delete succeeded: clear any pending-deletion marker left by
      // a previously failed attempt (best-effort, never throws).
      await this.clearPendingDeletionMarker(checkpointId);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Failed to delete checkpoint ${checkpointId}; recorded as pending deletion for retry`,
        err,
        { checkpointId }
      );
      emitTelemetry(this.config.telemetry, {
        name: 'migration.checkpoint.cleanup_failed',
        level: 'error',
        attributes: { checkpointId, error: err.message }
      });
      emitError(
        this.config.telemetry,
        new StructuredError(
          'CHECKPOINT_CLEANUP_FAILED',
          `Failed to delete checkpoint ${checkpointId}: ${err.message}`,
          { checkpointId }
        )
      );
      await this.recordPendingDeletion(checkpointId, err);
      // Don't throw - deletion failures shouldn't break migrations
    }
  }

  /**
   * Clean up old checkpoints (older than 24 hours for successful migrations),
   * then retry any deletions that previously failed durably.
   */
  async cleanupOldCheckpoints(): Promise<void> {
    try {
      const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours
      await this.storage.deleteOlderThan(cutoffTime);
    } catch (error) {
      this.logger.error(
        'Error cleaning up old checkpoints',
        error instanceof Error ? error : new Error(String(error))
      );
    }
    await this.retryPendingDeletions();
  }

  /**
   * Retry checkpoint deletions that previously failed durably (self-healing).
   *
   * Pending markers are discovered via native enumeration
   * (MigrationStorage.listNative — supported by both shipped adapters). For
   * opaque adapters that cannot enumerate, this degrades gracefully to a
   * no-op: the marker still exists and is retried/cleared by the next
   * explicit deleteCheckpoint of that id. Never throws.
   *
   * @returns ids whose deletion was retried successfully, and ids that are
   * still failing (their markers are kept for a later pass).
   */
  async retryPendingDeletions(): Promise<{ retried: string[]; failed: string[] }> {
    const retried: string[] = [];
    const failed: string[] = [];

    const migrationStorage = resolveMigrationStorage(this.config);
    if (!migrationStorage || !migrationStorage.canList()) {
      // Opaque adapter (or no adapter): markers cannot be discovered.
      // Degrade gracefully — see method doc.
      return { retried, failed };
    }

    let markerKeys: string[] | null = null;
    try {
      markerKeys = await migrationStorage.listNative(PENDING_DELETION_PREFIX);
    } catch (error) {
      this.logger.warn('Could not enumerate pending checkpoint deletions', {
        error: error instanceof Error ? error.message : String(error)
      });
      return { retried, failed };
    }
    if (!markerKeys) return { retried, failed };

    for (const markerKey of markerKeys) {
      let checkpointId: string | null = null;
      try {
        const text = await migrationStorage.getText(markerKey);
        if (!text) continue;
        const marker = JSON.parse(text) as Record<string, unknown>;
        // A tombstoned marker was already cleared on an adapter without
        // native delete — inert, skip it.
        if (marker[TOMBSTONE_MARKER] === true) continue;
        checkpointId =
          typeof marker.checkpointId === 'string'
            ? marker.checkpointId
            : markerKey.slice(PENDING_DELETION_PREFIX.length).replace(/\.json$/, '');
        if (!checkpointId) continue;

        await this.storage.delete(checkpointId);
        await this.clearPendingDeletionMarker(checkpointId);
        retried.push(checkpointId);
        this.logger.info(`Retried pending checkpoint deletion for ${checkpointId}`, { checkpointId });
        emitTelemetry(this.config.telemetry, {
          name: 'migration.checkpoint.cleanup_retried',
          attributes: { checkpointId }
        });
      } catch (error) {
        // Still failing: keep the marker for the next pass.
        if (checkpointId) failed.push(checkpointId);
        this.logger.warn(`Pending checkpoint deletion still failing for ${markerKey}`, {
          markerKey,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return { retried, failed };
  }

  /**
   * Durably record that a checkpoint's deletion failed and must be retried.
   * One immutable marker object per checkpoint — never a shared index.
   * Best-effort: a marker-write failure is logged, not thrown (the next
   * explicit deleteCheckpoint of this id retries the delete regardless).
   */
  private async recordPendingDeletion(checkpointId: string, cause: Error): Promise<void> {
    const migrationStorage = resolveMigrationStorage(this.config);
    if (!migrationStorage) return;
    try {
      await migrationStorage.putText(
        pendingDeletionKey(checkpointId),
        JSON.stringify({ checkpointId, recordedAt: Date.now(), reason: cause.message })
      );
    } catch (markerError) {
      this.logger.warn(
        `Could not record pending deletion marker for checkpoint ${checkpointId}`,
        {
          checkpointId,
          error: markerError instanceof Error ? markerError.message : String(markerError)
        }
      );
    }
  }

  /**
   * Clear a checkpoint's pending-deletion marker after a successful durable
   * delete. On adapters without native delete the marker is tombstoned in
   * place (same convention as CheckpointStorage), which retryPendingDeletions
   * treats as inert. Best-effort: never throws.
   */
  private async clearPendingDeletionMarker(checkpointId: string): Promise<void> {
    const migrationStorage = resolveMigrationStorage(this.config);
    if (!migrationStorage) return;
    const markerKey = pendingDeletionKey(checkpointId);
    try {
      const text = await migrationStorage.getText(markerKey);
      if (!text) return;
      const marker = JSON.parse(text) as Record<string, unknown>;
      if (marker[TOMBSTONE_MARKER] === true) return; // already cleared
      const deletedNatively = await migrationStorage.deleteNative(markerKey);
      if (!deletedNatively) {
        await migrationStorage.putText(markerKey, JSON.stringify({ [TOMBSTONE_MARKER]: true }));
      }
    } catch (error) {
      this.logger.warn(
        `Could not clear pending deletion marker for checkpoint ${checkpointId}`,
        {
          checkpointId,
          error: error instanceof Error ? error.message : String(error)
        }
      );
    }
  }

  private extractLayer(did: string): 'peer' | 'webvh' | 'btco' | null {
    if (did.startsWith('did:peer:')) return 'peer';
    if (did.startsWith('did:webvh:')) return 'webvh';
    if (did.startsWith('did:btco:')) return 'btco';
    return null;
  }
}
