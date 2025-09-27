import { BtcoDidResolver, type ResourceProviderLike } from '../../src/did/BtcoDidResolver';

const makeProvider = (overrides: Partial<ResourceProviderLike> = {}): ResourceProviderLike => ({
  async getSatInfo(_sat: string) { return { inscription_ids: ['ins-1'] }; },
  async resolveInscription(id: string) { return { id, sat: 0, content_type: 'text/plain', content_url: 'http://c/' + id }; },
  async getMetadata(_id: string) { return { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:1' }; },
  ...overrides
});

describe('BtcoDidResolver branches', () => {
  const originalFetch = global.fetch as any;
  beforeEach(() => {
    (global as any).fetch = jest.fn(async (url: string) => ({ ok: true, status: 200, statusText: 'OK', text: async () => `BTCO DID: did:btco:1` }));
  });
  afterAll(() => {
    (global as any).fetch = originalFetch;
  });

  test('invalid DID format', async () => {
    const r = new BtcoDidResolver();
    const res = await r.resolve('did:wrong:123');
    expect(res.didDocument).toBeNull();
    expect(res.resolutionMetadata?.error).toBe('invalidDid');
  });

  test('no provider supplied', async () => {
    const r = new BtcoDidResolver();
    const res = await r.resolve('did:btco:1');
    expect(res.resolutionMetadata?.error).toBe('noProvider');
  });

  test('provider getSatInfo throws', async () => {
    const provider = makeProvider({ getSatInfo: async () => { throw new Error('boom'); } });
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:1');
    expect(res.resolutionMetadata?.error).toBe('notFound');
  });

  test('no inscriptions found', async () => {
    const provider = makeProvider({ getSatInfo: async () => ({ inscription_ids: [] }) });
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:1');
    expect(res.resolutionMetadata?.error).toBe('notFound');
  });

  test('resolveInscription undefined', async () => {
    const provider = makeProvider({ resolveInscription: async () => undefined as any });
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:1');
    expect(res.inscriptions?.[0].error).toContain('not found');
  });

  test('fetch not ok', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: false, status: 500, statusText: 'ERR', text: async () => '' }));
    const provider = makeProvider();
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:1');
    expect(res.inscriptions?.[0].error).toContain('Failed to fetch content');
  });

  test('metadata throws and content does not match pattern', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => 'hello world' }));
    const provider = makeProvider({ getMetadata: async () => { throw new Error('x'); } });
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:1');
    expect(res.didDocument).toBeNull();
  });

  test('valid did doc selected as latest and network prefixes', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => 'BTCO DID: did:btco:test:2' }));
    const provider = makeProvider({
      getSatInfo: async () => ({ inscription_ids: ['ins-a', 'ins-b'] }),
      getMetadata: async (id: string) => ({ '@context': ['https://www.w3.org/ns/did/v1'], id: id === 'ins-b' ? 'did:btco:test:2' : 'did:btco:test:999' })
    });
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:test:2');
    expect(res.didDocument?.id).toBe('did:btco:test:2');
    expect(res.resolutionMetadata.network).toBe('test');
  });

  test('deactivated content with flame emoji', async () => {
    (global as any).fetch = jest.fn(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '🔥' }));
    const provider = makeProvider();
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:1');
    expect(res.inscriptions?.[0].error).toContain('deactivated');
  });
});

