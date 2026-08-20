/**
 * U15 / R29 — every money-path state transition emits a structured server log
 * line, and the periodic count of deposit addresses holding an unspent
 * confirmed balance.
 *
 * This is the whole instrument behind the "deploy and watch" posture: without
 * it, a stranger's BTC sitting unspendable at an address this app issued is
 * invisible to the operator forever. And because these lines link an
 * authenticated account to on-chain activity in a third-party log sink, the
 * identifier is part of the contract: Turnkey sub-org id, never an email.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { serializeCookie } from '../cookies';
import {
  createBitcoinRoutes,
  createDepositBalanceSweep,
  type OrdinalLookup,
} from '../bitcoin';
import { createInscriptionsStore } from '../inscriptions-store';
import { formatMoneyLog, createMoneyLogger } from '../money-log';

const JWT = 'test-secret-at-least-32-chars-long!!';
const EMAIL = 'stranger@example.com';

const PRIV = hex.decode('3'.repeat(64));
const PUB = secp256k1.getPublicKey(PRIV, true);
const ADDRESS = btc.p2wpkh(PUB, btc.NETWORK).address!;
const OTHER_ADDRESS = btc.p2wpkh(secp256k1.getPublicKey(hex.decode('7'.repeat(64)), true), btc.NETWORK).address!;

const noOrdinals: OrdinalLookup = { async outpointInscriptions() { return []; } };

/** Captured lines, plus the JSON payload each carries. */
function capture() {
  const lines: string[] = [];
  const log = createMoneyLogger((line) => lines.push(line));
  const events = () =>
    lines.map((l) => JSON.parse(l.slice(l.indexOf('{'))) as Record<string, unknown>);
  return { lines, log, events, of: (event: string) => events().filter((e) => e.event === event) };
}

function depositReq(address: string, sub = 'sub-1') {
  const token = signToken(sub, EMAIL, undefined, { secret: JWT });
  const cookie = serializeCookie(getAuthCookieConfig(token));
  return new Request(`http://host/api/btc/deposit?address=${encodeURIComponent(address)}`, {
    headers: { cookie },
  });
}

function depositHarness(opts: {
  utxos?: Array<{ txid: string; vout: number; value: number; status?: { confirmed?: boolean } }>;
  reply?: () => Response;
  ordinals?: OrdinalLookup;
  dataDir?: string;
}) {
  const cap = capture();
  const fetchImpl = (async () =>
    opts.reply
      ? opts.reply()
      : new Response(JSON.stringify(opts.utxos ?? []), { status: 200 })) as unknown as typeof fetch;
  const store = createInscriptionsStore({ dataDir: opts.dataDir ?? mkdtempSync(join(tmpdir(), 'money-')) });
  const routes = createBitcoinRoutes({
    jwtSecret: JWT,
    provider: {
      async estimateFee() { return 3; },
      async broadcastTransaction() { return 'f'.repeat(64); },
      async getTransactionStatus() { return { confirmed: false }; },
    } as unknown as Parameters<typeof createBitcoinRoutes>[0]['provider'],
    network: 'mainnet',
    indexer: { api: 'https://idx.example/api' },
    ordinals: opts.ordinals ?? noOrdinals,
    inscriptions: store,
    moneyLog: cap.log,
    fetchImpl,
  });
  return { routes, store, cap };
}

async function poll(h: ReturnType<typeof depositHarness>, address = ADDRESS, sub = 'sub-1') {
  const req = depositReq(address, sub);
  return h.routes.deposit(req, new URL(req.url));
}

describe('the log line itself', () => {
  test('is one grep-able, machine-readable line carrying the event and a timestamp', () => {
    const line = formatMoneyLog('deposit_seen', { sub: 'sub-1', confirmedSats: 40_000 }, new Date(0));
    expect(line.startsWith('[landing][money] ')).toBe(true);
    const payload = JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>;
    expect(payload.event).toBe('deposit_seen');
    expect(payload.sub).toBe('sub-1');
    expect(payload.confirmedSats).toBe(40_000);
    expect(payload.at).toBe('1970-01-01T00:00:00.000Z');
  });

  test('an email never reaches the sink — not by key, not by value', () => {
    // The sink is a third party. A future call site passing the wrong field
    // must not be the thing that decides whether an email is published.
    const line = formatMoneyLog('deposit_seen', {
      sub: 'sub-1',
      email: EMAIL,
      detail: `rejected for ${EMAIL}`,
    });
    expect(line).not.toContain('@');
    expect(line).toContain('[redacted]');
  });

  test('a throwing sink cannot fail a money-path request', () => {
    const log = createMoneyLogger(() => { throw new Error('log drain down'); });
    expect(() => log('inscribe_attempted', { sub: 'sub-1' })).not.toThrow();
  });
});

