import { BtcoDidResolver } from '../../src/did/BtcoDidResolver';
import type { ResourceProviderLike, BtcoInscriptionData } from '../../src/did/BtcoDidResolver';
import type { DIDDocument } from '../../src/types/did';

describe('BtcoDidResolver', () => {
  let provider: jest.Mocked<ResourceProviderLike>;
  let originalFetch: any;

  beforeEach(() => {
    provider = {
      getSatInfo: jest.fn(),
      resolveInscription: jest.fn(),
      getMetadata: jest.fn()
    };
    originalFetch = (global as any).fetch;
    (global as any).fetch = jest.fn();
  });

  afterEach(() => {
    (global as any).fetch = originalFetch;
    jest.resetAllMocks();
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
    expect(res.resolutionMetadata.error).toBe('noProvider');
    expect(res.resolutionMetadata.message).toBe('No provider supplied');
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
    (global as any).fetch = jest.fn().mockRejectedValue('netdown');

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
    const prefixTestnet = (resolver as any).getDidPrefix('testnet');
    const prefixSignet = (resolver as any).getDidPrefix('signet');
    const prefixMain = (resolver as any).getDidPrefix('mainnet');
    expect(prefixTestnet).toBe('did:btco:test');
    expect(prefixSignet).toBe('did:btco:sig');
    expect(prefixMain).toBe('did:btco');
  });
});
import './BtcoDidResolver.branches.part';
import './BtcoDidResolver.deactivation-keep-error.part';
import './BtcoDidResolver.deactivation-preserve-existing-error.part';
import './BtcoDidResolver.invalid-context.part';
import './BtcoDidResolver.invalid-doc.part';
import './BtcoDidResolver.more-branches.part';
import './BtcoDidResolver.signet.part';
