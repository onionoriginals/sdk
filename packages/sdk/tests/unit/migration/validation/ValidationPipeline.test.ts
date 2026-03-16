/**
 * Tests for ValidationPipeline - explicit validator guards and missing validator scenarios
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { ValidationPipeline } from '../../../../src/migration/validation/ValidationPipeline';
import { DIDManager } from '../../../../src/did/DIDManager';
import { CredentialManager } from '../../../../src/vc/CredentialManager';
import type { OriginalsConfig } from '../../../../src/types';
import type { MigrationOptions } from '../../../../src/migration/types';

// Minimal config for testing
const testConfig: OriginalsConfig = {
  network: 'regtest',
  webvhNetwork: 'magby',
  defaultKeyType: 'Ed25519',
  enableLogging: false,
};

describe('ValidationPipeline', () => {
  let pipeline: ValidationPipeline;
  let didManager: DIDManager;
  let credentialManager: CredentialManager;

  beforeEach(() => {
    didManager = {} as DIDManager;
    credentialManager = {} as CredentialManager;
    pipeline = new ValidationPipeline(testConfig, didManager, credentialManager);
  });

  describe('validator guard safety', () => {
    it('should return structured error when DID validator is missing', async () => {
      // Force-remove the DID validator to simulate missing state
      const validators = (pipeline as any).validators as Map<string, any>;
      validators.delete('did');

      const options: MigrationOptions = {
        sourceDid: 'did:peer:123',
        targetLayer: 'webvh',
        domain: 'example.com',
      };

      const result = await pipeline.validate(options);
      expect(result.valid).toBe(false);
      const didError = result.errors.find(e => e.code === 'DID_VALIDATOR_MISSING');
      expect(didError).toBeDefined();
      expect(didError!.message).toContain('DID compatibility validator');
    });

    it('should return structured error when credential validator is missing', async () => {
      const validators = (pipeline as any).validators as Map<string, any>;
      validators.delete('credential');

      // Mock DID validator to pass
      validators.set('did', {
        validate: async () => ({
          valid: true,
          errors: [],
          warnings: [],
          estimatedCost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' },
          estimatedDuration: 0,
        }),
      });

      const options: MigrationOptions = {
        sourceDid: 'did:peer:123',
        targetLayer: 'webvh',
        domain: 'example.com',
        credentialIssuance: true,
      };

      const result = await pipeline.validate(options);
      const credError = result.errors.find(e => e.code === 'CREDENTIAL_VALIDATOR_MISSING');
      expect(credError).toBeDefined();
      expect(credError!.message).toContain('Credential validator');
    });

    it('should return structured error when storage validator is missing', async () => {
      const validators = (pipeline as any).validators as Map<string, any>;
      validators.delete('storage');

      // Mock DID validator to pass
      validators.set('did', {
        validate: async () => ({
          valid: true,
          errors: [],
          warnings: [],
          estimatedCost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' },
          estimatedDuration: 0,
        }),
      });

      const options: MigrationOptions = {
        sourceDid: 'did:peer:123',
        targetLayer: 'webvh',
        domain: 'example.com',
        credentialIssuance: false,
      };

      const result = await pipeline.validate(options);
      const storageError = result.errors.find(e => e.code === 'STORAGE_VALIDATOR_MISSING');
      expect(storageError).toBeDefined();
      expect(storageError!.message).toContain('Storage validator');
    });

    it('should return structured error when lifecycle validator is missing', async () => {
      const validators = (pipeline as any).validators as Map<string, any>;
      validators.delete('lifecycle');

      // Mock required validators to pass
      const passResult = {
        valid: true,
        errors: [],
        warnings: [],
        estimatedCost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' },
        estimatedDuration: 0,
      };
      validators.set('did', { validate: async () => passResult });
      validators.set('storage', { validate: async () => passResult });

      const options: MigrationOptions = {
        sourceDid: 'did:peer:123',
        targetLayer: 'webvh',
        domain: 'example.com',
        credentialIssuance: false,
      };

      const result = await pipeline.validate(options);
      const lifecycleError = result.errors.find(e => e.code === 'LIFECYCLE_VALIDATOR_MISSING');
      expect(lifecycleError).toBeDefined();
      expect(lifecycleError!.message).toContain('Lifecycle validator');
    });

    it('should return structured error when bitcoin validator is missing for btco migration', async () => {
      // Pipeline without bitcoinManager already lacks bitcoin validator
      const passResult = {
        valid: true,
        errors: [],
        warnings: [],
        estimatedCost: { storageCost: 0, networkFees: 0, totalCost: 0, currency: 'sats' },
        estimatedDuration: 0,
      };
      const validators = (pipeline as any).validators as Map<string, any>;
      validators.set('did', { validate: async () => passResult });
      validators.set('storage', { validate: async () => passResult });
      validators.set('lifecycle', { validate: async () => passResult });

      const options: MigrationOptions = {
        sourceDid: 'did:peer:123',
        targetLayer: 'btco',
        credentialIssuance: false,
      };

      const result = await pipeline.validate(options);
      const btcError = result.errors.find(e => e.code === 'BITCOIN_VALIDATOR_MISSING');
      expect(btcError).toBeDefined();
      expect(btcError!.message).toContain('Bitcoin validator required');
    });

    it('should accumulate multiple missing validator errors', async () => {
      const validators = (pipeline as any).validators as Map<string, any>;
      validators.clear(); // Remove all validators

      const options: MigrationOptions = {
        sourceDid: 'did:peer:123',
        targetLayer: 'webvh',
        domain: 'example.com',
        credentialIssuance: false,
      };

      const result = await pipeline.validate(options);
      expect(result.valid).toBe(false);

      const missingErrors = result.errors.filter(e => e.code.endsWith('_MISSING'));
      // Should have DID, storage, and lifecycle missing (credential skipped because credentialIssuance=false)
      expect(missingErrors.length).toBe(3);
    });
  });
});
