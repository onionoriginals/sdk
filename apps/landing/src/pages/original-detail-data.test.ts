import { describe, test, expect } from 'bun:test';
import {
  webvhArtifacts,
  celTimeline,
  celCustody,
  celResources,
  parseDidLog,
  didLogSummary,
  digestMultibaseSha256Hex,
  sha256HexToResourceMultibase,
  sameOriginUrl,
  detailMode,
  type CelLog
} from './original-detail-data';

const DID = 'did:webvh:QmScid:demo.example.com:user-abc:asset-1';

// Shaped like a real published Original's cel.json (see public/example/cel-log.json).
const cel: CelLog = {
  events: [
    {
      type: 'create',
      data: {
        controller: 'did:key:z6MkhhHvRLSgmvgneytgm64PBFzgrr1maxVjEgCr4gWGZ85p',
        createdAt: '2026-07-16T05:56:22.011Z',
        name: 'artwork.svg',
        resources: [
          { id: 'artwork.svg', mediaType: 'image/svg+xml', digestMultibase: 'uEiDdigest1' },
          { id: 'metadata.json', mediaType: 'application/json', digestMultibase: 'uEiDdigest2' }
        ]
      },
      proof: [
        {
          created: '2026-07-16T05:56:22.038Z',
          cryptosuite: 'eddsa-jcs-2022',
          proofValue: 'z2nTv6dFXWK9…',
          type: 'DataIntegrityProof',
          verificationMethod: 'did:key:z6Mkhh…#z6Mkhh…'
        }
      ]
    },
    {
      type: 'migrate',
      data: {
        domain: 'demo.example.com',
        layer: 'webvh',
        migratedAt: '2026-07-16T05:56:22.053Z',
        sourceDid: 'did:cel:uEiD6909LPnH10_myIoEODhInq6jVmhbAl0hR_i0bpUpDKQ',
        targetDid: DID
      },
      proof: [{ cryptosuite: 'eddsa-jcs-2022', proofValue: 'z47VVZi…' }],
      previousEvent: 'uEiD6909…'
    }
  ]
};

describe('webvhArtifacts', () => {
  test('derives artifact URLs from a pathed DID', () => {
    const arts = webvhArtifacts(DID);
    expect(arts).not.toBeNull();
    expect(arts!.host).toBe('demo.example.com');
    expect(arts!.logUrl).toBe('https://demo.example.com/user-abc/asset-1/did.jsonl');
    expect(arts!.celUrl).toBe('https://demo.example.com/user-abc/asset-1/cel.json');
    expect(arts!.resourceUrl('uEiDx')).toBe('https://demo.example.com/user-abc/asset-1/resources/uEiDx');
  });
  test('same-host URLs are origin-relative (works over dev http)', () => {
    const arts = webvhArtifacts(DID, 'demo.example.com');
    expect(arts!.logUrl).toBe('/user-abc/asset-1/did.jsonl');
    expect(arts!.resourceUrl('uEiDx')).toBe('/user-abc/asset-1/resources/uEiDx');
  });
  test('decodes percent-encoded hosts (dev origins include a port)', () => {
    const arts = webvhArtifacts('did:webvh:QmS:localhost%3A3000:studio:you', 'localhost:3000');
    expect(arts!.host).toBe('localhost:3000');
    expect(arts!.logUrl).toBe('/studio/you/did.jsonl');
  });
  test('domain-root DIDs resolve under .well-known', () => {
    const arts = webvhArtifacts('did:webvh:QmS:demo.example.com');
    expect(arts!.logUrl).toBe('https://demo.example.com/.well-known/did.jsonl');
  });
  test('null for non-webvh DIDs', () => {
    expect(webvhArtifacts('did:cel:uEiDabc')).toBeNull();
    expect(webvhArtifacts('not-a-did')).toBeNull();
  });
});

