/**
 * Phase-3 Task 8: the creator→buyer hand-off — the protocol's promise as ONE
 * test, driven entirely through REAL flows.
 *
 * A creator (SDK A) mints and publishes an asset, then serializes it into an
 * interchange envelope. A buyer (SDK B) — FRESH: fresh keyStore (holds NONE of
 * A's keys), and a fresh MemoryStorageAdapter *instance* — but that adapter's
 * backing store is process-global, so B's storage instance actually DOES see
 * A's hosted did:cel/webvh logs (see MemoryStorageAdapter). That's irrelevant
 * to verification: loadAsset/verify never read storage at all — every CEL
 * controller proof uses did:key VMs that resolve offline, so the shared
 * OrdMock ("the chain") is verify's only external dependency. Proved below by
 * construction with a storage adapter that throws on every read. The only
 * thing that actually reads the shared host is the separate
 * sdk.did.resolveDID(did:cel) assertion later in this test. B loads the
 * envelope, verifies it with NO keys of their own (verification is public-key
 * only).
 *
 * Ownership model — OWNERSHIP IS SAT CONTROL:
 *   - transferOwnership moves the sat and writes NOTHING to the log. Ownership
 *     is read from the chain via getCurrentOwner, NOT from any CEL event.
 *   - Holding the sat grants NO control of the key set: the non-cooperative
 *     rotation path (#366) is deleted, so a buyer cannot take over the
 *     creator's controller slot. (The buyer's own right to APPEND arrives
 *     with sat-gated appends; until then a buyer holds the sat but cannot
 *     author.)
 *
 *   A: create -> publish -> inscribe -> rotate (cooperative) -> serialize
 *   B: loadAsset -> verify (no keys)
 *   A: transferOwnership(BUYER)  [sat move, NO log growth]
 *      => getCurrentOwner reads the BUYER (ownership is the sat)
 *   B: a rotation attempt with B's own key FAILS — the sat is not the key set
 *   B: onward RESALE = a sat move, NO log growth
 *      => getCurrentOwner flips to the next buyer
 *   + truncation guard: a pre-rotation prefix fails STALE_LOG
 *
 * No hand-built events except the explicitly-labelled truncation attack.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { KeyManager } from '../../src/did/KeyManager';
import { verifyEventLog } from '@originals/cel';
import { replayProvenance } from '../../src/lifecycle/replayProvenance';
import { resolveDidCel } from '@originals/cel';
import { createDidManagerKeyResolver } from '@originals/cel';
import type { AssetEnvelope } from '../../src/lifecycle/assetEnvelope';

const RES = [{ id: 'art', type: 'image', contentType: 'image/png', hash: 'ab'.repeat(32) }];

// regtest-accepted bech32 addresses (validated by the SDK's address validator).
const BUYER_ADDR = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
const ONWARD_ADDR = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7';

describe('creator→buyer hand-off end-to-end (#Phase3 Task8)', () => {
  test('serialize → fresh load+verify → sat-move transfer → buyer cannot rotate → third-party verify', async () => {
    // The ONE provider instance is the shared chain: it is A's inscription
    // backend AND the ordinals lookup every verifier uses for witness proofs.
    const ordinalsProvider = new OrdMockProvider();

    // ---- Creator (SDK A): keyStore + storage + the shared chain. ----
    const creatorStorage = new MemoryStorageAdapter();
    const sdkA = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider,
      storageAdapter: creatorStorage,
      keyStore: new MockKeyStore(),
    } as any);

    const aAsset = await sdkA.lifecycle.createAsset(RES);
    const didCel = aAsset.id;
    expect(didCel.startsWith('did:cel:u')).toBe(true);

    await sdkA.lifecycle.publishToWeb(aAsset, 'example.com');
    const webvhBinding = aAsset.bindings!['did:webvh'];
    expect(webvhBinding).toBeDefined();

    await sdkA.lifecycle.inscribeOnBitcoin(aAsset);
    const btcoDid = aAsset.bindings!['did:btco']!;
    expect(btcoDid).toMatch(/^did:btco:reg:\d+$/);

    // A rotates their own key COOPERATIVELY (signed by the outgoing
    // controller) — the only rotation the verifier accepts. The reinscription
    // this produces is also what arms the truncation guard below.
    const rotatedKey = await new KeyManager().generateKeyPair('Ed25519');
    const rotation = await sdkA.lifecycle.rotateBtcoKeys(aAsset, {
      publicKeyMultibase: rotatedKey.publicKey,
      privateKey: rotatedKey.privateKey,
    });
    expect(rotation.did).toBe(btcoDid);
    expect(aAsset.celLog!.events.some(e => e.type === 'rotateKey')).toBe(true);

    // The creator hands off a self-describing envelope (pre-transfer).
    const envelope: AssetEnvelope = aAsset.serialize();
    expect(envelope.assetDid).toBe(didCel);
    // The interchange payload round-trips through JSON on the wire.
    const wire = JSON.stringify(envelope);

    // ---- Buyer (SDK B) — FRESH: fresh keyStore, fresh storage, SAME chain. ----
    const sdkB = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider,
      storageAdapter: new MemoryStorageAdapter(), // fresh instance, but the store is
                                                   // process-global — B DOES see A's
                                                   // hosted logs (see header comment;
                                                   // verify itself is proved not to
                                                   // care, below)
      keyStore: new MockKeyStore(),               // fresh — B holds NONE of A's keys
    } as any);

    // loadAsset VERIFIES BY DEFAULT — and the buyer needs NO keys to do it
    // (verification is public-key only: resolveKey + the shared provider).
    const loaded = await sdkB.lifecycle.loadAsset(wire);
    expect(loaded.verification?.verified).toBe(true);
    expect(loaded.verification?.errors ?? []).toEqual([]);
    // The publication credential was issued by the PRE-rotation did:cel key;
    // after A's cooperative rotation the resolver only knows the current key,
    // so it is surfaced (documented behavior) as an advisory warning — the
    // load itself still verifies. No other warnings are tolerated.
    expect(loaded.warnings.every(w => /could not be cryptographically verified at load/.test(w))).toBe(true);
    const bAsset = loaded.asset;
    expect(bAsset.id).toBe(didCel);

    // ---- Proof by construction: verify never reads storage. ----
    // A SECOND buyer SDK whose storage adapter throws on every read (same
    // shared OrdMock, same envelope) still verifies successfully — this rules
    // out ordering flukes and shows loadAsset/verify are storage-independent
    // by construction, not by accident of what the test happened to populate.
    const throwingStorage = {
      putObject: async () => { throw new Error('storage must not be read during verify'); },
      getObject: async () => { throw new Error('storage must not be read during verify'); },
      exists: async () => { throw new Error('storage must not be read during verify'); },
      listObjects: async () => { throw new Error('storage must not be read during verify'); },
    };
    const sdkBNoStorage = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider,
      storageAdapter: throwingStorage,
      keyStore: new MockKeyStore(),
    } as any);
    const loadedNoStorage = await sdkBNoStorage.lifecycle.loadAsset(wire);
    expect(loadedNoStorage.verification?.verified).toBe(true);
    expect(loadedNoStorage.verification?.errors ?? []).toEqual([]);

    // ---- Fold parity: B's reconstruction matches A's live caches. ----
    const foldedA = replayProvenance(aAsset.celLog!);
    const foldedB = replayProvenance(bAsset.celLog!);
    expect(foldedB.currentLayer).toBe(foldedA.currentLayer);
    expect(bAsset.currentLayer).toBe('did:btco');
    expect(foldedB.bindings['did:cel']).toBe(didCel);
    expect(foldedB.bindings['did:webvh']).toBe(webvhBinding);
    expect(foldedB.bindings['did:btco']).toBe(btcoDid);

    // ---- Resolve historical DIDs forward to head. ----
    // (1) did:btco resolves off the shared chain to the current on-chain doc.
    const btcoDoc = await sdkB.did.resolveDID(btcoDid, { skipCache: true });
    expect(btcoDoc?.id).toBe(btcoDid);

    // (2) did:cel resolves forward to head from the ENVELOPE's own log — the
    // buyer holds the log, so the envelope alone is sufficient for resolution
    // (no hosted copy required).
    const celDocFromEnvelope = await resolveDidCel(didCel, bAsset.celLog!, {
      resolveKey: createDidManagerKeyResolver(sdkB.did),
      ordinalsProvider,
    });
    expect(celDocFromEnvelope?.id).toBe(didCel);

    // (3) did:cel ALSO resolves through the SDK-level persistence branch (Task
    // 3): that branch reads the hosted CEL log from storage, which here is the
    // public host both parties share (MemoryStorageAdapter's process-global
    // store models the hosting layer — the did:cel/webvh logs are public infra,
    // not private to the seller). So the honest split is: resolveDidCel(log)
    // needs only the envelope; sdk.did.resolveDID(did:cel) needs the hosted log.
    const celDocFromHost = await sdkB.did.resolveDID(didCel, { skipCache: true });
    expect(celDocFromHost?.id).toBe(didCel);

    // ---- The hand-off: ownership IS sat control. ----
    // A moves the sat to the buyer's address. This is a PURE sat move — it
    // writes NOTHING to the CEL (the move hands over the pen; the log records
    // it only when the new holder writes). Prove it: the
    // seller's log length is unchanged across transferOwnership.
    const aLogLenBeforeTransfer = aAsset.celLog!.events.length;
    await sdkA.lifecycle.transferOwnership(aAsset, BUYER_ADDR);
    expect(aAsset.celLog!.events.length).toBe(aLogLenBeforeTransfer);

    // THE HEADLINE: ownership now reads the BUYER's address — straight off the
    // chain, not from any CEL event (the log never mentioned the transfer).
    const ownerAfterSale = await sdkB.lifecycle.getCurrentOwner(bAsset);
    expect(ownerAfterSale?.address).toBe(BUYER_ADDR);

    // ---- Holding the sat grants NO control of the key set. ----
    // B holds the sat but NOT the creator's controller key, so B's rotation
    // attempt (with B's own fresh key) cannot be signed: the cooperative
    // rotation folds to the CURRENT controller, whose key B's keyStore does
    // not hold. There is no non-cooperative arm to fall back to (#366
    // deleted). The log must not grow.
    const buyerKey = await new KeyManager().generateKeyPair('Ed25519');
    const lenBeforeAttempt = bAsset.celLog!.events.length;
    let rotateErr: any;
    try {
      await sdkB.lifecycle.rotateBtcoKeys(bAsset, {
        publicKeyMultibase: buyerKey.publicKey,
        privateKey: buyerKey.privateKey,
      });
    } catch (e) {
      rotateErr = e;
    }
    expect(rotateErr).toBeDefined();
    expect(bAsset.celLog!.events.length).toBe(lenBeforeAttempt);

    // ---- A third, fully independent verifier verifies the WHOLE chain,
    // including the cooperative rotation. ----
    const sdkC = OriginalsSDK.create({ keyStore: new MockKeyStore(),
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider,
      storageAdapter: new MemoryStorageAdapter(),
    } as any);
    const postTransferEnvelope = bAsset.serialize();
    // loadAsset with a provider sets checkHeadFreshness — the strongest gate.
    const thirdParty = await sdkC.lifecycle.loadAsset(postTransferEnvelope);
    expect(thirdParty.verification?.verified).toBe(true);
    expect(thirdParty.verification?.errors ?? []).toEqual([]);
    // And directly, with checkHeadFreshness explicitly on.
    const direct = await verifyEventLog(bAsset.celLog!, {
      expectedDid: didCel,
      resolveKey: createDidManagerKeyResolver(sdkC.did),
      ordinalsProvider,
      checkHeadFreshness: true,
    });
    expect(direct.verified).toBe(true);

    // ---- The sharpest new-model assertion: B's onward RESALE. ----
    // B sells the sat onward. The resale is a PURE sat move: the log does NOT
    // grow, yet ownership flips to the next buyer — read live off the chain,
    // never from the CEL. Ownership is the sat; the log grows only when a
    // holder writes.
    const lenBeforeResale = bAsset.celLog!.events.length;
    await sdkB.lifecycle.transferOwnership(bAsset, ONWARD_ADDR);
    expect(bAsset.celLog!.events.length).toBe(lenBeforeResale); // no log growth
    const ownerAfterResale = await sdkB.lifecycle.getCurrentOwner(bAsset);
    expect(ownerAfterResale?.address).toBe(ONWARD_ADDR);

    // ---- Truncation guard: a seller handing a buyer-with-provider the
    // pre-rotation prefix fails STALE_LOG — the sat's newest inscription betrays
    // the omitted rotation. (Attack: an honest re-serialization of a PREFIX.) ----
    const postTransfer = bAsset.serialize();
    const rotateIdx = postTransfer.eventLog.events.findIndex(e => e.type === 'rotateKey');
    expect(rotateIdx).toBeGreaterThan(0);
    const truncated: AssetEnvelope = {
      ...postTransfer,
      eventLog: { ...postTransfer.eventLog, events: postTransfer.eventLog.events.slice(0, rotateIdx) },
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
