import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { currentControllerVm } from '../../../src/cel/signerAdapter';
import type { CelAppendSkippedEvent } from '../../../src/events/types';

/**
 * Coverage for the NO_SIGNING_KEY degrade branch in
 * LifecycleManager.appendCelEventOrSkip (~:1773) — distinct from its sibling
 * NO_KEYSTORE branch (~:1761, covered elsewhere): here a keyStore IS
 * configured, it just doesn't hold the CEL log's CURRENT controller key.
 * This is the "buyer received the asset but can't author yet" shape: a
 * pre-transfer envelope loaded by a party who isn't the controller.
 */
describe('appendCelEventOrSkip: NO_SIGNING_KEY (keyStore present, controller key absent)', () => {
  test('publishToWeb on a foreign-controller asset skips with NO_SIGNING_KEY', async () => {
    // SDK-A mints the asset — createAsset auto-registers the controller key
    // in ITS OWN keyStore only.
    const sdkA = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      keyStore: new MockKeyStore()
    });
    const asset = await sdkA.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32) }
    ]);
    const envelope = asset.serialize();

    // SDK-B's keyStore EXISTS but is empty — B holds none of A's keys. This
    // is the exact shape that discriminates NO_SIGNING_KEY from NO_KEYSTORE.
    const sdkB = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      keyStore: new MockKeyStore()
    });
    const { asset: loaded } = await sdkB.lifecycle.loadAsset(envelope);

    const skipped: CelAppendSkippedEvent[] = [];
    sdkB.lifecycle.on('cel:append-skipped', (e) => skipped.push(e as CelAppendSkippedEvent));

    await sdkB.lifecycle.publishToWeb(loaded, 'example.com');

    expect(skipped.map((e) => e.reason)).toEqual(['NO_SIGNING_KEY']);
    // The layer migration itself is not gated by the append — degrade contract.
    expect(loaded.currentLayer).toBe('did:webvh');
    // No migrate event landed on the log since the append was skipped.
    expect(loaded.celLog!.events.some((e) => e.type === 'migrate')).toBe(false);
  });

  test('control: with the controller key registered, the same publish signs — no skip fires', async () => {
    // Same scenario, but SDK-B's keyStore DOES hold the log's controller key
    // (simulating a cooperative key hand-off). Proves the assertion above
    // discriminates on key presence, not some other side effect of loading a
    // foreign envelope.
    const keyStoreA = new MockKeyStore();
    const sdkA = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      keyStore: keyStoreA
    });
    const asset = await sdkA.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '78'.repeat(32) }
    ]);
    const envelope = asset.serialize();

    const controllerVm = currentControllerVm(asset.celLog!);
    const controllerKey = await keyStoreA.getPrivateKey(controllerVm);
    expect(controllerKey).not.toBeNull();

    const keyStoreB = new MockKeyStore();
    await keyStoreB.setPrivateKey(controllerVm, controllerKey!);
    const sdkB = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      keyStore: keyStoreB
    });
    const { asset: loaded } = await sdkB.lifecycle.loadAsset(envelope);

    const skipped: CelAppendSkippedEvent[] = [];
    sdkB.lifecycle.on('cel:append-skipped', (e) => skipped.push(e as CelAppendSkippedEvent));

    await sdkB.lifecycle.publishToWeb(loaded, 'example.com');

    expect(skipped).toEqual([]);
    const last = loaded.celLog!.events[loaded.celLog!.events.length - 1];
    expect(last.type).toBe('migrate');
  });
});
