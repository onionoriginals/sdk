import { BtcoDidResolver, type ResourceProviderLike } from '../../src/did/BtcoDidResolver';

describe('BtcoDidResolver deactivation preserves an existing error', () => {
  test('error is not overwritten when content has flame and prior error set', async () => {
    const provider: ResourceProviderLike = {
      async getSatInfo() { return { inscription_ids: ['a'] } as any; },
      async resolveInscription(id: string) { return { id, sat: 0, content_type: 'text/plain', content_url: 'http://c/' + id }; },
      async getMetadata() {
        // Provide metadata so that isValidDid && metadata path is taken, but with invalid/mismatched DID
        return { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:999' } as any;
      }
    };
    const r = new BtcoDidResolver({ provider });
    const originalFetch = global.fetch as any;
    (global as any).fetch = async () => ({ ok: true, text: async () => 'BTCO DID: did:btco:1 🔥' }) as any;
    const res = await r.resolve('did:btco:1');
    (global as any).fetch = originalFetch;
    const entry = res.inscriptions![0];
    expect(entry.didDocument).toBeNull();
    // Since an error was set due to invalid/mismatched DID, it should remain after deactivation branch
    expect(entry.error).toBe('Invalid DID document structure or mismatched ID');
  });
});