describe('deposit-path transitions (R29)', () => {
  test('a newly bound address is logged once, by sub-org id and never by email', async () => {
    const h = depositHarness({});
    await poll(h);
    const issued = h.cap.of('deposit_address_issued');
    expect(issued).toHaveLength(1);
    expect(issued[0].sub).toBe('sub-1');
    expect(issued[0].address).toBe(ADDRESS);
    expect(issued[0].network).toBe('mainnet');
    // A second poll is not a second issuance.
    await poll(h);
    expect(h.cap.of('deposit_address_issued')).toHaveLength(1);
    expect(h.cap.lines.join('\n')).not.toContain(EMAIL);
  });

  test('the first confirmed deposit is logged once, not on every 15s poll', async () => {
    const h = depositHarness({
      utxos: [{ txid: 'a'.repeat(64), vout: 0, value: 40_000, status: { confirmed: true } }],
    });
    await poll(h);
    await poll(h);
    await poll(h);
    const seen = h.cap.of('deposit_seen');
    expect(seen).toHaveLength(1);
    expect(seen[0].confirmedSats).toBe(40_000);
    expect(seen[0].sub).toBe('sub-1');
  });

  test('a shortfall names the gap, and repeats only when the balance changes', async () => {
    let value = 2_000;
    const cap = capture();
    const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'money-')) });
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify([{ txid: 'a'.repeat(64), vout: 0, value, status: { confirmed: true } }]),
        { status: 200 }
      )) as unknown as typeof fetch;
    const routes = createBitcoinRoutes({
      jwtSecret: JWT,
      provider: {
        async estimateFee() { return 3; },
      } as unknown as Parameters<typeof createBitcoinRoutes>[0]['provider'],
      network: 'mainnet',
      indexer: { api: 'https://idx.example/api' },
      ordinals: noOrdinals,
      inscriptions: store,
      moneyLog: cap.log,
      fetchImpl,
    });
    const run = async () => {
      const req = depositReq(ADDRESS);
      return routes.deposit(req, new URL(req.url));
    };
    await run();
    await run(); // same balance — no second line
    expect(cap.of('deposit_shortfall')).toHaveLength(1);
    const first = cap.of('deposit_shortfall')[0];
    expect(first.spendableSats).toBe(2_000);
    expect(Number(first.shortfallSats)).toBeGreaterThan(0);
    expect(Number(first.shortfallSats)).toBe(Number(first.estimatedCostSats) - 2_000);

    // A top-up that still falls short IS a new state.
    value = 3_000;
    await run();
    expect(cap.of('deposit_shortfall')).toHaveLength(2);
  });

  test('an untrusted read is logged with which failure it was', async () => {
    const h = depositHarness({ reply: () => new Response('slow down', { status: 429 }) });
    await poll(h);
    const failed = h.cap.of('deposit_read_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBe('indexer_rate_limited');
    expect(failed[0].sub).toBe('sub-1');
  });

  test('an unclassifiable output is logged as a refusal, not silently spent', async () => {
    const h = depositHarness({
      utxos: [{ txid: 'a'.repeat(64), vout: 0, value: 40_000, status: { confirmed: true } }],
      ordinals: { async outpointInscriptions() { throw new Error('ord_getOutput failed (503)'); } },
    });
    await poll(h);
    const refused = h.cap.of('deposit_ordinal_check_unavailable');
    expect(refused).toHaveLength(1);
    expect(refused[0].candidates).toBe(1);
    expect(refused[0].sub).toBe('sub-1');
  });

  test('an unreadable bindings file is a logged refusal', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'money-corrupt-'));
    mkdirSync(join(dataDir, 'deposits'), { recursive: true });
    writeFileSync(join(dataDir, 'deposits', 'sub-1.json'), 'not json at all');
    const h = depositHarness({ dataDir });
    const res = await poll(h);
    expect(res.status).toBe(503);
    expect(h.cap.of('deposit_read_failed')[0].reason).toBe('binding_unreadable');
  });
});

