/**
 * Plan 041 — the defaults flip.
 *
 * Two behaviors that used to be silent are now loud:
 *   1. Minting without custody discarded the controller key, producing an asset
 *      that could never author another event. That was the default, and the
 *      documented quickstart.
 *   2. A lifecycle op that could not sign its provenance event carried on and
 *      reported success, so `publishToWeb` could return a published asset whose
 *      log was missing the migration that had just happened.
 */

import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { MockRemoteSigner } from '../../../src/crypto/MockRemoteSigner';
import type { OriginalsConfig } from '../../../src/types';

const RES = [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'ab'.repeat(32) }];

const makeSdk = (over: Partial<OriginalsConfig> = {}) =>
  OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    storageAdapter: new MemoryStorageAdapter(),
    ordinalsProvider: new OrdMockProvider(),
    ...over,
  });

describe('createAsset requires custody [plan 041]', () => {
  test('refuses to mint an asset whose key it would immediately discard', async () => {
    const sdk = makeSdk();
    const p = sdk.lifecycle.createAsset(RES);
    await expect(p).rejects.toMatchObject({ code: 'NO_CUSTODY' });
  });

  test('the error names every way to supply custody', async () => {
    const sdk = makeSdk();
    const err = await sdk.lifecycle.createAsset(RES).catch((e) => e);
    expect(err.message).toContain('options.signer');
    expect(err.message).toContain('config.keyStore');
    expect(err.message).toContain("'ephemeral'");
  });

  test('a keyStore satisfies it', async () => {
    const sdk = makeSdk({ keyStore: new MockKeyStore() });
    expect((await sdk.lifecycle.createAsset(RES)).currentLayer).toBe('did:cel');
  });

  test('a signer satisfies it — custody that never exports a key', async () => {
    const sdk = makeSdk({ signer: new MockRemoteSigner() });
    expect((await sdk.lifecycle.createAsset(RES)).currentLayer).toBe('did:cel');
  });

  test("'ephemeral' is the explicit opt-in for a write-once asset", async () => {
    const sdk = makeSdk();
    const asset = await sdk.lifecycle.createAsset(RES, { controller: 'ephemeral' });
    expect(asset.currentLayer).toBe('did:cel');
    // It still verifies — it simply can never gain another event.
    expect(await asset.verify()).toBe(true);
  });

  test('createDraft forwards custody rather than bypassing the requirement', async () => {
    const sdk = makeSdk();
    await expect(sdk.lifecycle.createDraft(RES)).rejects.toMatchObject({ code: 'NO_CUSTODY' });
    expect((await sdk.lifecycle.createDraft(RES, { controller: 'ephemeral' })).currentLayer)
      .toBe('did:cel');
  });
});

describe("'ephemeral' is honoured, not merely a guard bypass", () => {
  test('the key is NOT persisted even when a keyStore is configured', async () => {
    // Otherwise the flag would be a no-op wherever custody exists: the caller
    // asks for write-once and silently gets an asset that can still author.
    const keyStore = new MockKeyStore();
    const sdk = makeSdk({ keyStore });
    const asset = await sdk.lifecycle.createAsset(RES, { controller: 'ephemeral' });

    const controller = (asset.celLog!.events[0].data as { controller: string }).controller;
    const vm = `${controller}#${controller.slice('did:key:'.length)}`;
    expect(await keyStore.getPrivateKey(vm)).toBeNull();
    expect(await keyStore.getPrivateKey(`${asset.id}#key-0`)).toBeNull();
  });

  test('so the asset really is write-once: a later append cannot be signed', async () => {
    const sdk = makeSdk({ keyStore: new MockKeyStore() });
    const asset = await sdk.lifecycle.createAsset(RES, { controller: 'ephemeral' });

    await expect(sdk.lifecycle.publishToWeb(asset, 'example.com'))
      .rejects.toMatchObject({ code: 'CEL_APPEND_FAILED' });
  });

  test('a per-call signer plus ephemeral is refused as contradictory', async () => {
    // Both are explicit instructions for this call and they cannot both hold.
    // Silently honouring either one is the failure mode plan 041 removes.
    const sdk = makeSdk();
    const p = sdk.lifecycle.createAsset(RES, {
      signer: new MockRemoteSigner(),
      controller: 'ephemeral',
    });
    await expect(p).rejects.toMatchObject({ code: 'CONTRADICTORY_CUSTODY' });
  });

  test('but an AMBIENT config.signer is simply overridden by a per-call ephemeral', async () => {
    // Wanting one throwaway asset inside an app that otherwise has custody is a
    // coherent request; per-call options beat configuration.
    const ambient = new MockRemoteSigner();
    const sdk = makeSdk({ signer: ambient });
    const asset = await sdk.lifecycle.createAsset(RES, { controller: 'ephemeral' });

    // The controller is a freshly generated throwaway, NOT the ambient signer.
    const controller = (asset.celLog!.events[0].data as { controller: string }).controller;
    expect(controller).not.toBe(`did:key:${ambient.publicKeyMultibase}`);
    // And it really is write-once: the ambient signer cannot author for it.
    await expect(sdk.lifecycle.publishToWeb(asset, 'example.com'))
      .rejects.toMatchObject({ code: 'CEL_APPEND_FAILED' });
  });

  test('a non-ephemeral mint with a keyStore still persists, as before', async () => {
    const keyStore = new MockKeyStore();
    const sdk = makeSdk({ keyStore });
    const asset = await sdk.lifecycle.createAsset(RES);

    const controller = (asset.celLog!.events[0].data as { controller: string }).controller;
    const vm = `${controller}#${controller.slice('did:key:'.length)}`;
    expect(await keyStore.getPrivateKey(vm)).toBeTruthy();
  });
});

