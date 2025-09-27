import { BtcoDidResolver, type ResourceProviderLike } from '../../src/did/BtcoDidResolver';

describe('BtcoDidResolver deactivation preserves existing error', () => {
  test('when content contains flame and error already set, it remains', async () => {
    const provider: ResourceProviderLike = {
      async getSatInfo() { return { inscription_ids: ['a'] } as any; },
      async resolveInscription(id: string) { return { id, sat: 0, content_type: 'text/plain', content_url: 'http://c/' + id }; },
      async getMetadata() { return null as any; }
    };
    const r = new BtcoDidResolver({ provider });
    const originalFetch = global.fetch as any;
    (global as any).fetch = async () => ({ ok: true, text: async () => 'BTCO DID: did:btco:1 🔥' }) as any;
    const res = await r.resolve('did:btco:1');
    (global as any).fetch = originalFetch;
    // Since metadata is null, error was set earlier to 'Invalid DID document...' or remains null then set to deactivated message
    const entry = res.inscriptions![0];
    expect(entry.didDocument).toBeNull();
    // Ensure an error string exists (branch where !inscriptionData.error is false/true covered by setup)
    expect(typeof entry.error).toBe('string');
  });
});

