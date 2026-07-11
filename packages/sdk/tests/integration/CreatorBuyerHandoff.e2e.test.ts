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
 * only), and then, WITHOUT the seller's cooperation, claims ownership by
 * reinscribing the anchor doc on the sat with the buyer's OWN key. A third,
 * independent verifier then verifies the whole log including the
 * non-cooperatively-accepted rotation.
 *
 *   A: create -> publish -> inscribe -> serialize
 *   B: loadAsset -> verify (no keys) -> appends DEGRADE
 *   A: transferOwnership -> B: claimOwnership (B's own key)
 *   C: verify the whole chain incl. the non-cooperative rotation
 *   B: appends now SUCCEED (B is the controller)
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
import { verifyEventLog } from '../../src/cel/algorithms/verifyEventLog';
import { replayProvenance } from '../../src/lifecycle/replayProvenance';
import { resolveDidCel } from '../../src/cel/celDid';
import { createDidManagerKeyResolver } from '../../src/cel/keyResolver';
import type { AssetEnvelope } from '../../src/lifecycle/assetEnvelope';
import type { CelAppendSkippedEvent } from '../../src/events/types';

const RES = [{ id: 'art', type: 'image', contentType: 'image/png', hash: 'ab'.repeat(32) }];

// regtest-accepted bech32 addresses (validated by the SDK's address validator).
const BUYER_ADDR = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
const JUNK_ADDR = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const ONWARD_ADDR = 'tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7';

describe('creator→buyer hand-off end-to-end (#Phase3 Task8)', () => {
  test('serialize → fresh load+verify → non-cooperative claim → third-party verify', async () => {
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
    expect(loaded.warnings).toEqual([]);
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

    // ---- The keyStore contract, ASSERTED: B's appends DEGRADE. ----
    // B is not (yet) the controller: the log's current controller is A's key,
    // which B does not hold. Any lifecycle append degrades to a skip rather
    // than failing — verification is public, but WRITING needs the key.
    const skipped: CelAppendSkippedEvent[] = [];
    sdkB.lifecycle.on('cel:append-skipped', (e) => skipped.push(e as CelAppendSkippedEvent));
    // A throwaway load so the primary bAsset stays pristine for the real claim.
    const bThrowaway = (await sdkB.lifecycle.loadAsset(wire)).asset;
    // transferOwnership's guard-based degrade emits cel:append-skipped and falls
    // through (does NOT throw) — the never-had-the-key path.
    await sdkB.lifecycle.transferOwnership(bThrowaway, JUNK_ADDR);
    expect(skipped.some(e => e.reason === 'NO_SIGNING_KEY')).toBe(true);

    // ---- The non-cooperative hand-off. ----
    // A moves the sat to the buyer's address (real transfer, A holds the key).
    await sdkA.lifecycle.transferOwnership(aAsset, BUYER_ADDR);

    // B claims with B's OWN fresh Ed25519 keypair — self-signing the rotation,
    // reinscribing the anchor doc on the sat. No seller signature involved.
    const buyerKey = await new KeyManager().generateKeyPair('Ed25519');
    const claim = await sdkB.lifecycle.claimOwnership(bAsset, {
      publicKeyMultibase: buyerKey.publicKey,
      privateKey: buyerKey.privateKey,
    });
    expect(claim.did).toBe(btcoDid);
    const claimLog = bAsset.celLog!;
    expect(claimLog.events.some(e => e.type === 'rotateKey')).toBe(true);

    // ---- A third, fully independent verifier verifies the WHOLE chain,
    // including the non-cooperatively-accepted rotation. ----
    const sdkC = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider,
      storageAdapter: new MemoryStorageAdapter(),
    } as any);
    const postClaimEnvelope = bAsset.serialize();
    // loadAsset with a provider sets checkHeadFreshness — the strongest gate.
    const thirdParty = await sdkC.lifecycle.loadAsset(postClaimEnvelope);
    expect(thirdParty.verification?.verified).toBe(true);
    expect(thirdParty.verification?.errors ?? []).toEqual([]);
    // And directly, with checkHeadFreshness explicitly on.
    const direct = await verifyEventLog(claimLog, {
      expectedDid: didCel,
      resolveKey: createDidManagerKeyResolver(sdkC.did),
      ordinalsProvider,
      checkHeadFreshness: true,
    });
    expect(direct.verified).toBe(true);

    // ---- B's appends now SUCCEED: B is the current controller. ----
    // claimOwnership registered B's key under the canonical VM; a subsequent
    // transfer appends a signed transfer event (log grows, NO skip fires).
    const skipsBefore = skipped.length;
    const lenBefore = bAsset.celLog!.events.length;
    await sdkB.lifecycle.transferOwnership(bAsset, ONWARD_ADDR);
    expect(bAsset.celLog!.events.length).toBeGreaterThan(lenBefore);
    expect(bAsset.celLog!.events.some(e => e.type === 'transfer')).toBe(true);
    expect(skipped.length).toBe(skipsBefore); // no new degrade — B signed it

    // ---- Truncation guard (#366): a seller handing a buyer-with-provider the
    // pre-rotation prefix fails STALE_LOG — the sat's newest inscription betrays
    // the omitted rotation. (Attack: an honest re-serialization of a PREFIX.) ----
    const postClaim = bAsset.serialize();
    const rotateIdx = postClaim.eventLog.events.findIndex(e => e.type === 'rotateKey');
    expect(rotateIdx).toBeGreaterThan(0);
    const truncated: AssetEnvelope = {
      ...postClaim,
      eventLog: { ...postClaim.eventLog, events: postClaim.eventLog.events.slice(0, rotateIdx) },
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
