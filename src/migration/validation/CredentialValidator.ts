/**
 * CredentialValidator - Validates credential compatibility for migration
 */

import {
  MigrationOptions,
  MigrationValidationResult,
  ValidationError,
  ValidationWarning,
  IValidator
} from '../types';
import { OriginalsConfig } from '../../types';
import { CredentialManager } from '../../vc/CredentialManager';

export class CredentialValidator implements IValidator {
  constructor(
    private config: OriginalsConfig,
    private credentialManager: CredentialManager
  ) {}

  async validate(options: MigrationOptions): Promise<MigrationValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      // Credential validation is optional if credentialIssuance is false
      if (options.credentialIssuance === false) {
        return this.createResult(true, errors, warnings);
      }

      // All credential types are compatible with all layers
      // This validator primarily checks that credential issuance is possible

      // For now, credentials are always compatible
      // Future enhancements could include schema validation

      return this.createResult(true, errors, warnings);
    } catch (error) {
      errors.push({
        code: 'CREDENTIAL_VALIDATION_ERROR',
        message: 'Error validating credential compatibility',
        details: { error: error instanceof Error ? error.message : String(error) }
      });
      return this.createResult(false, errors, warnings);
    }
  }

  private createResult(valid: boolean, errors: ValidationError[], warnings: ValidationWarning[]): MigrationValidationResult {
    return {
      valid,
      errors,
      warnings,
      estimatedCost: {
        storageCost: 0,
        networkFees: 0,
        totalCost: 0,
        currency: 'sats'
      },
      estimatedDuration: 50 // Credential validation typically takes ~50ms
    };
  }
}
