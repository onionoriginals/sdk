import { describe, test, expect } from 'bun:test';
import * as SDK from '../src';
import { MigrationManager } from '../src/migration';

describe('package exports', () => {
  test('exports core classes and utils', () => {
    expect(SDK.OriginalsSDK).toBeDefined();
    expect(SDK.OriginalsAsset).toBeDefined();
    expect(SDK.DIDManager).toBeDefined();
    expect(SDK.KeyManager).toBeDefined();
    expect(SDK.CredentialManager).toBeDefined();
    expect(SDK.LifecycleManager).toBeDefined();
    expect(SDK.BitcoinManager).toBeDefined();
    expect(SDK.OrdinalsClient).toBeDefined();
    expect(SDK.Signer).toBeDefined();
    expect(SDK.ES256KSigner).toBeDefined();
    expect(SDK.Ed25519Signer).toBeDefined();
    expect(SDK.ES256Signer).toBeDefined();
  });

  // Issue #279: the experimental MigrationManager subsystem is intentionally NOT
  // part of the public API (it is unused in production and its safety machinery
  // protects no real path). It must not be re-exported from the package entry
  // point, but must remain importable from its module path for experimentation.
  test('does not re-export the experimental MigrationManager from the package root', () => {
    expect((SDK as Record<string, unknown>).MigrationManager).toBeUndefined();
    // Still available at its module path (subsystem itself is intact).
    expect(MigrationManager).toBeDefined();
  });
});