describe('inscribe-path transitions (R29)', () => {
  const USER_PRIV = hex.decode('4'.repeat(64));
  const USER_PUB = secp256k1.getPublicKey(USER_PRIV, true);
  const USER_P2WPKH = btc.p2wpkh(USER_PUB, btc.TEST_NETWORK);
  const USER_ADDRESS = USER_P2WPKH.address!;
  const USER_SCRIPT = hex.encode(USER_P2WPKH.script);

  function buildPair(fundingTxid = 'a'.repeat(64)) {
    const commit = new btc.Transaction();
    commit.addInput({
      txid: fundingTxid,
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: USER_P2WPKH.script, amount: 50_000n },
    });
    commit.addOutputAddress(USER_ADDRESS, 20_000n, btc.TEST_NETWORK);
    commit.addOutputAddress(USER_ADDRESS, 29_000n, btc.TEST_NETWORK);
    commit.sign(USER_PRIV);
    commit.finalize();
    const reveal = new btc.Transaction();
    reveal.addInput({
      txid: commit.id,
      index: 0,
      sequence: 0xfffffffd,
      witnessUtxo: { script: USER_P2WPKH.script, amount: 20_000n },
    });
    reveal.addOutputAddress(USER_ADDRESS, 19_000n, btc.TEST_NETWORK);
    reveal.sign(USER_PRIV);
    reveal.finalize();
    return {
      signedCommitHex: hex.encode(commit.extract()),
      commitTxId: commit.id,
      revealTxHex: hex.encode(reveal.extract()),
      revealTxId: reveal.id,
      fundingUtxos: [{ txid: fundingTxid, vout: 0, value: 50_000, scriptPubKey: USER_SCRIPT }],
      changeAddress: USER_ADDRESS,
    };
  }

  function inscribeHarness(broadcast?: (txHex: string) => Promise<string>) {
    const cap = capture();
    const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'money-insc-')) });
    const routes = createBitcoinRoutes({
      jwtSecret: JWT,
      provider: {
        async broadcastTransaction(txHex: string) {
          return broadcast ? broadcast(txHex) : 'f'.repeat(64);
        },
        async getTransactionStatus() { return { confirmed: false }; },
        async estimateFee() { return 3; },
      } as unknown as Parameters<typeof createBitcoinRoutes>[0]['provider'],
      inscriptions: store,
      moneyLog: cap.log,
    });
    return { routes, cap };
  }

  async function submit(routes: ReturnType<typeof inscribeHarness>['routes'], body: unknown) {
    const token = signToken('sub-1', EMAIL, undefined, { secret: JWT });
    const cookie = serializeCookie(getAuthCookieConfig(token));
    const req = new Request('http://host/api/btc/inscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    return routes.inscribe(req, new URL(req.url));
  }

  test('an attempt and its broadcast are both on the record', async () => {
    const { routes, cap } = inscribeHarness();
    const pair = buildPair();
    expect((await submit(routes, pair)).status).toBe(200);
    const attempted = cap.of('inscribe_attempted');
    expect(attempted).toHaveLength(1);
    expect(attempted[0].sub).toBe('sub-1');
    expect(attempted[0].commitTxId).toBe(pair.commitTxId);
    expect(attempted[0].inputs).toBe(1);
    expect(attempted[0].fundingSats).toBe(50_000);
    const broadcast = cap.of('inscribe_broadcast');
    expect(broadcast).toHaveLength(1);
    expect(broadcast[0].status).toBe('reveal_broadcast');
    expect(cap.lines.join('\n')).not.toContain(EMAIL);
  });

  test('a failure carries the reason that decides what an operator does next', async () => {
    const { routes, cap } = inscribeHarness();
    const pair = buildPair();
    // Declared funding that the commit does not spend: a client bug, refused.
    await submit(routes, { ...pair, fundingUtxos: [{ txid: 'b'.repeat(64), vout: 3, value: 50_000 }] });
    const failed = cap.of('inscribe_failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBe('commit_inputs_mismatch');
    expect(cap.of('inscribe_attempted')).toHaveLength(0); // never reached the money
  });

  test('a reveal that fails to broadcast is logged as an incomplete transition', async () => {
    const pair = buildPair();
    const { routes, cap } = inscribeHarness(async (txHex) => {
      if (txHex === pair.revealTxHex) throw new Error('connection reset');
      return 'f'.repeat(64);
    });
    const res = await submit(routes, pair);
    expect((await res.json() as { status: string }).status).toBe('commit_broadcast');
    expect(cap.of('inscribe_failed')[0].reason).toBe('reveal_broadcast_failed');
    expect(cap.of('inscribe_broadcast')[0].status).toBe('commit_broadcast');
  });
});