describe('celTimeline', () => {
  test('folds create + webvh migrate into done steps, btco stays upcoming', () => {
    const steps = celTimeline(cel);
    expect(steps.map((s) => s.id)).toEqual(['create', 'publish', 'inscribe']);
    expect(steps[0].state).toBe('done');
    expect(steps[0].at).toBe('2026-07-16T05:56:22.011Z');
    expect(steps[0].proof?.cryptosuite).toBe('eddsa-jcs-2022');
    expect(steps[0].facts.some((f) => f.label === 'Signed by')).toBe(true);
    expect(steps[1].state).toBe('done');
    expect(steps[1].facts.find((f) => f.label === 'Published as')?.value).toBe(DID);
    expect(steps[2].state).toBe('upcoming');
    expect(steps[2].at).toBeUndefined();
  });
  test('every step upcoming when there is no log', () => {
    const steps = celTimeline(null);
    expect(steps.every((s) => s.state === 'upcoming')).toBe(true);
  });
});

describe('celResources', () => {
  test('returns the resources sealed at genesis', () => {
    const res = celResources(cel);
    expect(res.map((r) => r.id)).toEqual(['artwork.svg', 'metadata.json']);
  });
  test('empty without a create event', () => {
    expect(celResources(null)).toEqual([]);
    expect(celResources({ events: [] })).toEqual([]);
  });
});

describe('parseDidLog / didLogSummary', () => {
  const line1 = JSON.stringify({
    versionId: '1-QmV1',
    versionTime: '2026-07-16T05:56:22Z',
    parameters: { scid: 'QmScid', updateKeys: ['z6MkKeyA'] },
    state: {
      id: DID,
      verificationMethod: [{ id: '#key-0', type: 'Multikey', publicKeyMultibase: 'z6MkKeyA' }]
    }
  });
  const line2 = JSON.stringify({
    versionId: '2-QmV2',
    versionTime: '2026-07-17T00:00:00Z',
    parameters: {},
    state: {
      id: DID,
      verificationMethod: [{ id: '#key-1', type: 'Multikey', publicKeyMultibase: 'z6MkKeyB' }]
    }
  });

  test('parses one JSON entry per non-empty line', () => {
    expect(parseDidLog(`${line1}\n${line2}\n`)).toHaveLength(2);
  });

  test('summary carries parameters forward and takes the last state', () => {
    const summary = didLogSummary(parseDidLog(`${line1}\n${line2}`));
    expect(summary).not.toBeNull();
    expect(summary!.versions).toBe(2);
    expect(summary!.scid).toBe('QmScid');
    expect(summary!.updateKeys).toEqual(['z6MkKeyA']);
    expect(summary!.did).toBe(DID);
    expect(summary!.createdAt).toBe('2026-07-16T05:56:22Z');
    expect(summary!.updatedAt).toBe('2026-07-17T00:00:00Z');
    expect(summary!.verificationMethods[0]?.publicKeyMultibase).toBe('z6MkKeyB');
  });

  test('null summary for an empty log', () => {
    expect(didLogSummary([])).toBeNull();
  });
});

describe('digestMultibaseSha256Hex', () => {
  // Real pair from the shipped example: cel-log.json's digestMultibase for
  // artwork.svg vs manifest.json's declared sha-256 hex.
  test('decodes a real sha2-256 multihash digest', () => {
    expect(digestMultibaseSha256Hex('uEiDq42LG0UdTeZMLYrsckqR3sn7DCIZuAV6nnKrn11NgWg')).toBe(
      'eae362c6d1475379930b62bb1c92a477b27ec308866e015ea79caae7d753605a'
    );
  });
  test('null for a non-u multibase or a non-sha2-256 multihash', () => {
    expect(digestMultibaseSha256Hex('zQmNotBase64url')).toBeNull();
    expect(digestMultibaseSha256Hex('uAAA')).toBeNull();
  });
});

describe('sha256HexToResourceMultibase', () => {
  // Real pair from a live publish: resource.hash hex vs the multibase segment
  // LifecycleManager.publishResources hosts the bytes under.
  test('encodes a raw sha-256 as the hosted base64url multibase', () => {
    expect(
      sha256HexToResourceMultibase('5d53804fc73b572e35ddbe52354379ef11b2ac295b92d84c1589bd473700d3e0')
    ).toBe('uXVOAT8c7Vy413b5SNUN57xGyrClbkthMFYm9RzcA0-A');
  });
  test('null for a non-sha-256 hex', () => {
    expect(sha256HexToResourceMultibase('abc')).toBeNull();
    expect(sha256HexToResourceMultibase('not-hex')).toBeNull();
  });
});

