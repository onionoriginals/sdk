import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { multikey } from '../../../src/crypto/Multikey';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { computeDigestMultibase } from '../../../src/cel/hash';
import { canonicalizeEntryForChain } from '../../../src/cel/canonicalize';

describe('rotateBtcoKeys (#366 rotation-first)', () => {
  test('reinscribes same-id document with the new key; resolver serves it', async () => {
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', ordinalsProvider: provider });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const btcoDid = asset.bindings!['did:btco']!;

    // New owner's key: 32 arbitrary bytes — multikey only encodes/decodes bytes,
    // it does not validate the Ed25519 point, so a fixed pattern is fine here.
    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');

    const rotation = await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey });
    expect(rotation.did).toBe(btcoDid);

    const doc = await sdk.did.resolveDID(btcoDid, { skipCache: true });
    expect(doc).not.toBeNull();
    expect(doc!.id).toBe(btcoDid);
    expect(doc!.verificationMethod?.[0]?.publicKeyMultibase).toBe(newKey);
  });

  test('rotation preserves the resource manifest in the resolved document', async () => {
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', ordinalsProvider: provider });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const btcoDid = asset.bindings!['did:btco']!;

    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');
    await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey });

    const doc = await sdk.did.resolveDID(btcoDid, { skipCache: true });
    expect(doc).not.toBeNull();
    const manifestService = doc!.service?.find((s: any) => s.type === 'OriginalsResourceManifest');
    expect(manifestService).toBeDefined();
    expect((manifestService as any).serviceEndpoint.resources[0].hash).toBe(asset.resources[0].hash);
  });

  test('derives btco network from webvhNetwork tier when no explicit network is set', async () => {
    // magby → regtest. With no `network`, the binding is minted did:btco:reg:N;
    // rotation must derive the same network or it bricks with NETWORK_MISMATCH.
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({ webvhNetwork: 'magby', defaultKeyType: 'Ed25519', ordinalsProvider: provider });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '9a'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const btcoDid = asset.bindings!['did:btco']!;
    expect(btcoDid.startsWith('did:btco:reg:')).toBe(true);

    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');
    const rotation = await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey });
    expect(rotation.did).toBe(btcoDid);
  });

  test('appends rotateKey signed by the current controller; rotated doc re-embeds #cel + #resources (#365)', async () => {
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: provider,
      keyStore: new MockKeyStore()
    });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '56'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const btcoDid = asset.bindings!['did:btco']!;

    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');
    await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey });

    // The rotateKey event is the new head, naming the incoming controller.
    const last = asset.celLog!.events[asset.celLog!.events.length - 1];
    expect(last.type).toBe('rotateKey');
    expect((last.data as any).newController).toBe(`did:key:${newKey}`);
    // Cooperative rotation: signed by the OUTGOING (current) controller.
    const proofVm = (last.proof as any)[0].verificationMethod as string;
    expect(proofVm.startsWith(`did:key:${newKey}`)).toBe(false);

    // The rotated on-chain doc carries a FRESH #cel (digest of the rotateKey
    // entry) AND the re-embedded resource manifest.
    const doc = await sdk.did.resolveDID(btcoDid, { skipCache: true });
    const anchor = doc!.service?.find((s: any) => s.type === 'OriginalsCelAnchor');
    expect(anchor).toBeDefined();
    expect(anchor!.id).toBe(`${btcoDid}#cel`);
    expect((anchor!.serviceEndpoint as any).headDigestMultibase)
      .toBe(computeDigestMultibase(canonicalizeEntryForChain(last)));
    expect(doc!.service?.some((s: any) => s.type === 'OriginalsResourceManifest')).toBe(true);
  });

  test('keyStore-less rotation degrades: no rotateKey event, no #cel in the rotated doc', async () => {
    const provider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', ordinalsProvider: provider });
    const skipped: string[] = [];
    sdk.lifecycle.on('cel:append-skipped', (e) => { skipped.push(e.reason); });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '34'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const btcoDid = asset.bindings!['did:btco']!;
    const logBefore = asset.celLog;
    skipped.length = 0; // ignore the inscribe-time skip

    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');
    await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey });

    expect(skipped).toEqual(['NO_KEYSTORE']);
    expect(asset.celLog).toBe(logBefore);
    const doc = await sdk.did.resolveDID(btcoDid, { skipCache: true });
    expect(doc!.service?.some((s: any) => s.type === 'OriginalsCelAnchor') ?? false).toBe(false);
    expect(doc!.service?.some((s: any) => s.type === 'OriginalsResourceManifest')).toBe(true);
  });

  test('rotation inscription failure restores the pre-append CEL log', async () => {
    class FailSecondProvider extends OrdMockProvider {
      calls = 0;
      async createInscription(params: any): Promise<any> {
        this.calls += 1;
        if (this.calls > 1) throw new Error('rotation broadcast failed');
        return super.createInscription(params);
      }
    }
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: new FailSecondProvider(),
      keyStore: new MockKeyStore()
    });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '78'.repeat(32) }
    ]);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const logBefore = asset.celLog;

    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');
    await expect(
      sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey })
    ).rejects.toThrow('rotation broadcast failed');
    expect(asset.celLog).toBe(logBefore);
    const events = asset.celLog!.events;
    expect(events[events.length - 1].type).not.toBe('rotateKey');
  });

  test('rejects when asset is not on btco layer', async () => {
    const sdk = OriginalsSDK.create({ network: 'regtest', defaultKeyType: 'Ed25519', ordinalsProvider: new OrdMockProvider() });
    const asset = await sdk.lifecycle.createAsset([
      { id: 'r', type: 'data', contentType: 'text/plain', hash: '78'.repeat(32) }
    ]);
    await expect(
      sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: 'z6Mkfake' })
    ).rejects.toThrow(/btco/i);
  });
});
