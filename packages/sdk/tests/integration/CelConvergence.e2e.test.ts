/**
 * Phase-2 Task 9: CEL-convergence end-to-end.
 *
 * The protocol's promise as ONE test, driven entirely through REAL flows
 * (OrdMock + MemoryStorage + keyStore) — no hand-built events:
 *
 *   create -> publish -> inscribe -> transfer -> rotate
 *
 * An Original asset IS a CEL. Every lifecycle operation appends a signed event;
 * the log tells the whole story and verifies against the chain at the end.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK } from '../../src';
import { OrdMockProvider } from '../../src/adapters/providers/OrdMockProvider';
import { MemoryStorageAdapter } from '../../src/storage/MemoryStorageAdapter';
import { MockKeyStore } from '../mocks/MockKeyStore';
import { multikey } from '../../src/crypto/Multikey';
import { computeDigestMultibase } from '../../src/cel/hash';
import { canonicalizeEntryForChain } from '../../src/cel/canonicalize';
import { verifyEventLog } from '../../src/cel/algorithms/verifyEventLog';
import { replayProvenance } from '../../src/lifecycle/replayProvenance';
import { deriveDidCel } from '../../src/cel/celDid';

// regtest accepts this bech32 address in the SDK's validator (see the other
// transferOwnership integration tests).
const NEW_OWNER = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

describe('CEL convergence end-to-end (#Phase2 Task9)', () => {
  test('create -> publish -> inscribe -> transfer -> rotate: one log, verifies against the chain', async () => {
    // One provider instance is both the SDK's inscription backend AND the
    // ordinals lookup verifyEventLog uses to check the bitcoin witness proof.
    const ordinalsProvider = new OrdMockProvider();
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      defaultKeyType: 'Ed25519',
      ordinalsProvider,
      storageAdapter: new MemoryStorageAdapter(),
      keyStore: new MockKeyStore()
    });

    // create — mints did:cel genesis; currentLayer label stays 'did:peer'.
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: 'ab'.repeat(32) }
    ]);
    const didCel = asset.id;
    expect(didCel.startsWith('did:cel:u')).toBe(true);
    expect(deriveDidCel(asset.celLog!)).toBe(didCel);
    expect(asset.currentLayer).toBe('did:peer');

    // publish — appends the webvh migrate event.
    await sdk.lifecycle.publishToWeb(asset, 'example.com');
    const webvhBinding = asset.bindings!['did:webvh'];
    expect(webvhBinding).toBeDefined();

    // inscribe — appends the btco migrate event; the inscribed DID doc IS the
    // witness artifact. Capture the anchor while events[2] is still the head.
    await sdk.lifecycle.inscribeOnBitcoin(asset);
    const btcoDid = asset.bindings!['did:btco']!;
    expect(btcoDid).toMatch(/^did:btco:reg:\d+$/);

    const btcoMigrateEntry = asset.celLog!.events[2]; // the head AT inscription time
    const inscriptionDoc = await sdk.did.resolveDID(btcoDid, { skipCache: true });
    const inscriptionAnchor = (inscriptionDoc!.service || []).find(s => s.type === 'OriginalsCelAnchor');
    expect(inscriptionAnchor).toBeDefined();
    // Anchor A: the #cel embedded at inscription time commits to the log entry
    // that WAS the head then — the btco migrate (index 2), NOT the later head.
    const inscriptionAnchorDigest = (inscriptionAnchor!.serviceEndpoint as any).headDigestMultibase;
    expect(inscriptionAnchorDigest)
      .toBe(computeDigestMultibase(canonicalizeEntryForChain(btcoMigrateEntry)));

    // transfer — the sat moves; ownership IS sat control, so a transfer writes
    // NOTHING to the CEL. The sharpest new-model assertion: the log length is
    // UNCHANGED across transferOwnership (a transfer grows no log).
    const lenBeforeTransfer = asset.celLog!.events.length;
    await sdk.lifecycle.transferOwnership(asset, NEW_OWNER);
    expect(asset.celLog!.events.length).toBe(lenBeforeTransfer);

    // rotate — the recipient reinscribes the same-id doc with a fresh key,
    // appending rotateKey and RE-embedding a fresher #cel on the same sat.
    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');
    await sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey });

    // ---- The log tells the whole story, in order. ----
    // inscribe appends a controller-signed acknowledgeWitness update after the
    // btco migrate (map §5.1). The transfer contributed nothing. The fill(7)
    // rotation carries no matching secret, so the post-rotation controller can't
    // sign its own acknowledgment — that append degrades (NO_SIGNING_KEY) and no
    // trailing update lands.
    const log = asset.celLog!;
    expect(log.events.map(e => e.type)).toEqual(['create', 'migrate', 'migrate', 'update', 'rotateKey']);

    // ---- verify() gates on the WHOLE chain, needing the ordinals provider
    // for the btco witness proof. ----
    const result = await verifyEventLog(log, { expectedDid: didCel, ordinalsProvider });
    expect(result.verified).toBe(true);
    // Same guarantee via the asset façade, and fail-closed without the dep.
    expect(await asset.verify({ ordinalsProvider })).toBe(true);
    expect(await asset.verify()).toBe(false);

    // ---- The pure fold agrees with the live in-memory caches. ----
    const folded = replayProvenance(log);
    expect(folded.currentLayer).toBe('did:btco');
    expect(folded.currentLayer).toBe(asset.currentLayer);
    expect(folded.bindings['did:cel']).toBe(didCel);
    expect(folded.bindings['did:webvh']).toBe(webvhBinding);
    // The btco witness proof (#367) makes the binding log-derivable in the real flow.
    expect(folded.bindings['did:btco']).toBe(btcoDid);

    // ---- Two anchors, one sat: newest-inscription-wins resolution. ----
    // resolveDID returns the CURRENT (rotated) doc, so its #cel is the FRESHER
    // anchor — the rotateKey entry (now index 4, after the inscribe ack; the
    // transfer added nothing), not the inscription-time head.
    const rotateEntry = log.events[4];
    const currentDoc = await sdk.did.resolveDID(btcoDid, { skipCache: true });
    const currentAnchor = (currentDoc!.service || []).find(s => s.type === 'OriginalsCelAnchor');
    expect(currentAnchor).toBeDefined();
    expect((currentAnchor!.serviceEndpoint as any).headDigestMultibase)
      .toBe(computeDigestMultibase(canonicalizeEntryForChain(rotateEntry)));
    // Sanity: the two anchors are genuinely distinct heads of the same log.
    expect(inscriptionAnchorDigest)
      .not.toBe((currentAnchor!.serviceEndpoint as any).headDigestMultibase);
    // The rotated doc carries the incoming controller's key and keeps its manifest.
    expect(currentDoc!.verificationMethod?.[0]?.publicKeyMultibase).toBe(newKey);
    expect((currentDoc!.service || []).some(s => s.type === 'OriginalsResourceManifest')).toBe(true);
  });
});
