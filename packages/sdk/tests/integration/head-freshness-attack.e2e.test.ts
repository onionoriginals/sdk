/**
 * Head-freshness end-to-end attack (#366): the seller hands the buyer a
 * pre-rotation prefix of the log. It is a VALID prefix — it verifies on its
 * own — but the anchored satoshi's newest inscription commits to the rotation
 * the seller sliced off. loadAsset with a provider sets checkHeadFreshness and
 * catches it as STALE_LOG; the honest full log loads; a no-provider load of a
 * btco-anchored envelope surfaces a "cannot check freshness" warning.
 *
 * Drives the REAL write path: createAsset → inscribeOnBitcoin → claimOwnership
 * (Task 6) reinscribes the rotated anchor doc on the shared OrdMock.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { KeyManager } from '../../src/did/KeyManager';
import type { AssetEnvelope } from '../../src/lifecycle/assetEnvelope';

const RES = [{ id: 'art', type: 'image', contentType: 'image/png', hash: 'ab'.repeat(32) }];

function makeSdk(provider: OrdMockProvider) {
  return OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: provider,
    storageAdapter: new MemoryStorageAdapter(),
    keyStore: new MockKeyStore(),
  } as any);
}

// create → inscribeOnBitcoin → claimOwnership: the buyer's rotation reinscribes
// the anchor doc on the sat. Returns the full envelope + the rotateKey index.
async function buildRotatedAsset(provider: OrdMockProvider) {
  const sdk = makeSdk(provider);
  const asset = await sdk.lifecycle.createAsset(RES);
  await sdk.lifecycle.inscribeOnBitcoin(asset);

  const claimer = await new KeyManager().generateKeyPair('Ed25519');
  await sdk.lifecycle.claimOwnership(asset, {
    publicKeyMultibase: claimer.publicKey,
    privateKey: claimer.privateKey,
  });

  const envelope = asset.serialize();
  const rotateIdx = envelope.eventLog.events.findIndex(e => e.type === 'rotateKey');
  expect(rotateIdx).toBeGreaterThan(0);
  return { sdk, envelope, rotateIdx };
}

// Honest re-serialization of a prefix: slice events, keep everything else.
function truncateBeforeRotation(envelope: AssetEnvelope, rotateIdx: number): AssetEnvelope {
  return {
    ...envelope,
    eventLog: { ...envelope.eventLog, events: envelope.eventLog.events.slice(0, rotateIdx) },
  };
}

describe('head-freshness e2e: truncated-log hand-off attack', () => {
  test('the truncated (pre-rotation) envelope fails loadAsset with STALE_LOG', async () => {
    const provider = new OrdMockProvider();
    const { sdk, envelope, rotateIdx } = await buildRotatedAsset(provider);
    const truncated = truncateBeforeRotation(envelope, rotateIdx);

    // Without verification it "loads" (the prefix is structurally valid) —
    // proving the prefix is a genuine, honestly re-serialized valid prefix.
    const lenient = await sdk.lifecycle.loadAsset(truncated, { skipVerification: true });
    expect(lenient.asset.currentLayer).toBe('did:btco');

    // With the shared provider the truncation is caught.
    let err: any;
    try {
      await sdk.lifecycle.loadAsset(truncated);
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.code).toBe('ASSET_LOAD_VERIFICATION_FAILED');
    expect(err.details.verification.verified).toBe(false);
    expect(err.details.verification.errors.some((m: string) => /STALE_LOG/.test(m))).toBe(true);
  });

  test('the honest FULL envelope loads and verifies', async () => {
    const provider = new OrdMockProvider();
    const { sdk, envelope } = await buildRotatedAsset(provider);

    const { asset, verification, warnings } = await sdk.lifecycle.loadAsset(envelope);
    expect(verification?.verified).toBe(true);
    expect(verification?.errors ?? []).toEqual([]);
    expect(warnings).toEqual([]);
    expect(asset.currentLayer).toBe('did:btco');
  });

  test('a no-provider load of a btco-anchored envelope carries a freshness warning', async () => {
    const provider = new OrdMockProvider();
    const { envelope } = await buildRotatedAsset(provider);

    // A manager with NO ordinals provider cannot check freshness on a btco log.
    const offlineSdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      storageAdapter: new MemoryStorageAdapter(),
    } as any);

    const { warnings } = await offlineSdk.lifecycle.loadAsset(envelope, { skipVerification: true });
    expect(warnings.some(w => /freshness/i.test(w))).toBe(true);
  });
});
