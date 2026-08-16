import { describe, test, expect } from 'bun:test';
import { LifecycleManager } from '../../../src/lifecycle/LifecycleManager';
import { DIDManager } from '../../../src/did/DIDManager';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { OriginalsConfig } from '../../../src/types';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { deriveDidCel } from '@originals/cel';
import { verifyEventLog } from '@originals/cel';
import { OriginalsAsset } from '../../../src/lifecycle/OriginalsAsset';

const config: OriginalsConfig = {
  network: 'regtest',
  defaultKeyType: 'Ed25519',
  enableLogging: false,
  storageAdapter: new MemoryStorageAdapter()
};

// Copy of LifecycleManager.keymanagement.test.ts's SDK+keyStore construction.
function makeSdkWithKeyStoreExposed() {
  const didManager = new DIDManager(config);
  const credentialManager = new CredentialManager(config, didManager);
  const keyStore = new MockKeyStore();
  const lifecycle = new LifecycleManager(config, didManager, credentialManager, undefined, keyStore);
  return { sdk: { lifecycle }, keyStore };
}

function makeSdkWithKeyStore() {
  return makeSdkWithKeyStoreExposed().sdk;
}

describe('createAsset mints did:cel genesis (#Phase2)', () => {
  test('asset.id is the derived did:cel; log verifies; layer label is did:cel', async () => {
    const sdk = makeSdkWithKeyStore();
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash: 'ab'.repeat(32) }
    ]);
    expect(asset.id.startsWith('did:cel:u')).toBe(true);
    expect(asset.celLog).toBeDefined();
    expect(deriveDidCel(asset.celLog!)).toBe(asset.id);
    expect(asset.currentLayer).toBe('did:cel');
    const result = await verifyEventLog(asset.celLog!, { expectedDid: asset.id });
    expect(result.verified).toBe(true);
    // genesis resource digest matches the AssetResource hash (bridged)
    const genesis = asset.celLog!.events[0].data as { resources: Array<{ digestMultibase: string }> };
    expect(genesis.resources[0].digestMultibase.startsWith('u')).toBe(true);
  });

  test('keyStore holds the controller key under both VM ids', async () => {
    const { sdk, keyStore } = makeSdkWithKeyStoreExposed();
    // No ephemeral marker: this is the keyStore-backed path, and an ephemeral
    // controller is deliberately NOT persisted.
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: 'cd'.repeat(32) }
    ]);
    const genesis = asset.celLog!.events[0].data as { controller: string };
    const didKeyVm = `${genesis.controller}#${genesis.controller.slice('did:key:'.length)}`;
    expect(await keyStore.getPrivateKey(didKeyVm)).toBeTruthy();
    expect(await keyStore.getPrivateKey(`${asset.id}#key-0`)).toBeTruthy();
  });

  test('an explicitly ephemeral mint does NOT emit key:unpersisted', async () => {
    // The event means custody was lost by ACCIDENT — the README tells callers to
    // treat it as a misconfiguration alarm and throw. A caller who asked for a
    // write-once asset has not misconfigured anything, and firing it here would
    // make `controller: 'ephemeral'` unusable for anyone following that advice.
    const didManager = new DIDManager(config);
    const credentialManager = new CredentialManager(config, didManager);
    const lifecycle = new LifecycleManager(config, didManager, credentialManager); // no keyStore
    const unpersisted: unknown[] = [];
    lifecycle.on('key:unpersisted', (e) => { unpersisted.push(e); });

    const asset = await lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: 'ef'.repeat(32) }
    ], { controller: 'ephemeral' });

    expect(unpersisted).toHaveLength(0);
    expect(asset.id.startsWith('did:cel:')).toBe(true);
  });

  test('keyStore-backed createAsset does NOT emit key:unpersisted', async () => {
    const { sdk } = makeSdkWithKeyStoreExposed();
    const unpersisted: any[] = [];
    sdk.lifecycle.on('key:unpersisted', (e) => { unpersisted.push(e); });
    await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '01'.repeat(32) }
    ], { controller: 'ephemeral' });
    expect(unpersisted.length).toBe(0);
  });
});

describe('verify() binds in-memory resources to the CEL genesis', () => {
  test('genuine log + swapped resource fails; unswapped passes', async () => {
    const sdk = makeSdkWithKeyStore();
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash: 'ab'.repeat(32) }
    ]);
    // Baseline: genuine asset with the resource the genesis committed to.
    expect(await asset.verify()).toBe(true);

    // Same verified log + facade DID doc, but a DIFFERENT resource (different
    // hash). The genesis digest is no longer among the current resources → fail.
    const swapped = new OriginalsAsset(
      [{ id: 'res-1', type: 'data', contentType: 'text/plain', hash: 'cd'.repeat(32) }],
      asset.did,
      [],
      asset.celLog!
    );
    expect(await swapped.verify()).toBe(false);
  });
});
