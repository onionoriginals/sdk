import { describe, test, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { hex, base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { serializeCookie } from '../cookies';
import {
  createBitcoinRoutes,
  rawKeyFaucetSigner,
  fetchFaucetUtxos,
  fetchAddressUtxos,
  p2wpkhScriptHex,
  estimateInscriptionCostSats,
  P2TR_OUTPUT_VB,
  P2WPKH_OUTPUT_VB,
  type OrdinalLookup,
} from '../bitcoin';
import { createInscriptionsStore } from '../inscriptions-store';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

/**
 * An ordinal classifier that answers for every outpoint (U15). The deposit
 * route fails CLOSED without one — an unclassified output is never spendable —
 * so every deposit test states what the index says about its UTXOs.
 */
function ordinalsSaying(inscribed: string[] = []): OrdinalLookup {
  const set = new Set(inscribed.map((o) => o.toLowerCase()));
  return {
    async outpointInscriptions({ txid, vout }) {
      return set.has(`${txid.toLowerCase()}:${vout}`) ? [`${txid}i0`] : [];
    },
  };
}

/** A classifier that cannot answer — the fail-closed case. */
const ordinalsDown: OrdinalLookup = {
  async outpointInscriptions() {
    throw new Error('ord_getOutput failed (503)');
  },
};

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

  function depositDeps(
    utxos: Array<{ txid: string; vout: number; value: number; status?: { confirmed?: boolean } }>,
    ordinals: OrdinalLookup = ordinalsSaying()
  ) {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(utxos), { status: 200 })) as unknown as typeof fetch;
    return {
      jwtSecret: JWT,
      provider: fakeProvider(),
      network: 'mainnet' as const,
      depositApi: 'https://mempool.example/api',
      ordinals,
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

  function harness(
    utxos: Array<{ txid: string; vout: number; value: number; status?: { confirmed?: boolean } }>,
    ordinals: OrdinalLookup = ordinalsSaying()
  ) {
    const fetchImpl = (async () =>
      new Response(JSON.stringify(utxos), { status: 200 })) as unknown as typeof fetch;
    const inscriptions = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'dep-')) });
    const routes = createBitcoinRoutes({
      jwtSecret: JWT,
      provider: fakeProvider(),
      network: 'mainnet' as const,
      depositApi: 'https://mempool.example/api',
      fetchImpl,
      ordinals,
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

  async function depositBody(routes: ReturnType<typeof harness>['routes'], address = MAINNET_ADDRESS) {
    const r = req(address);
    const res = await routes.deposit(r, new URL(r.url));
    return {
      status: res.status,
      body: (await res.json()) as {
        confirmedUtxos: Array<{ txid: string; value: number }>;
        confirmedSats: number;
        ordinalCheck: 'ok' | 'unavailable';
        network: string;
      },
    };
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

  /**
   * U15 — the guard that summing made load-bearing. Until funding was summed,
   * postage (546) sat below any single-UTXO threshold and arithmetic kept an
   * inscription output out of the selection. A sum has no such property.
   */
  test("a UTXO carrying the user's own existing inscription is excluded", async () => {
    const revealTxId = 'e'.repeat(64);
    const { routes } = harness(
      [
        // The inscribed sat came back to this address as the reveal's vout 0.
        { txid: revealTxId, vout: 0, value: 60_000, status: { confirmed: true } },
        { txid: 'd'.repeat(64), vout: 0, value: 40_000, status: { confirmed: true } },
      ],
      ordinalsSaying([`${revealTxId}:0`])
    );
    const { body } = await depositBody(routes);
    // Spending it would make an existing inscription's sat the DID sat of a
    // new one — even though it is the fattest UTXO at the address.
    expect(body.confirmedUtxos.map((u) => u.txid)).toEqual(['d'.repeat(64)]);
    expect(body.ordinalCheck).toBe('ok');
    // The BALANCE still reports it: what a block explorer shows and what we
    // will spend are different numbers, and saying so beats being disbelieved.
    expect(body.confirmedSats).toBe(100_000);
    expect(body.network).toBe('mainnet');
  });

  /**
   * The case the old exclusion list could not see: the list was built from
   * inscriptions THIS app made for THIS user, so an ordinal received at the
   * address (or inscribed elsewhere, or aged out of the per-user row cap) read
   * as ordinary change — and at 546 sats it is exactly the size that gets
   * pulled in as a top-up and burned as fees.
   */
  test('a dust-sized output carrying an inscription this app did not create is also excluded', async () => {
    const strayOrdinal = '9'.repeat(64);
    const { routes, inscriptions } = harness(
      [
        { txid: strayOrdinal, vout: 0, value: 546, status: { confirmed: true } },
        { txid: 'd'.repeat(64), vout: 0, value: 40_000, status: { confirmed: true } },
      ],
      ordinalsSaying([`${strayOrdinal}:0`])
    );
    // No record of it anywhere in this app's store — that is the point.
    expect(inscriptions.list('sub-1')).toEqual([]);
    const { body } = await depositBody(routes);
    expect(body.confirmedUtxos.map((u) => u.txid)).toEqual(['d'.repeat(64)]);
    expect(body.confirmedSats).toBe(40_546);
  });

  test('with the ordinal lookup unavailable, selection refuses rather than guessing', async () => {
    const { routes } = harness(
      [{ txid: 'd'.repeat(64), vout: 0, value: 40_000, status: { confirmed: true } }],
      ordinalsDown
    );
    const { status, body } = await depositBody(routes);
    // The address and the quote are still honest; only the SPEND is withheld.
    expect(status).toBe(200);
    expect(body.ordinalCheck).toBe('unavailable');
    expect(body.confirmedUtxos).toEqual([]);
    expect(body.confirmedSats).toBe(40_000);
  });

  test('with no classifier configured at all, nothing is offered as spendable', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([{ txid: 'd'.repeat(64), vout: 0, value: 40_000, status: { confirmed: true } }]),
        { status: 200 }
      )) as unknown as typeof fetch;
    const routes = createBitcoinRoutes({
      jwtSecret: JWT,
      provider: fakeProvider(),
      network: 'mainnet',
      depositApi: 'https://mempool.example/api',
      fetchImpl,
    });
    const { body } = await depositBody(routes);
    expect(body.ordinalCheck).toBe('unavailable');
    expect(body.confirmedUtxos).toEqual([]);
  });

  test('unconfirmed deposits are never offered as funding', async () => {
    const { routes } = harness([
      { txid: 'd'.repeat(64), vout: 0, value: 40_000, status: { confirmed: false } },
    ]);
    const { body } = await depositBody(routes);
    expect(body.confirmedUtxos).toEqual([]);
    expect(body.confirmedSats).toBe(0);
  });

  /**
   * The bindings file is the WHOLE of "this deposit address belongs to this
   * account" — nothing re-derives it from Turnkey. Reading a corrupt one as
   * `{}` would silently permit a rebind, which is a stranger's mainnet BTC
   * pointed at an address that is not theirs.
   */
  test('an unreadable bindings file fails closed instead of permitting a rebind', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dep-corrupt-'));
    const inscriptions = createInscriptionsStore({ dataDir });
    inscriptions.bindDepositAddress('sub-1', 'mainnet', MAINNET_ADDRESS);
    mkdirSync(join(dataDir, 'deposits'), { recursive: true });
    writeFileSync(join(dataDir, 'deposits', 'sub-1.json'), '{ this is not json');

    const fetchImpl = (async () => new Response('[]', { status: 200 })) as unknown as typeof fetch;
    const routes = createBitcoinRoutes({
      jwtSecret: JWT,
      provider: fakeProvider(),
      network: 'mainnet',
      depositApi: 'https://mempool.example/api',
      ordinals: ordinalsSaying(),
      fetchImpl,
      inscriptions,
    });
    // Not a rebind to whatever the caller now claims — a named refusal.
    const r = req(OTHER_ADDRESS);
    const res = await routes.deposit(r, new URL(r.url));
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('deposit_binding_unreadable');
    expect(body.address).toBeUndefined();
  });
});

