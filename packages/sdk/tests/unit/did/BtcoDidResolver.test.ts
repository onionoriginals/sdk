import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { BtcoDidResolver } from '../../../src/did/BtcoDidResolver';
import type { ResourceProviderLike, BtcoInscriptionData } from '../../../src/did/BtcoDidResolver';
import type { DIDDocument } from '../../../src/types/did';

describe('BtcoDidResolver', () => {
  let provider: ResourceProviderLike;
  let originalFetch: any;

  beforeEach(() => {
    provider = {
      getSatInfo: mock(),
      resolveInscription: mock(),
      getMetadata: mock()
    };
    originalFetch = (global as any).fetch;
    (global as any).fetch = mock();
  });

  afterEach(() => {
    (global as any).fetch = originalFetch;
  });

  test('invalid DID format path', async () => {
    const resolver = new BtcoDidResolver();
    const res = await resolver.resolve('did:btc:123');
    expect(res.didDocument).toBeNull();
    expect(res.resolutionMetadata.error).toBe('invalidDid');
    expect(res.resolutionMetadata.message).toMatch(/Invalid BTCO DID format/);
  });

  test('missing provider path', async () => {
    const resolver = new BtcoDidResolver();
    const res = await resolver.resolve('did:btco:123');
    expect(res.didDocument).toBeNull();
    expect(res.resolutionMetadata.error).toBe('notFound');
    expect(res.resolutionMetadata.message).toBe('No provider supplied');
  });

  test('returns representationNotSupported for unsupported accept header', async () => {
    const resolver = new BtcoDidResolver({ provider });
    const res = await resolver.resolve('did:btco:123', { accept: 'application/did+ld+json' });
    expect(res.didDocument).toBeNull();
    expect(res.resolutionMetadata.error).toBe('representationNotSupported');
  });

  test('returns representationNotSupported for DID URL path dereference', async () => {
    const resolver = new BtcoDidResolver({ provider });
    const res = await resolver.resolve('did:btco:123/some/path');
    expect(res.didDocument).toBeNull();
    expect(res.resolutionMetadata.error).toBe('representationNotSupported');
  });

  test('provider.getSatInfo failure path', async () => {
    provider.getSatInfo.mockRejectedValue(new Error('boom'));
    const resolver = new BtcoDidResolver({ provider });
    const res = await resolver.resolve('did:btco:100');
    expect(res.didDocument).toBeNull();
    expect(res.resolutionMetadata.error).toBe('notFound');
    expect(res.resolutionMetadata.message).toMatch('Failed to retrieve inscriptions for satoshi 100: boom');
  });

  test('zero inscriptions path', async () => {
    provider.getSatInfo.mockResolvedValue({ inscription_ids: [] });
    const resolver = new BtcoDidResolver({ provider });
    const res = await resolver.resolve('did:btco:101');
    expect(res.didDocument).toBeNull();
    expect(res.resolutionMetadata.error).toBe('notFound');
    expect(res.resolutionMetadata.message).toBe('No inscriptions found on satoshi 101');
  });

  test('fetch content HTTP error path', async () => {
    const inscriptionId = 'insc1';
    provider.getSatInfo.mockResolvedValue({ inscription_ids: [inscriptionId] });
    provider.resolveInscription.mockResolvedValue({
      id: inscriptionId,
      sat: 100,
      content_type: 'text/plain',
      content_url: 'https://example.com/content'
    });
    (global as any).fetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' });

    const resolver = new BtcoDidResolver({ provider });
    const res = await resolver.resolve('did:btco:100');
    expect(res.didDocument).toBeNull();
    expect(res.inscriptions).toBeDefined();
    const entry = (res.inscriptions as BtcoInscriptionData[])[0];
    expect(entry.inscriptionId).toBe(inscriptionId);
    expect(entry.error).toBe('Failed to fetch content: HTTP 500: Internal Server Error');
    expect(res.resolutionMetadata.totalInscriptions).toBe(1);
  });

  test('metadata missing/null path', async () => {
    const inscriptionId = 'insc2';
    provider.getSatInfo.mockResolvedValue({ inscription_ids: [inscriptionId] });
    provider.resolveInscription.mockResolvedValue({
      id: inscriptionId,
      sat: 123,
      content_type: 'text/plain',
      content_url: 'http://local/content2'
    });
    (global as any).fetch.mockResolvedValue({ ok: true, text: async () => 'BTCO DID: did:btco:123' });
    provider.getMetadata.mockRejectedValue(new Error('no meta'));

    const resolver = new BtcoDidResolver({ provider });
    const res = await resolver.resolve('did:btco:123');
    const entry = (res.inscriptions as BtcoInscriptionData[])[0];
    expect(entry.isValidDid).toBe(true);
    expect(entry.metadata).toBeNull();
    expect(entry.didDocument).toBeUndefined();
    expect(res.didDocument).toBeNull();
  });

  test('invalid DID document: mismatched ID', async () => {
    const inscriptionId = 'insc3';
    provider.getSatInfo.mockResolvedValue({ inscription_ids: [inscriptionId] });
    provider.resolveInscription.mockResolvedValue({
      id: inscriptionId,
      sat: 124,
      content_type: 'text/plain',
      content_url: 'http://local/content3'
    });
    (global as any).fetch.mockResolvedValue({ ok: true, text: async () => 'BTCO DID: did:btco:124' });
    const badDoc: DIDDocument = {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:btco:999'
    };
    provider.getMetadata.mockResolvedValue(badDoc);

    const resolver = new BtcoDidResolver({ provider });
    const res = await resolver.resolve('did:btco:124');
    const entry = (res.inscriptions as BtcoInscriptionData[])[0];
    expect(entry.isValidDid).toBe(true);
    expect(entry.error).toBe('Invalid DID document structure or mismatched ID');
    expect(entry.didDocument).toBeUndefined();
    expect(res.didDocument).toBeNull();
  });

  test('invalid DID document structure: missing @context', async () => {
    const inscriptionId = 'insc4';
    provider.getSatInfo.mockResolvedValue({ inscription_ids: [inscriptionId] });
    provider.resolveInscription.mockResolvedValue({
      id: inscriptionId,
      sat: 125,
      content_type: 'text/plain',
      content_url: 'http://local/content4'
    });
    (global as any).fetch.mockResolvedValue({ ok: true, text: async () => 'did:btco:125' });
    // Missing @context
    provider.getMetadata.mockResolvedValue({ id: 'did:btco:125' });

    const resolver = new BtcoDidResolver({ provider });
    const res = await resolver.resolve('did:btco:125');
    const entry = (res.inscriptions as BtcoInscriptionData[])[0];
    expect(entry.isValidDid).toBe(true);
    expect(entry.error).toBe('Invalid DID document structure or mismatched ID');
    expect(res.didDocument).toBeNull();
  });

  test('invalid DID document structure: missing id', async () => {
    const inscriptionId = 'insc5';
    provider.getSatInfo.mockResolvedValue({ inscription_ids: [inscriptionId] });
    provider.resolveInscription.mockResolvedValue({
      id: inscriptionId,
      sat: 126,
      content_type: 'text/plain',
      content_url: 'http://local/content5'
    });
    (global as any).fetch.mockResolvedValue({ ok: true, text: async () => 'did:btco:126' });
    // Missing id
    provider.getMetadata.mockResolvedValue({ '@context': ['https://www.w3.org/ns/did/v1'] });

    const resolver = new BtcoDidResolver({ provider });
    const res = await resolver.resolve('did:btco:126');
    const entry = (res.inscriptions as BtcoInscriptionData[])[0];
    expect(entry.isValidDid).toBe(true);
    expect(entry.error).toBe('Invalid DID document structure or mismatched ID');
    expect(res.didDocument).toBeNull();
  });

  test('invalid DID document structure: wrong types (verificationMethod not array)', async () => {
    const inscriptionId = 'insc6';
    provider.getSatInfo.mockResolvedValue({ inscription_ids: [inscriptionId] });
    provider.resolveInscription.mockResolvedValue({
      id: inscriptionId,
      sat: 127,
      content_type: 'text/plain',
      content_url: 'http://local/content6'
    });
    (global as any).fetch.mockResolvedValue({ ok: true, text: async () => 'BTCO DID: did:btco:127' });
    provider.getMetadata.mockResolvedValue({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:btco:127',
      verificationMethod: { id: 'x' } // wrong type
    });

    const resolver = new BtcoDidResolver({ provider });
    const res = await resolver.resolve('did:btco:127');
    const entry = (res.inscriptions as BtcoInscriptionData[])[0];
    expect(entry.isValidDid).toBe(true);
    expect(entry.error).toBe('Invalid DID document structure or mismatched ID');
    expect(res.didDocument).toBeNull();
  });

  test('deactivation marker path (🔥)', async () => {
    const inscriptionId = 'insc7';
    provider.getSatInfo.mockResolvedValue({ inscription_ids: [inscriptionId] });
    provider.resolveInscription.mockResolvedValue({
      id: inscriptionId,
      sat: 128,
      content_type: 'text/plain',
      content_url: 'http://local/content7'
    });
    (global as any).fetch.mockResolvedValue({ ok: true, text: async () => 'BTCO DID: did:btco:128 🔥' });
    provider.getMetadata.mockResolvedValue({
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:btco:128'
    });

    const resolver = new BtcoDidResolver({ provider });
    const res = await resolver.resolve('did:btco:128');
    const entry = (res.inscriptions as BtcoInscriptionData[])[0];
    expect(entry.error).toBe('DID has been deactivated');
    expect(entry.didDocument).toBeNull();
    expect(res.didDocument).toBeNull();
  });

  test('provider.resolveInscription failure path triggers outer catch', async () => {
    const inscriptionId = 'insc8';
    provider.getSatInfo.mockResolvedValue({ inscription_ids: [inscriptionId] });
    provider.resolveInscription.mockRejectedValue(new Error('resolution failed'));

    const resolver = new BtcoDidResolver({ provider });
    const res = await resolver.resolve('did:btco:129');
    const entry = (res.inscriptions as BtcoInscriptionData[])[0];
    expect(entry.error).toBe('Failed to process inscription: resolution failed');
    expect(res.didDocument).toBeNull();
  });

  test('getSatInfo failure without message uses String(e) fallback', async () => {
    // throw a non-Error to trigger || String(e)
    provider.getSatInfo.mockRejectedValue('nope');
    const resolver = new BtcoDidResolver({ provider });
    const res = await resolver.resolve('did:btco:200');
    expect(res.resolutionMetadata.error).toBe('notFound');
    expect(res.resolutionMetadata.message).toContain('nope');
  });

  test('fetch content rejection without message uses String(err) fallback', async () => {
    const inscriptionId = 'ins-fallback';
    provider.getSatInfo.mockResolvedValue({ inscription_ids: [inscriptionId] });
    provider.resolveInscription.mockResolvedValue({
      id: inscriptionId,
      sat: 300,
      content_type: 'text/plain',
      content_url: 'http://local/content-fallback'
    });
    (global as any).fetch = mock(() => Promise.reject('netdown'));

    const resolver = new BtcoDidResolver({ provider });
    const res = await resolver.resolve('did:btco:300');
    const entry = (res.inscriptions as BtcoInscriptionData[])[0];
    expect(entry.error).toBe('Failed to fetch content: netdown');
  });

  test('resolveInscription failure without message uses String(err) fallback', async () => {
    const inscriptionId = 'ins-outer-fallback';
    provider.getSatInfo.mockResolvedValue({ inscription_ids: [inscriptionId] });
    provider.resolveInscription.mockRejectedValue('boom');

    const resolver = new BtcoDidResolver({ provider });
    const res = await resolver.resolve('did:btco:400');
    const entry = (res.inscriptions as BtcoInscriptionData[])[0];
    expect(entry.error).toBe('Failed to process inscription: boom');
  });

  test('inscription not found branch', async () => {
    const inscriptionId = 'insc9';
    provider.getSatInfo.mockResolvedValue({ inscription_ids: [inscriptionId] });
    provider.resolveInscription.mockResolvedValue(undefined as any);

    const resolver = new BtcoDidResolver({ provider });
    const res = await resolver.resolve('did:btco:130');
    const entry = (res.inscriptions as BtcoInscriptionData[])[0];
    expect(entry.error).toBe(`Inscription ${inscriptionId} not found`);
    expect(res.didDocument).toBeNull();
  });

  test('network prefixes mapping via private getDidPrefix', () => {
    const resolver = new BtcoDidResolver({ provider });
    const prefixRegtest = (resolver as any).getDidPrefix('regtest');
    const prefixSignet = (resolver as any).getDidPrefix('signet');
    const prefixMain = (resolver as any).getDidPrefix('mainnet');
    expect(prefixRegtest).toBe('did:btco:reg');
    expect(prefixSignet).toBe('did:btco:sig');
    expect(prefixMain).toBe('did:btco');
  });
});

