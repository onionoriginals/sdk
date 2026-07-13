/**
 * Regression tests for issues #346 and #352:
 *
 * - #346: asset:migrated / asset:transferred were emitted only on the asset's
 *   private emitter, so documented `sdk.lifecycle.on(...)` subscriptions (and
 *   the built-in EventLogger metrics) never fired for migrations/transfers.
 * - #352: 'verification:completed' and 'batch:progress' were declared in the
 *   public EventTypeMap and subscribed by EventLogger but never emitted.
 */

import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { MockOrdinalsProvider } from '../../mocks/adapters';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import type { AssetMigratedEvent, AssetTransferredEvent, BatchProgressEvent, VerificationCompletedEvent } from '../../../src/events/types';

// Fresh objects per call: createAsset keeps resource objects by reference, so
// a test that corrupts its asset must not poison the shared fixture.
const makeResources = () => [
  {
    id: 'res1',
    type: 'text',
    content: 'hello world',
    contentType: 'text/plain',
    hash: 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9'
  }
];

const makeSdk = () => OriginalsSDK.create({
  storageAdapter: new MemoryStorageAdapter(),
  network: 'regtest',
  ordinalsProvider: new MockOrdinalsProvider()
} as never);

describe('manager-level asset:migrated / asset:transferred (issue #346)', () => {
  test('publishToWeb emits asset:migrated on the LifecycleManager emitter', async () => {
    const sdk = makeSdk();
    const events: AssetMigratedEvent[] = [];
    sdk.lifecycle.on('asset:migrated', (e) => { events.push(e); });

    const asset = await sdk.lifecycle.createAsset(makeResources());
    await sdk.lifecycle.publishToWeb(asset, 'example.com');

    expect(events.length).toBe(1);
    expect(events[0].asset.fromLayer).toBe('did:peer');
    expect(events[0].asset.toLayer).toBe('did:webvh');
    expect(events[0].asset.id).toBe(asset.id);
  });

  test('inscribeOnBitcoin emits asset:migrated with Bitcoin details on the manager emitter', async () => {
    const sdk = makeSdk();
    const events: AssetMigratedEvent[] = [];
    sdk.lifecycle.on('asset:migrated', (e) => { events.push(e); });

    const asset = await sdk.lifecycle.createAsset(makeResources());
    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    await sdk.lifecycle.inscribeOnBitcoin(asset, 7);

    const btcoEvent = events.find((e) => e.asset.toLayer === 'did:btco');
    expect(btcoEvent).toBeDefined();
    expect(btcoEvent!.details?.inscriptionId).toBe('insc-mock');
    expect(btcoEvent!.details?.satoshi).toBe('123');
    expect(btcoEvent!.details?.feeRate).toBe(7);
  });

  test('transferOwnership emits asset:transferred on the manager emitter', async () => {
    const sdk = makeSdk();
    const events: AssetTransferredEvent[] = [];
    sdk.lifecycle.on('asset:transferred', (e) => { events.push(e); });

    const asset = await sdk.lifecycle.createAsset(makeResources());
    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    await sdk.lifecycle.inscribeOnBitcoin(asset, 7);
    const tx = await sdk.lifecycle.transferOwnership(asset, 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');

    expect(events.length).toBe(1);
    expect(events[0].to).toBe('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080');
    expect(events[0].transactionId).toBe(tx.txid);
    expect(events[0].asset.layer).toBe('did:btco');
    // Ownership is the sat now — no rotation-first flag (#366 ownership-is-sat).
    expect('keyRotationPending' in events[0]).toBe(false);
  });

  test('asset-level subscriptions still fire (dual emit)', async () => {
    const sdk = makeSdk();
    const asset = await sdk.lifecycle.createAsset(makeResources());
    const assetEvents: AssetMigratedEvent[] = [];
    asset.on('asset:migrated', (e) => { assetEvents.push(e); });

    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    expect(assetEvents.length).toBe(1);
  });
});

describe("'verification:completed' is emitted by OriginalsAsset.verify (issue #352)", () => {
  test('emits with the verification result', async () => {
    const sdk = makeSdk();
    const asset = await sdk.lifecycle.createAsset(makeResources());
    const events: VerificationCompletedEvent[] = [];
    asset.on('verification:completed', (e) => { events.push(e); });

    const ok = await asset.verify();
    expect(events.length).toBe(1);
    expect(events[0].result).toBe(ok);
    expect(events[0].asset.id).toBe(asset.id);
  });

  test('emits result=false for a corrupted asset', async () => {
    const sdk = makeSdk();
    const asset = await sdk.lifecycle.createAsset(makeResources());
    (asset.resources[0] as { hash: string }).hash = 'not-a-real-hash';
    const events: VerificationCompletedEvent[] = [];
    asset.on('verification:completed', (e) => { events.push(e); });

    const ok = await asset.verify();
    expect(ok).toBe(false);
    expect(events.length).toBe(1);
    expect(events[0].result).toBe(false);
  });
});

describe("'batch:progress' is emitted per settled batch item (issue #352)", () => {
  test('batchCreateAssets reports incremental progress on the manager emitter', async () => {
    const sdk = makeSdk();
    const events: BatchProgressEvent[] = [];
    sdk.lifecycle.on('batch:progress', (e) => { events.push(e); });

    const result = await sdk.lifecycle.batchCreateAssets([makeResources(), makeResources(), makeResources()]);
    expect(result.successful.length).toBe(3);

    expect(events.length).toBe(3);
    expect(events[0].operation).toBe('create');
    expect(events[0].total).toBe(3);
    expect(events.map((e) => e.completed)).toEqual([1, 2, 3]);
    expect(events[events.length - 1].progress).toBe(100);
    // Correlated with the batch lifecycle events
    expect(events.every((e) => e.batchId === events[0].batchId)).toBe(true);
  });
});
