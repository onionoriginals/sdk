import { BtcoDidResolver, type ResourceProviderLike } from '../../src/did/BtcoDidResolver';

describe('BtcoDidResolver more branches', () => {
  const originalFetch = global.fetch as any;
  afterEach(() => { (global as any).fetch = originalFetch; });

  test('parseBtcoDid invalid returns error via resolve', async () => {
    const r = new BtcoDidResolver({ provider: { getSatInfo: async () => ({ inscription_ids: [] }), resolveInscription: async () => ({} as any), getMetadata: async () => null } });
    const res = await r.resolve('did:btco:abc');
    expect(res.resolutionMetadata.error).toBe('invalidDid');
  });

  test('getSatInfo returns inscription_ids property missing -> empty handled', async () => {
    const provider: ResourceProviderLike = {
      async getSatInfo() { return {} as any; },
      async resolveInscription(id: string) { return { id, sat: 0, content_type: 'text/plain', content_url: 'http://c/' + id }; },
      async getMetadata() { return null as any; }
    };
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:1');
    expect(res.resolutionMetadata.error).toBe('notFound');
  });
});

