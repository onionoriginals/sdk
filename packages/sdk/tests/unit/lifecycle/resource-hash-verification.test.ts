/**
 * Regression tests for issue #347: resource content must be verified against
 * its declared hash at create/publish/inscribe time — a signed ResourceMigrated
 * credential (or an inscribed manifest) must never attest a hash the actual
 * bytes do not match.
 */
import { describe, test, expect } from 'bun:test';
import { createHash } from 'crypto';
import { OriginalsSDK } from '../../../src';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { MockOrdinalsProvider } from '../../mocks/adapters';

const contentHash = (c: string) => createHash('sha256').update(c, 'utf8').digest('hex');

const makeSdk = (extra: Record<string, unknown> = {}) =>
  OriginalsSDK.create({ storageAdapter: new MemoryStorageAdapter(), network: 'regtest', ...extra } as any);

const goodResource = () => ({
  id: 'res1',
  type: 'text',
  contentType: 'text/plain',
  content: 'authentic bytes',
  hash: contentHash('authentic bytes')
});

describe('issue #347: content/hash verification', () => {
  test('createAsset rejects inline content whose hash does not match', async () => {
    const sdk = makeSdk();
    const mismatched = {
      ...goodResource(),
      // Valid hex, valid length — but the hash of DIFFERENT bytes.
      hash: contentHash('some other bytes entirely')
    };
    await expect(sdk.lifecycle.createAsset([mismatched])).rejects.toThrow(/RESOURCE_HASH_MISMATCH|does not match its declared hash/);
  });

  test('createAsset accepts inline content whose hash matches (case-insensitive)', async () => {
    const sdk = makeSdk();
    const upper = { ...goodResource(), hash: contentHash('authentic bytes').toUpperCase() };
    const asset = await sdk.lifecycle.createAsset([upper]);
    expect(asset.currentLayer).toBe('did:peer');
  });

  test('createAsset still accepts hash-only resources (no inline content to check)', async () => {
    const sdk = makeSdk();
    const hashOnly = {
      id: 'res1',
      type: 'text',
      contentType: 'text/plain',
      hash: contentHash('content hosted elsewhere')
    };
    const asset = await sdk.lifecycle.createAsset([hashOnly]);
    expect(asset.currentLayer).toBe('did:peer');
  });

  test('publishToWeb rejects content tampered with after creation, BEFORE writing or attesting', async () => {
    const storage = new MemoryStorageAdapter();
    const sdk = makeSdk({ storageAdapter: storage });
    const asset = await sdk.lifecycle.createAsset([goodResource()]);

    // Simulate a content swap between creation and publication (the exact
    // gap the publish-time check closes).
    (asset.resources[0] as { content?: string }).content = 'swapped bytes';

    // MemoryStorageAdapter shares one global store across instances, so use
    // a domain no other test publishes to.
    const domain = 'hash-mismatch-347.test';
    await expect(sdk.lifecycle.publishToWeb(asset, domain)).rejects.toThrow(/RESOURCE_HASH_MISMATCH|does not match its declared hash/);

    // No resource content was written: the DID log (.well-known) may exist,
    // but no content-addressed object under resources/ may have been stored.
    const objects = await storage.listObjects(domain, '');
    expect(objects.filter((p) => p.includes('resources/')).length).toBe(0);
    // No publication credential was minted and no URL was attached.
    expect(asset.credentials.length).toBe(0);
    expect(asset.resources[0].url).toBeUndefined();
    // The asset did not migrate.
    expect(asset.currentLayer).toBe('did:peer');
  });

  test('publishToWeb succeeds when content matches its declared hash', async () => {
    const sdk = makeSdk();
    const asset = await sdk.lifecycle.createAsset([goodResource()]);
    const published = await sdk.lifecycle.publishToWeb(asset, 'example.com');
    expect(published.currentLayer).toBe('did:webvh');
    expect(published.resources[0].url).toBeDefined();
  });

  test('inscribeOnBitcoin rejects tampered content before inscribing the manifest', async () => {
    const sdk = makeSdk({ ordinalsProvider: new MockOrdinalsProvider() });
    const asset = await sdk.lifecycle.createAsset([goodResource()]);
    await sdk.lifecycle.publishToWeb(asset, 'example.com');

    (asset.resources[0] as { content?: string }).content = 'swapped bytes';

    await expect(sdk.lifecycle.inscribeOnBitcoin(asset, 5)).rejects.toThrow(/RESOURCE_HASH_MISMATCH|does not match its declared hash/);
    expect(asset.currentLayer).toBe('did:webvh');
  });
});
