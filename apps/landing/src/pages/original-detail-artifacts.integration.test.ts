/**
 * End-to-end guarantee for the detail page's data pipeline: after a real authed
 * publish (DemoEngine → DurableHostingStorageAdapter → originals store), every
 * artifact URL webvhArtifacts() derives from the DID — did.jsonl, cel.json, and
 * each sealed resource — serves from the durable store, and the parsed
 * artifacts fold into the timeline/summary/digests the page renders.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { withLiveInscriptionStatus, type OriginalRow } from './YourOriginals';
import { sha256 } from '@noble/hashes/sha2.js';
import { installCel3Host, engineWithSigner } from '../sdk/cel3-test-helpers';
import {
  webvhArtifacts,
  celTimeline,
  celResources,
  parseDidLog,
  didLogSummary,
  digestMultibaseSha256Hex,
  sha256HexToResourceMultibase,
  type CelLog
} from './original-detail-data';

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

describe('detail page artifacts after a real durable publish', () => {
  let host: ReturnType<typeof installCel3Host>;
  beforeEach(() => { host = installCel3Host('sub-1'); });
  afterEach(() => host.restore());

  test('every derived artifact URL serves, and the artifacts fold into the page models', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>';
    const { engine } = engineWithSigner('sub-1');
    const store = host.store;
    await engine.create('Detail Piece', 'Artwork', svg);
    const state = await engine.publish();
    const did = state.webvhDid!;

    const arts = webvhArtifacts(did);
    expect(arts).not.toBeNull();

    // did.jsonl serves at the derived URL and summarizes to THIS did.
    const logRes = store.serve(new URL(arts!.logUrl));
    expect(logRes).not.toBeNull();
    const entries = parseDidLog(await logRes!.text());
    const summary = didLogSummary(entries);
    expect(summary?.did).toBe(did);
    expect(summary?.scid).toBeDefined();
    expect(summary?.verificationMethods.length).toBeGreaterThan(0);

    // cel.json serves beside it and folds into the timeline the page renders.
    const celRes = store.serve(new URL(arts!.celUrl));
    expect(celRes).not.toBeNull();
    const cel = JSON.parse(await celRes!.text()) as CelLog;
    const steps = celTimeline(cel);
    expect(steps[0].state).toBe('done'); // create (did:cel genesis)
    expect(steps[1].state).toBe('done'); // publish (did:webvh)
    expect(steps[1].facts.find((f) => f.label === 'Published as')?.value).toBe(did);
    expect(steps[2].state).toBe('upcoming'); // inscribe (did:btco)
    expect(steps[0].proof?.proofValue).toBeDefined();

    // The hosted log remains at WebVH after a Bitcoin submission. The same
    // recorded row and live-status join used by the page must stop advertising
    // inscription as a future action, both before and after confirmation.
    const commitTxId = 'ab'.repeat(32);
    const revealTxId = 'cd'.repeat(32);
    const row: OriginalRow = {
      did, title: 'Detail Piece', resourceHash: '', createdAt: new Date().toISOString(),
      commitTxId, revealTxId, inscriptionId: revealTxId + 'i0', inscriptionStatus: 'pending',
    };
    for (const status of ['commit_broadcast', 'reveal_broadcast', 'confirmed'] as const) {
      const [current] = withLiveInscriptionStatus([row], [{
        commitTxId, revealTxId, inscriptionId: row.inscriptionId!,
        fundingOutpoint: 'ef'.repeat(32) + ':0', status,
        createdAt: row.createdAt, updatedAt: row.createdAt,
      }]);
      const timeline = celTimeline(cel, current);
      expect(timeline.map((step) => step.id)).toEqual(['create', 'publish']);
      expect(current.inscriptionStatus).toBe(status === 'confirmed' ? 'confirmed' : 'pending');
    }

    // Every sealed resource serves at its derived URL (declared multihash
    // digest → hosted raw-hash multibase, the exact key publishResources
    // writes), and the artwork's declared digest matches the sha-256 of the
    // bytes actually served.
    const resources = celResources(cel);
    expect(resources.length).toBe(2); // artwork.svg + metadata.json
    const hostedSeg = (digest: string) => sha256HexToResourceMultibase(digestMultibaseSha256Hex(digest)!)!;
    for (const r of resources) {
      expect(r.digestMultibase).toBeDefined();
      const served = store.serve(new URL(arts!.resourceUrl(hostedSeg(r.digestMultibase!))));
      expect(served).not.toBeNull();
    }
    const artwork = resources.find((r) => r.mediaType === 'image/svg+xml')!;
    const artRes = store.serve(new URL(arts!.resourceUrl(hostedSeg(artwork.digestMultibase!))));
    const bytes = new Uint8Array(await artRes!.arrayBuffer());
    expect(toHex(sha256(bytes))).toBe(digestMultibaseSha256Hex(artwork.digestMultibase!));
  });
});
