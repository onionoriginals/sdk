/**
 * CheckpointStorage - Persists checkpoints to storage
 */

import { MigrationCheckpoint } from '../types';
import { OriginalsConfig } from '../../types';

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

    // Optionally persist to configured storage adapter
    const storageAdapter = (this.config as any).storageAdapter;
    if (storageAdapter && typeof storageAdapter.put === 'function') {
      try {
        const data = JSON.stringify(checkpoint);
        const key = `checkpoints/${checkpoint.checkpointId}.json`;
        await storageAdapter.put(key, Buffer.from(data), { contentType: 'application/json' });
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

    // Try loading from storage adapter
    const storageAdapter = (this.config as any).storageAdapter;
    if (storageAdapter && typeof storageAdapter.get === 'function') {
      try {
        const key = `checkpoints/${checkpointId}.json`;
        const data = await storageAdapter.get(key);
        if (data) {
          const checkpoint = JSON.parse(data.toString());
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
   * Delete a checkpoint
   */
  async delete(checkpointId: string): Promise<void> {
    this.checkpoints.delete(checkpointId);

    // Also delete from storage adapter
    const storageAdapter = (this.config as any).storageAdapter;
    if (storageAdapter && typeof storageAdapter.delete === 'function') {
      try {
        const key = `checkpoints/${checkpointId}.json`;
        await storageAdapter.delete(key);
      } catch (error) {
        // Ignore deletion errors
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
