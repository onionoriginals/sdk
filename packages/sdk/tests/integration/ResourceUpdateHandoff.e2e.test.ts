import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { hashResource } from '../../src/utils/validation';
import type { CelAppendSkippedEvent } from '../../src/events/types';

const h = (s: string) => hashResource(Buffer.from(s, 'utf-8'));

describe('Resource-update handoff (e2e)', () => {
  test('honest round-trip: creator updates, buyer verifies offline with no keys', async () => {
    const creator = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    const asset = await creator.lifecycle.createAsset([
      { id: 'note', type: 'text', content: 'v1', contentType: 'text/plain', hash: h('v1') }
    ]);
    await asset.addResourceVersion('note', 'v2', 'text/plain', 'edit');

    // The signed update landed on the log.
    expect(asset.celLog!.events.some(e => e.type === 'update')).toBe(true);

    const envelope = asset.serialize();

    // Buyer loads with a FRESH, keyless SDK — verification is public-key-only.
    const buyer = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    const { asset: loaded, verification } = await buyer.lifecycle.loadAsset(envelope);
    expect(verification?.verified).toBe(true);
    // The folded current resource is v2.
    expect(loaded.getResourceVersion('note', 2)?.content).toBe('v2');
    expect(loaded.getProvenance().resourceUpdates.some(u => u.toVersion === 2)).toBe(true);
  });

  test('content-tamper in the envelope is rejected at load', async () => {
    const creator = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    const asset = await creator.lifecycle.createAsset([
      { id: 'note', type: 'text', content: 'v1', contentType: 'text/plain', hash: h('v1') }
    ]);
    await asset.addResourceVersion('note', 'v2', 'text/plain');
    const envelope = asset.serialize();

    // Flip the embedded content of the update event.
    const updateEv = envelope.eventLog.events.find(e => e.type === 'update')!;
    (updateEv.data as { content: string }).content = 'tampered';

    const buyer = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore: new MockKeyStore() });
    await expect(buyer.lifecycle.loadAsset(envelope)).rejects.toThrow();
  });

  test('degrade: keyless creator emits cel:append-skipped and the update is not on the log', async () => {
    // No keyStore ⇒ createAsset drops the controller key ⇒ appends degrade.
    const creator = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519' });
    const asset = await creator.lifecycle.createAsset([
      { id: 'note', type: 'text', content: 'v1', contentType: 'text/plain', hash: h('v1') }
    ]);
    const skipped: CelAppendSkippedEvent[] = [];
    creator.lifecycle.on('cel:append-skipped', (e) => skipped.push(e as CelAppendSkippedEvent));

    await asset.addResourceVersion('note', 'v2', 'text/plain');

    expect(asset.getResourceVersion('note', 2)?.content).toBe('v2'); // usable in-memory
    expect(asset.celLog!.events.some(e => e.type === 'update')).toBe(false); // not provable
    expect(skipped.length).toBe(1);
    expect(asset.getProvenance().resourceUpdates.length).toBe(0);
  });
});