describe('the periodic balance sweep (R29)', () => {
  function sweepHarness(opts: {
    balances: Record<string, number>;
    maxPerPass?: number;
    now?: () => number;
  }) {
    const cap = capture();
    // The store shares the sweep's clock: `lastReadAt` is what the drop-out
    // rule is measured against, so a store stamping real time would make the
    // aging test meaningless.
    const store = createInscriptionsStore({
      dataDir: mkdtempSync(join(tmpdir(), 'sweep-')),
      ...(opts.now ? { now: opts.now } : {}),
    });
    const fetchImpl = (async (url: string) => {
      const address = String(url).split('/address/')[1].split('/')[0];
      const sats = opts.balances[address] ?? 0;
      return new Response(
        JSON.stringify(
          sats > 0 ? [{ txid: 'a'.repeat(64), vout: 0, value: sats, status: { confirmed: true } }] : []
        ),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const sweep = createDepositBalanceSweep({
      store,
      indexer: { api: 'https://idx.example/api' },
      network: 'mainnet',
      moneyLog: cap.log,
      fetchImpl,
      maxPerPass: opts.maxPerPass,
      now: opts.now,
    });
    return { sweep, store, cap };
  }

  test('reports a nonzero count when a bound address still holds a confirmed balance', async () => {
    const { sweep, store, cap } = sweepHarness({ balances: { [ADDRESS]: 40_000, [OTHER_ADDRESS]: 0 } });
    store.bindDepositAddress('sub-1', 'mainnet', ADDRESS);
    store.bindDepositAddress('sub-2', 'mainnet', OTHER_ADDRESS);

    const out = await sweep();
    expect(out.scanned).toBe(2);
    expect(out.withBalance).toBe(1);
    expect(out.heldSats).toBe(40_000);

    // The per-address finding names the account by sub-org id.
    const held = cap.of('deposit_balance_held');
    expect(held).toHaveLength(1);
    expect(held[0].sub).toBe('sub-1');
    expect(held[0].address).toBe(ADDRESS);
    expect(held[0].confirmedSats).toBe(40_000);

    // And the roll-up carries the count the operator actually watches.
    const rollup = cap.of('deposit_balance_sweep');
    expect(rollup).toHaveLength(1);
    expect(rollup[0].withBalance).toBe(1);
    expect(rollup[0].heldSats).toBe(40_000);
    expect(cap.lines.join('\n')).not.toContain('@');
  });

  test('respects its per-pass cap and rotates, rather than scanning every address ever bound', async () => {
    const balances: Record<string, number> = {};
    const { sweep, store, cap } = sweepHarness({ balances, maxPerPass: 2 });
    // Six bound addresses; the cap is two reads per pass.
    const addresses: string[] = [];
    for (let i = 0; i < 6; i++) {
      const addr = btc.p2wpkh(
        secp256k1.getPublicKey(hex.decode(String(i + 1).repeat(64).slice(0, 64)), true),
        btc.NETWORK
      ).address!;
      addresses.push(addr);
      balances[addr] = 1_000; // all funded, so none can age out
      store.bindDepositAddress(`sub-${i}`, 'mainnet', addr);
    }
    const first = await sweep();
    expect(first.candidates).toBe(6);
    expect(first.scanned).toBe(2);

    // The next pass starts where the last one stopped: three passes cover six.
    await sweep();
    await sweep();
    const scannedAddresses = new Set(cap.of('deposit_balance_held').map((e) => e.address));
    expect(scannedAddresses.size).toBe(6);
  });

  test('an idle, empty, nothing-in-flight address drops out; a funded one never does', async () => {
    const day = 24 * 60 * 60_000;
    let clock = Date.parse('2026-01-01T00:00:00.000Z');
    const { sweep, store, cap } = sweepHarness({
      balances: { [ADDRESS]: 40_000, [OTHER_ADDRESS]: 0 },
      now: () => clock,
    });
    store.bindDepositAddress('sub-1', 'mainnet', ADDRESS);
    store.bindDepositAddress('sub-2', 'mainnet', OTHER_ADDRESS);

    // Pass one reads both and records what it found.
    expect((await sweep()).scanned).toBe(2);
    // A day later the empty one has been quiet long enough to stop costing a
    // read every hour for the rest of time; the funded one is exactly what the
    // instrument exists to keep watching.
    clock += day + 1;
    const later = await sweep();
    expect(later.candidates).toBe(1);
    expect(later.scanned).toBe(1);
    expect(later.withBalance).toBe(1);
    expect(cap.of('deposit_balance_held').every((e) => e.address === ADDRESS)).toBe(true);
  });

  test('an unreadable address is counted, not swallowed, and does not stop the pass', async () => {
    const cap = capture();
    const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'sweep-')) });
    const fetchImpl = (async (url: string) =>
      String(url).includes(OTHER_ADDRESS)
        ? new Response('boom', { status: 500 })
        : new Response(
            JSON.stringify([{ txid: 'a'.repeat(64), vout: 0, value: 7_000, status: { confirmed: true } }]),
            { status: 200 }
          )) as unknown as typeof fetch;
    const sweep = createDepositBalanceSweep({
      store,
      indexer: { api: 'https://idx.example/api' },
      network: 'mainnet',
      moneyLog: cap.log,
      fetchImpl,
    });
    store.bindDepositAddress('sub-1', 'mainnet', ADDRESS);
    store.bindDepositAddress('sub-2', 'mainnet', OTHER_ADDRESS);
    const out = await sweep();
    expect(out.unreadable).toBe(1);
    expect(out.withBalance).toBe(1);
  });
});
