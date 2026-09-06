/**
 * Rebuilding an Original from what it hosts.
 *
 * The centrepiece is the round-trip at the bottom: create → publish → throw the
 * live asset away → rebuild it from nothing but the hosted CEL and resource
 * bytes → inscribe. That is the pre-broadcast resume gap, proved closed against
 * the real SDK rather than a mock of it.
 *
 * The fixture CEL is a verbatim capture from a real create+publish in Chromium,
 * not a hand-written approximation.
 */
import { describe, test, expect } from 'bun:test';
import { OriginalsSDK, signerFromKeyPair } from '@originals/sdk';
import { OrdMockProvider } from '@originals/sdk/testing';
import { hostedAssetEnvelope, hostedResourceRefs, resourceKind } from './hosted-envelope';
import type { CelLog } from '../pages/original-detail-data';

/** Captured from a real publish; only the proofValues are shortened. */
const REAL_CEL: CelLog = {
  events: [
    {
      type: 'create',
      data: {
        name: 'artwork.svg',
        controller: 'did:key:z6Mkj2fLd1Cft3Y1d4keoArcN9fxSUKUXo49sdyPDHA796qk',
        resources: [
          { id: 'artwork.svg', digestMultibase: 'uEiCa7YhDsJKiCLu84Gz_4QdSecy3Jz_65YR8OLfyXpbVvw', mediaType: 'image/svg+xml' },
          { id: 'metadata.json', digestMultibase: 'uEiCITXva8WrVO0iHWM-XPCA3mVMLMhtrSQcDcstcE8xQOg', mediaType: 'application/json' },
        ],
        createdAt: '2026-08-24T04:22:37.512Z',
        nonce: 'utSErwuLwgXS1Et-o5HeozQ',
      },
    },
    {
      type: 'migrate',
      data: {
        sourceDid: 'did:cel:uEiBjBg5wDWOZrccLiGvMhhSOUCPcc2zRwzCucjSItNxtgA',
        targetDid: 'did:webvh:QmSA6tmBJb64cWA2VPmpk9vuNo5bk9Qyu51EmyRYuEMoRJ:localhost%3A5173:ueibjbg5wdwozrccligvmhhsoucpcc2zrwzcucjsitnxtga',
        layer: 'webvh',
        domain: 'localhost:5173',
        migratedAt: '2026-08-24T04:22:39.194Z',
      },
    },
  ],
};

/** Keyed by hosted segment, which the refs themselves report. */
const CONTENTS: Record<string, string> = Object.fromEntries(
  hostedResourceRefs(REAL_CEL).map((r) => [r.segment, r.id.endsWith('.json') ? '{}' : '<svg/>'])
);

const ok = <T,>(r: T | { problem: unknown }): T => {
  if (r && typeof r === 'object' && 'problem' in r) {
    throw new Error(`expected an envelope, got problem ${JSON.stringify(r.problem)}`);
  }
  return r as T;
};

describe('resourceKind', () => {
  test('splits media types the way the demo seals them', () => {
    expect(resourceKind('image/svg+xml')).toBe('image');
    expect(resourceKind('application/json')).toBe('data');
    expect(resourceKind('text/plain')).toBe('text');
    expect(resourceKind(undefined)).toBe('data');
  });
});

describe('hostedResourceRefs', () => {
  test('reads the resources genesis sealed', () => {
    expect(hostedResourceRefs(REAL_CEL).map((r) => r.id)).toEqual(['artwork.svg', 'metadata.json']);
    expect(hostedResourceRefs(REAL_CEL).every((r) => r.version === 1)).toBe(true);
  });

  test('empty for no log', () => {
    expect(hostedResourceRefs(null)).toEqual([]);
  });
});

