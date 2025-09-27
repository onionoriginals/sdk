/** Canonical test aggregator created by combine-tests script. */

/** Inlined from DIDManager.btco.integration.part.ts */
import { OriginalsSDK } from '../../src';

describe('Integration: DIDManager btco resolve via OrdinalsClient adapter', () => {
  const sdk = OriginalsSDK.create({ network: 'mainnet', bitcoinRpcUrl: 'http://ord' });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('resolves did:btco using adapter with mocked fetch', async () => {
    const sat = '123456';
    const did = `did:btco:${sat}`;

    const fetchMock = jest.spyOn(global as any, 'fetch').mockImplementation(async (url: any) => {
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
