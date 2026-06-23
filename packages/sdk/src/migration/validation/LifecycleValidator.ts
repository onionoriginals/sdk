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
import type { DIDManager } from '../../did/DIDManager';

export class LifecycleValidator implements IValidator {
  constructor(
    private config: OriginalsConfig,
    private didManager?: DIDManager
  ) {}

  async validate(options: MigrationOptions): Promise<MigrationValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      // DEF-019: Reject migration of deactivated assets.
      //
      // Belt-and-braces: two complementary detection paths.
      //
      // Path 1 (caller-supplied flag): The caller may signal deactivation via
      // MigrationOptions.metadata.deactivated (used by CEL layer state machines
      // and the OriginalsSDK verify path).
      const deactivated = options.metadata?.['deactivated'];
      if (deactivated === true) {
        errors.push({
          code: 'ASSET_DEACTIVATED',
          message: 'Cannot migrate a deactivated asset',
          field: 'metadata.deactivated',
          details: { sourceDid: options.sourceDid }
        });
      }

      // Path 2 (auto-detect via DID resolution): If a DIDManager is available
      // and the caller has NOT already flagged deactivation, resolve the source
      // DID and treat a null result as a deactivation signal.
      //
      // Rationale: BtcoDidResolver sets didDocument to null when the inscription
      // contains a deactivation marker (🔥), so DIDManager.resolveDID() returns
      // null for a deactivated did:btco. For did:peer / did:webvh the resolver
      // always returns a (possibly stub) document, so a null result specifically
      // indicates a resolution failure that is treated conservatively as
      // deactivation to prevent migration of an unresolvable asset.
      //
      // We skip this check when the metadata flag already fired (to avoid
      // duplicating the error) and skip it when no DIDManager is wired in
      // (preserves backward-compatibility for callers that construct the
      // validator without a resolver).
      if (deactivated !== true && this.didManager && options.sourceDid) {
        let resolvedDoc: Awaited<ReturnType<DIDManager['resolveDID']>> | undefined;
        try {
          resolvedDoc = await this.didManager.resolveDID(options.sourceDid);
        } catch {
          // Resolution errors are non-fatal for the validator; the DID
          // compatibility validator will surface connectivity issues separately.
        }
        if (resolvedDoc === null) {
          errors.push({
            code: 'ASSET_DEACTIVATED',
            message: 'Cannot migrate a deactivated asset',
            field: 'sourceDid',
            details: { sourceDid: options.sourceDid, detectedBy: 'did-resolution' }
          });
        }
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
