/**
 * BitcoinValidator - Validates Bitcoin network requirements for btco migrations
 */

import {
  MigrationOptions,
  MigrationValidationResult,
  ValidationError,
  ValidationWarning,
  IValidator
} from '../types.js';
import { OriginalsConfig } from '../../types/index.js';
import { BitcoinManager } from '../../bitcoin/BitcoinManager.js';

export class BitcoinValidator implements IValidator {
  constructor(
    private config: OriginalsConfig,
    private bitcoinManager: BitcoinManager
  ) {}

  async validate(options: MigrationOptions): Promise<MigrationValidationResult> {
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
      const estimatedDuration = 600000; // 10 minutes default

      try {
        // Estimate fee for a typical inscription (assume ~1KB envelope).
        const estimatedSize = 1024; // bytes
        // Prefer the caller-supplied feeRate; otherwise actually consult the
        // fee oracle, then the provider's estimator. This is a real (possibly
        // network) call, so a genuine failure now reaches the catch below —
        // previously the block was pure arithmetic and FEE_ESTIMATION_FAILED
        // was unreachable dead code.
        let feeRate = options.feeRate;
        if (feeRate === undefined) {
          feeRate = this.config.feeOracle
            ? await this.config.feeOracle.estimateFeeRate(1)
            : await ordinalsProvider.estimateFee(1);
        }
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
          message: `Could not estimate Bitcoin network fees: ${error instanceof Error ? error.message : String(error)}`
        });
        networkFees = 10240; // Default fallback: ~1KB at 10 sat/vB
      }

      // btco anchoring uses the SDK's configured Bitcoin network as-is
      // (regtest->regtest, signet->signet). Warn on any non-mainnet network so
      // the caller knows this is not a production anchor — the old text wrongly
      // claimed regtest "will use signet", which the network mapping never does.
      if (this.config.network !== 'mainnet') {
        warnings.push({
          code: 'NON_MAINNET_NETWORK',
          message: `Bitcoin anchoring will use the '${this.config.network}' network (non-mainnet)`
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
  ): MigrationValidationResult {
    return {
      valid,
      errors,
      warnings,
      estimatedCost: {
        storageCost: 0,
        networkFees,
        totalCost: networkFees,
        currency: 'sats'
      },
      estimatedDuration: duration
    };
  }
}
