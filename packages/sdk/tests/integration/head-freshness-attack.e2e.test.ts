/**
 * Head-freshness end-to-end attack: the seller hands the buyer a truncated
 * prefix of the log. It is a VALID prefix — it verifies on its own — but the
 * anchored satoshi's newest inscription commits to the sat-gated append the
 * seller sliced off. loadAsset with a provider sets checkHeadFreshness and
 * catches it as STALE_LOG; the honest full log loads; a no-provider load of a
 * btco-anchored envelope surfaces a "cannot check freshness" warning.
 *
 * Drives the REAL write path: createAsset → inscribeOnBitcoin →
 * addResourceVersion (a sat-gated creator append) reinscribes on the shared
 * OrdMock.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { MockKeyStore } from '../mocks/MockKeyStore';
import type { AssetEnvelope } from '../../src/lifecycle/assetEnvelope';

import { hashResource } from '../../src/utils/validation';
const RES = [{ id: 'art', type: 'image', contentType: 'image/png', hash: hashResource(Buffer.from('v1', 'utf8')), content: 'v1' }];

function makeSdk(provider: OrdMockProvider) {
  return OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: provider,
    storageAdapter: new MemoryStorageAdapter(),
    keyStore: new MockKeyStore(),
  } as any);
}

// create → inscribeOnBitcoin → addResourceVersion: the sat-gated creator
// append reinscribes on the sat. Returns the full envelope + the index of the
// appended update event.
async function buildAppendedAsset(provider: OrdMockProvider) {
  const sdk = makeSdk(provider);
  const asset = await sdk.lifecycle.createAsset(RES.map(r => ({ ...r })));
  await sdk.lifecycle.inscribeOnBitcoin(asset);

  await asset.addResourceVersion('art', 'v2', 'image/png', 'to v2');

  const envelope = asset.serialize();
  const appendIdx = envelope.eventLog.events.findIndex(e => e.type === 'update');
  expect(appendIdx).toBeGreaterThan(0);
  return { sdk, envelope, appendIdx };
}

// Honest re-serialization of a prefix: slice events, keep everything else.
// Drop the v2 resource too — an honest prefix seller serializes the asset as
// it stood BEFORE the append (an envelope whose resources outrun its log
// would trip the resource↔log cross-checks instead of the freshness gate).
function truncateBeforeAppend(envelope: AssetEnvelope, appendIdx: number): AssetEnvelope {
  return {
    ...envelope,
    eventLog: { ...envelope.eventLog, events: envelope.eventLog.events.slice(0, appendIdx) },
    resources: envelope.resources.filter(r => (r as { version?: number }).version === undefined || (r as { version?: number }).version === 1),
  };
}

describe('head-freshness e2e: truncated-log hand-off attack', () => {
  test('the truncated (pre-append) envelope fails loadAsset with STALE_LOG', async () => {
    const provider = new OrdMockProvider();
    const { sdk, envelope, appendIdx } = await buildAppendedAsset(provider);
    const truncated = truncateBeforeAppend(envelope, appendIdx);

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
    const { sdk, envelope } = await buildAppendedAsset(provider);

    const { asset, verification, warnings } = await sdk.lifecycle.loadAsset(envelope);
    expect(verification?.verified).toBe(true);
    expect(verification?.errors ?? []).toEqual([]);
    expect(warnings).toEqual([]);
    expect(asset.currentLayer).toBe('did:btco');
  });

  test('a no-provider load of a btco-anchored envelope carries a freshness warning', async () => {
    const provider = new OrdMockProvider();
    const { envelope } = await buildAppendedAsset(provider);

    // A manager with NO ordinals provider cannot check freshness on a btco log.
    const offlineSdk = OriginalsSDK.create({ keyStore: new MockKeyStore(),
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      storageAdapter: new MemoryStorageAdapter(),
    } as any);

    const { warnings } = await offlineSdk.lifecycle.loadAsset(envelope, { skipVerification: true });
    expect(warnings.some(w => /freshness/i.test(w))).toBe(true);
  });
});
