import { describe, test, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { hex, base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { serializeCookie } from '../cookies';
import { createBitcoinRoutes, rawKeyFaucetSigner, fetchFaucetUtxos, fetchAddressUtxos, p2wpkhScriptHex } from '../bitcoin';
import { createInscriptionsStore, type InscriptionRecord } from '../inscriptions-store';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const JWT = 'test-secret-at-least-32-chars-long!!';

// The faucet key: its P2WPKH script is what the faucet's UTXOs pay to, so the
// funding tx signs+finalizes cleanly with this key (mirrors the raw-key faucet).
const FAUCET_PRIV = hex.decode('3'.repeat(64));
const FAUCET_PUB = secp256k1.getPublicKey(FAUCET_PRIV, true);
const FAUCET_P2WPKH = btc.p2wpkh(FAUCET_PUB, btc.TEST_NETWORK);
const FAUCET_ADDRESS = FAUCET_P2WPKH.address!;
const FAUCET_SCRIPT = hex.encode(FAUCET_P2WPKH.script);

const faucetSignFundingTx = async (tx: btc.Transaction) => {
  tx.sign(FAUCET_PRIV);
  tx.finalize();
  return hex.encode(tx.extract());
};

function authedReq(path: string, body: unknown) {
  const token = signToken('sub-1', 'a@b.com', undefined, { secret: JWT });
  const cookie = serializeCookie(getAuthCookieConfig(token));
  return new Request(`http://host${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

function fakeProvider() {
  return {
    async getFirstSatOfOutput() { return '5000000000'; },
    async estimateFee() { return 3; },
    async broadcastTransaction() { return 'f'.repeat(64); },
    async getSpendableUtxos() {
      // Faucet UTXOs pay to the faucet address → the faucet key can sign them.
      return [{ txid: 'a'.repeat(64), vout: 0, value: 100_000, scriptPubKey: FAUCET_SCRIPT }];
    },
  } as unknown as Parameters<typeof createBitcoinRoutes>[0]['provider'];
}

const deps = () => ({
  jwtSecret: JWT,
  provider: fakeProvider(),
  faucet: { address: FAUCET_ADDRESS, signFundingTx: faucetSignFundingTx },
  faucetSats: 20_000,
});

describe('bitcoin routes', () => {
  test('POST /api/btc/sat proxies getFirstSatOfOutput', async () => {
    const r = createBitcoinRoutes(deps());
    const req = authedReq('/api/btc/sat', { txid: 'a'.repeat(64), vout: 0 });
    const res = await r.sat(req, new URL(req.url));
    expect(res.status).toBe(200);
    expect((await res.json()).satoshi).toBe('5000000000');
  });

  test('POST /api/btc/fee proxies estimateFee', async () => {
    const r = createBitcoinRoutes(deps());
    const req = authedReq('/api/btc/fee', { blocks: 1 });
    const res = await r.fee(req, new URL(req.url));
    expect((await res.json()).feeRate).toBe(3);
  });

  test('POST /api/btc/broadcast proxies broadcastTransaction', async () => {
    const r = createBitcoinRoutes(deps());
    const req = authedReq('/api/btc/broadcast', { txHex: '0200000000' });
    const res = await r.broadcast(req, new URL(req.url));
    expect((await res.json()).txid).toBe('f'.repeat(64));
  });

  test('anonymous request is rejected 401', async () => {
    const r = createBitcoinRoutes(deps());
    const req = new Request('http://host/api/btc/sat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ txid: 'a'.repeat(64), vout: 0 }),
    });
    const res = await r.sat(req, new URL(req.url));
    expect(res.status).toBe(401);
  });

  test("POST /api/btc/funding returns the user's funded outpoint + change address", async () => {
    const r = createBitcoinRoutes(deps());
    const userAddr = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
    const req = authedReq('/api/btc/funding', { address: userAddr });
    const res = await r.funding(req, new URL(req.url));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fundingUtxo: { txid: string; vout: number; value: number; scriptPubKey: string }; changeAddress: string };
    expect(body.changeAddress).toBe(userAddr);
    expect(body.fundingUtxo.txid).toMatch(/^[0-9a-f]{64}$/);
    expect(body.fundingUtxo.value).toBe(20_000);
    // scriptPubKey is REQUIRED by the SDK's commit builder — must be the user
    // output's P2WPKH script (0014 + 20-byte hash).
    expect(body.fundingUtxo.scriptPubKey).toMatch(/^0014[0-9a-f]{40}$/);
  });

  test('funding rejects a non-testnet address 400', async () => {
    const r = createBitcoinRoutes(deps());
    const req = authedReq('/api/btc/funding', { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' });
    const res = await r.funding(req, new URL(req.url));
    expect(res.status).toBe(400);
  });
});

describe('GET /api/btc/deposit (creator-pays)', () => {
  const MAINNET_P2WPKH = btc.p2wpkh(FAUCET_PUB, btc.NETWORK);
  const MAINNET_ADDRESS = MAINNET_P2WPKH.address!;

  function depositDeps(utxos: Array<{ txid: string; vout: number; value: number; status?: { confirmed?: boolean } }>) {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(utxos), { status: 200 })) as unknown as typeof fetch;
    return {
      jwtSecret: JWT,
      provider: fakeProvider(),
      network: 'mainnet' as const,
      depositApi: 'https://mempool.example/api',
      fetchImpl,
    };
  }

  function depositReq(address: string) {
    const token = signToken('sub-1', 'a@b.com', undefined, { secret: JWT });
    const cookie = serializeCookie(getAuthCookieConfig(token));
    return new Request(`http://host/api/btc/deposit?address=${encodeURIComponent(address)}`, {
      method: 'GET',
      headers: { cookie },
    });
  }

  test('returns confirmed UTXOs, unconfirmed sum, and a buffered cost estimate', async () => {
    const r = createBitcoinRoutes(depositDeps([
      { txid: 'a'.repeat(64), vout: 0, value: 40_000, status: { confirmed: true } },
      { txid: 'b'.repeat(64), vout: 1, value: 15_000, status: { confirmed: false } },
    ]));
    const req = depositReq(MAINNET_ADDRESS);
    const res = await r.deposit(req, new URL(req.url));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      address: string;
      confirmedUtxos: Array<{ txid: string; value: number; scriptPubKey: string }>;
      unconfirmedSats: number;
      estimatedCostSats: number;
    };
    expect(body.address).toBe(MAINNET_ADDRESS);
    expect(body.confirmedUtxos).toHaveLength(1);
    expect(body.confirmedUtxos[0].value).toBe(40_000);
    // scriptPubKey derived from the bc1q address — required by the SDK's commit builder.
    expect(body.confirmedUtxos[0].scriptPubKey).toBe(p2wpkhScriptHex(MAINNET_ADDRESS, 'mainnet'));
    expect(body.unconfirmedSats).toBe(15_000);
    // fee 3 sat/vB (fakeProvider) on a bounded tx + 1.5x buffer + postage:
    // sane range, never zero.
    expect(body.estimatedCostSats).toBeGreaterThan(546);
    expect(body.estimatedCostSats).toBeLessThan(100_000);
  });

  /**
   * R26 — the quote must track the number of inputs the creator will actually
   * spend. A flat one-input commit vsize under-quotes the moment a second UTXO
   * is selected, which drops the creator back into the shortfall state.
   */
  test('the quoted cost accounts for the number of inputs actually selected', async () => {
    async function quote(utxos: Array<{ txid: string; vout: number; value: number }>) {
      const r = createBitcoinRoutes(depositDeps(utxos.map((u) => ({ ...u, status: { confirmed: true } }))));
      const req = depositReq(MAINNET_ADDRESS);
      const res = await r.deposit(req, new URL(req.url));
      return (await res.json()) as { estimatedCostSats: number; confirmedUtxos: Array<{ value: number }> };
    }

    // One UTXO fat enough to fund the whole thing on its own: a one-input commit.
    const one = await quote([{ txid: 'a'.repeat(64), vout: 0, value: 400_000 }]);
    // Two UTXOs, neither sufficient alone: a two-input commit.
    const two = await quote([
      { txid: 'b'.repeat(64), vout: 0, value: 6_000 },
      { txid: 'c'.repeat(64), vout: 0, value: 6_000 },
    ]);

    // One extra P2WPKH input is 68 vB; at 3 sat/vB (fakeProvider) with the
    // 1.5x buffer that is exactly 306 sats more.
    expect(two.estimatedCostSats - one.estimatedCostSats).toBe(306);
    // And the quote is honest: the two UTXOs really do cover it.
    expect(two.confirmedUtxos.reduce((n, u) => n + u.value, 0)).toBeGreaterThanOrEqual(two.estimatedCostSats);

    // A third input costs another 306.
    const three = await quote([
      { txid: 'd'.repeat(64), vout: 0, value: 4_000 },
      { txid: 'e'.repeat(64), vout: 0, value: 4_000 },
      { txid: 'f'.repeat(64), vout: 0, value: 4_000 },
    ]);
    expect(three.estimatedCostSats - two.estimatedCostSats).toBe(306);

    // An empty address quotes the single-input cost — the creator has yet to
    // deposit, and the first deposit is one input.
    const none = await quote([]);
    expect(none.estimatedCostSats).toBe(one.estimatedCostSats);
  });

  test('rejects a testnet address on mainnet', async () => {
    const r = createBitcoinRoutes(depositDeps([]));
    const req = depositReq('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx');
    const res = await r.deposit(req, new URL(req.url));
    expect(res.status).toBe(400);
  });

  test('401 for anonymous; 503 when no deposit API is configured', async () => {
    const r = createBitcoinRoutes(depositDeps([]));
    const anon = new Request(`http://host/api/btc/deposit?address=${MAINNET_ADDRESS}`);
    expect((await r.deposit(anon, new URL(anon.url))).status).toBe(401);

    const noApi = createBitcoinRoutes({ jwtSecret: JWT, provider: fakeProvider() });
    const req = depositReq(MAINNET_ADDRESS);
    expect((await noApi.deposit(req, new URL(req.url))).status).toBe(503);
  });
});