/**
 * R25 — no service fee ships at launch, but the deposit and estimate shapes
 * must not foreclose one. The quote is derived from a LIST of commit outputs,
 * so a platform fee output is an added entry, not a re-derived constant.
 */
describe('the cost estimate does not assume a single spend output (R25)', () => {
  const base = { feeRate: 3, inputs: 1, contentBytes: 8_000 };

  test('a third commit output can be priced without changing anything else', () => {
    const today = estimateInscriptionCostSats({
      ...base,
      commitOutputsVB: [P2TR_OUTPUT_VB, P2WPKH_OUTPUT_VB],
    });
    const withPlatformFee = estimateInscriptionCostSats({
      ...base,
      commitOutputsVB: [P2TR_OUTPUT_VB, P2WPKH_OUTPUT_VB, P2WPKH_OUTPUT_VB],
    });
    // One more P2WPKH output is 31 vB: at 3 sat/vB with the 1.5x buffer that
    // is 139.5 sats, and the ceil applies to the WHOLE quote — so the delta is
    // that figure rounded either way, and nothing else moves.
    const delta = withPlatformFee - today;
    expect(delta).toBeGreaterThanOrEqual(Math.floor(3 * P2WPKH_OUTPUT_VB * 1.5));
    expect(delta).toBeLessThanOrEqual(Math.ceil(3 * P2WPKH_OUTPUT_VB * 1.5));
  });

  test('inputs and outputs are independent terms', () => {
    const outputs = [P2TR_OUTPUT_VB, P2WPKH_OUTPUT_VB];
    const one = estimateInscriptionCostSats({ ...base, inputs: 1, commitOutputsVB: outputs });
    const two = estimateInscriptionCostSats({ ...base, inputs: 2, commitOutputsVB: outputs });
    expect(two - one).toBe(Math.ceil(3 * 68 * 1.5));
  });

  test('postage is added on top of the buffer, never multiplied through it', () => {
    const withPostage = estimateInscriptionCostSats({ ...base, commitOutputsVB: [P2TR_OUTPUT_VB] });
    const withoutPostage = estimateInscriptionCostSats({
      ...base,
      commitOutputsVB: [P2TR_OUTPUT_VB],
      postageSats: 0,
    });
    expect(withPostage - withoutPostage).toBe(546);
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

/**
 * R3 / KTD3 — ONE fee source for the money path. The deposit quote and the
 * /api/btc/fee estimate the inscribe path builds against must be the same
 * number from the same estimator, and neither may invent a fallback: a
 * floored 1 sat/vB quote names a deposit the SDK's FEE_RATE_REQUIRED path
 * would refuse to spend at, stranding a stranger's real BTC.
 */
describe('one fee source for deposit estimate and inscribe (R3)', () => {
  const MAINNET_ADDRESS = btc.p2wpkh(FAUCET_PUB, btc.NETWORK).address!;

  /** A provider whose estimateFee is scripted per call, and counted. */
  function feeProvider(script: () => number | Promise<number>) {
    const calls = { n: 0 };
    const provider = {
      async getFirstSatOfOutput() { return '5000000000'; },
      async estimateFee() { calls.n++; return await script(); },
      async broadcastTransaction() { return 'f'.repeat(64); },
      async getSpendableUtxos() {
        return [{ txid: 'a'.repeat(64), vout: 0, value: 100_000, scriptPubKey: FAUCET_SCRIPT }];
      },
    } as unknown as Parameters<typeof createBitcoinRoutes>[0]['provider'];
    return { provider, calls };
  }

  function routesFor(
    provider: Parameters<typeof createBitcoinRoutes>[0]['provider'],
    opts?: { now?: () => number }
  ) {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([{ txid: 'a'.repeat(64), vout: 0, value: 400_000, status: { confirmed: true } }]),
        { status: 200 }
      )) as unknown as typeof fetch;
    return createBitcoinRoutes({
      jwtSecret: JWT,
      provider,
      network: 'mainnet' as const,
      depositApi: 'https://mempool.example/api',
      fetchImpl,
      now: opts?.now,
    });
  }

  function depositReq(address = MAINNET_ADDRESS) {
    const token = signToken('sub-1', 'a@b.com', undefined, { secret: JWT });
    const cookie = serializeCookie(getAuthCookieConfig(token));
    return new Request(`http://host/api/btc/deposit?address=${encodeURIComponent(address)}`, {
      method: 'GET',
      headers: { cookie },
    });
  }

  test('the deposit quote and the inscribe-path fee estimate read the same rate', async () => {
    // An estimator that would return a DIFFERENT rate on a second call: if the
    // two routes each called it, they would disagree.
    let n = 0;
    const { provider } = feeProvider(() => (++n === 1 ? 9 : 40));
    const r = routesFor(provider);

    const dep = depositReq();
    const depBody = (await (await r.deposit(dep, new URL(dep.url))).json()) as { estimatedCostSats: number };

    const feeReq = authedReq('/api/btc/fee', { blocks: 1 });
    const feeBody = (await (await r.fee(feeReq, new URL(feeReq.url))).json()) as { feeRate: number };

    expect(feeBody.feeRate).toBe(9);
    // The quote is that same 9 sat/vB: one input, 8 000-byte default content.
    const revealVB = 111 + Math.ceil((8_000 + 300) / 4);
    expect(depBody.estimatedCostSats).toBe(Math.ceil(9 * (85 + 68 + revealVB) * 1.5) + 546);
  });

  test('estimator down: the deposit route returns a named error, no cost figure, no address', async () => {
    const { provider } = feeProvider(() => { throw new Error('quicknode down'); });
    const r = routesFor(provider);
    const req = depositReq();
    const res = await r.deposit(req, new URL(req.url));

    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('fee_estimate_unavailable');
    // Nothing a UI could turn into "send this much here".
    expect(body.estimatedCostSats).toBeUndefined();
    expect(body.address).toBeUndefined();
    expect(body.confirmedUtxos).toBeUndefined();
  });

  test('estimator down: the fee proxy fails closed rather than returning a floor', async () => {
    const { provider } = feeProvider(() => { throw new Error('quicknode down'); });
    const r = routesFor(provider);
    const req = authedReq('/api/btc/fee', { blocks: 1 });
    const res = await r.fee(req, new URL(req.url));
    expect(res.status).toBe(502);
    expect((await res.json() as { feeRate?: number }).feeRate).toBeUndefined();
  });

  test('estimator down: the faucet funding route refuses rather than flooring to 1 sat/vB', async () => {
    const { provider } = feeProvider(() => { throw new Error('quicknode down'); });
    const r = createBitcoinRoutes({
      jwtSecret: JWT,
      provider,
      faucet: { address: FAUCET_ADDRESS, signFundingTx: faucetSignFundingTx },
      faucetSats: 20_000,
    });
    const req = authedReq('/api/btc/funding', { address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' });
    const res = await r.funding(req, new URL(req.url));
    expect(res.status).toBe(502);
    expect((await res.json() as { error: string }).error).toBe('fee_estimate_unavailable');
  });

  test('an absurd rate above the SDK maximum is rejected, not quoted', async () => {
    // MAX_REASONABLE_FEE_RATE in the SDK is 10 000 sat/vB.
    const { provider } = feeProvider(() => 10_001);
    const r = routesFor(provider);
    const req = depositReq();
    const res = await r.deposit(req, new URL(req.url));
    expect(res.status).toBe(502);
    expect((await res.json() as { error: string }).error).toBe('fee_estimate_unavailable');
  });

  test('a non-positive / non-finite rate is rejected, not floored', async () => {
    for (const bad of [0, -3, Number.NaN]) {
      const { provider } = feeProvider(() => bad);
      const r = routesFor(provider);
      const req = depositReq();
      const res = await r.deposit(req, new URL(req.url));
      expect(res.status).toBe(502);
      expect((await res.json() as { error: string }).error).toBe('fee_estimate_unavailable');
    }
  });

  test('the 60s cache keeps a 15s poll off the estimator, and expiry refreshes once', async () => {
    let clock = 1_000_000;
    const { provider, calls } = feeProvider(() => 5);
    const r = routesFor(provider, { now: () => clock });

    // Four polls 15s apart inside one 60s window → exactly one estimator call.
    for (let i = 0; i < 4; i++) {
      const req = depositReq();
      expect((await r.deposit(req, new URL(req.url))).status).toBe(200);
      clock += 15_000;
    }
    expect(calls.n).toBe(1);

    // Past 60s: one more call, shared by the fee proxy on the same tick.
    clock += 61_000;
    const dep = depositReq();
    await r.deposit(dep, new URL(dep.url));
    const feeReq = authedReq('/api/btc/fee', { blocks: 1 });
    await r.fee(feeReq, new URL(feeReq.url));
    expect(calls.n).toBe(2);
  });

  test('a synchronous estimator throw does not poison the shared slot', async () => {
    // A provider that validates its config BEFORE returning a promise throws
    // synchronously. If the single-flight slot keeps that rejected promise,
    // every later poll re-serves the same failure and the creator can never
    // recover without a server restart.
    let first = true;
    const calls = { n: 0 };
    const provider = {
      estimateFee() {
        calls.n++;
        if (first) { first = false; throw new Error('no endpoint configured'); }
        return Promise.resolve(5);
      },
      async getFirstSatOfOutput() { return '5000000000'; },
      async broadcastTransaction() { return 'f'.repeat(64); },
      async getSpendableUtxos() { return []; },
    } as unknown as Parameters<typeof createBitcoinRoutes>[0]['provider'];
    const r = routesFor(provider);

    const a = depositReq();
    expect((await r.deposit(a, new URL(a.url))).status).toBe(502);
    // The estimator is healthy now — the retry must actually reach it.
    const b = depositReq();
    expect((await r.deposit(b, new URL(b.url))).status).toBe(200);
    expect(calls.n).toBe(2);
  });

  test('an expired cache triggers exactly one refresh across concurrent requests', async () => {
    let clock = 1_000_000;
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { provider, calls } = feeProvider(async () => { await gate; return 7; });
    const r = routesFor(provider, { now: () => clock });

    // Six concurrent cold-cache requests: without single-flight dedup each
    // one issues its own QuickNode call.
    const inFlight = Array.from({ length: 6 }, () => {
      const req = depositReq();
      return r.deposit(req, new URL(req.url));
    });
    await Promise.resolve();
    release!();
    const results = await Promise.all(inFlight);

    expect(calls.n).toBe(1);
    for (const res of results) expect(res.status).toBe(200);
  });
});

// U7: the /api/btc/* burst limiter keys on the client identity the server layer
// resolved, not on a header these routes read themselves (which was bypassable
// by rotating X-Forwarded-For). Driven through `deposit` — the route the 15s
// poll hits, and the only money-path route bounded by this limiter alone (no
// per-user quota cap). It has no depositApi here, so 503 means "passed the
// limiter" and 429 means "throttled".
describe('bitcoin routes client-identity rate limiting', () => {
  const poll = (r: ReturnType<typeof createBitcoinRoutes>, clientIp: string, xff: string) => {
    const token = signToken('sub-1', 'a@b.com', undefined, { secret: JWT });
    const url = new URL('http://host/api/btc/deposit?address=tb1qexample');
    const req = new Request(url, {
      headers: { cookie: serializeCookie(getAuthCookieConfig(token)), 'x-forwarded-for': xff },
    });
    return r.deposit(req, url, clientIp);
  };

  test('one client is throttled at the burst cap; a rotating header does not help', async () => {
    const r = createBitcoinRoutes(deps());
    let last: Response | undefined;
    // 120/min per client — the 121st from the same identity is refused even
    // though every request carries a different X-Forwarded-For.
    for (let i = 0; i < 121; i++) last = await poll(r, '203.0.113.7', `9.9.9.${i % 256}`);
    expect(last!.status).toBe(429);
    expect((await last!.json()).error).toBe('rate_limited');
    // A different client identity still has its own bucket.
    expect((await poll(r, '203.0.113.8', '9.9.9.9')).status).toBe(503);
  });

  test('the cap leaves room for the 15s deposit poll from several NATed creators', async () => {
    const r = createBitcoinRoutes(deps());
    // 4 polls/min each, one shared egress address: ten creators must all pass.
    let last: Response | undefined;
    for (let i = 0; i < 40; i++) last = await poll(r, '198.51.100.1', '1.1.1.1');
    expect(last!.status).toBe(503);
  });
});
