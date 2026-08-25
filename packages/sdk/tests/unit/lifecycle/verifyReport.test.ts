/**
 * `asset.verify()` across the documented lifecycle, and what it says when it
 * cannot answer.
 *
 * The launch-review regression: the create → publish → inscribe → verify flow
 * that the README documents ended in `false`, because `verify()` ignored the
 * `ordinalsProvider` the SDK config already held and the btco witness proof
 * fails closed without one. The developer got a bare `false` and nothing to
 * debug with — for a product whose claim is "the proof verifies", the worst
 * possible default.
 *
 * Two properties are pinned here:
 *   1. every layer of the documented flow verifies with a bare `verify()`;
 *   2. when the proof genuinely cannot be checked, the report SAYS SO
 *      (`ORDINALS_PROVIDER_REQUIRED`) rather than implying the proof failed.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MockKeyStore } from '../../mocks/MockKeyStore';

// A FACTORY, not a shared constant: some tests below mutate the asset's
// resources in place, and createAsset holds the objects it was handed.
const resources = () => [
  { id: 'artwork-1', type: 'image', contentType: 'image/png', hash: 'ab'.repeat(32) }
];

function makeSdk(ordinalsProvider = new OrdMockProvider()) {
  return OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider,
    keyStore: new MockKeyStore()
  });
}

describe('asset.verify() across the documented lifecycle', () => {
  test('did:cel genesis verifies', async () => {
    const asset = await makeSdk().lifecycle.createAsset(resources());
    expect(asset.currentLayer).toBe('did:cel');
    const report = await asset.verify();
    expect(report.verified).toBe(true);
    expect(report.code).toBeUndefined();
  });

  test('did:webvh publication verifies', async () => {
    const sdk = makeSdk();
    const asset = await sdk.lifecycle.createAsset(resources());
    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    expect(asset.currentLayer).toBe('did:webvh');
    const report = await asset.verify();
    expect(report.verified).toBe(true);
    expect(report.code).toBeUndefined();
  });

  test('did:btco inscription verifies with NO argument — the regression this file exists for', async () => {
    const sdk = makeSdk();
    const asset = await sdk.lifecycle.createAsset(resources());
    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    expect(asset.currentLayer).toBe('did:btco');

    // Before the fix this was `false`: the config held a provider, verify()
    // did not use it, and the btco witness proof failed closed.
    const report = await asset.verify();
    expect(report.verified).toBe(true);
    expect(report.code).toBeUndefined();
  });

  test('an explicitly passed provider still wins over the configured one', async () => {
    const configProvider = new OrdMockProvider();
    const sdk = makeSdk(configProvider);
    const asset = await sdk.lifecycle.createAsset(resources());
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    let calls = 0;
    const override = {
      getInscriptionById: (id: string) => { calls += 1; return configProvider.getInscriptionById(id); },
      getInscriptionsBySatoshi: (sat: string) => configProvider.getInscriptionsBySatoshi(sat),
      getAnchoringsForDidCel: (did: string) => configProvider.getAnchoringsForDidCel!(did)
    };
    expect((await asset.verify({ ordinalsProvider: override })).verified).toBe(true);
    expect(calls).toBeGreaterThan(0);
  });
});

describe('verify() distinguishes "the proof does not hold" from "I did not look"', () => {
  test('a btco asset with no provider anywhere reports ORDINALS_PROVIDER_REQUIRED, not a bare false', async () => {
    const sdk = makeSdk();
    const asset = await sdk.lifecycle.createAsset(resources());
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    // Loaded by an SDK that has no provider at all — the stranger's position.
    const bare = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      keyStore: new MockKeyStore()
    });
    const { asset: loaded } = await bare.lifecycle.loadAsset(asset.serialize(), { skipVerification: true });

    const report = await loaded.verify();
    expect(report.verified).toBe(false);
    expect(report.code).toBe('ORDINALS_PROVIDER_REQUIRED');
    // The message has to name the fix, not just the symptom.
    expect(report.message).toContain('ordinalsProvider');
    expect(report.details?.errors).toBeDefined();
  });

  test('a swapped resource reports the binding failure, not the provider', async () => {
    const sdk = makeSdk();
    const asset = await sdk.lifecycle.createAsset(resources());
    (asset.resources[0] as { hash: string }).hash = 'cd'.repeat(32);

    const report = await asset.verify();
    expect(report.verified).toBe(false);
    expect(report.code).toBe('GENESIS_RESOURCE_BINDING');
  });

  test('a structurally invalid resource hash is reported, not thrown', async () => {
    const sdk = makeSdk();
    const asset = await sdk.lifecycle.createAsset(resources());
    (asset.resources[0] as { hash: string }).hash = 'not-a-real-hash';

    // `hexSha256ToDigestMultibase` throws on this; the report must still be a
    // report. VERIFICATION_ERROR would mean the check crashed.
    const report = await asset.verify();
    expect(report.verified).toBe(false);
    expect(report.code).toBe('GENESIS_RESOURCE_BINDING');
  });

  test('a hosted resource with no fetcher is reported as unverifiable, not as a failed proof', async () => {
    const sdk = makeSdk();
    const asset = await sdk.lifecycle.createAsset(resources());
    (asset.resources[0] as { url?: string }).url = 'https://example.com/artwork.png';

    const report = await asset.verify();
    expect(report.verified).toBe(false);
    expect(report.code).toBe('RESOURCE_UNVERIFIABLE');
    expect(report.details?.resourceId).toBe('artwork-1');
  });
});
