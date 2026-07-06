/**
 * StorageValidator - Validates storage adapter compatibility
 */

import {
  MigrationOptions,
  MigrationValidationResult,
  ValidationError,
  ValidationWarning,
  IValidator
} from '../types.js';
import { OriginalsConfig } from '../../types/index.js';
import { resolveMigrationStorage } from '../storage/MigrationStorage.js';

export class StorageValidator implements IValidator {
  constructor(private config: OriginalsConfig) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async validate(options: MigrationOptions): Promise<MigrationValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      const storageAdapter = (this.config as { storageAdapter?: unknown }).storageAdapter;

      // Resolve the adapter through the same shape-adaptation the migration
      // system actually uses for persistence (canonical putObject/getObject,
      // or legacy put/get). This replaces the old duck-typed `putChunk` probe:
      // no shipped StorageAdapter ever had putChunk, so that check misreported
      // shipped adapters as incapable while letting genuinely unusable
      // adapters pass silently (issue #318; same bug class as the
      // CheckpointStorage/AuditLogger fix).
      const migrationStorage = resolveMigrationStorage(this.config);

      // Check if storage adapter is available
      if (!storageAdapter) {
        warnings.push({
          code: 'NO_STORAGE_ADAPTER',
          message: 'No storage adapter configured; using memory storage (not persistent)'
        });
      } else if (!migrationStorage) {
        // Fail closed: an adapter is configured but exposes none of the
        // methods the migration system can persist through, so checkpoints,
        // audit records, and partial-migration state would be silently lost.
        errors.push({
          code: 'STORAGE_ADAPTER_INCOMPATIBLE',
          message:
            'Configured storage adapter exposes neither putObject/getObject (StorageAdapter interface) ' +
            'nor legacy put/get; migration state cannot be persisted',
          field: 'storageAdapter'
        });
      }

      // Partial (chunked/resumable) migrations persist intermediate state
      // through the storage adapter. Resumable mode is impossible without
      // persistent storage, so surface that as a hard error instead of
      // silently accepting options that cannot be honored.
      if (options.partialMode?.resumable && !migrationStorage) {
        errors.push({
          code: 'PARTIAL_MODE_STORAGE_REQUIRED',
          message:
            'partialMode.resumable requires a storage adapter that can persist objects ' +
            '(putObject/getObject or legacy put/get); resume state cannot be persisted',
          field: 'partialMode.resumable'
        });
      }

      // Estimate storage costs (minimal for webvh, zero for peer/btco)
      const storageCost = options.targetLayer === 'webvh' ? 0.001 : 0;

      return {
        valid: errors.length === 0,
        errors,
        warnings,
        estimatedCost: {
          storageCost,
          networkFees: 0,
          totalCost: storageCost,
          currency: 'sats'
        },
        estimatedDuration: 50
      };
    } catch (error) {
      errors.push({
        code: 'STORAGE_VALIDATION_ERROR',
        message: 'Error validating storage compatibility',
        details: { error: error instanceof Error ? error.message : String(error) }
      });

      return {
        valid: false,
        errors,
        warnings,
        estimatedCost: {
          storageCost: 0,
          networkFees: 0,
          totalCost: 0,
          currency: 'sats'
        },
        estimatedDuration: 0
      };
    }
  }
}
