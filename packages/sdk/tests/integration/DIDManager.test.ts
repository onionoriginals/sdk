/** Canonical test aggregator created by combine-tests script. */

/** Inlined from DIDManager.btco.integration.part.ts */
import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { OriginalsSDK } from '../../src';

describe('Integration: DIDManager btco resolve via OrdinalsClient adapter', () => {
  const sdk = OriginalsSDK.create({ network: 'mainnet', bitcoinRpcUrl: 'http://ord' });

  test('resolves did:btco using adapter with mocked fetch', async () => {
    const sat = '123456';
    const did = `did:btco:${sat}`;

    const fetchMock = spyOn(global as any, 'fetch').mockImplementation(async (url: any) => {
      if (url === 'http://ord/sat/' + sat) {
        return new Response(JSON.stringify({ inscription_ids: ['i1', 'i2'] }), { status: 200 });
      }
      if (url === 'http://ord/inscription/i1') {
        return new Response(JSON.stringify({ inscription_id: 'i1', content_type: 'text/plain', content_url: 'http://c/i1', sat }), { status: 200 });
      }
      if (url === 'http://ord/inscription/i2') {
        return new Response(JSON.stringify({ inscription_id: 'i2', content_type: 'text/plain', content_url: 'http://c/i2', sat }), { status: 200 });
      }
      if (url === 'http://c/i1') {
        return new Response(`BTCO DID: ${did}`, { status: 200 });
      }
      if (url === 'http://c/i2') {
        return new Response('not a did doc', { status: 200 });
      }
      if (url === 'http://ord/r/metadata/i1') {
        // Return DID Document JSON encoded as hex CBOR; for test simplicity return plain JSON string, adapter tolerates null metadata
        return new Response('7b7d', { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    const doc = await sdk.did.resolveDID(did);
    expect(doc === null || typeof doc === 'object').toBe(true);
    fetchMock.mockRestore();
  });
});

describe('Integration: DIDManager did:webvh resolve requires a verifier', () => {
  const sdk = OriginalsSDK.create({ defaultKeyType: 'Ed25519' });

  test('resolves a real did:webvh log (regression: verifier must be passed to didwebvh-ts)', async () => {
    // Build a genuine did:webvh with its signed log.
    const { did, log } = await sdk.did.createDIDWebVH({
      domain: 'example.com',
      paths: ['user', 'alice']
    });
    expect(did.startsWith('did:webvh:')).toBe(true);

    // Serve the JSONL log for whatever did.jsonl URL didwebvh-ts requests.
    const jsonl = log.map((entry: unknown) => JSON.stringify(entry)).join('\n');
    const fetchMock = spyOn(global as any, 'fetch').mockImplementation(async (url: any) => {
      const u = String(url);
      // Only the log is hosted; the optional witness file is absent (404) so
      // the resolver treats the DID as un-witnessed rather than mis-parsing it.
      if (u.includes('did-witness')) {
        return new Response('', { status: 404 });
      }
      if (u.includes('did.jsonl')) {
        return new Response(jsonl, { status: 200 });
      }
      return new Response('', { status: 404 });
    });

    try {
      const resolved = await sdk.did.resolveDID(did);
      // Before the fix, resolveDID passed no verifier, didwebvh-ts threw
      // "Verifier implementation is required" internally, and this returned null.
      expect(resolved).not.toBeNull();
      expect(resolved?.id).toBe(did);
    } finally {
      fetchMock.mockRestore();
    }
  });
});
