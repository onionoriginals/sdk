import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../../src';
import { OrdMockProvider } from '../../../src/adapters/providers/OrdMockProvider';
import { MemoryStorageAdapter } from '../../../src/storage/MemoryStorageAdapter';
import { MockKeyStore } from '../../mocks/MockKeyStore';
import { multikey } from '../../../src/crypto/Multikey';
import { KeyManager } from '../../../src/did/KeyManager';
import { verifyEventLog } from '../../../src/cel/algorithms/verifyEventLog';
import { appendEvent } from '../../../src/cel/algorithms/appendEvent';
import { celSignerFromKeyPair, currentControllerVm } from '../../../src/cel/signerAdapter';
import { deriveDidCel, DID_CEL_PREFIX } from '../../../src/cel/celDid';
import { parseEventLogJson } from '../../../src/cel/serialization/json';
import { LifecycleManager } from '../../../src/lifecycle/LifecycleManager';
import { DIDManager } from '../../../src/did/DIDManager';
import { CredentialManager } from '../../../src/vc/CredentialManager';
import { BitcoinManager } from '../../../src/bitcoin/BitcoinManager';
import { OriginalsConfig } from '../../../src/types';

// regtest-accepted bech32 address (same one the transfer integration tests use).
const NEW_OWNER = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const RES = [{ id: 'art', type: 'image', contentType: 'image/png', hash: 'ab'.repeat(32) }];

function makeSdk(provider: OrdMockProvider, keyStore?: MockKeyStore) {
  return OriginalsSDK.create({
    network: 'regtest',
    defaultKeyType: 'Ed25519',
    ordinalsProvider: provider,
    storageAdapter: new MemoryStorageAdapter(),
    ...(keyStore ? { keyStore } : {})
  } as any);
}