describe('a provenance append that cannot be signed throws [plan 041]', () => {
  test('publishToWeb fails instead of returning an asset with a hole in its log', async () => {
    const sdk = makeSdk();
    const asset = await sdk.lifecycle.createAsset(RES, { controller: 'ephemeral' });

    const p = sdk.lifecycle.publishToWeb(asset, 'example.com');
    await expect(p).rejects.toMatchObject({ code: 'CEL_APPEND_FAILED' });
    // The layer did not move: the operation genuinely did not happen.
    expect(asset.currentLayer).toBe('did:cel');
  });

  test('the error says which custody is missing and how to degrade instead', async () => {
    const sdk = makeSdk();
    const asset = await sdk.lifecycle.createAsset(RES, { controller: 'ephemeral' });
    const err = await sdk.lifecycle.publishToWeb(asset, 'example.com').catch((e) => e);

    expect(err.message).toContain('NO_KEYSTORE');
    expect(err.message).toContain('No custody is configured');
    expect(err.message).toContain("onAppendFailure: 'skip'");
  });

  test("onAppendFailure: 'skip' restores the pre-041 degrade, per call", async () => {
    const sdk = makeSdk();
    const skipped: string[] = [];
    sdk.lifecycle.on('cel:append-skipped', (e) => { skipped.push(e.reason); });

    const asset = await sdk.lifecycle.createAsset(RES, { controller: 'ephemeral' });
    await sdk.lifecycle.publishToWeb(asset, 'example.com', { onAppendFailure: 'skip' });

    expect(asset.currentLayer).toBe('did:webvh');
    expect(skipped).toEqual(['NO_KEYSTORE']);
    expect(asset.celLog!.events.map((e) => e.type)).toEqual(['create']);
  });

  test("config.onAppendFailure: 'skip' sets the default for every op", async () => {
    const sdk = makeSdk({ onAppendFailure: 'skip' });
    const asset = await sdk.lifecycle.createAsset(RES, { controller: 'ephemeral' });
    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    expect(asset.currentLayer).toBe('did:webvh');
  });

  test('a legacy asset with no CEL log still degrades — it is not a custody fault', async () => {
    // NO_CEL_LOG cannot be fixed by configuring anything, so gating on it would
    // refuse to operate on pre-CEL assets entirely.
    const { OriginalsAsset } = await import('../../../src');
    const sdk = makeSdk({ keyStore: new MockKeyStore() });
    const legacy = new OriginalsAsset(
      RES,
      { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:webvh:example.com:legacy' } as never,
      []
    );
    const skipped: string[] = [];
    sdk.lifecycle.on('cel:append-skipped', (e) => { skipped.push(e.reason); });

    await sdk.lifecycle.inscribeOnBitcoin(legacy);
    expect(skipped).toContain('NO_CEL_LOG');
  });
});

describe('config.keyStore survives however the manager is built [plan 041]', () => {
  test('a keyStore on the config is honoured, not only the constructor argument', async () => {
    const sdk = makeSdk({ keyStore: new MockKeyStore() });
    // Rebuild the manager from the SDK's own config, as test harnesses do.
    const Manager = sdk.lifecycle.constructor as new (...a: unknown[]) => typeof sdk.lifecycle;
    const rebuilt = new Manager(
      (sdk.lifecycle as unknown as { config: OriginalsConfig }).config,
      (sdk.lifecycle as unknown as { didManager: unknown }).didManager,
      (sdk.lifecycle as unknown as { credentialManager: unknown }).credentialManager
    );
    // No keyStore argument passed: it must still be found on the config.
    expect((await rebuilt.createAsset(RES)).currentLayer).toBe('did:cel');
  });
});
