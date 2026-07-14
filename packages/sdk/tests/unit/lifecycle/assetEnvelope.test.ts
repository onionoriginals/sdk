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

    // A post-genesis resource version → appends a signed `update` CEL event.
    await asset.addResourceVersion('note', 'hello originals v2', 'text/plain', 'edit');

    const env = asset.serialize();

    // Format + version + assetDid.
    expect(env.format).toBe(ASSET_ENVELOPE_FORMAT);
    expect(env.version).toBe(ASSET_ENVELOPE_VERSION);
    expect(env.assetDid).toBe(didCel);

    // eventLog is THE provenance encoding, embedded as a parsed object. The
    // first update is the btco migrate's acknowledgeWitness (map §5.1); the
    // second is the signed resource-version update appended above.
    expect(env.eventLog.events.map(e => e.type)).toEqual(['create', 'migrate', 'migrate', 'update', 'update']);
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

    // Honesty section: btco IS log-derivable → no advisory bindings. feeRate
    // rides the provenance cache; resourceUpdates is no longer advisory (hard
    // cutover — it's folded from the signed `update` log event instead).
    expect(env.unverified?.bindings).toBeUndefined();
    expect(typeof env.unverified?.feeRate).toBe('number');
    expect(folded.resourceUpdates.some(u => u.resourceId === 'note' && u.toVersion === 2)).toBe(true);
  });

  test('serialize no longer emits unverified.resourceUpdates; loadAsset folds versions from the log', async () => {
    const sdk = makeSDK();
    const asset = await sdk.lifecycle.createAsset([
      { id: 'note', type: 'text', content: 'hello v1', contentType: 'text/plain', hash: hashResource(Buffer.from('hello v1', 'utf-8')) }
    ]);
    await asset.addResourceVersion('note', 'hello v2', 'text/plain', 'edit');

    const env = asset.serialize();
    // Cutover: the advisory array is gone.
    expect((env.unverified as any)?.resourceUpdates).toBeUndefined();
    // The update event is on the log.
    expect(env.eventLog.events.some(e => e.type === 'update')).toBe(true);
    // A fresh SDK (no keys) loads and the folded provenance shows the version.
    const fresh = makeSDK(false);
    const { asset: loaded } = await fresh.lifecycle.loadAsset(env);
    expect(loaded.getProvenance().resourceUpdates.some(u => u.resourceId === 'note' && u.toVersion === 2)).toBe(true);
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

  // Review fix (#377 follow-up): serialize() must hand out defensive copies of
  // every didDocuments entry, not live references — a caller mutating the
  // envelope must never be able to corrupt the asset's own signing-key state
  // (asset.did, or a later-serialized webvh/btco doc).
  test('serialize() didDocuments are defensive copies — mutating them does not corrupt the asset', async () => {
    const sdk = makeSDK();
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: 'ab'.repeat(32) }
    ]);
    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const originalCelVmId = asset.did.verificationMethod?.[0]?.id;
    const originalCelKey = asset.did.verificationMethod?.[0]?.publicKeyMultibase;

    const env = asset.serialize();
    env.didDocuments['did:cel'].verificationMethod![0].publicKeyMultibase = 'CORRUPTED';
    env.didDocuments['did:webvh']!.verificationMethod![0].publicKeyMultibase = 'CORRUPTED';
    env.didDocuments['did:btco']!.verificationMethod![0].publicKeyMultibase = 'CORRUPTED';

    // The live asset's own DID doc (consumed by migrateToDIDBTCO etc.) is untouched.
    expect(asset.did.verificationMethod?.[0]?.id).toBe(originalCelVmId);
    expect(asset.did.verificationMethod?.[0]?.publicKeyMultibase).toBe(originalCelKey);

    // A fresh serialize() also proves the internal #didDocuments cache was
    // never mutated via the handed-out reference.
    const env2 = asset.serialize();
    expect(env2.didDocuments['did:cel'].verificationMethod![0].publicKeyMultibase).not.toBe('CORRUPTED');
    expect(env2.didDocuments['did:webvh']!.verificationMethod![0].publicKeyMultibase).not.toBe('CORRUPTED');
    expect(env2.didDocuments['did:btco']!.verificationMethod![0].publicKeyMultibase).not.toBe('CORRUPTED');
  });

  test('_captureDidDocument clones at capture time — later mutation of the source object does not corrupt the asset', async () => {
    const sdk = makeSDK();
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: 'ab'.repeat(32) }
    ]);

    const doc = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:webvh:example.com:mutation-source',
      verificationMethod: [{
        id: 'did:webvh:example.com:mutation-source#key-0',
        type: 'Multikey',
        controller: 'did:webvh:example.com:mutation-source',
        publicKeyMultibase: 'zORIGINAL'
      }]
    } as any;

    (asset as unknown as { _captureDidDocument: (l: 'did:webvh' | 'did:btco', d: any) => void })
      ._captureDidDocument('did:webvh', doc);

    // Mutate the source object AFTER handing it to _captureDidDocument.
    doc.verificationMethod[0].publicKeyMultibase = 'zCORRUPTED';

    const env = asset.serialize();
    expect(env.didDocuments['did:webvh']!.verificationMethod![0].publicKeyMultibase).toBe('zORIGINAL');
  });
});
