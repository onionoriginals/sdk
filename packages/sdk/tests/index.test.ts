import { describe, test, expect } from 'bun:test';
import * as SDK from '../src';
import { OriginalsSDK as Workflow } from '../src/originals/sdk';

describe('package exports', () => {
  test('the root OriginalsSDK is the Originals workflow class', () => {
    expect(SDK.OriginalsSDK).toBe(Workflow);
    expect(SDK.default).toBe(Workflow);
    expect(SDK.MemoryStore).toBeDefined();
    expect(SDK.keySigner).toBeDefined();
    expect(SDK.readZip).toBeDefined();
    expect(SDK.writeZip).toBeDefined();
  });

  test('exports the kept DID, credential, Bitcoin and crypto utilities', () => {
    for (const name of [
      'DIDManager', 'KeyManager', 'CredentialManager', 'BitcoinManager', 'OrdinalsClient',
      'Signer', 'ES256KSigner', 'Ed25519Signer', 'ES256Signer', 'Ed25519Verifier',
      'StructuredError', 'multikey', 'canonicalDidKeyVm', 'signingInput', 'encoding',
      'QuickNodeProvider', 'OrdHttpProvider', 'RegtestProvider', 'MemoryStorageAdapter',
      'prepareInscriptionOnSat', 'validateInscriptionReveal', 'validateSatoshiNumber',
      'isValidBitcoinAddress', 'base58AddressToEd25519Multikey', 'normalizeInscriptionId',
      'normalizeSatpoint', 'createBitcoinCoreChainValidator', 'createBitcoinCoreContentValidator',
    ]) {
      expect((SDK as Record<string, unknown>)[name], name).toBeDefined();
    }
  });

  test('did:webvh identity operations are plain functions', () => {
    for (const name of ['createDIDOriginal', 'updateDIDOriginal', 'verifyDIDSignature', 'prepareDIDDataForSigning', 'createOriginal', 'updateOriginal']) {
      expect(typeof (SDK as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  test('the deleted CEL 3 and earlier asset APIs are gone', () => {
    for (const name of ['OriginalsAsset', 'LifecycleManager', 'MigrationManager', 'v3', 'verifyHistory', 'parseAssetEnvelope', 'CelError', 'createLocalSigner']) {
      expect((SDK as Record<string, unknown>)[name], name).toBeUndefined();
    }
  });
});
