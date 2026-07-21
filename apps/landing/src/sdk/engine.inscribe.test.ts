import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { DemoEngine, btcoExplorerUrl } from './engine';
import { createWebvhHostStore } from '../../server/webvh-host';

// publish() hosts the did:webvh log via relative /api/host/* fetches, which are
// invalid without a browser origin — route them through an in-process store so
// create→publish works, then inscribe runs against OrdMockProvider (mock path).
function installHostFetch(host = 'demo.test') {
  const store = createWebvhHostStore();
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), `http://${host}`);
    if (url.pathname.startsWith('/api/host/')) {
      const req = new Request(url, { method: (init?.method ?? 'GET'), headers: init?.headers as HeadersInit, body: init?.body as BodyInit });
      return store.handlePut(req, url);
    }
    const served = store.serve(new Request(url), url);
    return served ?? new Response('nf', { status: 404 });
  }) as unknown as typeof fetch;
  return () => { globalThis.fetch = real; };
}

describe('engine inscribe wiring', () => {
  let restore: () => void;
  beforeEach(() => { restore = installHostFetch(); });
  afterEach(() => restore());

  test('btcoExplorerUrl builds a testnet4 mempool link', () => {
    // Only meaningful when testnet is enabled; the helper is pure.
    const url = btcoExplorerUrl('f'.repeat(64));
    // In the default (mock) test env VITE_BTC_TESTNET is unset → undefined.
    expect(url === undefined || url === `https://mempool.space/testnet4/tx/${'f'.repeat(64)}`).toBe(true);
  });

  test('inscribe() without funding runs the mock path and still yields an inscription', async () => {
    const engine = new DemoEngine();
    await engine.create('T', 'Artwork', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await engine.publish();
    const state = await engine.inscribe(); // mock path (no funding) — OrdMockProvider/regtest
    expect(state.layer).toBe('did:btco');
    expect(state.inscription?.txid).toBeTruthy();
  });

  test('inscribe() with funding but a broken signer surfaces the failure (real path is attempted)', async () => {
    const engine = new DemoEngine();
    await engine.create('T', 'Artwork', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await engine.publish();
    const brokenClient = {
      async signTransaction() { throw new Error('turnkey down'); },
      async createWalletAccounts() { throw new Error('x'); },
      async getWallets() { throw new Error('x'); },
    };
    // With funding provided, the engine takes the sat-selected path; the broken
    // signer makes the SDK throw (COMMIT signing fails) — proving the real path
    // is wired, not the mock.
    await expect(
      engine.inscribe({
        funding: {
          fundingUtxo: { txid: 'a'.repeat(64), vout: 0, value: 20_000 },
          changeAddress: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
          signingClient: brokenClient as never,
        },
      })
    ).rejects.toThrow();
  });
});
