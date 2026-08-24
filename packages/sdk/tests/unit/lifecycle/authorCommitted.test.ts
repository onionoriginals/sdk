/**
 * Stage 3 of the ownership-model spec: the author's key is committed INSIDE
 * the signed data of every post-anchor append. Chain digests exclude proofs,
 * so `data.author` is what makes a reinscription commit to WHO signed an
 * entry, not just what it says. Pre-anchor events stay author-less (key
 * lineage already names the signer there), and the reinscribed btco document
 * announces the same appending key the entry commits to.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { KeyManager } from '../../../src/did/KeyManager';
import { hashResource } from '../../../src/utils/validation';
import { currentControllerVm } from '@originals/cel';

const contentHash = (s: string) => hashResource(Buffer.from(s, 'utf8'));

function makeSdk(provider = new OrdMockProvider()) {
  const sdk = OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: provider,
    storageAdapter: new MemoryStorageAdapter(),
    keyStore: new MockKeyStore(),
  });
  return { sdk, provider };
}

const RES = () => [
  { id: 'art', type: 'image', contentType: 'image/png', hash: contentHash('v1'), content: 'v1' },
];

describe('post-anchor appends commit data.author', () => {
  test('a btco resource update carries author = the signing key, and the whole log verifies', async () => {
    const { sdk, provider } = makeSdk();
    const asset = await sdk.lifecycle.createAsset(RES());
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

    const controllerDid = currentControllerVm(asset.celLog!).split('#')[0];
    await asset.addResourceVersion('art', 'v2', 'image/png', 'update to v2');

    const updates = asset.celLog!.events.filter(
      (e) => e.type === 'update' && (e.data as { toHash?: unknown }).toHash !== undefined
    );
    expect(updates.length).toBe(1);
    expect((updates[0].data as { author?: string }).author).toBe(controllerDid);
    // The committed author binds to the actual signer — the log verifies.
    expect((await asset.verify({ ordinalsProvider: provider })).verified).toBe(true);
  });

  test('the reinscribed btco document announces the appending key the entry commits to', async () => {
    const { sdk, provider } = makeSdk();
    const asset = await sdk.lifecycle.createAsset(RES());
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    await asset.addResourceVersion('art', 'v2', 'image/png');

    const head = asset.celLog!.events[asset.celLog!.events.length - 1];
    const author = (head.data as { author?: string }).author!;
    expect(author.startsWith('did:key:')).toBe(true);

    const sat = asset.bindings!['did:btco'].split(':').pop()!;
    const onSat = await provider.getInscriptionsBySatoshi(sat);
    const newest = await provider.getInscriptionById(onSat[onSat.length - 1].inscriptionId);
    const doc = (newest!.metadata as { didDocument?: { verificationMethod?: Array<{ publicKeyMultibase?: string }> } }).didDocument;
    expect(doc?.verificationMethod?.[0]?.publicKeyMultibase).toBe(author.slice('did:key:'.length));
  });

  test('inscribeOnBitcoin appends NO acknowledgment: the migrate head carries the witness proof itself', async () => {
    // A post-anchor acknowledgment append would need its own reinscription
    // under sat-gated appends; the SDK no longer writes one.
    const { sdk, provider } = makeSdk();
    const asset = await sdk.lifecycle.createAsset(RES());
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);

    expect(asset.celLog!.events.map((e) => e.type)).toEqual(['create', 'migrate']);
    const head = asset.celLog!.events[1];
    expect(head.proof.some((p) => (p as { cryptosuite?: string }).cryptosuite === 'bitcoin-ordinals-2024')).toBe(true);
    expect((await asset.verify({ ordinalsProvider: provider })).verified).toBe(true);
  });

  test('a statement append commits its author and verifies (rotateKey is refused post-anchor)', async () => {
    const { sdk, provider } = makeSdk();
    const asset = await sdk.lifecycle.createAsset(RES());
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    const controllerDid = currentControllerVm(asset.celLog!).split('#')[0];

    const rotated = await new KeyManager().generateKeyPair('Ed25519');
    await expect(
      sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: rotated.publicKey, privateKey: rotated.privateKey })
    ).rejects.toMatchObject({ code: 'KEY_ROTATION_NOT_PERMITTED' });

    await asset.appendStatement({ statement: 'still mine' });
    const head = asset.celLog!.events[asset.celLog!.events.length - 1];
    expect((head.data as { author?: string }).author).toBe(controllerDid);
    expect((await asset.verify({ ordinalsProvider: provider })).verified).toBe(true);
  });

  test('pre-anchor events carry NO author (key lineage governs before the anchor)', async () => {
    const { sdk } = makeSdk();
    const asset = await sdk.lifecycle.createAsset(RES());
    await asset.addResourceVersion('art', 'v2', 'image/png');
    await sdk.lifecycle.publishToWeb(asset, 'example.com');

    for (const e of asset.celLog!.events) {
      expect((e.data as { author?: unknown }).author).toBeUndefined();
    }

    // The btco MIGRATE itself is the anchor, not post-anchor: still no author.
    await sdk.lifecycle.inscribeOnBitcoin(asset, 5);
    const btcoMigrate = asset.celLog!.events.find(
      (e) => e.type === 'migrate' && (e.data as { layer?: unknown }).layer === 'btco'
    )!;
    expect((btcoMigrate.data as { author?: unknown }).author).toBeUndefined();
  });
});
