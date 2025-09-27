import { BtcoDidResolver, type ResourceProviderLike } from '../../src/did/BtcoDidResolver';

describe('BtcoDidResolver invalid doc @context branch', () => {
  test('metadata without did context fails validation', async () => {
    const provider: ResourceProviderLike = {
      async getSatInfo() { return { inscription_ids: ['ins-1'] }; },
      async resolveInscription(id: string) { return { id, sat: 0, content_type: 'text/plain', content_url: 'http://c/' + id }; },
      async getMetadata() { return { '@context': ['https://example.org/other'], id: 'did:btco:1' } as any; }
    };
    const originalFetch = global.fetch as any;
    (global as any).fetch = async () => ({ ok: true, text: async () => 'BTCO DID: did:btco:1' });
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:1');
    expect(res.inscriptions?.[0].error).toContain('Invalid DID document');
    (global as any).fetch = originalFetch;
  });
});

