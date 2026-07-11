/**
 * Phase-3 Task 4 carry-forward: LifecycleManager.verifyAsset(asset, overrides?).
 *
 * asset.verify(deps) requires the caller to hand-thread didManager/
 * credentialManager/ordinalsProvider. verifyAsset wraps it with the manager's
 * own deps (config.ordinalsProvider by default), so callers with just an SDK
 * instance and an asset don't have to reach into config themselves — this is
 * the same provider-threading contract loadAsset already has (see
 * tests/unit/lifecycle/loadAsset.test.ts, which hand-passes
 * `(sdk as any).config?.ordinalsProvider` to asset.verify() directly).
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MockKeyStore } from '../../mocks/MockKeyStore';

describe('LifecycleManager.verifyAsset', () => {
  test('verifies a did:peer asset with no ordinalsProvider needed', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519' });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '11'.repeat(32) }
    ]);
    expect(await sdk.lifecycle.verifyAsset(asset)).toBe(true);
  });

  test('verifies a btco-anchored asset WITHOUT hand-passing a provider (config.ordinalsProvider is threaded automatically)', async () => {
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: provider,
      keyStore: new MockKeyStore()
    });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '22'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    // Bare call — no overrides. Bitcoin witness verification requires a
    // provider; asset.verify() called directly (with no deps) would fail
    // closed here. verifyAsset must supply config.ordinalsProvider itself.
    expect(await sdk.lifecycle.verifyAsset(asset)).toBe(true);
  });

  test('an explicit override provider takes priority over config.ordinalsProvider', async () => {
    const configProvider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: configProvider,
      keyStore: new MockKeyStore()
    });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '33'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    // Delegates to the SAME underlying store (configProvider) so the
    // inscription it needs actually exists, while independently proving this
    // is the instance verifyAsset used (not silently falling back to config).
    let calls = 0;
    const overrideProvider = {
      getInscriptionById: async (id: string) => {
        calls += 1;
        return configProvider.getInscriptionById(id);
      },
      getInscriptionsBySatoshi: (sat: string) => configProvider.getInscriptionsBySatoshi(sat)
    };
    expect(await sdk.lifecycle.verifyAsset(asset, { ordinalsProvider: overrideProvider })).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });

  test('a btco-anchored asset fails closed with NO provider configured and none overridden', async () => {
    const provider = new OrdMockProvider();
    const sdkWithProvider = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: provider,
      keyStore: new MockKeyStore()
    });
    const asset = await sdkWithProvider.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '44'.repeat(32) }
    ]);
    await sdkWithProvider.lifecycle.inscribeOnBitcoin(asset);

    // A SEPARATE manager configured with no ordinalsProvider at all.
    const sdkNoProvider = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519' });
    expect(await sdkNoProvider.lifecycle.verifyAsset(asset)).toBe(false);
  });
});
