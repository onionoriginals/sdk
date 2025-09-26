import { OrdinalsClientProvider } from '../../src/bitcoin/providers/OrdinalsProvider';
import { OrdinalsClient } from '../../src/bitcoin/OrdinalsClient';

describe('OrdinalsClientProvider', () => {
  const client: jest.Mocked<OrdinalsClient> = new OrdinalsClient('http://ord', 'regtest') as any;
  (client.getSatInfo as any) = jest.fn(async (_: string) => ({ inscription_ids: ['a'] }));
  (client.getInscriptionById as any) = jest.fn(async (id: string) => ({ inscriptionId: id, satoshi: '1', content: Buffer.alloc(0), contentType: 'text/plain', txid: 't', vout: 0 }));
  (client.getMetadata as any) = jest.fn(async (_: string) => ({ ok: true } as any));
  (client.estimateFee as any) = jest.fn(async (_?: number) => 123);

  test('getSatInfo proxies with retry', async () => {
    const p = new OrdinalsClientProvider(client, { retries: 0, baseUrl: 'http://ord' });
    const v = await p.getSatInfo('1');
    expect(v.inscription_ids).toEqual(['a']);
  });

  test('getSatInfo retries once on failure to cover isRetriable', async () => {
    (client.getSatInfo as any).mockImplementationOnce(async () => { throw new Error('fail'); });
    const p = new OrdinalsClientProvider(client, { retries: 1, baseUrl: 'http://ord' });
    const v = await p.getSatInfo('1');
    expect(v.inscription_ids).toEqual(['a']);
  });

  test('resolveInscription validates fields and builds content_url', async () => {
    const p = new OrdinalsClientProvider(client, { baseUrl: 'http://ord/' });
    const v = await p.resolveInscription('ins-1');
    expect(v).toEqual(expect.objectContaining({ id: 'ins-1', content_url: 'http://ord/content/ins-1', content_type: 'text/plain', sat: expect.any(Number) }));
  });

  test('resolveInscription errors when missing baseUrl', async () => {
    const p = new OrdinalsClientProvider(client, {} as any);
    await expect(p.resolveInscription('ins-1')).rejects.toThrow('baseUrl is required');
  });

  test('resolveInscription errors on missing fields', async () => {
    (client.getInscriptionById as any).mockImplementationOnce(async () => ({ inscriptionId: 'id' } as any));
    const p = new OrdinalsClientProvider(client, { baseUrl: 'http://ord', retries: 0 } as any);
    await expect(p.resolveInscription('id')).rejects.toThrow('Inscription missing satoshi');
  });

  test('resolveInscription errors on invalid satoshi value', async () => {
    (client.getInscriptionById as any).mockImplementationOnce(async (id: string) => ({ inscriptionId: id, satoshi: 'NaN', content: Buffer.alloc(0), contentType: 'text/plain', txid: 't', vout: 0 }));
    const p = new OrdinalsClientProvider(client, { baseUrl: 'http://ord', retries: 0 } as any);
    await expect(p.resolveInscription('id')).rejects.toThrow('Invalid satoshi value');
  });

  test('resolveInscription errors on missing contentType', async () => {
    (client.getInscriptionById as any).mockImplementationOnce(async (id: string) => ({ inscriptionId: id, satoshi: '1', content: Buffer.alloc(0), txid: 't', vout: 0 }));
    const p = new OrdinalsClientProvider(client, { baseUrl: 'http://ord', retries: 0 } as any);
    await expect(p.resolveInscription('id')).rejects.toThrow('Inscription missing contentType');
  });

  test('getMetadata proxies with retry', async () => {
    const p = new OrdinalsClientProvider(client, { baseUrl: 'http://ord' });
    const v = await p.getMetadata('id');
    expect(v).toEqual({ ok: true });
  });

  test('getMetadata retries on first failure to cover isRetriable', async () => {
    (client.getMetadata as any).mockImplementationOnce(async () => { throw new Error('fail meta'); });
    const p = new OrdinalsClientProvider(client, { baseUrl: 'http://ord', retries: 1 });
    const v = await p.getMetadata('id');
    expect(v).toEqual({ ok: true });
  });

  test('estimateFee proxies with retry', async () => {
    const p = new OrdinalsClientProvider(client, { baseUrl: 'http://ord' });
    const v = await p.estimateFee(2);
    expect(v).toBe(123);
  });

  test('estimateFee retries on first failure to cover isRetriable', async () => {
    (client.estimateFee as any).mockImplementationOnce(async () => { throw new Error('fee fail'); });
    const p = new OrdinalsClientProvider(client, { baseUrl: 'http://ord', retries: 1 });
    const v = await p.estimateFee(2);
    expect(v).toBe(123);
  });

  test('retries default when options.retries not provided', async () => {
    const p = new OrdinalsClientProvider(client as any);
    const v = await p.getSatInfo('1');
    expect(v.inscription_ids).toEqual(['a']);
  });

  test('resolveInscription constructs content_url from baseUrl as-is', async () => {
    const p = new OrdinalsClientProvider(client, { baseUrl: 'http://ord//' });
    const v = await p.resolveInscription('x');
    expect(v.content_url).toBe('http://ord//content/x');
  });
})

