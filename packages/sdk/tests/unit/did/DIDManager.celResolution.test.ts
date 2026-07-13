import { describe, test, expect, beforeEach } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { multikey } from '../../../src/crypto/Multikey';

const RES = [{ id: 'res-1', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32) }];

const celStoragePath = (didCel: string) => `${didCel.slice('did:cel:'.length)}.json`;

function makeSdk(overrides: Record<string, unknown> = {}) {
  return OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: new OrdMockProvider(),
    keyStore: new MockKeyStore(),
    storageAdapter: new MemoryStorageAdapter(),
    ...overrides
  } as any);
}

describe('persistence-backed did:cel resolution (#Phase3 Task 3)', () => {
  beforeEach(() => {
    MemoryStorageAdapter.clear();
  });

  test('createAsset then resolveDID returns the facade doc from storage (fresh cache)', async () => {
    const sdk = makeSdk();
    const asset = await sdk.lifecycle.createAsset(RES);

    const doc = await sdk.did.resolveDID(asset.id);
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe(asset.id);
    expect(doc!.verificationMethod?.[0]?.publicKeyMultibase)
      .toBe(asset.did.verificationMethod![0].publicKeyMultibase);
  });

  test('a fresh SDK sharing the storage resolves the did:cel too', async () => {
    const creator = makeSdk();
    const asset = await creator.lifecycle.createAsset(RES);

    // MemoryStorageAdapter instances share one global store, so this is a
    // genuinely different SDK (fresh DIDManager + cache) over the same storage.
    const verifier = makeSdk({ keyStore: undefined });
    const doc = await verifier.did.resolveDID(asset.id);
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe(asset.id);
  });

  test('post-rotation resolution reflects the NEW controller (witness-proofed log verifies via provider)', async () => {
    const provider = new OrdMockProvider();
    const sdk = makeSdk({ ordinalsProvider: provider });
    const asset = await sdk.lifecycle.createAsset(RES);
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    // Pre-rotation: current controller is the genesis key.
    const genesisKey = asset.did.verificationMethod![0].publicKeyMultibase;
    const before = await sdk.did.resolveDID(asset.id, { skipCache: true });
    expect(before?.verificationMethod?.[0]?.publicKeyMultibase).toBe(genesisKey);

    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');
    await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey });

    const after = await sdk.did.resolveDID(asset.id, { skipCache: true });
    expect(after).not.toBeNull();
    expect(after!.id).toBe(asset.id);
    expect(after!.verificationMethod?.[0]?.publicKeyMultibase).toBe(newKey);
    expect(after!.alsoKnownAs).toContain(`did:key:${newKey}`);
  });

  test('btco-anchored log fails closed when the resolving SDK has no ordinalsProvider', async () => {
    const sdk = makeSdk();
    const asset = await sdk.lifecycle.createAsset(RES);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');
    await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey });

    // Same storage, but no provider: the stored log carries a bitcoin witness
    // proof that cannot be verified — resolution must stay honest-null.
    const offline = makeSdk({ ordinalsProvider: undefined, keyStore: undefined });
    expect(await offline.did.resolveDID(asset.id)).toBeNull();
  });

  test('resolved doc is cached: survives storage loss on the next resolve', async () => {
    const sdk = makeSdk();
    const asset = await sdk.lifecycle.createAsset(RES);

    const first = await sdk.did.resolveDID(asset.id);
    expect(first).not.toBeNull();

    MemoryStorageAdapter.clear();
    const second = await sdk.did.resolveDID(asset.id);
    expect(second).not.toBeNull();
    expect(second!.id).toBe(asset.id);
  });

  test('garbage at the conventional key resolves to null without throwing', async () => {
    const storage = new MemoryStorageAdapter();
    const sdk = makeSdk({ storageAdapter: storage });
    const asset = await sdk.lifecycle.createAsset(RES);

    await storage.putObject('cel', celStoragePath(asset.id), 'not json at all');
    expect(await sdk.did.resolveDID(asset.id, { skipCache: true })).toBeNull();
  });

  test('a tampered stored log fails verification and resolves to null', async () => {
    const storage = new MemoryStorageAdapter();
    const sdk = makeSdk({ storageAdapter: storage });
    const asset = await sdk.lifecycle.createAsset(RES);

    const stored = await storage.getObject('cel', celStoragePath(asset.id));
    const log = JSON.parse(Buffer.from(stored!.content).toString('utf8'));
    log.events[0].data.name = 'tampered';
    await storage.putObject('cel', celStoragePath(asset.id), JSON.stringify(log));

    expect(await sdk.did.resolveDID(asset.id, { skipCache: true })).toBeNull();
  });

  test('adapter-less SDK still returns warn + null exactly as today', async () => {
    const sdk = makeSdk({ storageAdapter: undefined, keyStore: undefined });
    expect(await sdk.did.resolveDID('did:cel:uEiUnknownDigest')).toBeNull();
  });
});