describe('mainnet plumbing', () => {
  test('funding returns 404 when no faucet is configured (creator-pays deploy)', async () => {
    const r = createBitcoinRoutes({ jwtSecret: JWT, provider: fakeProvider(), network: 'mainnet' });
    const req = authedReq('/api/btc/funding', { address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' });
    const res = await r.funding(req, new URL(req.url));
    expect(res.status).toBe(404);
  });

  test('p2wpkhScriptHex handles bc1q on mainnet and rejects cross-network decode', () => {
    const mainnetAddr = btc.p2wpkh(FAUCET_PUB, btc.NETWORK).address!;
    expect(p2wpkhScriptHex(mainnetAddr, 'mainnet')).toMatch(/^0014[0-9a-f]{40}$/);
    expect(() => p2wpkhScriptHex(mainnetAddr, 'testnet')).toThrow();
  });

  test('fetchAddressUtxos splits confirmed from unconfirmed', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([
          { txid: 'a'.repeat(64), vout: 0, value: 50_000, status: { confirmed: true } },
          { txid: 'b'.repeat(64), vout: 1, value: 30_000, status: { confirmed: false } },
        ]),
        { status: 200 }
      )) as unknown as typeof fetch;
    const out = await fetchAddressUtxos({ api: 'https://x/api', address: FAUCET_ADDRESS, fetchImpl });
    expect(out.confirmed).toHaveLength(1);
    expect(out.unconfirmedSats).toBe(30_000);
  });
});

