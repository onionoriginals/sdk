/**
 * Phase-3 Task 1: AssetEnvelope + serialize() + per-layer DID-document capture (#377).
 *
 * serialize() turns a live asset into the versioned interchange envelope. The
 * envelope's provenance IS the CEL (eventLog); log-underivable metadata rides in
 * the `unverified` honesty section. These tests drive REAL lifecycle flows
 * (OrdMock + MemoryStorage + keyStore) — the same fixture pattern as
 * CelConvergence.e2e — then assert the serialized shape.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import {
  ASSET_ENVELOPE_FORMAT,
  ASSET_ENVELOPE_VERSION,
  type AssetEnvelope
} from '../../../src/lifecycle/assetEnvelope';
import { OriginalsAsset } from '../../../src/lifecycle/OriginalsAsset';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { replayProvenance } from '../../../src/lifecycle/replayProvenance';
import { hashResource } from '../../../src/utils/validation';

function makeSDK(withKeyStore = true) {
  return OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: new OrdMockProvider(),
    storageAdapter: new MemoryStorageAdapter(),
    ...(withKeyStore ? { keyStore: new MockKeyStore() } : {})
  });
}

describe('AssetEnvelope + serialize() (#377)', () => {
  test('serialize after a full lifecycle carries the log, all captured docs, resources, honesty section', async () => {
    const sdk = makeSDK();
    const content = 'hello originals';
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: 'ab'.repeat(32) },
      { id: 'note', type: 'text', contentType: 'text/plain', content, hash: hashResource(Buffer.from(content, 'utf8')) }
    ]);
    const didCel = asset.id;

    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    const webvhBinding = asset.bindings!['did:webvh'];
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const btcoBinding = asset.bindings!['did:btco'];

    // A post-genesis resource version → rides envelope-only (no CEL event until Phase 4).
    asset.addResourceVersion('note', 'hello originals v2', 'text/plain', 'edit');

    const env = asset.serialize();

    // Format + version + assetDid.
    expect(env.format).toBe(ASSET_ENVELOPE_FORMAT);
    expect(env.version).toBe(ASSET_ENVELOPE_VERSION);
    expect(env.assetDid).toBe(didCel);

    // eventLog is THE provenance encoding, embedded as a parsed object.
    expect(env.eventLog.events.map(e => e.type)).toEqual(['create', 'migrate', 'migrate']);
    const folded = replayProvenance(env.eventLog);
    expect(folded.bindings['did:cel']).toBe(didCel);
    expect(folded.bindings['did:webvh']).toBe(webvhBinding);
    expect(folded.bindings['did:btco']).toBe(btcoBinding); // witness proof makes it derivable

    // All three per-layer DID docs captured.
    expect(env.didDocuments['did:cel'].id).toBe(didCel);
    expect(env.didDocuments['did:webvh']!.id).toBe(webvhBinding);
    expect(env.didDocuments['did:btco']!.id).toBe(btcoBinding);

    // Resources include inline content and the post-genesis version.
    const note = env.resources.filter(r => r.id === 'note');
    expect(note.some(r => r.content === content)).toBe(true);
    expect(note.some(r => r.content === 'hello originals v2')).toBe(true);

    // Honesty section: btco IS log-derivable → no advisory bindings. feeRate +
    // resourceUpdates ride from the provenance cache.
    expect(env.unverified?.bindings).toBeUndefined();
    expect(typeof env.unverified?.feeRate).toBe('number');
    expect(env.unverified?.resourceUpdates?.some(u => u.resourceId === 'note' && u.toVersion === 2)).toBe(true);
  });

  test('serialize is JSON-safe: JSON.parse(JSON.stringify(env)) deep-equals', async () => {
    const sdk = makeSDK();
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: 'ab'.repeat(32) }
    ]);
    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const env = asset.serialize();
    const roundTripped = JSON.parse(JSON.stringify(env));
    expect(roundTripped).toEqual(env as unknown as Record<string, unknown>);
  });

  test('degraded btco (no witness proof) surfaces the live binding in unverified.bindings', async () => {
    // No keyStore → CEL appends are skipped; the btco migrate never lands in the
    // log, so the fold cannot derive did:btco even though the live cache has it.
    const sdk = makeSDK(false);
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: 'ab'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const btcoBinding = asset.bindings!['did:btco'];

    const env = asset.serialize();
    expect(replayProvenance(env.eventLog).bindings['did:btco']).toBeUndefined();
    expect(env.unverified?.bindings?.['did:btco']).toBe(btcoBinding);
  });

  test('serialize on a legacy 3-arg asset (no CEL log) throws ASSET_NOT_SERIALIZABLE', () => {
    const legacy = new OriginalsAsset(
      [{ id: 'r', type: 'text', contentType: 'text/plain', hash: 'ab'.repeat(32) }],
      { id: 'did:peer:0zlegacy' } as any,
      []
    );
    expect(() => legacy.serialize()).toThrow();
    try {
      legacy.serialize();
      throw new Error('expected serialize() to throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('ASSET_NOT_SERIALIZABLE');
    }
  });
});
