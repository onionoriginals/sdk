/**
 * The creator→buyer hand-off — the protocol's promise as ONE test, driven
 * through REAL flows under the sat-gated ownership model:
 *
 *   - Ownership IS sat control: transferOwnership moves the sat and writes
 *     NOTHING to the log; getCurrentOwner reads the chain, never the CEL.
 *   - Holding the sat grants the right to APPEND — the buyer writes their own
 *     entry, signed with their own key, authorized by the reinscription on the
 *     anchoring sat, with no rotation and no key-set change.
 *   - Holding the sat grants NO control of the key set: rotation is refused
 *     post-anchor, and a holder cannot make authenticity claims (the holder
 *     allowlist).
 *
 *   A: create -> publish -> inscribe -> serialize
 *   B: loadAsset -> verify (no keys)
 *   A: transferOwnership(BUYER)  [sat move, NO log growth]
 *      => getCurrentOwner reads the BUYER (ownership is the sat)
 *   B: appendStatement with B's OWN key -> the log GROWS, class = holder
 *   B: addResourceVersion attempt -> CEL_HOLDER_FIELD_NOT_PERMITTED
 *   B: rotation attempt -> KEY_ROTATION_NOT_PERMITTED
 *   A: an OFF-CHAIN post-sale append never verifies (the sat gate)
 *   C: third-party verify of the whole chain; holders = [B]
 *   B: onward RESALE = a sat move, NO log growth; owner flips
 *   + resolveAssetFromSat reports the live owner + the creator lineage
 *   + truncation guard: a prefix without B's entry fails STALE_LOG
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { KeyManager } from '../../src/did/KeyManager';
import { signerFromKeyPair } from '../../src/crypto/OriginalsSigner';
import { verifyEventLog, appendEvent, celSignerFromKeyPair, currentControllerVm } from '@originals/cel';
import { replayProvenance } from '../../src/lifecycle/replayProvenance';
import { createDidManagerKeyResolver } from '@originals/cel';
import { hashResource } from '../../src/utils/validation';
import type { AssetEnvelope } from '../../src/lifecycle/assetEnvelope';

const RES = () => [{
  id: 'art', type: 'image', contentType: 'image/png',
  hash: hashResource(Buffer.from('the-work', 'utf8')), content: 'the-work',
}];

// regtest-accepted bech32 addresses (validated by the SDK's address validator).
const BUYER_ADDR = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
const ONWARD_ADDR = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7';

describe('creator→buyer hand-off end-to-end (sat-gated appends)', () => {
  test('serialize → fresh load+verify → sat move → BUYER APPENDS → third-party verify → resale', async () => {
    // The ONE provider instance is the shared chain.
    const ordinalsProvider = new OrdMockProvider();

    // ---- Creator (SDK A). ----
    const keyStoreA = new MockKeyStore();
    const sdkA = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider,
      storageAdapter: new MemoryStorageAdapter(),
      keyStore: keyStoreA,
    } as any);

    const aAsset = await sdkA.lifecycle.createAsset(RES());
    const didCel = aAsset.id;
    expect(didCel.startsWith('did:cel:u')).toBe(true);
    await sdkA.lifecycle.publishToWeb(aAsset, 'example.com');
    await sdkA.lifecycle.inscribeOnBitcoin(aAsset);
    const btcoDid = aAsset.bindings!['did:btco']!;
    const sat = btcoDid.split(':').pop()!;
    const creatorDid = currentControllerVm(aAsset.celLog!).split('#')[0];

    // The creator hands off a self-describing envelope (pre-transfer).
    const wire = JSON.stringify(aAsset.serialize());

    // ---- Buyer (SDK B) — FRESH keyStore (none of A's keys), B's OWN signer. ----
    const buyerKp = await new KeyManager().generateKeyPair('Ed25519');
    const buyerSigner = signerFromKeyPair(buyerKp);
    const sdkB = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider,
      storageAdapter: new MemoryStorageAdapter(),
      keyStore: new MockKeyStore(),
      signer: buyerSigner,
    } as any);

    // loadAsset VERIFIES BY DEFAULT — the buyer needs NO keys to do it.
    const loaded = await sdkB.lifecycle.loadAsset(wire);
    expect(loaded.verification?.verified).toBe(true);
    expect(loaded.verification?.errors ?? []).toEqual([]);
    const bAsset = loaded.asset;
    expect(bAsset.id).toBe(didCel);

    // ---- Fold parity across the wire. ----
    const foldedB = replayProvenance(bAsset.celLog!);
    expect(foldedB.currentLayer).toBe('did:btco');
    expect(foldedB.bindings['did:btco']).toBe(btcoDid);
    expect(foldedB.custody).toEqual([]);

    // ---- The hand-off: ownership IS sat control. ----
    const aLogLenBeforeTransfer = aAsset.celLog!.events.length;
    await sdkA.lifecycle.transferOwnership(aAsset, BUYER_ADDR);
    expect(aAsset.celLog!.events.length).toBe(aLogLenBeforeTransfer);
    const ownerAfterSale = await sdkB.lifecycle.getCurrentOwner(bAsset);
    expect(ownerAfterSale?.address).toBe(BUYER_ADDR);

    // ---- THE HEADLINE: the buyer appends, with their own brand-new key. ----
    // No rotation, no key-set change, no seller signature: the entry commits
    // B's key in data.author and is authorized by its reinscription on the
    // anchoring sat.
    const lenBefore = bAsset.celLog!.events.length;
    const headDigest = await bAsset.appendStatement({
      statement: 'acquired for my collection',
      occurredAt: '2026-08-23T12:00:00Z',
    });
    expect(headDigest).not.toBeNull();
    expect(bAsset.celLog!.events.length).toBe(lenBefore + 1);
    const bEntry = bAsset.celLog!.events[bAsset.celLog!.events.length - 1];
    expect((bEntry.data as any).author).toBe(`did:key:${buyerKp.publicKey}`);

    // ---- A holder cannot make authenticity claims. ----
    // addResourceVersion would publish a new version of the work's bytes —
    // a creator-only claim. It must refuse LOCALLY, before any inscription.
    await expect(
      bAsset.addResourceVersion('art', 'forged-bytes', 'image/png')
    ).rejects.toMatchObject({ code: 'CEL_HOLDER_FIELD_NOT_PERMITTED' });

    // ---- Nor can the sat buy the key set. ----
    const takeover = await new KeyManager().generateKeyPair('Ed25519');
    await expect(
      sdkB.lifecycle.rotateBtcoKeys(bAsset, { publicKeyMultibase: takeover.publicKey, privateKey: takeover.privateKey })
    ).rejects.toMatchObject({ code: 'KEY_ROTATION_NOT_PERMITTED' });

    // ---- The creator cannot write after selling (off-chain). ----
    // A still holds their controller key; an append WITHOUT a reinscription on
    // the sat (here: hand-built, exactly what a hosted-copy write would be) is
    // simply unauthorized under the sat gate.
    const creatorVm = currentControllerVm(aAsset.celLog!);
    const creatorPriv = await keyStoreA.getPrivateKey(creatorVm);
    const creatorCel = celSignerFromKeyPair({ publicKey: creatorVm.split('#')[1], privateKey: creatorPriv! });
    const offChain = await appendEvent(
      aAsset.celLog!,
      'update',
      { author: creatorDid, statement: 'still mine, surely' },
      { signer: creatorCel.signer, verificationMethod: creatorVm }
    );
    const offChainResult = await verifyEventLog(offChain, { ordinalsProvider });
    expect(offChainResult.verified).toBe(false);
    expect(offChainResult.errors.some(e => /post-anchor events must be inscribed on the anchoring satoshi/.test(e))).toBe(true);

    // ---- A third, fully independent verifier verifies the WHOLE chain. ----
    const sdkC = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider,
      storageAdapter: new MemoryStorageAdapter(),
      keyStore: new MockKeyStore(),
    } as any);
    const postAppend = bAsset.serialize();
    const thirdParty = await sdkC.lifecycle.loadAsset(postAppend);
    expect(thirdParty.verification?.verified).toBe(true);
    expect(thirdParty.verification?.errors ?? []).toEqual([]);
    // The custody chain names the buyer; the creator lineage is intact.
    expect(thirdParty.verification?.holders).toEqual([`did:key:${buyerKp.publicKey}`]);
    expect(thirdParty.verification?.creatorKeys).toEqual([creatorDid]);
    expect(thirdParty.asset.getProvenance().custody?.map(c => c.author)).toEqual([`did:key:${buyerKp.publicKey}`]);
    // And directly, with checkHeadFreshness explicitly on.
    const direct = await verifyEventLog(bAsset.celLog!, {
      expectedDid: didCel,
      resolveKey: createDidManagerKeyResolver(sdkC.did),
      ordinalsProvider,
      checkHeadFreshness: true,
    });
    expect(direct.verified).toBe(true);

    // ---- B's onward RESALE: a pure sat move — no log growth, owner flips. ----
    const lenBeforeResale = bAsset.celLog!.events.length;
    await sdkB.lifecycle.transferOwnership(bAsset, ONWARD_ADDR);
    expect(bAsset.celLog!.events.length).toBe(lenBeforeResale);
    const ownerAfterResale = await sdkB.lifecycle.getCurrentOwner(bAsset);
    expect(ownerAfterResale?.address).toBe(ONWARD_ADDR);

    // ---- resolveAssetFromSat: chain-only reconstruction reports the LIVE
    // owner beside the verified asset; the creator stays the genesis
    // controller. (Checked after the resale: OrdMock resets its ownership
    // index on every reinscription, so the resale is the last ownership-
    // bearing operation on the mock — live Bitcoin keeps the sat with its
    // holder across reinscriptions.) ----
    const resolved = await sdkC.lifecycle.resolveAssetFromSat(sat);
    expect(resolved.verification?.verified).toBe(true);
    expect(resolved.owner?.address).toBe(ONWARD_ADDR);
    expect(resolved.verification?.creatorKeys).toEqual([creatorDid]);
    expect(resolved.verification?.holders).toEqual([`did:key:${buyerKp.publicKey}`]);

    // ---- Truncation guard: a prefix without B's entry fails STALE_LOG. ----
    const appendIdx = postAppend.eventLog.events.length - 1;
    const truncated: AssetEnvelope = {
      ...postAppend,
      eventLog: { ...postAppend.eventLog, events: postAppend.eventLog.events.slice(0, appendIdx) },
    };
    let err: any;
    try {
      await sdkC.lifecycle.loadAsset(truncated);
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('ASSET_LOAD_VERIFICATION_FAILED');
    expect(err.details.verification.errors.some((m: string) => /STALE_LOG/.test(m))).toBe(true);
  });
});
