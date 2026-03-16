/**
 * Tests for data model audit fixes (ORI-66, ORI-67, ORI-68)
 */
import { describe, test, expect } from 'bun:test';
import { CostEstimate, MigrationValidationResult } from '../../../src/migration/types';
import { DataIntegrityProof } from '../../../src/cel/types';
import { DataIntegrityProof as EdDSADataIntegrityProof } from '../../../src/vc/cryptosuites/eddsa';
import { ResourceVersionManager, ResourceHistory } from '../../../src/lifecycle/ResourceVersioning';

describe('ORI-66: CostEstimate shape consistency', () => {
  test('CostEstimate interface accepts estimatedDuration', () => {
    const cost: CostEstimate = {
      storageCost: 100,
      networkFees: 50,
      totalCost: 150,
      currency: 'sats',
      estimatedDuration: 5000
    };
    expect(cost.estimatedDuration).toBe(5000);
  });

  test('CostEstimate allows omitting estimatedDuration', () => {
    const cost: CostEstimate = {
      storageCost: 100,
      networkFees: 50,
      totalCost: 150,
      currency: 'sats'
    };
    expect(cost.estimatedDuration).toBeUndefined();
  });

  test('MigrationValidationResult estimatedCost matches CostEstimate shape', () => {
    const result: MigrationValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
      estimatedCost: {
        storageCost: 0,
        networkFees: 0,
        totalCost: 0,
        estimatedDuration: 0,
        currency: 'sats'
      },
      estimatedDuration: 0
    };
    expect(result.estimatedCost.estimatedDuration).toBe(0);
  });
});

describe('ORI-67: ValidationPipeline validator guards', () => {
  test('ValidationPipeline returns structured errors for missing validators', async () => {
    // Import dynamically to test the class
    const { ValidationPipeline } = await import('../../../src/migration/validation/ValidationPipeline');
    const { DIDManager } = await import('../../../src/did/DIDManager');
    const { CredentialManager } = await import('../../../src/vc/CredentialManager');

    const config = {
      network: 'regtest' as const,
      webvhNetwork: 'magby' as const,
      defaultKeyType: 'Ed25519' as const,
    };

    const didManager = new DIDManager(config);
    const credentialManager = new CredentialManager(config);
    const pipeline = new ValidationPipeline(config, didManager, credentialManager);

    // Clear validators to simulate missing validators
    // @ts-ignore - accessing private field for testing
    pipeline.validators.clear();

    const result = await pipeline.validate({
      sourceDid: 'did:peer:test',
      targetLayer: 'webvh',
      domain: 'example.com'
    });

    expect(result.valid).toBe(false);
    const validatorErrors = result.errors.filter(e => e.code === 'VALIDATOR_NOT_CONFIGURED');
    expect(validatorErrors.length).toBeGreaterThanOrEqual(1);
    expect(validatorErrors[0].details).toHaveProperty('validator');
  });
});

describe('ORI-68: DataIntegrityProof deduplication', () => {
  test('cel/types.ts DataIntegrityProof is the canonical definition', () => {
    const proof: DataIntegrityProof = {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      created: '2024-01-01T00:00:00Z',
      verificationMethod: 'did:example:123#key-1',
      proofPurpose: 'assertionMethod',
      proofValue: 'z1234',
      id: 'proof-1',
      previousProof: 'proof-0'
    };
    expect(proof.id).toBe('proof-1');
    expect(proof.previousProof).toBe('proof-0');
  });

  test('eddsa.ts re-exports same DataIntegrityProof type', () => {
    // Both imports should reference the same type
    const proof: EdDSADataIntegrityProof = {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      verificationMethod: 'did:example:123#key-1',
      proofPurpose: 'assertionMethod',
      proofValue: 'z1234',
      previousProof: ['proof-0', 'proof-1']
    };
    expect(proof.previousProof).toEqual(['proof-0', 'proof-1']);
    expect(proof.created).toBeUndefined();
  });

  test('DataIntegrityProof supports optional fields', () => {
    const minimal: DataIntegrityProof = {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-jcs-2022',
      verificationMethod: 'did:example:123#key-1',
      proofPurpose: 'assertionMethod',
      proofValue: 'z1234'
    };
    expect(minimal.id).toBeUndefined();
    expect(minimal.previousProof).toBeUndefined();
    expect(minimal.created).toBeUndefined();
  });
});

describe('ORI-68: ResourceHistory includes versionCount', () => {
  test('ResourceHistory returned by getHistory includes versionCount', () => {
    const manager = new ResourceVersionManager();
    manager.addVersion('res-1', 'hash-1', 'image/png');
    manager.addVersion('res-1', 'hash-2', 'image/png', 'hash-1', 'Updated colors');

    const history = manager.getHistory('res-1');
    expect(history).not.toBeNull();
    expect(history!.versionCount).toBe(2);
    expect(history!.versions.length).toBe(history!.versionCount);
  });

  test('ResourceHistory versionCount matches versions array length', () => {
    const manager = new ResourceVersionManager();
    manager.addVersion('res-1', 'hash-1', 'text/plain');

    const history = manager.getHistory('res-1') as ResourceHistory;
    expect(history.versionCount).toBe(1);
    expect(history.versions).toHaveLength(1);
    expect(history.currentVersion.hash).toBe('hash-1');
  });
});
