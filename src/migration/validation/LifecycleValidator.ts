/**
 * LifecycleValidator - Validates lifecycle state transitions
 */

import {
  MigrationOptions,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  IValidator
} from '../types';
import { OriginalsConfig } from '../../types';

export class LifecycleValidator implements IValidator {
  constructor(private config: OriginalsConfig) {}

  async validate(options: MigrationOptions): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      // All lifecycle states are compatible with all layers
      // This validator checks for pending operations that might interfere

      // For now, lifecycle is always compatible
      // Future enhancements could check for:
      // - Pending operations on source DID
      // - State machine compatibility
      // - Event history preservation capability

      return {
        valid: errors.length === 0,
        errors,
        warnings,
        estimatedCost: {
          storageCost: 0,
          networkFees: 0,
          totalCost: 0,
          estimatedDuration: 0,
          currency: 'sats'
        },
        estimatedDuration: 30
      };
    } catch (error) {
      errors.push({
        code: 'LIFECYCLE_VALIDATION_ERROR',
        message: 'Error validating lifecycle compatibility',
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
          estimatedDuration: 0,
          currency: 'sats'
        },
        estimatedDuration: 0
      };
    }
  }
}