/** Inlined from BtcoDidResolver.branches.part.ts */
// duplicate imports removed during inlining

const makeProvider = (overrides: Partial<ResourceProviderLike> = {}): ResourceProviderLike => ({
  async getSatInfo(_sat: string) { return { inscription_ids: ['ins-1'] }; },
  async resolveInscription(id: string) { return { id, sat: 0, content_type: 'text/plain', content_url: 'http://c/' + id }; },
  async getMetadata(_id: string) { return { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:btco:1' }; },
  ...overrides
});

describe('BtcoDidResolver branches', () => {
  const originalFetch = global.fetch as any;
  beforeEach(() => {
    (global as any).fetch = mock(async (url: string) => ({ ok: true, status: 200, statusText: 'OK', text: async () => `BTCO DID: did:btco:1` }));
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
    expect(res.resolutionMetadata?.error).toBe('notFound');
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
    (global as any).fetch = mock(async () => ({ ok: false, status: 500, statusText: 'ERR', text: async () => '' }));
    const provider = makeProvider();
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:1');
    expect(res.inscriptions?.[0].error).toContain('Failed to fetch content');
  });

  test('metadata throws and content does not match pattern', async () => {
    (global as any).fetch = mock(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => 'hello world' }));
    const provider = makeProvider({ getMetadata: async () => { throw new Error('x'); } });
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:1');
    expect(res.didDocument).toBeNull();
  });

  test('valid did doc selected as latest and network prefixes', async () => {
    (global as any).fetch = mock(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => 'BTCO DID: did:btco:reg:2' }));
    const provider = makeProvider({
      getSatInfo: async () => ({ inscription_ids: ['ins-a', 'ins-b'] }),
      getMetadata: async (id: string) => ({ '@context': ['https://www.w3.org/ns/did/v1'], id: id === 'ins-b' ? 'did:btco:reg:2' : 'did:btco:reg:999' })
    });
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:reg:2');
    expect(res.didDocument?.id).toBe('did:btco:reg:2');
    expect(res.resolutionMetadata.network).toBe('reg');
  });

  test('deactivated content with flame emoji', async () => {
    (global as any).fetch = mock(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => '🔥' }));
    const provider = makeProvider();
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:1');
    expect(res.inscriptions?.[0].error).toContain('deactivated');
  });
});




