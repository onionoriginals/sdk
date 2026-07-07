/**
 * Regression tests for SignetProvider.broadcastTransaction hardening (issue #272):
 * non-hex input rejection, HTTP-error handling, empty-result rejection, and
 * optional RPC auth.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { SignetProvider } from '../../../src/bitcoin/providers/SignetProvider';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const rawTxHex = '02000000000101abcdef';

describe('SignetProvider.broadcastTransaction (issue #272)', () => {
  test('rejects a non-hex / object payload before hitting the network', async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
    const provider = new SignetProvider({ ordUrl: 'http://ord', bitcoinRpcUrl: 'http://rpc' });

    await expect(provider.broadcastTransaction({ not: 'hex' } as unknown as string))
      .rejects.toThrow(/hex string/i);
    expect(called).toBe(false);
  });

  test('rejects odd-length / invalid hex', async () => {
    const provider = new SignetProvider({ ordUrl: 'http://ord', bitcoinRpcUrl: 'http://rpc' });
    await expect(provider.broadcastTransaction('abc')).rejects.toThrow(/hex string/i);
    await expect(provider.broadcastTransaction('zz')).rejects.toThrow(/hex string/i);
  });

  test('throws (not returns "") when the RPC response has neither result nor error', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ id: 1 }), { status: 200 })) as typeof fetch;
    const provider = new SignetProvider({ ordUrl: 'http://ord', bitcoinRpcUrl: 'http://rpc' });
    await expect(provider.broadcastTransaction(rawTxHex)).rejects.toThrow(/no txid/i);
  });

  test('surfaces an HTTP error with a non-JSON body instead of an opaque parse error', async () => {
    globalThis.fetch = (async () => new Response('<html>401 Unauthorized</html>', { status: 401, statusText: 'Unauthorized' })) as typeof fetch;
    const provider = new SignetProvider({ ordUrl: 'http://ord', bitcoinRpcUrl: 'http://rpc' });
    await expect(provider.broadcastTransaction(rawTxHex)).rejects.toThrow(/HTTP 401/);
  });

  test('surfaces a JSON-RPC error message', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'bad-txns-inputs-missingorspent' } }), { status: 500 })) as typeof fetch;
    const provider = new SignetProvider({ ordUrl: 'http://ord', bitcoinRpcUrl: 'http://rpc' });
    await expect(provider.broadcastTransaction(rawTxHex)).rejects.toThrow(/bad-txns-inputs-missingorspent/);
  });

  test('returns the txid on success', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ result: 'deadbeeftxid' }), { status: 200 })) as typeof fetch;
    const provider = new SignetProvider({ ordUrl: 'http://ord', bitcoinRpcUrl: 'http://rpc' });
    await expect(provider.broadcastTransaction(rawTxHex)).resolves.toBe('deadbeeftxid');
  });

  test('sends HTTP Basic auth when bitcoinRpcAuth is configured', async () => {
    let seenAuth: string | null = null;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seenAuth = (init.headers as Record<string, string>)['Authorization'] ?? null;
      return new Response(JSON.stringify({ result: 'txid' }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new SignetProvider({
      ordUrl: 'http://ord',
      bitcoinRpcUrl: 'http://rpc',
      bitcoinRpcAuth: { username: 'user', password: 'pass' },
    });
    await provider.broadcastTransaction(rawTxHex);
    expect(seenAuth).toBe('Basic ' + Buffer.from('user:pass').toString('base64'));
  });
});

describe('SignetProvider.estimateFee fail-loud policy (issue #351)', () => {
  test('throws without bitcoinRpcUrl instead of fabricating a rate', async () => {
    const provider = new SignetProvider({ ordUrl: 'http://ord' });
    await expect(provider.estimateFee(6)).rejects.toThrow(/bitcoinRpcUrl/);
  });

  test('throws when the RPC returns no feerate instead of inventing one', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ result: { errors: ['Insufficient data or no feerate found'] } }),
      { status: 200 }
    )) as typeof fetch;
    const provider = new SignetProvider({ ordUrl: 'http://ord', bitcoinRpcUrl: 'http://rpc' });
    await expect(provider.estimateFee(1)).rejects.toThrow(/no feerate/i);
  });

  test('propagates RPC transport failures instead of swallowing them', async () => {
    globalThis.fetch = (async () => { throw new Error('connection refused'); }) as typeof fetch;
    const provider = new SignetProvider({ ordUrl: 'http://ord', bitcoinRpcUrl: 'http://rpc' });
    await expect(provider.estimateFee(1)).rejects.toThrow(/connection refused/);
  });

  test('converts a real BTC/kB feerate to sat/vB', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ result: { feerate: 0.00012 } }),
      { status: 200 }
    )) as typeof fetch;
    const provider = new SignetProvider({ ordUrl: 'http://ord', bitcoinRpcUrl: 'http://rpc' });
    await expect(provider.estimateFee(1)).resolves.toBe(12);
  });
});
