import { afterEach, beforeEach, expect, test } from 'bun:test';
import { RegtestProvider } from '../../../src/adapters/providers/RegtestProvider';

const nativeFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== '127.0.0.1') throw new Error('Test permits only loopback HTTP');
    return nativeFetch(input, init);
  }) as typeof fetch;
});

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

test('a mismatched Core chain prevents transaction submission to the local backend', async () => {
  const calls: string[] = [];
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    if (req.method === 'GET') return Response.json({ chain: 'regtest', sat_index: true, address_index: true });
    const { method } = await req.json() as { method: string };
    calls.push(method);
    return Response.json({ result: { chain: 'main' }, error: null });
  } });
  const provider = new RegtestProvider({ rpcUrl: server.url.href, ordUrl: server.url.href, rpcAuth: 'test:only' });
  await expect(provider.broadcastTransaction('00')).rejects.toThrow(/regtest/i);
  expect(calls).toEqual(['getblockchaininfo']);
  expect(calls).not.toContain('sendrawtransaction');
});

test('a regtest provider requires explicit loopback endpoints', () => {
  expect(() => new RegtestProvider({ rpcUrl: 'https://example.com', ordUrl: 'http://127.0.0.1:8080', rpcAuth: 'test:only' })).toThrow(/loopback/i);
});

test('plain-text ord block hashes must match the active Core tip before serving sat state', async () => {
  let indexedHash = 'a'.repeat(64);
  const coreHash = 'a'.repeat(64);
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    if (req.method === 'POST') return Response.json({ result: { chain: 'regtest', blocks: 1, bestblockhash: coreHash } });
    const path = new URL(req.url).pathname;
    if (path === '/status') return Response.json({ chain: 'regtest', sat_index: true, address_index: true, height: 1 });
    if (path === '/blockhash/1') return new Response(indexedHash);
    if (path === '/sat/1') return Response.json({ inscriptions: [] });
    return new Response('Not found', { status: 404 });
  } });
  const provider = new RegtestProvider({ rpcUrl: server.url.href, ordUrl: server.url.href, rpcAuth: 'test:only' });
  expect(await provider.getInscriptionsBySatoshi('1')).toEqual([]);
  indexedHash = 'b'.repeat(64);
  await expect(provider.getInscriptionsBySatoshi('1')).rejects.toThrow('current Bitcoin Core tip');
});

test('an empty address index cannot hide an unindexed Core tip', async () => {
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    if (req.method === 'POST') return Response.json({ result: { chain: 'regtest', blocks: 2, bestblockhash: 'b'.repeat(64) } });
    if (new URL(req.url).pathname === '/status') return Response.json({ chain: 'regtest', sat_index: true, address_index: true, height: 1 });
    if (new URL(req.url).pathname.startsWith('/blockhash/')) return new Response('a'.repeat(64));
    return Response.json({ outputs: [] });
  } });
  const provider = new RegtestProvider({ rpcUrl: server.url.href, ordUrl: server.url.href, rpcAuth: 'test:only' });
  await expect(provider.getAddressUtxos('bcrt1qqqq')).rejects.toThrow('current Bitcoin Core tip');
});
