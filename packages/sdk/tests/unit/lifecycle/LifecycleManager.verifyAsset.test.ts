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
    const sdk = OriginalsSDK.create({ keyStore: new MockKeyStore(), network: 'regtest', defaultKeyType: 'Ed25519' });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '11'.repeat(32) }
    ]);
    expect((await sdk.lifecycle.verifyAsset(asset)).verified).toBe(true);
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
    expect((await sdk.lifecycle.verifyAsset(asset)).verified).toBe(true);
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
      getInscriptionsBySatoshi: (sat: string) => configProvider.getInscriptionsBySatoshi(sat),
      getAnchoringsForDidCel: (didCel: string) => configProvider.getAnchoringsForDidCel!(didCel)
    };
    expect((await sdk.lifecycle.verifyAsset(asset, { ordinalsProvider: overrideProvider })).verified).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });

  test('a btco-anchored asset loaded by a provider-less SDK fails closed, and SAYS it did not look', async () => {
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

    // The stranger's position: someone else's envelope, an SDK with no
    // ordinalsProvider at all. The Bitcoin witness proof CANNOT be checked, so
    // this must not report success...
    const sdkNoProvider = OriginalsSDK.create({ keyStore: new MockKeyStore(), network: 'regtest', defaultKeyType: 'Ed25519' });
    const { asset: loaded } = await sdkNoProvider.lifecycle.loadAsset(asset.serialize(), { skipVerification: true });
    const report = await sdkNoProvider.lifecycle.verifyAsset(loaded);
    expect(report.verified).toBe(false);
    // ...and must not let that be mistaken for a failed proof. This is the
    // distinction the bare boolean could not make.
    expect(report.code).toBe('ORDINALS_PROVIDER_REQUIRED');
    expect(report.message).toContain('ordinals provider');
  });

  test('an asset minted through a configured SDK keeps that provider, so a bare verify() still checks the chain', async () => {
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: provider,
      keyStore: new MockKeyStore()
    });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '55'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    // Not through verifyAsset — directly on the asset, with no arguments. This
    // is the call the README documents and it used to answer `false`.
    const report = await asset.verify();
    expect(report.verified).toBe(true);
    expect(report.code).toBeUndefined();
  });
});
