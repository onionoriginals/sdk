import { BtcoDidResolver } from '../../src/did/BtcoDidResolver';

class MockProvider {
  constructor(private inscriptions: Record<string, { content: string; content_type?: string; metadata?: any }>, private satToIds: Record<string, string[]>) {}

  async getSatInfo(satNumber: string): Promise<{ inscription_ids: string[] }> {
    return { inscription_ids: this.satToIds[satNumber] || [] };
  }
  async resolveInscription(inscriptionId: string) {
    const insc = this.inscriptions[inscriptionId];
    if (!insc) throw new Error('not found');
    return {
      id: inscriptionId,
      sat: 0,
      content_type: insc.content_type || 'text/plain',
      content_url: `https://example.com/${inscriptionId}`
    };
  }
  async getMetadata(inscriptionId: string) {
    return this.inscriptions[inscriptionId]?.metadata ?? null;
  }
}

describe('BtcoDidResolver', () => {
  it('returns error for invalid did', async () => {
    const r = new BtcoDidResolver();
    const res = await r.resolve('did:bad:123');
    expect(res.didDocument).toBeNull();
    expect(res.resolutionMetadata.error).toBe('invalidDid');
  });

  it('resolves latest valid DID document on sat', async () => {
    const sat = '12345';
    const did = `did:btco:${sat}`;
    const doc = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: did
    };
    const provider = new MockProvider(
      {
        a: { content: `BTCO DID: ${did}`, metadata: doc },
        b: { content: 'not a did' }
      },
      { [sat]: ['b', 'a'] }
    );

    // mock global fetch
    const originalFetch = global.fetch as any;
    (global as any).fetch = async (url: string) => {
      const id = url.split('/').pop() as string;
      const content = provider['inscriptions'][id]?.content || '';
      return { ok: true, text: async () => content } as any;
    };

    const resolver = new BtcoDidResolver({ provider });
    const res = await resolver.resolve(did);

    expect(res.didDocument?.id).toBe(did);
    expect(res.inscriptions?.length).toBe(2);
    expect(res.resolutionMetadata.totalInscriptions).toBe(2);

    (global as any).fetch = originalFetch;
  });

  it('handles deactivated DID marker', async () => {
    const sat = '9';
    const did = `did:btco:${sat}`;
    const provider = new MockProvider(
      {
        x: { content: `BTCO DID: ${did} 🔥`, metadata: { '@context': ['https://www.w3.org/ns/did/v1'], id: did } }
      },
      { [sat]: ['x'] }
    );

    const originalFetch = global.fetch as any;
    (global as any).fetch = async () => ({ ok: true, text: async () => `BTCO DID: ${did} 🔥` }) as any;

    const resolver = new BtcoDidResolver({ provider });
    const res = await resolver.resolve(did);
    expect(res.didDocument).toBeNull();
    expect(res.inscriptions?.[0].error).toMatch(/deactivated/);

    (global as any).fetch = originalFetch;
  });
});

