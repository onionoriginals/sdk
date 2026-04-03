import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { OriginalsCel } from '../../../src/cel/OriginalsCel';
import { signAsync, getPublicKeyAsync } from '@noble/ed25519';

describe('OriginalsSDK', () => {
  test('create() returns instance with managers and defaults', () => {
    const sdk = OriginalsSDK.create();
    expect(sdk).toBeInstanceOf(OriginalsSDK);
    expect(sdk.did).toBeDefined();
    expect(sdk.credentials).toBeDefined();
    expect(sdk.lifecycle).toBeDefined();
    expect(sdk.bitcoin).toBeDefined();
  });

  test('create() accepts config overrides', () => {
    const sdk = OriginalsSDK.create({ network: 'regtest', enableLogging: true });
    expect(sdk).toBeInstanceOf(OriginalsSDK);
  });

  test('constructor throws error when config is null', () => {
    expect(() => new OriginalsSDK(null as any)).toThrow('Configuration object is required');
  });

  test('constructor throws error when config is not an object', () => {
    expect(() => new OriginalsSDK('invalid' as any)).toThrow('Configuration object is required');
  });

  test('constructor throws error when network is invalid', () => {
    expect(() => new OriginalsSDK({ network: 'invalid' as any, defaultKeyType: 'ES256K' }))
      .toThrow('Invalid network: must be mainnet, regtest, or signet');
  });

  test('constructor throws error when network is missing', () => {
    expect(() => new OriginalsSDK({ defaultKeyType: 'ES256K' } as any))
      .toThrow('Invalid network: must be mainnet, regtest, or signet');
  });

  test('constructor throws error when defaultKeyType is invalid', () => {
    expect(() => new OriginalsSDK({ network: 'mainnet', defaultKeyType: 'invalid' as any }))
      .toThrow('Invalid defaultKeyType: must be ES256K, Ed25519, or ES256');
  });

  test('constructor throws error when defaultKeyType is missing', () => {
    expect(() => new OriginalsSDK({ network: 'mainnet' } as any))
      .toThrow('Invalid defaultKeyType: must be ES256K, Ed25519, or ES256');
  });

  describe('validateBitcoinConfig', () => {
    test('does not throw when ordinalsProvider is configured', () => {
      const mockProvider = {
        getInscription: mock(() => Promise.resolve({ id: 'test', content: new Uint8Array() })),
        getBalance: mock(() => Promise.resolve(1000)),
        getUtxos: mock(() => Promise.resolve([])),
        inscribe: mock(() => Promise.resolve({ txid: 'test', vout: 0 })),
        broadcastTx: mock(() => Promise.resolve('txid')),
        estimateFee: mock(() => Promise.resolve(10)),
      };

      const sdk = OriginalsSDK.create({ ordinalsProvider: mockProvider });
      expect(() => sdk.validateBitcoinConfig()).not.toThrow();
    });

    test('throws StructuredError when ordinalsProvider is not configured', () => {
      const sdk = OriginalsSDK.create();
      expect(() => sdk.validateBitcoinConfig()).toThrow('Bitcoin operations require an ordinalsProvider');
    });
  });

  describe('verifyDIDSignature', () => {
    let privateKey: Uint8Array;
    let publicKey32: Uint8Array;
    let publicKey33: Uint8Array;
    const message = new TextEncoder().encode('test message');

    beforeEach(async () => {
      privateKey = new Uint8Array(32).fill(1);
      publicKey32 = await getPublicKeyAsync(privateKey);
      publicKey33 = new Uint8Array(33);
      publicKey33[0] = 0x00;
      publicKey33.set(publicKey32, 1);
    });

    test('verifies valid signature with 32-byte public key', async () => {
      const signature = await signAsync(message, privateKey);
      const result = await OriginalsSDK.verifyDIDSignature(signature, message, publicKey32);
      expect(result).toBe(true);
    });

    test('verifies valid signature with 33-byte public key (slices off version byte)', async () => {
      const signature = await signAsync(message, privateKey);
      const result = await OriginalsSDK.verifyDIDSignature(signature, message, publicKey33);
      expect(result).toBe(true);
    });

    test('returns false for invalid signature', async () => {
      const signature = await signAsync(message, privateKey);
      const wrongMessage = new TextEncoder().encode('wrong message');
      const result = await OriginalsSDK.verifyDIDSignature(signature, wrongMessage, publicKey32);
      expect(result).toBe(false);
    });

    test('throws error for invalid public key length', async () => {
      const signature = await signAsync(message, privateKey);
      const invalidKey = new Uint8Array(16);
      await expect(OriginalsSDK.verifyDIDSignature(signature, message, invalidKey))
        .rejects.toThrow('Invalid Ed25519 public key length: 16');
    });

    test('returns false on verification error', async () => {
      const invalidSignature = new Uint8Array(32); // Invalid signature
      const result = await OriginalsSDK.verifyDIDSignature(invalidSignature, message, publicKey32);
      expect(result).toBe(false);
    });
  });

  describe('prepareDIDDataForSigning', () => {
    test('calls didwebvh-ts prepareDataForSigning', async () => {
      const document = { id: 'did:webvh:example.com' };
      const proof = { type: 'DataIntegrityProof' };

      // This test verifies the method exists and delegates to didwebvh-ts
      const result = await OriginalsSDK.prepareDIDDataForSigning(document, proof);
      expect(result).toBeInstanceOf(Uint8Array);
    });
  });

  describe('createCel', () => {
    test('creates CEL-first API instance', () => {
      const signer = mock(async () => ({
        type: 'DataIntegrityProof',
        cryptosuite: 'eddsa-jcs-2022',
        created: new Date().toISOString(),
        verificationMethod: 'did:key:z6MkTest#z6MkTest',
        proofPurpose: 'assertionMethod',
        proofValue: 'zMockSignature',
      }));

      const cel = OriginalsSDK.createCel({ layer: 'peer', signer });
      expect(cel).toBeInstanceOf(OriginalsCel);
    });
  });

  describe('createOriginal', () => {
    test('throws error for unsupported type', async () => {
      const options = {
        type: 'invalid' as any,
        domain: 'example.com',
      };

      await expect(OriginalsSDK.createOriginal(options))
        .rejects.toThrow('Unsupported Original type: invalid');
    });
  });

  describe('updateOriginal', () => {
    test('throws error for unsupported type', async () => {
      const options = {
        type: 'invalid' as any,
        log: [],
      };

      await expect(OriginalsSDK.updateOriginal(options))
        .rejects.toThrow('Unsupported Original type');
    });
  });
});


