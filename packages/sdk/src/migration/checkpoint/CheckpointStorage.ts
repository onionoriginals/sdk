/**
 * CheckpointStorage - Persists checkpoints to storage
 *
 * Persistence goes through resolveMigrationStorage, which speaks BOTH the
 * canonical StorageAdapter interface (putObject/getObject — the only shape
 * the shipped Memory/Local adapters implement) and legacy duck-typed
 * put/get/delete adapters. Previously only the legacy shape was probed, so
 * with every shipped adapter the guards silently skipped and checkpoints
 * were never persisted — after a crash, rollback() found nothing and
 * quarantined the migration.
 */

import { MigrationCheckpoint } from '../types.js';
import { OriginalsConfig } from '../../types/index.js';
import { resolveMigrationStorage, storedDataToString } from '../storage/MigrationStorage.js';

// Re-exported for backward compatibility (AuditLogger and external callers
// historically imported this from CheckpointStorage).
export { storedDataToString };

/**
 * Marker object written in place of a deleted checkpoint on adapters without
 * a native delete (the canonical StorageAdapter has none). A tombstoned key
 * reads back as "not found".
 */
const TOMBSTONE_MARKER = '__originals_deleted__';

function checkpointKey(checkpointId: string): string {
  return `checkpoints/${checkpointId}.json`;
}

export class CheckpointStorage {
  private checkpoints: Map<string, MigrationCheckpoint>;

  constructor(private config: OriginalsConfig) {
    this.checkpoints = new Map();
  }

  /**
   * Save a checkpoint
   */
  async save(checkpoint: MigrationCheckpoint): Promise<void> {
    if (!checkpoint.checkpointId) {
      throw new Error('Checkpoint must have an ID');
    }
    this.checkpoints.set(checkpoint.checkpointId, checkpoint);

    // Persist through whatever storage adapter is configured (canonical
    // StorageAdapter or legacy duck-typed adapter).
    const storage = resolveMigrationStorage(this.config);
    if (storage) {
      try {
        await storage.putText(checkpointKey(checkpoint.checkpointId), JSON.stringify(checkpoint));
      } catch (error) {
        console.error('Failed to persist checkpoint to storage:', error);
        // Continue - in-memory checkpoint is still available
      }
    }
  }

  /**
   * Retrieve a checkpoint
   */
  async get(checkpointId: string): Promise<MigrationCheckpoint | null> {
    // Try in-memory first
    const memoryCheckpoint = this.checkpoints.get(checkpointId);
    if (memoryCheckpoint) {
      return memoryCheckpoint;
    }

    // Try loading from the configured storage adapter (crash recovery path)
    const storage = resolveMigrationStorage(this.config);
    if (storage) {
      try {
        const text = await storage.getText(checkpointKey(checkpointId));
        if (text) {
          const parsed: unknown = JSON.parse(text);
          // A tombstoned checkpoint was deleted on an adapter without native
          // delete support; treat it as absent.
          if (
            parsed &&
            typeof parsed === 'object' &&
            (parsed as Record<string, unknown>)[TOMBSTONE_MARKER] === true
          ) {
            return null;
          }
          const checkpoint = parsed as MigrationCheckpoint;
          this.checkpoints.set(checkpointId, checkpoint);
          return checkpoint;
        }
      } catch (error) {
        // Checkpoint not found in storage
      }
    }

    return null;
  }

  /**
   * Delete a checkpoint.
   *
   * The in-memory entry is always removed, but callers treat a resolved
   * delete() as "durably deleted" — so failures on the persistent path
   * (a native delete throwing, or the tombstone write failing) MUST
   * propagate. Swallowing them would report success while the checkpoint
   * survives in storage, letting a fresh CheckpointStorage after restart
   * "recover" a checkpoint the caller was told was gone.
   */
  async delete(checkpointId: string): Promise<void> {
    this.checkpoints.delete(checkpointId);

    // Also delete from persistent storage. The canonical StorageAdapter has
    // no delete, so fall back to overwriting with a tombstone that get()
    // treats as absent. The tombstone is the ONLY durable deletion marker on
    // such adapters — if writing it fails, this method must reject.
    const storage = resolveMigrationStorage(this.config);
    if (storage) {
      const key = checkpointKey(checkpointId);
      const deletedNatively = await storage.deleteNative(key);
      if (!deletedNatively) {
        await storage.putText(key, JSON.stringify({ [TOMBSTONE_MARKER]: true }));
      }
    }
  }

  /**
   * Delete checkpoints older than specified timestamp
   */
  async deleteOlderThan(cutoffTime: number): Promise<void> {
    const toDelete: string[] = [];

    for (const [id, checkpoint] of this.checkpoints.entries()) {
      if (checkpoint.timestamp < cutoffTime) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      await this.delete(id);
    }
  }
}
