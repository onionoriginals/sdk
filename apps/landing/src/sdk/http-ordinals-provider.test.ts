import { describe, test, expect } from 'bun:test';
import { HttpOrdinalsProvider } from './http-ordinals-provider';

function mockFetch(routes: Record<string, unknown>) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, body });
    const key = new URL(url, 'http://x').pathname;
    if (!(key in routes)) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('HttpOrdinalsProvider', () => {
  test('getFirstSatOfOutput hits /api/btc/sat and returns the sat', async () => {
    const { impl, calls } = mockFetch({ '/api/btc/sat': { satoshi: '5000000000' } });
    const p = new HttpOrdinalsProvider({ baseUrl: '', fetchImpl: impl });
    const sat = await p.getFirstSatOfOutput({ txid: 'a'.repeat(64), vout: 0 });
    expect(sat).toBe('5000000000');
    expect(calls[0].url).toBe('/api/btc/sat');
    expect(calls[0].body).toEqual({ txid: 'a'.repeat(64), vout: 0 });
  });

  test('estimateFee hits /api/btc/fee', async () => {
    const { impl } = mockFetch({ '/api/btc/fee': { feeRate: 4 } });
    const p = new HttpOrdinalsProvider({ baseUrl: '', fetchImpl: impl });
    expect(await p.estimateFee(1)).toBe(4);
  });

  test('broadcastTransaction hits /api/btc/broadcast and returns txid', async () => {
    const { impl, calls } = mockFetch({ '/api/btc/broadcast': { txid: 'f'.repeat(64) } });
    const p = new HttpOrdinalsProvider({ baseUrl: '', fetchImpl: impl });
    expect(await p.broadcastTransaction('0200000000')).toBe('f'.repeat(64));
    expect(calls[0].body).toEqual({ txHex: '0200000000' });
  });

  test('createInscription rejects by design (tx built locally)', async () => {
    const { impl } = mockFetch({});
    const p = new HttpOrdinalsProvider({ baseUrl: '', fetchImpl: impl });
    await expect(p.createInscription({ contentType: 'text/plain' })).rejects.toThrow();
  });

  test('broadcast surfaces a server error as a throw', async () => {
    const failing = (async () => new Response(JSON.stringify({ error: 'broadcast_failed' }), { status: 502 })) as unknown as typeof fetch;
    const p = new HttpOrdinalsProvider({ baseUrl: '', fetchImpl: failing });
    await expect(p.broadcastTransaction('0200000000')).rejects.toThrow();
  });
});
