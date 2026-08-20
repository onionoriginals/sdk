/**
 * U4 — the deposit indexer as a swappable, authenticated configuration seam.
 *
 * The read behind a deposit address is the one call that decides whether a
 * stranger's real BTC is visible to this app. These tests pin the seam (where
 * it reads, what it authenticates with), the fail-closed posture when the read
 * cannot be trusted (R28), and the persistence that makes an asynchronous
 * stuck state reach someone who has already closed the tab (R31).
 */
import { describe, test, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { serializeCookie } from '../cookies';
import {
  createBitcoinRoutes,
  fetchAddressUtxos,
  fetchFaucetUtxos,
  resolveIndexer,
  indexerAuthHeaders,
  IndexerError,
  DEFAULT_INDEXER_API,
} from '../bitcoin';
import { createInscriptionsStore } from '../inscriptions-store';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JWT = 'test-secret-at-least-32-chars-long!!';
const PRIV = hex.decode('3'.repeat(64));
const PUB = secp256k1.getPublicKey(PRIV, true);
const MAINNET_ADDRESS = btc.p2wpkh(PUB, btc.NETWORK).address!;
const TESTNET_ADDRESS = btc.p2wpkh(PUB, btc.TEST_NETWORK).address!;

function authedGet(address: string, sub = 'sub-1') {
  const token = signToken(sub, 'a@b.com', undefined, { secret: JWT });
  const cookie = serializeCookie(getAuthCookieConfig(token));
  return new Request(`http://host/api/btc/deposit?address=${encodeURIComponent(address)}`, {
    headers: { cookie },
  });
}

function listReq(sub = 'sub-1') {
  const token = signToken(sub, 'a@b.com', undefined, { secret: JWT });
  const cookie = serializeCookie(getAuthCookieConfig(token));
  return new Request('http://host/api/btc/inscribe', { headers: { cookie } });
}

const fakeProvider = () =>
  ({
    async getFirstSatOfOutput() { return '5000000000'; },
    async estimateFee() { return 3; },
    async broadcastTransaction() { return 'f'.repeat(64); },
    async getTransactionStatus() { return { confirmed: false }; },
  }) as unknown as Parameters<typeof createBitcoinRoutes>[0]['provider'];

/** A fetch stub that records every call and replies from `reply`. */
function recordingFetch(reply: (url: string) => Response | Promise<Response>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const asString = typeof url === 'string' ? url : url.toString();
    calls.push({ url: asString, headers });
    return reply(asString);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const okUtxos = (
  utxos: Array<{ txid: string; vout: number; value: number; status?: { confirmed?: boolean } }>
) => () => new Response(JSON.stringify(utxos), { status: 200 });

// ───────────────────────────────────────────────────────────────────────────
// The seam itself: one documented base URL + optional auth, resolved from env.
// ───────────────────────────────────────────────────────────────────────────
describe('resolveIndexer — the configuration seam', () => {
  test('defaults to the free public API per network, with no auth', () => {
    expect(resolveIndexer({}, 'mainnet')).toEqual({ api: DEFAULT_INDEXER_API.mainnet });
    expect(resolveIndexer({}, 'testnet')).toEqual({ api: DEFAULT_INDEXER_API.testnet });
  });

  test('BTC_INDEXER_API replaces the default on either network', () => {
    expect(resolveIndexer({ BTC_INDEXER_API: 'https://idx.example/api' }, 'mainnet').api)
      .toBe('https://idx.example/api');
    expect(resolveIndexer({ BTC_INDEXER_API: 'https://idx.example/api' }, 'testnet').api)
      .toBe('https://idx.example/api');
  });

  test('a trailing slash is normalized away (the path is appended, not doubled)', () => {
    expect(resolveIndexer({ BTC_INDEXER_API: 'https://idx.example/api/' }, 'mainnet').api)
      .toBe('https://idx.example/api');
  });

  test('the legacy MEMPOOL_* variables still work — the testnet4 faucet is not broken', () => {
    expect(resolveIndexer({ MEMPOOL_API: 'https://legacy.example/api' }, 'mainnet').api)
      .toBe('https://legacy.example/api');
    expect(resolveIndexer({ MEMPOOL_TESTNET4_API: 'https://legacy4.example/api' }, 'testnet').api)
      .toBe('https://legacy4.example/api');
    // The new name wins when both are present.
    expect(
      resolveIndexer(
        { BTC_INDEXER_API: 'https://new.example/api', MEMPOOL_API: 'https://legacy.example/api' },
        'mainnet'
      ).api
    ).toBe('https://new.example/api');
  });

  test('a token is carried, defaulting to an Authorization: Bearer header', () => {
    const cfg = resolveIndexer({ BTC_INDEXER_API: 'https://idx/api', BTC_INDEXER_TOKEN: 'tok' }, 'mainnet');
    expect(cfg.authToken).toBe('tok');
    expect(indexerAuthHeaders(cfg)).toEqual({ Authorization: 'Bearer tok' });
  });

  test('a custom header name sends the token raw (paid tiers that want X-Api-Key)', () => {
    const cfg = resolveIndexer(
      { BTC_INDEXER_TOKEN: 'tok', BTC_INDEXER_AUTH_HEADER: 'X-Api-Key' },
      'mainnet'
    );
    expect(indexerAuthHeaders(cfg)).toEqual({ 'X-Api-Key': 'tok' });
  });

  test('no token configured means no auth header at all', () => {
    expect(indexerAuthHeaders(resolveIndexer({}, 'mainnet'))).toEqual({});
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The read: where it goes, what it sends, how it fails.
// ───────────────────────────────────────────────────────────────────────────
describe('fetchAddressUtxos through the seam', () => {
  test('reads from the configured base URL — changing it changes where we read', async () => {
    const { impl, calls } = recordingFetch(okUtxos([]));
    await fetchAddressUtxos({ api: 'https://idx.example/api', address: MAINNET_ADDRESS, network: 'mainnet', fetchImpl: impl });
    expect(calls[0].url).toBe(`https://idx.example/api/address/${MAINNET_ADDRESS}/utxo`);

    const second = recordingFetch(okUtxos([]));
    await fetchAddressUtxos({ api: 'https://other.example/rest', address: MAINNET_ADDRESS, network: 'mainnet', fetchImpl: second.impl });
    expect(second.calls[0].url).toBe(`https://other.example/rest/address/${MAINNET_ADDRESS}/utxo`);
  });

  test('sends the configured auth header, and sends none when unconfigured', async () => {
    const withAuth = recordingFetch(okUtxos([]));
    await fetchAddressUtxos({
      api: 'https://idx.example/api',
      authToken: 'sekret',
      address: MAINNET_ADDRESS,
      network: 'mainnet',
      fetchImpl: withAuth.impl,
    });
    expect(withAuth.calls[0].headers.authorization).toBe('Bearer sekret');

    const free = recordingFetch(okUtxos([]));
    const out = await fetchAddressUtxos({
      api: 'https://mempool.space/api',
      address: MAINNET_ADDRESS,
      network: 'mainnet',
      fetchImpl: free.impl,
    });
    expect(free.calls[0].headers.authorization).toBeUndefined();
    expect(out.confirmed).toEqual([]); // the free default still works
  });

  test('an address with no UTXOs is an empty set, not an error', async () => {
    const { impl } = recordingFetch(okUtxos([]));
    const out = await fetchAddressUtxos({ api: 'https://idx/api', address: MAINNET_ADDRESS, network: 'mainnet', fetchImpl: impl });
    expect(out.confirmed).toEqual([]);
    expect(out.unconfirmedSats).toBe(0);
  });

  test('a 429 is a rate-limit, distinguishable from a hard failure', async () => {
    const { impl } = recordingFetch(() => new Response('slow down', { status: 429, headers: { 'Retry-After': '30' } }));
    const err = await fetchAddressUtxos({ api: 'https://idx/api', address: MAINNET_ADDRESS, network: 'mainnet', fetchImpl: impl })
      .then(() => null, (e: unknown) => e as IndexerError);
    expect(err).toBeInstanceOf(IndexerError);
    expect(err!.kind).toBe('rate_limited');
    expect(err!.retryAfterSec).toBe(30);
  });

  test('any other non-ok status is a hard failure', async () => {
    const { impl } = recordingFetch(() => new Response('boom', { status: 503 }));
    const err = await fetchAddressUtxos({ api: 'https://idx/api', address: MAINNET_ADDRESS, network: 'mainnet', fetchImpl: impl })
      .then(() => null, (e: unknown) => e as IndexerError);
    expect(err).toBeInstanceOf(IndexerError);
    expect(err!.kind).toBe('unavailable');
  });

  test('the faucet path still resolves its UTXOs through the same seam', async () => {
    const { impl, calls } = recordingFetch(
      okUtxos([
        { txid: 'a'.repeat(64), vout: 0, value: 50_000, status: { confirmed: true } },
        { txid: 'b'.repeat(64), vout: 1, value: 30_000, status: { confirmed: false } },
      ])
    );
    const cfg = resolveIndexer({ BTC_INDEXER_TOKEN: 'tok' }, 'testnet');
    const utxos = await fetchFaucetUtxos({ ...cfg, address: TESTNET_ADDRESS, network: 'testnet', fetchImpl: impl });
    expect(calls[0].url).toBe(`${DEFAULT_INDEXER_API.testnet}/address/${TESTNET_ADDRESS}/utxo`);
    expect(calls[0].headers.authorization).toBe('Bearer tok');
    expect(utxos).toHaveLength(1); // confirmed only
    expect(utxos[0].value).toBe(50_000);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The route: fail closed, disclose, persist.
// ───────────────────────────────────────────────────────────────────────────
describe('GET /api/btc/deposit through the seam', () => {
  function harness(opts: {
    reply: (url: string) => Response | Promise<Response>;
    indexer?: { api: string; authToken?: string; authHeader?: string };
    store?: ReturnType<typeof createInscriptionsStore>;
  }) {
    const { impl, calls } = recordingFetch(opts.reply);
    const inscriptions = opts.store ?? createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'u4-')) });
    const routes = createBitcoinRoutes({
      jwtSecret: JWT,
      provider: fakeProvider(),
      network: 'mainnet',
      indexer: opts.indexer ?? { api: 'https://idx.example/api' },
      inscriptions,
      fetchImpl: impl,
    });
    return { routes, calls, inscriptions };
  }

  test('the route reads through the configured seam, auth header included', async () => {
    const { routes, calls } = harness({
      reply: okUtxos([]),
      indexer: { api: 'https://paid.example/api', authToken: 'tok' },
    });
    const req = authedGet(MAINNET_ADDRESS);
    expect((await routes.deposit(req, new URL(req.url))).status).toBe(200);
    expect(calls[0].url).toBe(`https://paid.example/api/address/${MAINNET_ADDRESS}/utxo`);
    expect(calls[0].headers.authorization).toBe('Bearer tok');
  });

  test('the unconfirmed sum is still reported so "deposit detected" fires', async () => {
    const { routes } = harness({
      reply: okUtxos([{ txid: 'b'.repeat(64), vout: 0, value: 12_345, status: { confirmed: false } }]),
    });
    const req = authedGet(MAINNET_ADDRESS);
    const body = (await (await routes.deposit(req, new URL(req.url))).json()) as { unconfirmedSats: number };
    expect(body.unconfirmedSats).toBe(12_345);
  });

  test('an empty address is an empty set, 200, not an error', async () => {
    const { routes } = harness({ reply: okUtxos([]) });
    const req = authedGet(MAINNET_ADDRESS);
    const res = await routes.deposit(req, new URL(req.url));
    expect(res.status).toBe(200);
    expect((await res.json() as { confirmedUtxos: unknown[] }).confirmedUtxos).toEqual([]);
  });

  test('a hard indexer failure: named error, no address, no stale UTXO set', async () => {
    const { routes } = harness({ reply: () => new Response('boom', { status: 500 }) });
    const req = authedGet(MAINNET_ADDRESS);
    const res = await routes.deposit(req, new URL(req.url));
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('utxo_lookup_failed');
    expect(body.address).toBeUndefined();
    expect(body.confirmedUtxos).toBeUndefined();
    expect(body.estimatedCostSats).toBeUndefined();
  });

  test('an indexer rate-limit is its own disclosed state, not a hard failure', async () => {
    const { routes } = harness({
      reply: () => new Response('slow down', { status: 429, headers: { 'Retry-After': '42' } }),
    });
    const req = authedGet(MAINNET_ADDRESS);
    const res = await routes.deposit(req, new URL(req.url));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('indexer_rate_limited');
    expect(res.headers.get('Retry-After')).toBe('42');
    // Same fail-closed posture: nothing a UI could render as "send this here".
    expect(body.address).toBeUndefined();
    expect(body.confirmedUtxos).toBeUndefined();
    expect(body.estimatedCostSats).toBeUndefined();
  });

  test('the deposit poll has its own per-user bound, distinct from the QuickNode quota cap', async () => {
    const { routes } = harness({ reply: okUtxos([]) });
    let last: Response | undefined;
    for (let i = 0; i < 481; i++) {
      const req = authedGet(MAINNET_ADDRESS);
      last = await routes.deposit(req, new URL(req.url), `10.0.0.${i % 200}`);
      if (last.status === 429) break;
    }
    expect(last!.status).toBe(429);
    expect((await last!.json() as { error: string }).error).toBe('deposit_user_cap');
    expect(last!.headers.get('Retry-After')).toBeTruthy();

    // The QuickNode-quota routes are NOT what bounded it: the sat proxy, which
    // carries the quota cap, is untouched by a spent deposit budget.
    const token = signToken('sub-1', 'a@b.com', undefined, { secret: JWT });
    const satReq = new Request('http://host/api/btc/sat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: serializeCookie(getAuthCookieConfig(token)) },
      body: JSON.stringify({ txid: 'a'.repeat(64), vout: 0 }),
    });
    expect((await routes.sat(satReq, new URL(satReq.url))).status).toBe(200);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// R28 + R31 — a stuck state that survives the tab closing.
// ───────────────────────────────────────────────────────────────────────────
describe('deposit exhaustion is a disclosed, durable state (R28/R31)', () => {
  const dataDir = () => mkdtempSync(join(tmpdir(), 'u4-alert-'));

  function routesFor(store: ReturnType<typeof createInscriptionsStore>, reply: (url: string) => Response) {
    const { impl } = recordingFetch(reply);
    return createBitcoinRoutes({
      jwtSecret: JWT,
      provider: fakeProvider(),
      network: 'mainnet',
      indexer: { api: 'https://idx.example/api' },
      inscriptions: store,
      fetchImpl: impl,
    });
  }

  test('a user holding a confirmed deposit is told what they hold, not just that the call failed', async () => {
    const store = createInscriptionsStore({ dataDir: dataDir() });

    // 1. A good read: 40 000 sats confirmed at their address.
    const healthy = routesFor(store, okUtxos([{ txid: 'a'.repeat(64), vout: 0, value: 40_000, status: { confirmed: true } }]));
    const good = authedGet(MAINNET_ADDRESS);
    expect((await healthy.deposit(good, new URL(good.url))).status).toBe(200);

    // 2. The indexer goes away. The response is the disclosed state, and it
    //    carries what we last knew they hold — the thing a stranded creator
    //    actually needs to hear.
    const broken = routesFor(store, () => new Response('nope', { status: 500 }));
    const req = authedGet(MAINNET_ADDRESS);
    const res = await broken.deposit(req, new URL(req.url));
    const body = (await res.json()) as { error: string; depositAlert?: { kind: string; heldSats: number; address: string } };
    expect(body.error).toBe('utxo_lookup_failed');
    expect(body.depositAlert).toBeDefined();
    expect(body.depositAlert!.kind).toBe('indexer_unavailable');
    expect(body.depositAlert!.heldSats).toBe(40_000);
    expect(body.depositAlert!.address).toBe(MAINNET_ADDRESS);
  });

  test('a user who left during exhaustion sees the stuck state on the next visit', async () => {
    const store = createInscriptionsStore({ dataDir: dataDir() });
    const healthy = routesFor(store, okUtxos([{ txid: 'a'.repeat(64), vout: 0, value: 40_000, status: { confirmed: true } }]));
    const good = authedGet(MAINNET_ADDRESS);
    await healthy.deposit(good, new URL(good.url));

    const broken = routesFor(store, () => new Response('nope', { status: 500 }));
    const req = authedGet(MAINNET_ADDRESS);
    await broken.deposit(req, new URL(req.url));

    // The tab closes. The next visit loads Your Originals, which reads this
    // route — the alert is there, with no deposit poll in sight.
    const fresh = routesFor(store, okUtxos([]));
    const list = listReq();
    const body = (await (await fresh.inscribeList(list, new URL(list.url))).json()) as {
      depositAlert?: { kind: string; heldSats: number; firstSeenAt: string };
    };
    expect(body.depositAlert).toBeDefined();
    expect(body.depositAlert!.kind).toBe('indexer_unavailable');
    expect(body.depositAlert!.heldSats).toBe(40_000);
    expect(typeof body.depositAlert!.firstSeenAt).toBe('string');
  });

  test('a rate-limited read persists as its own kind', async () => {
    const store = createInscriptionsStore({ dataDir: dataDir() });
    const limited = routesFor(store, () => new Response('slow', { status: 429 }));
    const req = authedGet(MAINNET_ADDRESS);
    await limited.deposit(req, new URL(req.url));

    const fresh = routesFor(store, okUtxos([]));
    const list = listReq();
    const body = (await (await fresh.inscribeList(list, new URL(list.url))).json()) as {
      depositAlert?: { kind: string };
    };
    expect(body.depositAlert!.kind).toBe('indexer_rate_limited');
  });

  test('a healthy read clears the alert — the stuck state does not outlive the outage', async () => {
    const store = createInscriptionsStore({ dataDir: dataDir() });
    const broken = routesFor(store, () => new Response('nope', { status: 500 }));
    const bad = authedGet(MAINNET_ADDRESS);
    await broken.deposit(bad, new URL(bad.url));

    const healthy = routesFor(store, okUtxos([{ txid: 'a'.repeat(64), vout: 0, value: 40_000, status: { confirmed: true } }]));
    const good = authedGet(MAINNET_ADDRESS);
    expect((await healthy.deposit(good, new URL(good.url))).status).toBe(200);

    const list = listReq();
    const body = (await (await healthy.inscribeList(list, new URL(list.url))).json()) as {
      depositAlert?: unknown;
    };
    expect(body.depositAlert).toBeUndefined();
  });

  test('one user\'s alert never leaks into another user\'s response', async () => {
    const store = createInscriptionsStore({ dataDir: dataDir() });
    const broken = routesFor(store, () => new Response('nope', { status: 500 }));
    const bad = authedGet(MAINNET_ADDRESS, 'sub-1');
    await broken.deposit(bad, new URL(bad.url));

    const list = listReq('sub-2');
    const body = (await (await broken.inscribeList(list, new URL(list.url))).json()) as { depositAlert?: unknown };
    expect(body.depositAlert).toBeUndefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Bounding the seam without punishing the person it protects.
// ───────────────────────────────────────────────────────────────────────────
describe('the deposit poll bound spends only on reads that happen', () => {
  test('a request that never reaches the indexer does not consume the budget', async () => {
    const { impl, calls } = recordingFetch(okUtxos([]));
    const routes = createBitcoinRoutes({
      jwtSecret: JWT,
      provider: fakeProvider(),
      network: 'mainnet',
      indexer: { api: 'https://idx.example/api' },
      inscriptions: createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'u4-cap-')) }),
      fetchImpl: impl,
    });

    // 600 rejected requests — well past the 480/hour bound — none of which
    // touch the indexer. A buggy or hostile client must not be able to spend
    // an honest creator's poll budget on reads that never happened.
    for (let i = 0; i < 600; i++) {
      const req = authedGet(TESTNET_ADDRESS); // wrong network for these routes
      const res = await routes.deposit(req, new URL(req.url), `10.1.0.${i % 200}`);
      expect(res.status).toBe(400);
    }
    expect(calls).toHaveLength(0);

    // The real poll still works.
    const good = authedGet(MAINNET_ADDRESS);
    expect((await routes.deposit(good, new URL(good.url))).status).toBe(200);
  });

  test('an ongoing outage keeps ONE clock across repeated polls', async () => {
    const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'u4-clock-')) });
    const { impl } = recordingFetch(() => new Response('nope', { status: 500 }));
    const routes = createBitcoinRoutes({
      jwtSecret: JWT,
      provider: fakeProvider(),
      network: 'mainnet',
      indexer: { api: 'https://idx.example/api' },
      inscriptions: store,
      fetchImpl: impl,
    });
    const first = authedGet(MAINNET_ADDRESS);
    const a = (await (await routes.deposit(first, new URL(first.url))).json()) as {
      depositAlert: { firstSeenAt: string };
    };
    for (let i = 0; i < 5; i++) {
      const again = authedGet(MAINNET_ADDRESS);
      await routes.deposit(again, new URL(again.url));
    }
    // "How long has this been going on" must survive the 15s poll re-stamping it.
    expect(store.getDepositAlert('sub-1')!.firstSeenAt).toBe(a.depositAlert.firstSeenAt);
  });
});
