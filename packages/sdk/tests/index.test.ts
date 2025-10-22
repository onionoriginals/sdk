import { describe, test, expect } from 'bun:test';
import * as SDK from '../src';

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
});