describe('hostedAssetEnvelope', () => {
  test('maps a real hosted CEL into an envelope', () => {
    const { envelope } = ok(hostedAssetEnvelope(REAL_CEL, CONTENTS));
    expect(envelope.format).toBe('originals/asset');
    expect(envelope.resources.map((r) => r.id)).toEqual(['artwork.svg', 'metadata.json']);
    expect(envelope.resources[0].type).toBe('image');
    expect(envelope.resources[0].contentType).toBe('image/svg+xml');
    // digestMultibase -> the hex hash the envelope carries.
    expect(envelope.resources[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(envelope.didDocuments['did:cel']).toBeTruthy();
  });

  test('derives assetDid from the log, never from the page', () => {
    // A tampered cel.json must not be able to point loadAsset at another
    // asset. Re-derived from the genesis event, this reproduces exactly the
    // sourceDid the real migrate event recorded — which is the check: the
    // identifier comes from the log, and the log alone.
    const { envelope } = ok(hostedAssetEnvelope(REAL_CEL, CONTENTS));
    expect(envelope.assetDid).toBe(REAL_CEL.events[1].data!.sourceDid);
    expect(envelope.assetDid).toBe('did:cel:uEiBjBg5wDWOZrccLiGvMhhSOUCPcc2zRwzCucjSItNxtgA');
  });

  describe('refuses rather than guessing', () => {
    const cases: Array<[string, CelLog | null, Record<string, string>, string]> = [
      ['no log at all', null, {}, 'NO_CEL'],
      ['an empty log', { events: [] }, {}, 'NO_CEL'],
      [
        'a log not starting at genesis',
        { events: [REAL_CEL.events[1]] },
        CONTENTS,
        'NO_GENESIS',
      ],
      [
        'a genesis naming no controller',
        { events: [{ ...REAL_CEL.events[0], data: { ...REAL_CEL.events[0].data, controller: undefined } }] },
        CONTENTS,
        'NO_CONTROLLER',
      ],
      [
        'a genesis sealing no resources',
        { events: [{ ...REAL_CEL.events[0], data: { ...REAL_CEL.events[0].data, resources: [] } }] },
        CONTENTS,
        'NO_RESOURCES',
      ],
      [
        'an unreadable digest',
        {
          events: [
            { ...REAL_CEL.events[0], data: { ...REAL_CEL.events[0].data, resources: [{ id: 'x', digestMultibase: 'nonsense', mediaType: 'image/svg+xml' }] } },
          ],
        },
        CONTENTS,
        'BAD_DIGEST',
      ],
      ['resource bytes that would not fetch', REAL_CEL, {}, 'MISSING_CONTENT'],
    ];
    for (const [name, cel, contents, code] of cases) {
      test(name, () => {
        const r = hostedAssetEnvelope(cel, contents);
        expect('problem' in r && r.problem.code).toBe(code);
      });
    }
  });
});

/**
 * The gap itself. Publish an Original, discard every trace of the live object
 * and its keys, then rebuild from the hosted artifacts alone and carry it to
 * did:btco. If the controller key is in custody rather than in a Map, this
 * passes; before the custody change it could not.
 */
describe('hydrate then inscribe', () => {
  async function publishOne() {
    const { KeyManager } = await import('@originals/sdk');
    const controllerKp = await new KeyManager().generateKeyPair('Ed25519');
    const signer = signerFromKeyPair(controllerKp);
    const hosted: Record<string, string> = {};
    const sdk = OriginalsSDK.create({
      network: 'regtest',
      webvhNetwork: 'magby',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: new OrdMockProvider(),
      enableLogging: false,
      signer,
      storageAdapter: {
        async put(_bucket: string, key: string, value: unknown) {
          hosted[key] =
            typeof value === 'string' ? value : new TextDecoder().decode(value as Uint8Array);
          return { url: `https://example.test/${key}` };
        },
        async get() { return null; },
        async delete() { return true; },
      },
    } as unknown as Parameters<typeof OriginalsSDK.create>[0]);

    const artwork = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>';
    const meta = JSON.stringify({ title: 'Resume me' });
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    const asset = await sdk.lifecycle.createAsset([
      { id: 'artwork.svg', type: 'image', content: artwork, contentType: 'image/svg+xml', hash: hex(sha256(new TextEncoder().encode(artwork))), size: artwork.length },
      { id: 'metadata.json', type: 'data', content: meta, contentType: 'application/json', hash: hex(sha256(new TextEncoder().encode(meta))), size: meta.length },
    ]);
    return { sdk, asset, signer };
  }

  test('rebuilds a published Original from its CEL and inscribes it', async () => {
    const { sdk, asset, signer } = await publishOne();

    // What the origin would serve back: the CEL, and the sealed bytes keyed by
    // the digest segment they are hosted under.
    const cel = JSON.parse(JSON.stringify({ events: asset.celLog.events })) as CelLog;
    const contents: Record<string, string> = {};
    for (const ref of hostedResourceRefs(cel)) {
      const live = asset.resources.find(
        (r) => r.id === ref.id && (r.version ?? 1) === ref.version
      );
      contents[ref.segment] = String(live?.content ?? '');
    }

    const { envelope } = ok(hostedAssetEnvelope(cel, contents));

    // A SECOND SDK with no memory of the first — the returning-creator case.
    // It holds the same signer, which is the whole point: custody, not the tab.
    const fresh = OriginalsSDK.create({
      network: 'regtest',
      webvhNetwork: 'magby',
      defaultKeyType: 'Ed25519',
      ordinalsProvider: new OrdMockProvider(),
      enableLogging: false,
      signer,
    } as unknown as Parameters<typeof OriginalsSDK.create>[0]);

    const { asset: revived } = await fresh.lifecycle.loadAsset(envelope);
    expect(revived.id).toBe(asset.id);
    expect(revived.resources.map((r) => r.id).sort()).toEqual(['artwork.svg', 'metadata.json']);

    const before = revived.celLog.events.length;
    await fresh.lifecycle.inscribeOnBitcoin(revived, 7);

    // The migrate event exists, is signed, and the asset reached did:btco.
    expect(revived.currentLayer).toBe('did:btco');
    const events = revived.celLog.events;
    expect(events.length).toBe(before + 1);
    const migrate = events[events.length - 1];
    expect(migrate.type).toBe('migrate');
    expect((migrate.data as { layer?: string }).layer).toBe('btco');
    expect((migrate as { proof?: unknown[] }).proof?.length).toBeGreaterThan(0);
    // Signed by the SAME controller — the custody key, not a new one.
    expect(JSON.stringify(migrate)).toContain(signer.publicKeyMultibase);

    void sdk;
  }, 30_000);
});

/**
 * The bug review caught on #515, pinned so it cannot come back.
 *
 * Reading genesis alone rebuilt a revised Original with only its v1 bytes.
 * `loadAsset` ACCEPTED that — v1 binds to genesis perfectly well, and nothing
 * requires an envelope to carry the latest version — so the failure was
 * silent, and inscribing would have anchored the superseded artwork to Bitcoin
 * permanently. The first assertion below is the one that failed before the fix.
 */
describe('a revised Original', () => {
  test('rebuilds with every version, not just genesis', async () => {
    const { KeyManager } = await import('@originals/sdk');
    const { sha256 } = await import('@noble/hashes/sha2.js');
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    const kp = await new KeyManager().generateKeyPair('Ed25519');
    const signer = signerFromKeyPair(kp);
    const sdk = OriginalsSDK.create({
      network: 'regtest', webvhNetwork: 'magby', defaultKeyType: 'Ed25519',
      ordinalsProvider: new OrdMockProvider(), enableLogging: false, signer,
      storageAdapter: {
        async put(_b: string, k: string) { return { url: `https://example.test/${k}` }; },
        async get() { return null; },
        async delete() { return true; },
      },
    } as unknown as Parameters<typeof OriginalsSDK.create>[0]);

    const v1 = '<svg id="v1"/>';
    const asset = await sdk.lifecycle.createAsset([
      { id: 'artwork.svg', type: 'image', content: v1, contentType: 'image/svg+xml', hash: hex(sha256(new TextEncoder().encode(v1))), size: v1.length },
    ]);
    const v2 = '<svg id="v2-revised"/>';
    await asset.addResourceVersion('artwork.svg', v2, 'image/svg+xml', hex(sha256(new TextEncoder().encode(v2))));

    const cel = JSON.parse(JSON.stringify({ events: asset.celLog.events })) as CelLog;
    const refs = hostedResourceRefs(cel);
    expect(refs.map((r) => r.version)).toEqual([1, 2]);

    const contents = Object.fromEntries(refs.map((r) => [r.segment, r.version === 1 ? v1 : v2]));
    const { envelope } = ok(hostedAssetEnvelope(cel, contents));

    const fresh = OriginalsSDK.create({
      network: 'regtest', webvhNetwork: 'magby', defaultKeyType: 'Ed25519',
      ordinalsProvider: new OrdMockProvider(), enableLogging: false, signer,
    } as unknown as Parameters<typeof OriginalsSDK.create>[0]);
    const { asset: revived } = await fresh.lifecycle.loadAsset(envelope);

    // The revised bytes are what a later inscription must anchor.
    const versions = revived.resources.filter((r) => r.id === 'artwork.svg');
    expect(versions.map((r) => r.version ?? 1).sort()).toEqual([1, 2]);
    expect(versions.find((r) => (r.version ?? 1) === 2)?.content).toBe(v2);
  }, 30_000);

  test('reports a version whose bytes will not load, rather than dropping it', () => {
    const cel: CelLog = {
      events: [
        REAL_CEL.events[0],
        { type: 'update', data: { resourceId: 'artwork.svg', contentType: 'image/svg+xml', toHash: 'aa'.repeat(32), toVersion: 2 } },
      ],
    };
    // Genesis bytes present, the v2 bytes missing: silently anchoring v1 is
    // exactly the failure this guards.
    const partial = Object.fromEntries(
      hostedResourceRefs(cel).filter((r) => r.version === 1).map((r) => [r.segment, '<svg/>'])
    );
    const r = hostedAssetEnvelope(cel, partial);
    expect('problem' in r && r.problem.code).toBe('MISSING_CONTENT');
    expect('problem' in r && r.problem.message).toContain('v2');
  });
});
