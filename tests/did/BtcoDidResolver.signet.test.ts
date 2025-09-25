import { BtcoDidResolver, type ResourceProviderLike } from '../../src/did/BtcoDidResolver';

describe('BtcoDidResolver signet and error branches', () => {
  const originalFetch = global.fetch as any;
  beforeEach(() => {
    (global as any).fetch = jest.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => 'BTCO DID: did:btco:sig:3' }));
  });
  afterAll(() => {
    (global as any).fetch = originalFetch;
  });

  const providerOk: ResourceProviderLike = {
    async getSatInfo() { return { inscription_ids: ['i1'] }; },
    async resolveInscription(id: string) { return { id, sat: 0, content_type: 'text/plain', content_url: 'http://c/' + id }; },
    async getMetadata() { return { '@context': 'https://w3id.org/did/v1', id: 'did:btco:sig:3' }; }
  };

  test('signet prefix resolution and w3id context accepted', async () => {
    const r = new BtcoDidResolver({ provider: providerOk });
    const res = await r.resolve('did:btco:sig:3');
    expect(res.didDocument?.id).toBe('did:btco:sig:3');
  });

  test('resolveInscription throws -> inscription error path', async () => {
    const providerErr: ResourceProviderLike = {
      async getSatInfo() { return { inscription_ids: ['i1'] }; },
      async resolveInscription() { throw new Error('bad'); },
      async getMetadata() { return null as any; }
    };
    const r = new BtcoDidResolver({ provider: providerErr });
    const res = await r.resolve('did:btco:sig:3');
    expect(res.inscriptions?.[0].error).toContain('Failed to process inscription');
  });
});