describe('claimOwnership (#366 non-cooperative rotation, write side)', () => {
  test('e2e: transfer then claimOwnership with a fresh key; whole log verifies through the REAL write path', async () => {
    const provider = new OrdMockProvider();
    const keyStore = new MockKeyStore();
    const sdk = makeSdk(provider, keyStore);

    const asset = await sdk.lifecycle.createAsset(RES);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    await sdk.lifecycle.transferOwnership(asset, NEW_OWNER);
    const satoshi = asset.bindings!['did:btco']!.split(':').pop()!;

    // Capture the OUTGOING controller's key BEFORE the claim rotates it away.
    const oldVm = currentControllerVm(asset.celLog!);
    const oldPriv = (await keyStore.getPrivateKey(oldVm))!;
    expect(oldPriv).toBeTruthy();

    // The buyer holds a FRESH Ed25519 keypair (never registered by the seller).
    const claimer = await new KeyManager().generateKeyPair('Ed25519');
    await sdk.lifecycle.claimOwnership(asset, {
      publicKeyMultibase: claimer.publicKey,
      privateKey: claimer.privateKey
    });

    // Last three events: transfer, rotateKey(+witness proof), update(ack).
    const events = asset.celLog!.events;
    expect(events.slice(-3).map(e => e.type)).toEqual(['transfer', 'rotateKey', 'update']);

    const rotateEntry = events[events.length - 2];
    expect((rotateEntry.data as any).newController).toBe(`did:key:${claimer.publicKey}`);
    // SELF-SIGNED with the NEW key (not folded to the seller's controller).
    expect(((rotateEntry.proof as any)[0].verificationMethod as string)
      .startsWith(`did:key:${claimer.publicKey}`)).toBe(true);
    // The bitcoin witness proof is attached post-inscription (satisfies check (a)).
    expect((rotateEntry.proof as any).some((p: any) => p.cryptosuite === 'bitcoin-ordinals-2024')).toBe(true);

    // Acknowledgment update, signed by the NEW controller (current post-rotation).
    const ackEntry = events[events.length - 1];
    expect((ackEntry.data as any).operation).toBe('acknowledgeWitness');
    expect((ackEntry.data as any).satoshi).toBe(satoshi);
    expect((ackEntry.data as any).inscriptionId).toBeDefined();
    expect(((ackEntry.proof as any)[0].verificationMethod as string)
      .startsWith(`did:key:${claimer.publicKey}`)).toBe(true);

    // The whole log verifies — Task 5's non-cooperative rule exercised through
    // the real write path, not hand-built events.
    const result = await verifyEventLog(asset.celLog!, { expectedDid: asset.id, ordinalsProvider: provider });
    expect(result.verified).toBe(true);

    // The OLD controller is locked out: a further append signed by the seller's
    // key is unauthorized after the accepted rotation.
    const oldPub = oldVm.slice('did:key:'.length).split('#')[0];
    const { signer, verificationMethod } = celSignerFromKeyPair({ publicKey: oldPub, privateKey: oldPriv } as any);
    const forged = await appendEvent(asset.celLog!, 'transfer', {
      previousOwner: `did:key:${claimer.publicKey}`, newOwner: 'someone', txid: 'zzz', transferredAt: new Date().toISOString()
    }, { signer, verificationMethod });
    expect((await verifyEventLog(forged, { expectedDid: asset.id, ordinalsProvider: provider })).verified).toBe(false);

    // The NEW controller IS authorized: a real transfer append signs with the
    // claimer key (registered by claim) and the whole log still verifies.
    await sdk.lifecycle.transferOwnership(asset, NEW_OWNER);
    const newLast = asset.celLog!.events[asset.celLog!.events.length - 1];
    expect(newLast.type).toBe('transfer');
    expect(((newLast.proof as any)[0].verificationMethod as string)
      .startsWith(`did:key:${claimer.publicKey}`)).toBe(true);
    expect((await verifyEventLog(asset.celLog!, { expectedDid: asset.id, ordinalsProvider: provider })).verified).toBe(true);
  });

  test('rejects a mismatched keypair with INVALID_KEY_PAIR and no side effects', async () => {
    class CountingProvider extends OrdMockProvider {
      inscribeCalls = 0;
      async createInscription(params: any): Promise<any> {
        this.inscribeCalls += 1;
        return super.createInscription(params);
      }
    }
    const provider = new CountingProvider();
    const sdk = makeSdk(provider, new MockKeyStore());
    const asset = await sdk.lifecycle.createAsset(RES);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const eventsBefore = asset.celLog!.events.length;
    const inscribeCallsBefore = provider.inscribeCalls;

    const kpA = await new KeyManager().generateKeyPair('Ed25519');
    const kpB = await new KeyManager().generateKeyPair('Ed25519');
    await expect(
      sdk.lifecycle.claimOwnership(asset, { publicKeyMultibase: kpA.publicKey, privateKey: kpB.privateKey })
    ).rejects.toMatchObject({ code: 'INVALID_KEY_PAIR' });

    expect(asset.celLog!.events.length).toBe(eventsBefore);
    expect(provider.inscribeCalls).toBe(inscribeCallsBefore);
  });

  test('rejects claiming a non-btco asset with INVALID_STATE', async () => {
    const sdk = makeSdk(new OrdMockProvider(), new MockKeyStore());
    const asset = await sdk.lifecycle.createAsset(RES); // did:peer
    const kp = await new KeyManager().generateKeyPair('Ed25519');
    await expect(
      sdk.lifecycle.claimOwnership(asset, { publicKeyMultibase: kp.publicKey, privateKey: kp.privateKey })
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  test('concurrent claims on the same asset reject with OPERATION_IN_PROGRESS', async () => {
    const provider = new OrdMockProvider();
    const sdk = makeSdk(provider, new MockKeyStore());
    const asset = await sdk.lifecycle.createAsset(RES);
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const kp1 = await new KeyManager().generateKeyPair('Ed25519');
    const kp2 = await new KeyManager().generateKeyPair('Ed25519');
    const p1 = sdk.lifecycle.claimOwnership(asset, { publicKeyMultibase: kp1.publicKey, privateKey: kp1.privateKey });
    const p2 = sdk.lifecycle.claimOwnership(asset, { publicKeyMultibase: kp2.publicKey, privateKey: kp2.privateKey });
    await expect(p2).rejects.toMatchObject({ code: 'OPERATION_IN_PROGRESS' });
    await p1;
  });

  test('inscribeOnBitcoin appends a controller-signed acknowledgeWitness update', async () => {
    const provider = new OrdMockProvider();
    const sdk = makeSdk(provider, new MockKeyStore());
    const asset = await sdk.lifecycle.createAsset(RES);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const satoshi = asset.bindings!['did:btco']!.split(':').pop()!;

    const last = asset.celLog!.events[asset.celLog!.events.length - 1];
    expect(last.type).toBe('update');
    expect((last.data as any).operation).toBe('acknowledgeWitness');
    expect((last.data as any).satoshi).toBe(satoshi);
    expect((last.data as any).inscriptionId).toBeDefined();
    // Signed by the current (genesis) controller — btco migrate does not rotate.
    const controllerVm = currentControllerVm(asset.celLog!);
    expect((last.proof as any)[0].verificationMethod).toBe(controllerVm);
    expect((await verifyEventLog(asset.celLog!, { expectedDid: asset.id, ordinalsProvider: provider })).verified).toBe(true);
  });

  test('rotateBtcoKeys appends an acknowledgeWitness update signed by the NEW controller', async () => {
    const provider = new OrdMockProvider();
    const sdk = makeSdk(provider, new MockKeyStore());
    const asset = await sdk.lifecycle.createAsset(RES);
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const newKp = await new KeyManager().generateKeyPair('Ed25519');
    await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKp.publicKey, privateKey: newKp.privateKey });

    const last = asset.celLog!.events[asset.celLog!.events.length - 1];
    expect(last.type).toBe('update');
    expect((last.data as any).operation).toBe('acknowledgeWitness');
    // Post-rotation the current controller folds to the new key; the ack signs with it.
    expect(((last.proof as any)[0].verificationMethod as string).startsWith(`did:key:${newKp.publicKey}`)).toBe(true);
    expect((await verifyEventLog(asset.celLog!, { expectedDid: asset.id, ordinalsProvider: provider })).verified).toBe(true);
  });

  test('requires a private key to self-sign the rotation', async () => {
    const provider = new OrdMockProvider();
    const sdk = makeSdk(provider, new MockKeyStore());
    const asset = await sdk.lifecycle.createAsset(RES);
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');
    await expect(
      // @ts-expect-error privateKey is required
      sdk.lifecycle.claimOwnership(asset, { publicKeyMultibase: newKey })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('persists the self-signed rotation to storage even with no keyStore configured', async () => {
    const provider = new OrdMockProvider();
    const storage = new MemoryStorageAdapter();
    // No keyStore: the trailing witness-ack append (the only other path to
    // persistCelArtifacts) degrades to a skip, so the direct persist after
    // the self-signed rotation is the only thing that can reach storage.
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: provider,
      storageAdapter: storage
    } as any);

    const asset = await sdk.lifecycle.createAsset(RES);
    await sdk.lifecycle.inscribeOnBitcoin(asset);

    const claimer = await new KeyManager().generateKeyPair('Ed25519');
    await sdk.lifecycle.claimOwnership(asset, {
      publicKeyMultibase: claimer.publicKey,
      privateKey: claimer.privateKey
    });

    const suffix = deriveDidCel(asset.celLog!).slice(DID_CEL_PREFIX.length);
    const stored = await storage.getObject('cel', `${suffix}.json`);
    expect(stored).not.toBeNull();
    const storedLog = parseEventLogJson(new TextDecoder().decode(stored!.content));
    const rotateEntry = storedLog.events.find(e => e.type === 'rotateKey');
    expect(rotateEntry).toBeDefined();
    expect((rotateEntry!.proof as any).some((p: any) => p.cryptosuite === 'bitcoin-ordinals-2024')).toBe(true);
  });

  test('throws ORD_PROVIDER_INVALID_RESPONSE when the reinscription has no txid', async () => {
    // BitcoinManager.inscribeData itself guarantees a txid, so this exercises
    // the defensive guard against a misbehaving deps.bitcoinManager — the only
    // way this shape reaches claimOwnership in practice — rather than relying
    // solely on the (real) provider's own invariant.
    const provider = new OrdMockProvider();
    const keyStore = new MockKeyStore();
    const config: OriginalsConfig = {
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: provider,
      storageAdapter: new MemoryStorageAdapter()
    } as any;
    const didManager = new DIDManager(config);
    const credentialManager = new CredentialManager(config, didManager);
    const lifecycleManager = new LifecycleManager(config, didManager, credentialManager, undefined, keyStore);

    const asset = await lifecycleManager.createAsset(RES);
    await lifecycleManager.inscribeOnBitcoin(asset);
    const satoshi = asset.bindings!['did:btco']!.split(':').pop()!;

    const brokenBitcoinManager = {
      inscribeData: async () => ({ inscriptionId: 'insc-no-txid', satoshi })
    } as unknown as BitcoinManager;
    const claimLifecycle = new LifecycleManager(
      config, didManager, credentialManager, { bitcoinManager: brokenBitcoinManager }, keyStore
    );

    const claimer = await new KeyManager().generateKeyPair('Ed25519');
    let caught: any;
    try {
      await claimLifecycle.claimOwnership(asset, {
        publicKeyMultibase: claimer.publicKey,
        privateKey: claimer.privateKey
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.code).toBe('ORD_PROVIDER_INVALID_RESPONSE');
    expect(caught.details?.inscriptionId).toBe('insc-no-txid');
  });
});
