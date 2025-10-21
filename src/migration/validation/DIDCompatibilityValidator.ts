/**
 * DIDCompatibilityValidator - Validates DID document compatibility between layers
 */

import {
  MigrationOptions,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  IValidator
} from '../types';
import { OriginalsConfig } from '../../types';
import { DIDManager } from '../../did/DIDManager';

export class DIDCompatibilityValidator implements IValidator {
  constructor(
    private config: OriginalsConfig,
    private didManager: DIDManager
  ) {}

  async validate(options: MigrationOptions): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const warnings: ValidationWarning[] = [];

    try {
      // Resolve source DID
      const sourceDid = await this.didManager.resolveDID(options.sourceDid);
      if (!sourceDid) {
        errors.push({
          code: 'SOURCE_DID_NOT_FOUND',
          message: `Could not resolve source DID: ${options.sourceDid}`,
          field: 'sourceDid'
        });
        return this.createResult(false, errors, warnings);
      }

      // Extract source layer from DID
      const sourceLayer = this.extractLayer(options.sourceDid);
      if (!sourceLayer) {
        errors.push({
          code: 'INVALID_SOURCE_DID_FORMAT',
          message: 'Source DID has unsupported format',
          field: 'sourceDid',
          details: { did: options.sourceDid }
        });
        return this.createResult(false, errors, warnings);
      }

      // Validate migration path
      const pathErrors = this.validateMigrationPath(sourceLayer, options.targetLayer);
      errors.push(...pathErrors);

      if (errors.length > 0) {
        return this.createResult(false, errors, warnings);
      }

      // Validate verification methods compatibility
      if (sourceDid.verificationMethod && Array.isArray(sourceDid.verificationMethod)) {
        for (const vm of sourceDid.verificationMethod) {
          if (!this.isVerificationMethodCompatible(vm, options.targetLayer)) {
            warnings.push({
              code: 'VERIFICATION_METHOD_INCOMPATIBLE',
              message: `Verification method ${vm.id} may not be compatible with ${options.targetLayer}`,
              field: 'verificationMethod'
            });
          }
        }
      }

      // Validate service endpoints
      if (sourceDid.service && Array.isArray(sourceDid.service)) {
        if (options.targetLayer === 'peer' && sourceDid.service.length > 0) {
          warnings.push({
            code: 'SERVICE_ENDPOINTS_ON_PEER',
            message: 'Service endpoints on peer DIDs may have limited discoverability'
          });
        }
      }

      return this.createResult(true, errors, warnings);
    } catch (error) {
      errors.push({
        code: 'DID_VALIDATION_ERROR',
        message: 'Error validating DID compatibility',
        details: { error: error instanceof Error ? error.message : String(error) }
      });
      return this.createResult(false, errors, warnings);
    }
  }

  private extractLayer(did: string): string | null {
    if (did.startsWith('did:peer:')) return 'peer';
    if (did.startsWith('did:webvh:')) return 'webvh';
    if (did.startsWith('did:btco:')) return 'btco';
    return null;
  }

  private validateMigrationPath(sourceLayer: string, targetLayer: string): ValidationError[] {
    const errors: ValidationError[] = [];

    // Check for invalid reverse migrations
    const layerOrder = { peer: 0, webvh: 1, btco: 2 };
    const sourceOrder = layerOrder[sourceLayer as keyof typeof layerOrder];
    const targetOrder = layerOrder[targetLayer as keyof typeof layerOrder];

    if (sourceOrder === undefined || targetOrder === undefined) {
      errors.push({
        code: 'INVALID_LAYER',
        message: 'Invalid source or target layer',
        details: { sourceLayer, targetLayer }
      });
      return errors;
    }

    if (sourceOrder >= targetOrder) {
      errors.push({
        code: 'INVALID_MIGRATION_PATH',
        message: `Cannot migrate from ${sourceLayer} to ${targetLayer}. Migrations must move forward through layers (peer → webvh → btco)`,
        details: { sourceLayer, targetLayer }
      });
    }

    return errors;
  }

  private isVerificationMethodCompatible(vm: any, targetLayer: string): boolean {
    // All verification method types are compatible with all layers
    // This is a placeholder for more sophisticated compatibility checks
    if (!vm.type) return false;

    // Common types that are widely supported
    const supportedTypes = ['Multikey', 'Ed25519VerificationKey2020', 'EcdsaSecp256k1VerificationKey2019'];

    return supportedTypes.includes(vm.type);
  }

  private createResult(valid: boolean, errors: ValidationError[], warnings: ValidationWarning[]): ValidationResult {
    return {
      valid,
      errors,
      warnings,
      estimatedCost: {
        storageCost: 0,
        networkFees: 0,
        totalCost: 0,
        estimatedDuration: 0,
        currency: 'sats'
      },
      estimatedDuration: 100 // DID validation typically takes ~100ms
    };
  }
}