describe('rawKeyFaucetSigner', () => {
  test('decodes a testnet WIF to its tb1q address', () => {
    // Build a testnet compressed WIF (version 0xEF + priv + 0x01) from a known key.
    const wif = base58check(sha256).encode(new Uint8Array([0xef, ...FAUCET_PRIV, 0x01]));
    const signer = rawKeyFaucetSigner(wif);
    expect(signer.address).toBe(FAUCET_ADDRESS);
    expect(signer.address.startsWith('tb1q')).toBe(true);
  });

  test('rejects a mainnet WIF (version 0x80)', () => {
    const mainnetWif = base58check(sha256).encode(new Uint8Array([0x80, ...FAUCET_PRIV, 0x01]));
    expect(() => rawKeyFaucetSigner(mainnetWif)).toThrow('testnet WIF');
  });

  test('rejects an uncompressed testnet WIF (no 0x01 flag)', () => {
    const uncompressed = base58check(sha256).encode(new Uint8Array([0xef, ...FAUCET_PRIV]));
    expect(() => rawKeyFaucetSigner(uncompressed)).toThrow('COMPRESSED');
  });
});

describe('fetchFaucetUtxos (mempool.space)', () => {
  test('returns only confirmed UTXOs with the faucet address scriptPubKey', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([
          { txid: 'a'.repeat(64), vout: 0, value: 50_000, status: { confirmed: true } },
          { txid: 'b'.repeat(64), vout: 1, value: 30_000, status: { confirmed: false } }, // unconfirmed → dropped
        ]),
        { status: 200 }
      )) as unknown as typeof fetch;
    const utxos = await fetchFaucetUtxos({ api: 'https://x/api', address: FAUCET_ADDRESS, fetchImpl });
    expect(utxos).toHaveLength(1);
    expect(utxos[0].txid).toBe('a'.repeat(64));
    expect(utxos[0].value).toBe(50_000);
    expect(utxos[0].scriptPubKey).toBe(FAUCET_SCRIPT);
  });

  test('throws on a non-ok response', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch;
    await expect(fetchFaucetUtxos({ api: 'https://x/api', address: FAUCET_ADDRESS, fetchImpl })).rejects.toThrow();
  });

  test('aborts a hung request via the timeout', async () => {
    // fetchImpl respects the abort signal but never resolves on its own.
    const fetchImpl = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    await expect(
      fetchFaucetUtxos({ api: 'https://x/api', address: FAUCET_ADDRESS, fetchImpl, timeoutMs: 20 })
    ).rejects.toThrow();
  });
});