describe('sameOriginUrl', () => {
  test('relativizes a same-host https URL (works over dev http)', () => {
    expect(sameOriginUrl('https://demo.test/a/resources/uX', 'demo.test')).toBe('/a/resources/uX');
  });
  test('passes foreign hosts and non-URLs through unchanged', () => {
    expect(sameOriginUrl('https://other.test/a', 'demo.test')).toBe('https://other.test/a');
    expect(sameOriginUrl('not-a-url', 'demo.test')).toBe('not-a-url');
    expect(sameOriginUrl('https://demo.test/a')).toBe('https://demo.test/a');
  });
});

describe('detailMode', () => {
  const row = { did: DID, title: 'T', resourceHash: 'h', createdAt: '2026-07-21T00:00:00Z' };
  // R20: a deep link or hard refresh must not flash the signed-out state at a
  // signed-in user while `fetchMe()` is still in flight.
  test('loading while auth itself is still resolving — never signed-out', () => {
    expect(detailMode({ authLoading: true, authenticated: false, loaded: false, row: null })).toBe(
      'loading'
    );
  });
  test('signed-out only once auth resolved', () => {
    expect(detailMode({ authLoading: false, authenticated: false, loaded: true, row })).toBe(
      'signed-out'
    );
  });
  test('loading until the fetch settles', () => {
    expect(detailMode({ authLoading: false, authenticated: true, loaded: false, row: null })).toBe(
      'loading'
    );
  });
  test('not-found when the DID is not among the user\u2019s Originals', () => {
    expect(detailMode({ authLoading: false, authenticated: true, loaded: true, row: null })).toBe(
      'not-found'
    );
  });
  test('ready with a row', () => {
    expect(detailMode({ authLoading: false, authenticated: true, loaded: true, row })).toBe('ready');
  });
});

describe('celCustody (item 5: the custody chain, folded from the CEL)', () => {
  const CREATOR = 'did:key:z6MkCreatorX';
  const HOLDER = 'did:key:z6MkHolderY';
  const log = (events: unknown[]) => ({ events }) as never;

  test('a post-anchor non-lineage update folds into custody; creator entries never do', () => {
    const rows = celCustody(log([
      { type: 'create', data: { controller: CREATOR, resources: [] } },
      { type: 'migrate', data: { layer: 'btco', to: 'did:btco:reg:1' } },
      { type: 'update', data: { author: CREATOR, name: 'renamed' } },
      { type: 'update', data: { author: HOLDER, statement: 'held it', occurredAt: 't1' } },
    ]));
    expect(rows).toEqual([{ author: HOLDER, statement: 'held it', occurredAt: 't1', eventIndex: 3 }]);
  });

  test('pre-anchor updates are never custody, and a pre-anchor rotation extends the lineage', () => {
    const ROTATED = 'did:key:z6MkRotatedZ';
    const rows = celCustody(log([
      { type: 'create', data: { controller: CREATOR, resources: [] } },
      { type: 'update', data: { name: 'pre-anchor rename' }, proof: [{ verificationMethod: `${CREATOR}#k` }] },
      { type: 'rotateKey', data: { newController: ROTATED } },
      { type: 'migrate', data: { layer: 'btco', to: 'did:btco:reg:1' } },
      { type: 'update', data: { author: ROTATED, name: 'post-anchor, still creator lineage' } },
    ]));
    expect(rows).toEqual([]);
  });

  test('an authorless post-anchor update is custody with the unverified-author placeholder', () => {
    const rows = celCustody(log([
      { type: 'create', data: { controller: CREATOR, resources: [] } },
      { type: 'migrate', data: { layer: 'btco', to: 'did:btco:reg:1' } },
      { type: 'update', data: { statement: 'no author' } },
    ]));
    expect(rows).toHaveLength(1);
    expect(rows[0].author).toBe('(unverified author)');
  });

  test('a null log folds to no custody', () => {
    expect(celCustody(null)).toEqual([]);
  });
});