/** Inlined from BtcoDidResolver.deactivation-keep-error.part.ts */

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




/** Inlined from BtcoDidResolver.deactivation-preserve-existing-error.part.ts */

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




/** Inlined from BtcoDidResolver.invalid-context.part.ts */

describe('BtcoDidResolver invalid @context branch', () => {
  const provider: ResourceProviderLike = {
    async getSatInfo() { return { inscription_ids: ['i1'] }; },
    async resolveInscription(id: string) { return { id, sat: 0, content_type: 'text/plain', content_url: 'http://c/' + id }; },
    async getMetadata() { return { '@context': ['https://example.org/other'], id: 'did:btco:1' }; }
  };

  const originalFetch = global.fetch as any;
  beforeEach(() => {
    (global as any).fetch = mock(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => 'BTCO DID: did:btco:1' }));
  });
  afterAll(() => { (global as any).fetch = originalFetch; });

  test('filters out invalid contexts', async () => {
    const r = new BtcoDidResolver({ provider });
    const res = await r.resolve('did:btco:1');
    expect(res.didDocument).toBeNull();
  });
});




/** Inlined from BtcoDidResolver.invalid-doc.part.ts */

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




/** Inlined from BtcoDidResolver.more-branches.part.ts */

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




/** Inlined from BtcoDidResolver.signet.part.ts */

describe('BtcoDidResolver signet and error branches', () => {
  const originalFetch = global.fetch as any;
  beforeEach(() => {
    (global as any).fetch = mock(async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => 'BTCO DID: did:btco:sig:3' }));
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