describe('GET /api/btc/deposit — ownership binding and ordinal safety', () => {
  const MAINNET_ADDRESS = btc.p2wpkh(FAUCET_PUB, btc.NETWORK).address!;
  // A second, unrelated mainnet address — stands in for "someone else's".
  const OTHER_ADDRESS = btc.p2wpkh(
    secp256k1.getPublicKey(hex.decode('7'.repeat(64)), true),
    btc.NETWORK
  ).address!;

  function harness(utxos: Array<{ txid: string; vout: number; value: number; status?: { confirmed?: boolean } }>) {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(utxos), { status: 200 })) as unknown as typeof fetch;
    const inscriptions = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'dep-')) });
    const routes = createBitcoinRoutes({
      jwtSecret: JWT,
      provider: fakeProvider(),
      network: 'mainnet' as const,
      depositApi: 'https://mempool.example/api',
      fetchImpl,
      inscriptions,
    });
    return { routes, inscriptions };
  }

  function req(address: string, sub = 'sub-1') {
    const token = signToken(sub, 'a@b.com', undefined, { secret: JWT });
    const cookie = serializeCookie(getAuthCookieConfig(token));
    return new Request(`http://host/api/btc/deposit?address=${encodeURIComponent(address)}`, {
      method: 'GET',
      headers: { cookie },
    });
  }

  test('binds one address per user: a later lookup of a DIFFERENT address is 403', async () => {
    const { routes } = harness([{ txid: 'a'.repeat(64), vout: 0, value: 40_000, status: { confirmed: true } }]);
    const first = req(MAINNET_ADDRESS);
    expect((await routes.deposit(first, new URL(first.url))).status).toBe(200);

    // Not a general UTXO-lookup proxy for arbitrary third-party addresses.
    const second = req(OTHER_ADDRESS);
    const res = await routes.deposit(second, new URL(second.url));
    expect(res.status).toBe(403);
    expect((await res.json() as { error: string }).error).toBe('address_not_bound');

    // A different user binds their own address independently.
    const other = req(OTHER_ADDRESS, 'sub-2');
    expect((await routes.deposit(other, new URL(other.url))).status).toBe(200);
  });

  test('excludes the user\'s own inscription outputs from the spendable set', async () => {
    const revealTxId = 'e'.repeat(64);
    const { routes, inscriptions } = harness([
      // The inscribed sat came back to this address as the reveal's vout 0.
      { txid: revealTxId, vout: 0, value: 60_000, status: { confirmed: true } },
      { txid: 'd'.repeat(64), vout: 0, value: 40_000, status: { confirmed: true } },
    ]);
    const rec: InscriptionRecord = {
      commitTxId: 'c'.repeat(64),
      revealTxId,
      inscriptionId: `${revealTxId}i0`,
      signedCommitHex: '02aa',
      revealTxHex: '02bb',
      fundingOutpoints: [`${'a'.repeat(64)}:0`],
      changeAddress: MAINNET_ADDRESS,
      status: 'reveal_broadcast',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    inscriptions.create('sub-1', rec);

    const r = req(MAINNET_ADDRESS);
    const body = (await (await routes.deposit(r, new URL(r.url))).json()) as {
      confirmedUtxos: Array<{ txid: string }>;
      network: string;
    };
    // Spending it would make an existing inscription's sat the DID sat of a
    // new one — even though it is the fattest UTXO at the address.
    expect(body.confirmedUtxos.map((u) => u.txid)).toEqual(['d'.repeat(64)]);
    expect(body.network).toBe('mainnet');
  });
});

describe('GET /api/btc/network', () => {
  test('reports the network these routes speak, unauthenticated', async () => {
    const routes = createBitcoinRoutes({
      jwtSecret: JWT,
      provider: fakeProvider(),
      network: 'mainnet',
      faucet: { address: FAUCET_ADDRESS, signFundingTx: faucetSignFundingTx },
    });
    // No cookie: the browser needs this BEFORE any gated flow, to detect a
    // build-time/runtime skew before it shows anyone a deposit address.
    const anon = new Request('http://host/api/btc/network');
    const res = await routes.networkInfo(anon, new URL(anon.url));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ network: 'mainnet', faucet: true });
  });

  test('defaults to testnet and reports an absent faucet', async () => {
    const routes = createBitcoinRoutes({ jwtSecret: JWT, provider: fakeProvider() });
    const anon = new Request('http://host/api/btc/network');
    expect(await (await routes.networkInfo(anon, new URL(anon.url))).json())
      .toEqual({ network: 'testnet', faucet: false });
  });
});
