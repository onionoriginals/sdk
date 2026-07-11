import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { computeDigestMultibase } from '../../src/cel/hash';
import { canonicalizeEntryForChain } from '../../src/cel/canonicalize';
import { verifyEventLog } from '../../src/cel/algorithms/verifyEventLog';

describe('did:btco round-trip (#375)', () => {
  test('lifecycle-inscribed asset resolves through the SDK resolver', async () => {
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'ES256K',
      ordinalsProvider: new OrdMockProvider()
    });
    const asset = await sdk.lifecycle.createAsset([
      // Declared-hash-only resource: inline content would be hash-checked by
      // createAsset (#347) and 'ab'.repeat(32) is not the hash of any short string.
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash: 'ab'.repeat(32) }
    ]);
    const peerDid = asset.id;

    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const btcoDid = asset.bindings?.['did:btco'];
    expect(btcoDid).toMatch(/^did:btco:reg:\d+$/);

    // The SDK's own resolver must accept its own inscription.
    const doc = await sdk.did.resolveDID(btcoDid!);
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe(btcoDid!);
    expect(doc!.alsoKnownAs).toContain(peerDid);
    const svc = (doc!.service || []).find(s => s.type === 'OriginalsResourceManifest');
    expect(svc).toBeDefined();
    const endpoint = svc!.serviceEndpoint as { resources: Array<{ id: string; hash: string }> };
    expect(endpoint.resources[0].hash).toBe('ab'.repeat(32));
  });
});

describe('inscribeOnBitcoin commits to the CEL head digest (#365)', () => {
  test('inscribed doc carries #cel anchoring the post-append head; log verifies', async () => {
    const ordinalsProvider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider,
      keyStore: new MockKeyStore()
    });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash: 'cd'.repeat(32) }
    ]);
    const eventsBefore = asset.celLog!.events.length;

    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const btcoDid = asset.bindings!['did:btco']!;

    // The append landed: last event is the signed btco migrate. Satoshi/txid
    // are NOT in the signed data — they arrive later via witness proofs.
    const log = asset.celLog!;
    expect(log.events.length).toBe(eventsBefore + 1);
    const last = log.events[log.events.length - 1];
    expect(last.type).toBe('migrate');
    expect((last.data as any).layer).toBe('btco');
    expect((last.data as any).network).toBe('regtest');
    expect((last.data as any).sourceDid).toBe(asset.id);
    expect((last.data as any).satoshi).toBeUndefined();
    expect((last.data as any).txid).toBeUndefined();

    // The migrate event now carries a bitcoin witness proof (#367), so
    // verification is gated on the chain: it needs the ordinals provider.
    const res = await verifyEventLog(log, { expectedDid: asset.id, ordinalsProvider });
    expect(res.verified).toBe(true);

    // The resolved on-chain document anchors the post-append head digest.
    const doc = await sdk.did.resolveDID(btcoDid);
    const anchor = (doc!.service || []).find(s => s.type === 'OriginalsCelAnchor');
    expect(anchor).toBeDefined();
    expect(anchor!.id).toBe(`${btcoDid}#cel`);
    expect((anchor!.serviceEndpoint as any).headDigestMultibase)
      .toBe(computeDigestMultibase(canonicalizeEntryForChain(last)));
    // The resource manifest is still present alongside the anchor.
    expect((doc!.service || []).some(s => s.type === 'OriginalsResourceManifest')).toBe(true);
  });

  test('btco migrate event carries a bitcoin witness proof from the DID-doc inscription (#367)', async () => {
    const ordinalsProvider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider,
      keyStore: new MockKeyStore()
    });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash: '34'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const btcoDid = asset.bindings!['did:btco']!;
    const satoshi = btcoDid.split(':').pop()!;

    // The DID-doc inscription IS the witness artifact: the migrate event's
    // proof array gains a bitcoin-ordinals-2024 witness proof binding the
    // satoshi/inscriptionId that carry the anchoring document.
    const last = asset.celLog!.events[asset.celLog!.events.length - 1];
    expect(last.type).toBe('migrate');
    const wp = (last.proof as Array<Record<string, unknown>>).find(
      p => p.cryptosuite === 'bitcoin-ordinals-2024'
    );
    expect(wp).toBeDefined();
    expect(wp!.satoshi).toBe(satoshi);
    expect(typeof wp!.inscriptionId).toBe('string');
    expect(typeof wp!.witnessedAt).toBe('string');

    // Fail-closed: a btco-anchored log must NOT verify without a provider...
    const unanchored = await verifyEventLog(asset.celLog!, { expectedDid: asset.id });
    expect(unanchored.verified).toBe(false);
    // ...and verifies against the chain with one — the btco binding is now
    // derivable from the log alone (closes the Task-7 gap).
    const anchored = await verifyEventLog(asset.celLog!, { expectedDid: asset.id, ordinalsProvider });
    expect(anchored.verified).toBe(true);

    // asset.verify() delegates: gated without the provider dep, true with it.
    expect(await asset.verify()).toBe(false);
    expect(await asset.verify({ ordinalsProvider })).toBe(true);
  });

  test('keyStore-less inscribe degrades: cel:append-skipped, no #cel anchor, log untouched', async () => {
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: new OrdMockProvider()
    });
    const skipped: string[] = [];
    sdk.lifecycle.on('cel:append-skipped', (e) => { skipped.push(e.reason); });

    const asset = await sdk.lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash: 'ef'.repeat(32) }
    ]);
    const logBefore = asset.celLog;

    await sdk.lifecycle.inscribeOnBitcoin(asset);
    expect(skipped).toEqual(['NO_KEYSTORE']);
    expect(asset.celLog).toBe(logBefore);

    const doc = await sdk.did.resolveDID(asset.bindings!['did:btco']!);
    expect((doc!.service || []).some(s => s.type === 'OriginalsCelAnchor')).toBe(false);
    expect((doc!.service || []).some(s => s.type === 'OriginalsResourceManifest')).toBe(true);
  });

  test('inscription failure restores the pre-append CEL log', async () => {
    class FailingProvider extends OrdMockProvider {
      async createInscription(): Promise<never> {
        throw new Error('broadcast failed');
      }
    }
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: new FailingProvider(),
      keyStore: new MockKeyStore()
    });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'res-1', type: 'data', contentType: 'text/plain', hash: '12'.repeat(32) }
    ]);
    const logBefore = asset.celLog;

    await expect(sdk.lifecycle.inscribeOnBitcoin(asset)).rejects.toThrow('broadcast failed');
    // Pure in-memory restore — nothing was paid before broadcast failed.
    expect(asset.celLog).toBe(logBefore);
    expect(asset.currentLayer).toBe('did:peer');
  });
});
