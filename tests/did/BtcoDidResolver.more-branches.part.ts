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

  test('resolveInscription throws -> caught as process error', async () => {
    const provider: ResourceProviderLike = {
      async getSatInfo() { return { inscription_ids: ['x'] } as any; },
      async resolveInscription() { throw new Error('boom'); },
      async getMetadata() { return null as any; }
    };
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:1');
    expect(res.inscriptions?.[0].error).toContain('Failed to process inscription');
  });

  test('getSatInfo throws non-Error -> uses String(e) branch', async () => {
    const provider: ResourceProviderLike = {
      async getSatInfo() { throw 5 as any; },
      async resolveInscription(id: string) { return { id, sat: 0, content_type: 'text/plain', content_url: 'http://c/' + id }; },
      async getMetadata() { return null as any; }
    };
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:1');
    expect(res.resolutionMetadata.message).toContain('5');
  });

  test('fetch throws non-Error -> uses String(err) branch', async () => {
    const provider: ResourceProviderLike = {
      async getSatInfo() { return { inscription_ids: ['x'] } as any; },
      async resolveInscription(id: string) { return { id, sat: 0, content_type: 'text/plain', content_url: 'http://c/' + id }; },
      async getMetadata() { return null as any; }
    };
    const originalFetch = global.fetch as any;
    (global as any).fetch = async () => { throw 7 as any; };
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:1');
    expect(res.inscriptions?.[0].error).toContain('7');
    (global as any).fetch = originalFetch;
  });

  test('process inscription catch non-Error -> String(err) branch', async () => {
    const provider: ResourceProviderLike = {
      async getSatInfo() { return { inscription_ids: ['x'] } as any; },
      async resolveInscription() { throw 'oops' as any; },
      async getMetadata() { return null as any; }
    };
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:1');
    expect(res.inscriptions?.[0].error).toContain('oops');
  });
});

// keep single import; duplicate removed

describe('BtcoDidResolver isValidDidDocument branches', () => {
  const resolver: any = new BtcoDidResolver({} as any);

  test('rejects non-object', () => {
    expect(resolver['isValidDidDocument'](null)).toBe(false);
    expect(resolver['isValidDidDocument']('x')).toBe(false);
  });

  test('rejects missing id or non-string id', () => {
    expect(resolver['isValidDidDocument']({ '@context': ['https://www.w3.org/ns/did/v1'] })).toBe(false);
    expect(resolver['isValidDidDocument']({ '@context': ['https://www.w3.org/ns/did/v1'], id: 123 })).toBe(false);
  });

  test('rejects missing @context and unsupported context', () => {
    expect(resolver['isValidDidDocument']({ id: 'did:btco:1' })).toBe(false);
    expect(resolver['isValidDidDocument']({ id: 'did:btco:1', '@context': ['https://example.org/not-did'] })).toBe(false);
  });

  test('rejects non-array verificationMethod/authentication', () => {
    const base = { id: 'did:btco:1', '@context': ['https://www.w3.org/ns/did/v1'] } as any;
    expect(resolver['isValidDidDocument']({ ...base, verificationMethod: {} })).toBe(false);
    expect(resolver['isValidDidDocument']({ ...base, authentication: {} })).toBe(false);
  });
});

