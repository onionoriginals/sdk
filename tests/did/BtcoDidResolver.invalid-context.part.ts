import { BtcoDidResolver, type ResourceProviderLike } from '../../src/did/BtcoDidResolver';

describe('BtcoDidResolver invalid @context branch', () => {
  const provider: ResourceProviderLike = {
    async getSatInfo() { return { inscription_ids: ['i1'] }; },
    async resolveInscription(id: string) { return { id, sat: 0, content_type: 'text/plain', content_url: 'http://c/' + id }; },
    async getMetadata() { return { '@context': ['https://example.org/other'], id: 'did:btco:1' }; }
  };

  const originalFetch = global.fetch as any;
  beforeEach(() => {
    (global as any).fetch = jest.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => 'BTCO DID: did:btco:1' }));
  });
  afterAll(() => { (global as any).fetch = originalFetch; });

  test('filters out invalid contexts', async () => {
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:1');
    expect(res.didDocument).toBeNull();
  });
});

