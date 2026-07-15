/**
 * Per-event real-time chain-recoverability (#407 phase 3). Once an asset is on
 * did:btco, every authorship append (addResourceVersion, rotateKey) inscribes on
 * the anchoring sat as it happens, so the sat's inscription chain IS the
 * always-current log. A resolver with ONLY the sat + a provider walks the chain
 * and rebuilds the FULL current log + current media, verified — no envelope, no
 * host.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { KeyManager } from '../../src/did/KeyManager';
import { hashResource } from '../../src/utils/validation';

const contentHash = (s: string) => hashResource(Buffer.from(s, 'utf8'));

function makeSDK(keyStore = new MockKeyStore()) {
  const ordinalsProvider = new OrdMockProvider();
  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider,
    storageAdapter: new MemoryStorageAdapter(),
    keyStore
  });
  return { sdk, ordinalsProvider, keyStore };
}

const inssOnSat = (p: OrdMockProvider, sat: string) =>
  (p as any)['state'].inscriptionsBySatoshi.get(sat) as string[] | undefined;
const recOf = (p: OrdMockProvider, id: string) =>
  (p as any)['state'].inscriptionsById.get(id);

describe('per-event real-time chain recovery (#407 phase 3)', () => {
  test('real-time round-trip: create → publish → inscribe → addResourceVersion (inscribes) → rotateKey (inscribes) rebuilds the FULL current log from the sat alone', async () => {
    const { sdk, ordinalsProvider } = makeSDK();
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: contentHash('v1'), content: 'v1' }
    ]);
    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    const sat = asset.bindings!['did:btco'].split(':').pop()!;
    const afterMigrate = inssOnSat(ordinalsProvider, sat)!.length;

    // Each btco authorship append inscribes as it happens.
    await asset.addResourceVersion('art', 'v2', 'image/png', 'to v2');
    expect(inssOnSat(ordinalsProvider, sat)!.length).toBe(afterMigrate + 1);
    await asset.addResourceVersion('art', 'v3', 'image/png', 'to v3');
    expect(inssOnSat(ordinalsProvider, sat)!.length).toBe(afterMigrate + 2);

    // A cooperative rotation also inscribes.
    const newKey = await new KeyManager().generateKeyPair('Ed25519');
    await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey.publicKey, privateKey: newKey.privateKey }, 5);
    expect(inssOnSat(ordinalsProvider, sat)!.length).toBe(afterMigrate + 3);

    // Fresh resolver: only the sat + provider.
    const fresh = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', ordinalsProvider });
    const { asset: recovered, verification } = await fresh.lifecycle.resolveAssetFromSat(sat);

    expect(verification?.verified).toBe(true);
    expect(recovered.id).toBe(asset.id);
    expect(recovered.currentLayer).toBe('did:btco');
    // The reconstructed log is a PREFIX of the live hosted log — it may omit only
    // a trailing witness-ack update that was appended AFTER (not inscribed by) the
    // last inscription. Every authorship event is present, in order.
    const recTypes = recovered.celLog!.events.map(e => e.type);
    const hostTypes = asset.celLog!.events.map(e => e.type);
    expect(hostTypes.slice(0, recTypes.length)).toEqual(recTypes);
    expect(recTypes).toEqual(expect.arrayContaining(['migrate', 'rotateKey']));
    expect(recTypes.filter(t => t === 'update').length).toBeGreaterThanOrEqual(2);
    // Current media is v3 (the most-recent resource update).
    expect(recovered.resources.find(r => r.hash === contentHash('v3'))?.content).toBe('v3');
  });

  test('immediacy: an addResourceVersion is recoverable IMMEDIATELY, before any later append', async () => {
    const { sdk, ordinalsProvider } = makeSDK();
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: contentHash('a'), content: 'a' }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    const sat = asset.bindings!['did:btco'].split(':').pop()!;

    await asset.addResourceVersion('art', 'b', 'image/png', 'to b');
    // Resolve right now — no rotation, no further appends.
    const { asset: recovered, verification } = await sdk.lifecycle.resolveAssetFromSat(sat);
    expect(verification?.verified).toBe(true);
    expect(recovered.resources.find(r => r.hash === contentHash('b'))?.content).toBe('b');
  });

  test('ordering: several appends reconstruct events in the correct order across the chain', async () => {
    const { sdk, ordinalsProvider } = makeSDK();
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: contentHash('0'), content: '0' }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    const sat = asset.bindings!['did:btco'].split(':').pop()!;
    for (const v of ['1', '2', '3', '4']) {
      await asset.addResourceVersion('art', v, 'image/png', `to ${v}`);
    }
    const { asset: recovered, verification } = await sdk.lifecycle.resolveAssetFromSat(sat);
    expect(verification?.verified).toBe(true);
    // The resource-update toHashes appear in ascending version order.
    const updates = recovered.celLog!.events.filter(e => e.type === 'update' && (e.data as any).toHash);
    expect(updates.map(e => (e.data as any).toHash)).toEqual(
      ['1', '2', '3', '4'].map(contentHash)
    );
    expect(recovered.resources.find(r => r.hash === contentHash('4'))?.content).toBe('4');
  });

  test('gap: a removed middle inscription breaks continuity → resolution fails closed', async () => {
    const { sdk, ordinalsProvider } = makeSDK();
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: contentHash('g0'), content: 'g0' }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    const sat = asset.bindings!['did:btco'].split(':').pop()!;
    await asset.addResourceVersion('art', 'g1', 'image/png', 'to g1');
    await asset.addResourceVersion('art', 'g2', 'image/png', 'to g2');

    // Drop the FIRST resource-update inscription (index afterMigrate) — the
    // second update's delta now chains from a missing event → broken chain.
    const list = inssOnSat(ordinalsProvider, sat)!;
    const removed = list.splice(list.length - 2, 1)[0];
    (ordinalsProvider as any)['state'].inscriptionsById.delete(removed);

    await expect(sdk.lifecycle.resolveAssetFromSat(sat)).rejects.toThrow();
  });

  test('tamper: a mutated delta event in metadata → resolution fails closed', async () => {
    const { sdk, ordinalsProvider } = makeSDK();
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: contentHash('t0'), content: 't0' }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    const sat = asset.bindings!['did:btco'].split(':').pop()!;
    await asset.addResourceVersion('art', 't1', 'image/png', 'to t1');

    // Flip a signed field in the newest inscription's delta event(s).
    const list = inssOnSat(ordinalsProvider, sat)!;
    const rec = recOf(ordinalsProvider, list[list.length - 1]);
    const evs = rec.metadata.events as any[];
    evs[evs.length - 1].data.toHash = contentHash('FORGED');

    await expect(sdk.lifecycle.resolveAssetFromSat(sat)).rejects.toThrow();
  });

  test('cost surfacing: a btco append emits cel:inscribe-cost', async () => {
    const { sdk } = makeSDK();
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: contentHash('c0'), content: 'c0' }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

    const costs: any[] = [];
    sdk.lifecycle.on('cel:inscribe-cost', (e) => costs.push(e));
    await asset.addResourceVersion('art', 'c1', 'image/png', 'to c1');
    expect(costs.length).toBe(1);
    expect(costs[0].estVsize).toBeGreaterThan(0);
  });

  test('degrade: a btco asset in a provider-less manager appends to the host and signals the skipped inscription', async () => {
    const keyStore = new MockKeyStore();
    const { sdk, ordinalsProvider } = makeSDK(keyStore);
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: contentHash('d0'), content: 'd0' }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    const sat = asset.bindings!['did:btco'].split(':').pop()!;

    // Provider-LESS SDK sharing the same keyStore (so it can sign the append),
    // recovering the asset via an explicitly-passed provider for verification.
    const providerless = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', keyStore });
    const { asset: recovered } = await providerless.lifecycle.resolveAssetFromSat(sat, { ordinalsProvider });

    const skipped: any[] = [];
    providerless.lifecycle.on('cel:append-inscribe-skipped', (e) => skipped.push(e));
    const before = inssOnSat(ordinalsProvider, sat)!.length;
    await recovered.addResourceVersion('art', 'd1', 'image/png', 'to d1');

    // No new inscription (no provider), but a clear degrade signal fired.
    expect(inssOnSat(ordinalsProvider, sat)!.length).toBe(before);
    expect(skipped.map(e => e.reason)).toContain('NO_ORDINALS_PROVIDER');
  });
});
