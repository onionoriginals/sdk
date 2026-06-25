/**
 * Tests: LifecycleValidator auto-detects deactivation via DID resolution (issue #207)
 *
 * Verifies that the validator rejects a migration when the source DID resolves
 * to null (the signal for a deactivated did:btco) WITHOUT the caller having to
 * pass metadata.deactivated = true.
 */
import { describe, it, expect } from 'bun:test';
import { LifecycleValidator } from '../../../src/migration/validation/LifecycleValidator';
import type { DIDManager } from '../../../src/did/DIDManager';
import type { MigrationOptions } from '../../../src/migration/types';
import type { OriginalsConfig } from '../../../src/types';

const testConfig: OriginalsConfig = {
  network: 'regtest',
  webvhNetwork: 'magby',
  defaultKeyType: 'Ed25519',
  enableLogging: false,
};

/** Minimal MigrationOptions pointing to a did:btco source */
const btcoOptions: MigrationOptions = {
  sourceDid: 'did:btco:reg:123456',
  targetLayer: 'webvh',
};

describe('LifecycleValidator — deactivation auto-detect', () => {
  it('rejects migration when DIDManager.resolveDID returns null (deactivated DID), without metadata flag', async () => {
    // Arrange: mock DIDManager whose resolveDID returns null (simulates 🔥 deactivation)
    const mockDIDManager = {
      resolveDID: async (_did: string) => null,
    } as unknown as DIDManager;

    const validator = new LifecycleValidator(testConfig, mockDIDManager);

    // Act: validate without setting metadata.deactivated
    const result = await validator.validate(btcoOptions);

    // Assert: should be invalid with ASSET_DEACTIVATED error detected via resolution
    expect(result.valid).toBe(false);
    const deactivatedError = result.errors.find(e => e.code === 'ASSET_DEACTIVATED');
    expect(deactivatedError).toBeDefined();
    expect(deactivatedError!.details).toMatchObject({ detectedBy: 'did-resolution' });
  });

  it('rejects migration when metadata.deactivated is true (existing path still works)', async () => {
    const validator = new LifecycleValidator(testConfig);

    const result = await validator.validate({
      ...btcoOptions,
      metadata: { deactivated: true },
    });

    expect(result.valid).toBe(false);
    const deactivatedError = result.errors.find(e => e.code === 'ASSET_DEACTIVATED');
    expect(deactivatedError).toBeDefined();
    expect(deactivatedError!.field).toBe('metadata.deactivated');
  });

  it('does not add duplicate error when both metadata flag and null resolution are present', async () => {
    // When metadata.deactivated is true, Path 2 is skipped entirely to avoid duplicates
    const mockDIDManager = {
      resolveDID: async (_did: string) => null,
    } as unknown as DIDManager;

    const validator = new LifecycleValidator(testConfig, mockDIDManager);

    const result = await validator.validate({
      ...btcoOptions,
      metadata: { deactivated: true },
    });

    expect(result.valid).toBe(false);
    const deactivatedErrors = result.errors.filter(e => e.code === 'ASSET_DEACTIVATED');
    // Only one error should be emitted (from Path 1; Path 2 is skipped)
    expect(deactivatedErrors.length).toBe(1);
  });

  it('allows migration when DIDManager.resolveDID returns a valid document', async () => {
    const mockDIDManager = {
      resolveDID: async (_did: string) => ({
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: 'did:btco:reg:123456',
      }),
    } as unknown as DIDManager;

    const validator = new LifecycleValidator(testConfig, mockDIDManager);

    const result = await validator.validate(btcoOptions);

    // Should pass (no ASSET_DEACTIVATED error)
    const deactivatedError = result.errors.find(e => e.code === 'ASSET_DEACTIVATED');
    expect(deactivatedError).toBeUndefined();
  });

  it('allows migration when no DIDManager is wired in (backward-compat: resolver-less path)', async () => {
    // Without a DIDManager, Path 2 is skipped entirely
    const validator = new LifecycleValidator(testConfig);

    const result = await validator.validate(btcoOptions);

    // No deactivation error from resolution
    const deactivatedError = result.errors.find(e => e.code === 'ASSET_DEACTIVATED');
    expect(deactivatedError).toBeUndefined();
  });

  it('is non-fatal when DIDManager.resolveDID throws (resolution error does not block migration)', async () => {
    const mockDIDManager = {
      resolveDID: async (_did: string) => {
        throw new Error('network unreachable');
      },
    } as unknown as DIDManager;

    const validator = new LifecycleValidator(testConfig, mockDIDManager);

    // Should not throw and should not emit ASSET_DEACTIVATED (can't confirm deactivation)
    const result = await validator.validate(btcoOptions);

    const deactivatedError = result.errors.find(e => e.code === 'ASSET_DEACTIVATED');
    expect(deactivatedError).toBeUndefined();
  });
});
