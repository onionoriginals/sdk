/**
 * LifecycleValidator - Validates lifecycle state transitions
 */

import {
  MigrationOptions,
  MigrationValidationResult,
  ValidationError,
  ValidationWarning,
  IValidator
} from '../types';
import { OriginalsConfig } from '../../types';

export class LifecycleValidator implements IValidator {
  constructor(private config: OriginalsConfig) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async validate(options: MigrationOptions): Promise<MigrationValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      // DEF-019: Reject migration of deactivated assets.
      //
      // Deactivation state is not encoded in the DIDDocument itself (DIDDocument
      // has no `deactivated` field in this SDK's type system).  The caller
      // signals deactivation through MigrationOptions.metadata.deactivated.
      // Sources that set this include the CEL layer state machines
      // (PeerCelManager / BtcoCelManager) and the OriginalsSDK verify path.
      const deactivated = options.metadata?.['deactivated'];
      if (deactivated === true) {
        errors.push({
          code: 'ASSET_DEACTIVATED',
          message: 'Cannot migrate a deactivated asset',
          field: 'metadata.deactivated',
          details: { sourceDid: options.sourceDid }
        });
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
        estimatedCost: {
          storageCost: 0,
          networkFees: 0,
          totalCost: 0,
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
          currency: 'sats'
        },
        estimatedDuration: 0
      };
    }
  }
}
