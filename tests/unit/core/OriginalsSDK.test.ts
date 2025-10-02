import { OriginalsSDK } from '../../../src';

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
    const sdk = OriginalsSDK.create({ network: 'testnet', enableLogging: true });
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
      .toThrow('Invalid network: must be mainnet, testnet, regtest, or signet');
  });

  test('constructor throws error when network is missing', () => {
    expect(() => new OriginalsSDK({ defaultKeyType: 'ES256K' } as any))
      .toThrow('Invalid network: must be mainnet, testnet, regtest, or signet');
  });

  test('constructor throws error when defaultKeyType is invalid', () => {
    expect(() => new OriginalsSDK({ network: 'mainnet', defaultKeyType: 'invalid' as any }))
      .toThrow('Invalid defaultKeyType: must be ES256K, Ed25519, or ES256');
  });

  test('constructor throws error when defaultKeyType is missing', () => {
    expect(() => new OriginalsSDK({ network: 'mainnet' } as any))
      .toThrow('Invalid defaultKeyType: must be ES256K, Ed25519, or ES256');
  });
});


