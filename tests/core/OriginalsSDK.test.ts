import { OriginalsSDK } from '../../src';

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
});


