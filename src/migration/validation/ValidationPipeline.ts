/**
 * ValidationPipeline - Orchestrates all validation checks before migration
 */

import {
  MigrationOptions,
  MigrationValidationResult,
  ValidationError,
  ValidationWarning,
  CostEstimate,
  IValidator
} from '../types';
import { DIDCompatibilityValidator } from './DIDCompatibilityValidator';
import { CredentialValidator } from './CredentialValidator';
import { StorageValidator } from './StorageValidator';
import { LifecycleValidator } from './LifecycleValidator';
import { BitcoinValidator } from './BitcoinValidator';
import { OriginalsConfig } from '../../types';
import { DIDManager } from '../../did/DIDManager';
import { CredentialManager } from '../../vc/CredentialManager';
import { BitcoinManager } from '../../bitcoin/BitcoinManager';

export class ValidationPipeline {
  private validators: Map<string, IValidator>;

  constructor(
    private config: OriginalsConfig,
    private didManager: DIDManager,
    private credentialManager: CredentialManager,
    private bitcoinManager?: BitcoinManager
  ) {
    this.validators = new Map();
    this.initializeValidators();
  }

  private initializeValidators(): void {
    this.validators.set('did', new DIDCompatibilityValidator(this.config, this.didManager));
    this.validators.set('credential', new CredentialValidator(this.config, this.credentialManager));
    this.validators.set('storage', new StorageValidator(this.config));
    this.validators.set('lifecycle', new LifecycleValidator(this.config));
    if (this.bitcoinManager) {
      this.validators.set('bitcoin', new BitcoinValidator(this.config, this.bitcoinManager));
    }
  }

  /**
   * Run all validation checks for a migration
   */
  async validate(options: MigrationOptions): Promise<MigrationValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];
    let estimatedCost: CostEstimate = {
      storageCost: 0,
      networkFees: 0,
      totalCost: 0,
      currency: 'sats'
    };
    let estimatedDuration = 0;

    try {
      // Basic input validation
      const inputErrors = this.validateInput(options);
      if (inputErrors.length > 0) {
        return {
          valid: false,
          errors: inputErrors,
          warnings: [],
          estimatedCost,
          estimatedDuration: 0
        };
      }

      // Run DID compatibility validation
      const didResult = await this.validators.get('did')!.validate(options);
      errors.push(...didResult.errors);
      warnings.push(...didResult.warnings);
      estimatedDuration = Math.max(estimatedDuration, didResult.estimatedDuration);

      // Run credential validation if enabled
      if (options.credentialIssuance !== false) {
        const credResult = await this.validators.get('credential')!.validate(options);
        errors.push(...credResult.errors);
        warnings.push(...credResult.warnings);
      }

      // Run storage validation
      const storageResult = await this.validators.get('storage')!.validate(options);
      errors.push(...storageResult.errors);
      warnings.push(...storageResult.warnings);
      estimatedCost.storageCost = storageResult.estimatedCost.storageCost;

      // Run lifecycle validation
      const lifecycleResult = await this.validators.get('lifecycle')!.validate(options);
      errors.push(...lifecycleResult.errors);
      warnings.push(...lifecycleResult.warnings);

      // Run Bitcoin validation for btco migrations
      if (options.targetLayer === 'btco') {
        const bitcoinValidator = this.validators.get('bitcoin');
        if (!bitcoinValidator) {
          errors.push({
            code: 'BITCOIN_VALIDATOR_MISSING',
            message: 'Bitcoin validator required for btco migrations but not configured',
            details: { targetLayer: options.targetLayer }
          });
        } else {
          const bitcoinResult = await bitcoinValidator.validate(options);
          errors.push(...bitcoinResult.errors);
          warnings.push(...bitcoinResult.warnings);
          estimatedCost.networkFees = bitcoinResult.estimatedCost.networkFees;
          estimatedDuration = Math.max(estimatedDuration, bitcoinResult.estimatedDuration);
        }
      }

      // Calculate total cost
      estimatedCost.totalCost = estimatedCost.storageCost + estimatedCost.networkFees;

      return {
        valid: errors.length === 0,
        errors,
        warnings,
        estimatedCost,
        estimatedDuration
      };
    } catch (error) {
      errors.push({
        code: 'VALIDATION_PIPELINE_ERROR',
        message: 'Unexpected error during validation',
        details: { error: error instanceof Error ? error.message : String(error) }
      });

      return {
        valid: false,
        errors,
        warnings,
        estimatedCost,
        estimatedDuration
      };
    }
  }

  /**
   * Validate basic input parameters
   */
  private validateInput(options: MigrationOptions): ValidationError[] {
    const errors: ValidationError[] = [];

    // Validate source DID
    if (!options.sourceDid || typeof options.sourceDid !== 'string') {
      errors.push({
        code: 'INVALID_SOURCE_DID',
        message: 'Source DID is required and must be a string',
        field: 'sourceDid'
      });
    }

    // Validate target layer
    if (!options.targetLayer) {
      errors.push({
        code: 'INVALID_TARGET_LAYER',
        message: 'Target layer is required',
        field: 'targetLayer'
      });
    } else if (!['peer', 'webvh', 'btco'].includes(options.targetLayer)) {
      errors.push({
        code: 'INVALID_TARGET_LAYER',
        message: 'Target layer must be one of: peer, webvh, btco',
        field: 'targetLayer',
        details: { received: options.targetLayer }
      });
    }

    // Validate partial mode options
    if (options.partialMode) {
      if (typeof options.partialMode.chunkSize !== 'number' || options.partialMode.chunkSize <= 0) {
        errors.push({
          code: 'INVALID_CHUNK_SIZE',
          message: 'Chunk size must be a positive number',
          field: 'partialMode.chunkSize'
        });
      }
    }

    // Validate webvh-specific options
    if (options.targetLayer === 'webvh' && !options.domain) {
      errors.push({
        code: 'DOMAIN_REQUIRED',
        message: 'Domain is required for webvh migrations',
        field: 'domain'
      });
    }

    // Validate btco-specific options
    if (options.targetLayer === 'btco') {
      if (options.feeRate !== undefined && (typeof options.feeRate !== 'number' || options.feeRate <= 0)) {
        errors.push({
          code: 'INVALID_FEE_RATE',
          message: 'Fee rate must be a positive number',
          field: 'feeRate'
        });
      }
    }

    return errors;
  }

  /**
   * Quick validation check (basic only, no async operations)
   */
  validateQuick(options: MigrationOptions): ValidationError[] {
    return this.validateInput(options);
  }
}
