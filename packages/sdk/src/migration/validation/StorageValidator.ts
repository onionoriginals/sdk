/**
 * StorageValidator - Validates storage adapter compatibility
 */

import {
  MigrationOptions,
  MigrationValidationResult,
  ValidationError,
  ValidationWarning,
  IValidator
} from '../types';
import { OriginalsConfig } from '../../types';

export class StorageValidator implements IValidator {
  constructor(private config: OriginalsConfig) {}

  async validate(options: MigrationOptions): Promise<MigrationValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      const storageAdapter = (this.config as any).storageAdapter;

      // Check if storage adapter is available
      if (!storageAdapter) {
        warnings.push({
          code: 'NO_STORAGE_ADAPTER',
          message: 'No storage adapter configured; using memory storage (not persistent)'
        });
      }

      // Check large file support for partial migrations
      if (options.partialMode) {
        // Verify storage adapter supports chunked uploads
        if (storageAdapter && typeof storageAdapter.putChunk !== 'function') {
          warnings.push({
            code: 'NO_CHUNKED_UPLOAD_SUPPORT',
            message: 'Storage adapter does not support chunked uploads; partial mode may be inefficient'
          });
        }
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
