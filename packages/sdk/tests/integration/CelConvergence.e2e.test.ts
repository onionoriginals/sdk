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
import { multikey } from '@originals/cel';
import { computeDigestMultibase } from '@originals/cel';
import { canonicalizeEntryForChain } from '@originals/cel';
import { verifyEventLog } from '@originals/cel';
import { replayProvenance } from '../../src/lifecycle/replayProvenance';
import { deriveDidCel } from '@originals/cel';

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

    // create — mints did:cel genesis; currentLayer label is 'did:cel'.
    const asset = await sdk.lifecycle.createAsset([
      { id: 'art', type: 'image', contentType: 'image/png', hash: 'ab'.repeat(32) }
    ]);
    const didCel = asset.id;
    expect(didCel.startsWith('did:cel:u')).toBe(true);
    expect(deriveDidCel(asset.celLog!)).toBe(didCel);
    expect(asset.currentLayer).toBe('did:cel');

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

    // rotate is a REMOVED capability: the key lineage is frozen at the anchor.
    const newKey = multikey.encodePublicKey(new Uint8Array(32).fill(7), 'Ed25519');
    await expect(sdk.lifecycle.rotateBtcoKeys(asset, { publicKeyMultibase: newKey }))
      .rejects.toMatchObject({ code: 'KEY_ROTATION_NOT_PERMITTED' });

    // append — a sat-gated statement: commits data.author, reinscribes the
    // same-id doc, RE-embedding a fresher #cel on the same sat.
    await asset.appendStatement({ statement: 'exhibited' });

    // ---- The log tells the whole story, in order. ----
    // The transfer contributed nothing; the refused rotation contributed
    // nothing; the statement is the new head.
    const log = asset.celLog!;
    expect(log.events.map(e => e.type)).toEqual(['create', 'migrate', 'migrate', 'update']);

    // ---- verify() gates on the WHOLE chain, needing the ordinals provider
    // for the btco witness proofs. ----
    const result = await verifyEventLog(log, { expectedDid: didCel, ordinalsProvider });
    expect(result.verified).toBe(true);
    // The creator still holds the pen: their post-anchor entry is a CREATOR claim.
    expect(result.events[3].authorClass).toBe('creator');
    expect(result.holders).toEqual([]);
    // Same guarantee via the asset façade. No argument needed: the asset was
    // minted through an SDK configured with this provider, and verify() uses it
    // rather than reporting `false` for a check it never ran.
    expect((await asset.verify({ ordinalsProvider })).verified).toBe(true);
    expect((await asset.verify()).verified).toBe(true);

    // ---- The pure fold agrees with the live in-memory caches. ----
    const folded = replayProvenance(log);
    expect(folded.currentLayer).toBe('did:btco');
    expect(folded.currentLayer).toBe(asset.currentLayer);
    expect(folded.bindings['did:cel']).toBe(didCel);
    expect(folded.bindings['did:webvh']).toBe(webvhBinding);
    // The btco witness proof (#367) makes the binding log-derivable in the real flow.
    expect(folded.bindings['did:btco']).toBe(btcoDid);
    // A creator statement is not custody.
    expect(folded.custody).toEqual([]);

    // ---- Two anchors, one sat: newest-inscription-wins resolution. ----
    // resolveDID returns the CURRENT doc, so its #cel is the FRESHER anchor —
    // the statement entry (index 3), not the inscription-time head.
    const statementEntry = log.events[3];
    const currentDoc = await sdk.did.resolveDID(btcoDid, { skipCache: true });
    const currentAnchor = (currentDoc!.service || []).find(s => s.type === 'OriginalsCelAnchor');
    expect(currentAnchor).toBeDefined();
    expect((currentAnchor!.serviceEndpoint as any).headDigestMultibase)
      .toBe(computeDigestMultibase(canonicalizeEntryForChain(statementEntry)));
    // Sanity: the two anchors are genuinely distinct heads of the same log.
    expect(inscriptionAnchorDigest)
      .not.toBe((currentAnchor!.serviceEndpoint as any).headDigestMultibase);
    // The reinscribed doc announces the APPENDING key (the creator, still
    // holding) and keeps its manifest.
    expect(`did:key:${currentDoc!.verificationMethod?.[0]?.publicKeyMultibase}`)
      .toBe((statementEntry.data as any).author);
    expect((currentDoc!.service || []).some(s => s.type === 'OriginalsResourceManifest')).toBe(true);
  });
});
