/**
 * BitcoinValidator - Validates Bitcoin network requirements for btco migrations
 */

import {
  MigrationOptions,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  IValidator
} from '../types';
import { OriginalsConfig } from '../../types';
import { BitcoinManager } from '../../bitcoin/BitcoinManager';

export class BitcoinValidator implements IValidator {
  constructor(
    private config: OriginalsConfig,
    private bitcoinManager: BitcoinManager
  ) {}

  async validate(options: MigrationOptions): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      // Only validate for btco migrations
      if (options.targetLayer !== 'btco') {
        return this.createResult(true, errors, warnings, 0, 0);
      }

      // Check if Bitcoin provider is configured
      const ordinalsProvider = this.config.ordinalsProvider;
      if (!ordinalsProvider) {
        errors.push({
          code: 'BITCOIN_PROVIDER_REQUIRED',
          message: 'Ordinals provider is required for btco migrations',
          details: { targetLayer: options.targetLayer }
        });
        return this.createResult(false, errors, warnings, 0, 0);
      }

      // Estimate Bitcoin network fees
      let networkFees = 0;
      let estimatedDuration = 600000; // 10 minutes default

      try {
        // Estimate fee for a typical inscription (assume 1KB data)
        const estimatedSize = 1024; // bytes
        const feeRate = options.feeRate || 10; // sats/vB
        networkFees = estimatedSize * feeRate;

        // Check if fee is within reasonable limits
        if (feeRate > 1000) {
          warnings.push({
            code: 'HIGH_FEE_RATE',
            message: `Fee rate of ${feeRate} sat/vB is unusually high`,
            field: 'feeRate'
          });
        }
      } catch (error) {
        warnings.push({
          code: 'FEE_ESTIMATION_FAILED',
          message: 'Could not estimate Bitcoin network fees',
          details: { error: error instanceof Error ? error.message : String(error) }
        });
        networkFees = 10240; // Default fallback: ~10KB at 10 sat/vB
      }

      // Validate network (should be signet for testnet)
      if (this.config.network !== 'mainnet' && this.config.network !== 'signet') {
        warnings.push({
          code: 'NETWORK_MISMATCH',
          message: `Network '${this.config.network}' will use signet for Bitcoin anchoring`
        });
      }

      return this.createResult(true, errors, warnings, networkFees, estimatedDuration);
    } catch (error) {
      errors.push({
        code: 'BITCOIN_VALIDATION_ERROR',
        message: 'Error validating Bitcoin requirements',
        details: { error: error instanceof Error ? error.message : String(error) }
      });
      return this.createResult(false, errors, warnings, 0, 0);
    }
  }

  private createResult(
    valid: boolean,
    errors: ValidationError[],
    warnings: ValidationWarning[],
    networkFees: number,
    duration: number
  ): ValidationResult {
    return {
      valid,
      errors,
      warnings,
      estimatedCost: {
        storageCost: 0,
        networkFees,
        totalCost: networkFees,
        estimatedDuration: duration,
        currency: 'sats'
      },
      estimatedDuration: duration
    };
  }
}
