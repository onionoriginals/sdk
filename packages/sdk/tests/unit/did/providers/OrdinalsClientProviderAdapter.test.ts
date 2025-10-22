import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { OrdinalsClient } from '../../../../src/bitcoin/OrdinalsClient';
import { OrdinalsClientProviderAdapter } from '../../../../src/did/providers/OrdinalsClientProviderAdapter';

describe('OrdinalsClientProviderAdapter.resolveInscription', () => {
  const inscriptionId = 'insc123';
  const originalFetch = global.fetch as any;

  beforeEach(() => {
    // Bun doesn't require resetAllMocks
  });

  afterEach(() => {
    (global as any).fetch = originalFetch;
  });

  test('throws when baseUrl is missing/empty', async () => {
    const client = new OrdinalsClient('http://rpc', 'mainnet');
    const adapter = new OrdinalsClientProviderAdapter(client, '');
    await expect(adapter.resolveInscription(inscriptionId)).rejects.toThrow('OrdinalsClientProviderAdapter requires a baseUrl');
  });

  test('throws when inscription endpoint returns non-OK', async () => {
    const client = new OrdinalsClient('http://rpc', 'mainnet');
    const adapter = new OrdinalsClientProviderAdapter(client, 'https://api.example.com/');

    const fetchMock = mock(() => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }));
    (globalThis as any).fetch = fetchMock;

    await expect(adapter.resolveInscription(inscriptionId)).rejects.toThrow(`Failed to resolve inscription: ${inscriptionId}`);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/inscription/insc123',
      { headers: { Accept: 'application/json' } }
    );
  });

  test('maps fields correctly when JSON has explicit values and numeric sat', async () => {
    const client = new OrdinalsClient('http://rpc', 'mainnet');
    const adapter = new OrdinalsClientProviderAdapter(client, 'https://ord.example');

    const apiResponse = {
      inscription_id: 'abc123',
      sat: 42,
      content_type: 'image/png',
      content_url: 'https://cdn.example/abc123.png'
    };

    const fetchMock = mock(() => Promise.resolve({ ok: true, json: async () => apiResponse }));
    (globalThis as any).fetch = fetchMock;

    const result = await adapter.resolveInscription(inscriptionId);

    expect(result).toEqual({
      id: 'abc123',
      sat: 42,
      content_type: 'image/png',
      content_url: 'https://cdn.example/abc123.png'
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ord.example/inscription/insc123',
      { headers: { Accept: 'application/json' } }
    );
  });

  test('applies fallbacks and coerces string sat to number', async () => {
    const client = new OrdinalsClient('http://rpc', 'mainnet');
    const adapter = new OrdinalsClientProviderAdapter(client, 'https://api.example.com/');

    const apiResponse = {
      sat: '007'
      // missing inscription_id, content_type, content_url
    } as any;

    const fetchMock = mock(() => Promise.resolve({ ok: true, json: async () => apiResponse }));
    (globalThis as any).fetch = fetchMock;

    const result = await adapter.resolveInscription(inscriptionId);

    expect(result).toEqual({
      id: 'insc123',
      sat: 7,
      content_type: 'text/plain',
      content_url: 'https://api.example.com/content/insc123'
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/inscription/insc123',
      { headers: { Accept: 'application/json' } }
    );
  });

  test('applies default sat=0 when sat is missing', async () => {
    const client = new OrdinalsClient('http://rpc', 'mainnet');
    const adapter = new OrdinalsClientProviderAdapter(client, 'https://api.example.com/');

    const apiResponse = { } as any;

    const fetchMock = mock(() => Promise.resolve({ ok: true, json: async () => apiResponse }));
    (globalThis as any).fetch = fetchMock;

    const result = await adapter.resolveInscription(inscriptionId);

    expect(result).toEqual({
      id: 'insc123',
      sat: 0,
      content_type: 'text/plain',
      content_url: 'https://api.example.com/content/insc123'
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/inscription/insc123',
      { headers: { Accept: 'application/json' } }
    );
  });

  test('getSatInfo proxies to client.getSatInfo', async () => {
    const mockClient = {
      getSatInfo: mock(async (n: string) => ({ inscription_ids: ['a', 'b'] })),
      getMetadata: mock()
    } as unknown as OrdinalsClient;

    const adapter = new OrdinalsClientProviderAdapter(mockClient, 'https://x');
    const result = await adapter.getSatInfo('12345');
    expect(result).toEqual({ inscription_ids: ['a', 'b'] });
    expect((mockClient as any).getSatInfo).toHaveBeenCalledWith('12345');
  });

  test('getMetadata proxies to client.getMetadata', async () => {
    const expected = { hello: 'world' };
    const mockClient = {
      getSatInfo: mock(),
      getMetadata: mock(async (id: string) => expected)
    } as unknown as OrdinalsClient;

    const adapter = new OrdinalsClientProviderAdapter(mockClient, 'https://x');
    const result = await adapter.getMetadata('iid');
    expect(result).toBe(expected);
    expect((mockClient as any).getMetadata).toHaveBeenCalledWith('iid');
  });
});

