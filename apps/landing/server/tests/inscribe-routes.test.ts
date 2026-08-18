/**
 * The stranded-funds fix (build-plan step 1): the signed commit + reveal pair
 * is persisted server-side BEFORE anything is broadcast, so a browser dying
 * between the two broadcasts can never orphan committed funds — the reveal
 * completes from server state via rebroadcast.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { serializeCookie } from '../cookies';
import { createBitcoinRoutes, isAlreadyKnownTxError } from '../bitcoin';
import { createInscriptionsStore } from '../inscriptions-store';

const JWT = 'test-secret-at-least-32-chars-long!!';

const USER_PRIV = hex.decode('4'.repeat(64));
const USER_PUB = secp256k1.getPublicKey(USER_PRIV, true);
const USER_P2WPKH = btc.p2wpkh(USER_PUB, btc.TEST_NETWORK);
const USER_ADDRESS = USER_P2WPKH.address!;
const USER_SCRIPT = hex.encode(USER_P2WPKH.script);

/**
 * A structurally-valid signed commit (1 input spending the funding UTXO, 2
 * outputs) + reveal (1 input spending commit:0, 1 output). Signature validity
 * is not what the route checks — the invariants are structural — but signing
 * for real keeps the txs parseable as broadcast-ready raw hex.
 */
function buildPair(fundingTxid = 'a'.repeat(64), fundingVout = 0) {
  const commit = new btc.Transaction();
  commit.addInput({
    txid: fundingTxid,
    index: fundingVout,
    sequence: 0xfffffffd,
    witnessUtxo: { script: USER_P2WPKH.script, amount: 50_000n },
  });
  commit.addOutputAddress(USER_ADDRESS, 20_000n, btc.TEST_NETWORK); // commit output
  commit.addOutputAddress(USER_ADDRESS, 29_000n, btc.TEST_NETWORK); // change
  commit.sign(USER_PRIV);
  commit.finalize();
  const signedCommitHex = hex.encode(commit.extract());
  const commitTxId = commit.id;

  const reveal = new btc.Transaction();
  reveal.addInput({
    txid: commitTxId,
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: USER_P2WPKH.script, amount: 20_000n },
  });
  reveal.addOutputAddress(USER_ADDRESS, 19_000n, btc.TEST_NETWORK);
  reveal.sign(USER_PRIV);
  reveal.finalize();
  const revealTxHex = hex.encode(reveal.extract());

  return {
    signedCommitHex,
    commitTxId,
    revealTxHex,
    revealTxId: reveal.id,
    fundingUtxo: { txid: fundingTxid, vout: fundingVout, value: 50_000, scriptPubKey: USER_SCRIPT },
    changeAddress: USER_ADDRESS,
  };
}

function authedReq(path: string, body?: unknown, method = 'POST', sub = 'sub-1') {
  const token = signToken(sub, 'a@b.com', undefined, { secret: JWT });
  const cookie = serializeCookie(getAuthCookieConfig(token));
  return new Request(`http://host${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function harness(opts?: { broadcast?: (txHex: string) => Promise<string>; txStatus?: { confirmed: boolean } }) {
  const broadcasts: string[] = [];
  const provider = {
    async broadcastTransaction(txHex: string) {
      if (opts?.broadcast) {
        const id = await opts.broadcast(txHex);
        broadcasts.push(txHex);
        return id;
      }
      broadcasts.push(txHex);
      return 'f'.repeat(64);
    },
    async getTransactionStatus() {
      if (opts?.txStatus) return opts.txStatus;
      return { confirmed: false };
    },
    async estimateFee() { return 3; },
  } as unknown as Parameters<typeof createBitcoinRoutes>[0]['provider'];
  const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'insc-')) });
  const routes = createBitcoinRoutes({
    jwtSecret: JWT,
    provider,
    faucet: { address: USER_ADDRESS, signFundingTx: async () => '00' },
    inscriptions: store,
  });
  return { routes, store, broadcasts };
}

async function post(routes: ReturnType<typeof harness>['routes'], body: unknown) {
  const req = authedReq('/api/btc/inscribe', body);
  return routes.inscribe(req, new URL(req.url));
}

describe('POST /api/btc/inscribe', () => {
  test('persists the pair BEFORE broadcast, then broadcasts commit → reveal', async () => {
    const { routes, store, broadcasts } = harness();
    const pair = buildPair();
    const res = await post(routes, pair);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commitTxId: string; revealTxId: string; inscriptionId: string; status: string };
    expect(body.commitTxId).toBe(pair.commitTxId);
    expect(body.revealTxId).toBe(pair.revealTxId);
    expect(body.inscriptionId).toBe(`${pair.revealTxId}i0`);
    expect(body.status).toBe('reveal_broadcast');
    expect(broadcasts).toEqual([pair.signedCommitHex, pair.revealTxHex]);
    const rec = store.get('sub-1', pair.commitTxId)!;
    expect(rec.status).toBe('reveal_broadcast');
    expect(rec.revealTxHex).toBe(pair.revealTxHex);
  });

  test('dead-tab recovery: reveal broadcast fails → 200 commit_broadcast; rebroadcast completes from SERVER state', async () => {
    const pair = buildPair();
    let failReveal = true;
    const { routes, store, broadcasts } = harness({
      broadcast: async (txHex) => {
        if (failReveal && txHex === pair.revealTxHex) throw new Error('connection reset');
        return 'f'.repeat(64);
      },
    });

    // The "tab dies" moment: the submit call itself survives, but the reveal
    // broadcast fails and the client is never heard from again.
    const res = await post(routes, pair);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('commit_broadcast');
    expect(store.get('sub-1', pair.commitTxId)!.status).toBe('commit_broadcast');

    // "Reload": a fresh session rebroadcasts by commitTxId ONLY — the reveal
    // hex comes from the persisted record, not the (dead) client.
    failReveal = false;
    const req = authedReq('/api/btc/inscribe/rebroadcast', { commitTxId: pair.commitTxId });
    const res2 = await routes.inscribeRebroadcast(req, new URL(req.url));
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as { status: string }).status).toBe('reveal_broadcast');
    expect(store.get('sub-1', pair.commitTxId)!.status).toBe('reveal_broadcast');
    expect(broadcasts.filter((h) => h === pair.revealTxHex)).toHaveLength(1);
  });

  test('commit broadcast failure → 502, pair stays persisted as signed (retryable, nothing on-chain)', async () => {
    const pair = buildPair();
    const { routes, store } = harness({
      broadcast: async (txHex) => {
        if (txHex === pair.signedCommitHex) throw new Error('502 from upstream');
        return 'f'.repeat(64);
      },
    });
    const res = await post(routes, pair);
    expect(res.status).toBe(502);
    expect(store.get('sub-1', pair.commitTxId)!.status).toBe('signed');
  });

  test('an "already in mempool" rejection counts as broadcast success', async () => {
    const { routes } = harness({
      broadcast: async () => { throw new Error('txn-already-in-mempool'); },
    });
    const res = await post(routes, buildPair());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('reveal_broadcast');
  });

  test('rejects a commit that does not spend the declared funding UTXO', async () => {
    const { routes, broadcasts } = harness();
    const pair = buildPair();
    const res = await post(routes, { ...pair, fundingUtxo: { ...pair.fundingUtxo, txid: 'b'.repeat(64) } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('commit_invariant_violation');
    expect(broadcasts).toHaveLength(0);
  });

  test('rejects a reveal that does not spend the commit output 0', async () => {
    const { routes, broadcasts } = harness();
    const pair = buildPair();
    const other = buildPair('c'.repeat(64)); // reveal spends a different commit
    const res = await post(routes, { ...pair, revealTxHex: other.revealTxHex });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('reveal_invariant_violation');
    expect(broadcasts).toHaveLength(0);
  });

  test('double-click safety: a DIFFERENT pair on the same funding outpoint is 409', async () => {
    const { routes } = harness();
    const pair = buildPair();
    expect((await post(routes, pair)).status).toBe(200);
    // Same outpoint, different commit (different output split → different txid).
    const rival = (() => {
      const commit = new btc.Transaction();
      commit.addInput({ txid: pair.fundingUtxo.txid, index: 0, sequence: 0xfffffffd, witnessUtxo: { script: USER_P2WPKH.script, amount: 50_000n } });
      commit.addOutputAddress(USER_ADDRESS, 25_000n, btc.TEST_NETWORK);
      commit.sign(USER_PRIV);
      commit.finalize();
      const reveal = new btc.Transaction();
      reveal.addInput({ txid: commit.id, index: 0, sequence: 0xfffffffd, witnessUtxo: { script: USER_P2WPKH.script, amount: 25_000n } });
      reveal.addOutputAddress(USER_ADDRESS, 24_000n, btc.TEST_NETWORK);
      reveal.sign(USER_PRIV);
      reveal.finalize();
      return { ...pair, signedCommitHex: hex.encode(commit.extract()), revealTxHex: hex.encode(reveal.extract()) };
    })();
    const res = await post(routes, rival);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('outpoint_pending');
  });

  test('resubmitting the SAME pair is idempotent (200, single record)', async () => {
    const { routes, store } = harness();
    const pair = buildPair();
    expect((await post(routes, pair)).status).toBe(200);
    expect((await post(routes, pair)).status).toBe(200);
    expect(store.list('sub-1')).toHaveLength(1);
  });

  test('anonymous → 401; oversize body → 413; malformed tx hex → 400', async () => {
    const { routes } = harness();
    const anon = new Request('http://host/api/btc/inscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildPair()),
    });
    expect((await routes.inscribe(anon, new URL(anon.url))).status).toBe(401);

    const big = { ...buildPair(), signedCommitHex: 'ab'.repeat(60 * 1024) };
    expect((await post(routes, big)).status).toBe(413);

    const garbage = { ...buildPair(), signedCommitHex: 'abcd' };
    expect((await post(routes, garbage)).status).toBe(400);
  });
});

describe('GET /api/btc/inscribe', () => {
  test('lists the user\'s records without the tx hex payloads', async () => {
    const { routes } = harness();
    const pair = buildPair();
    await post(routes, pair);
    const req = authedReq('/api/btc/inscribe', undefined, 'GET');
    const res = await routes.inscribeList(req, new URL(req.url));
    const { inscriptions } = (await res.json()) as { inscriptions: Array<Record<string, unknown>> };
    expect(inscriptions).toHaveLength(1);
    expect(inscriptions[0].commitTxId).toBe(pair.commitTxId);
    expect(inscriptions[0].status).toBe('reveal_broadcast');
    expect(inscriptions[0].signedCommitHex).toBeUndefined();
    expect(inscriptions[0].revealTxHex).toBeUndefined();
  });

  test('confirmation is refreshed and STICKY: once confirmed, no further provider lookups', async () => {
    let lookups = 0;
    const pair = buildPair();
    const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'insc-')) });
    const provider = {
      async broadcastTransaction() { return 'f'.repeat(64); },
      async getTransactionStatus() { lookups++; return { confirmed: true }; },
      async estimateFee() { return 3; },
    } as unknown as Parameters<typeof createBitcoinRoutes>[0]['provider'];
    const routes = createBitcoinRoutes({
      jwtSecret: JWT,
      provider,
      faucet: { address: USER_ADDRESS, signFundingTx: async () => '00' },
      inscriptions: store,
    });
    await post(routes, pair); // broadcast both → reveal_broadcast

    const listReq = () => authedReq('/api/btc/inscribe', undefined, 'GET');
    let req = listReq();
    let res = await routes.inscribeList(req, new URL(req.url));
    let body = (await res.json()) as { inscriptions: Array<{ status: string }> };
    expect(body.inscriptions[0].status).toBe('confirmed');
    expect(lookups).toBe(1);
    expect(store.get('sub-1', pair.commitTxId)!.status).toBe('confirmed'); // persisted

    req = listReq();
    res = await routes.inscribeList(req, new URL(req.url));
    body = (await res.json()) as { inscriptions: Array<{ status: string }> };
    expect(body.inscriptions[0].status).toBe('confirmed');
    expect(lookups).toBe(1); // sticky: no second lookup
  });

  test('is scoped to the authenticated user', async () => {
    const { routes } = harness();
    await post(routes, buildPair());
    const req = authedReq('/api/btc/inscribe', undefined, 'GET', 'sub-2');
    const res = await routes.inscribeList(req, new URL(req.url));
    expect(((await res.json()) as { inscriptions: unknown[] }).inscriptions).toHaveLength(0);
  });
});

describe('POST /api/btc/inscribe/rebroadcast', () => {
  test('unknown commitTxId → 404', async () => {
    const { routes } = harness();
    const req = authedReq('/api/btc/inscribe/rebroadcast', { commitTxId: 'a'.repeat(64) });
    expect((await routes.inscribeRebroadcast(req, new URL(req.url))).status).toBe(404);
  });

  test('a CONFIRMED reveal short-circuits without rebroadcasting', async () => {
    const pair = buildPair();
    let failReveal = true;
    const h = harness({
      broadcast: async (txHex) => {
        if (failReveal && txHex === pair.revealTxHex) throw new Error('down');
        return 'f'.repeat(64);
      },
      txStatus: { confirmed: true },
    });
    await post(h.routes, pair); // leaves status commit_broadcast
    const before = h.broadcasts.length;
    const req = authedReq('/api/btc/inscribe/rebroadcast', { commitTxId: pair.commitTxId });
    const res = await h.routes.inscribeRebroadcast(req, new URL(req.url));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('confirmed');
    expect(h.broadcasts.length).toBe(before); // nothing rebroadcast
  });
});

describe('isAlreadyKnownTxError', () => {
  test('matches already-known rejections, not conflicts', () => {
    expect(isAlreadyKnownTxError(new Error('txn-already-in-mempool'))).toBe(true);
    expect(isAlreadyKnownTxError(new Error('Transaction already in block chain'))).toBe(true);
    expect(isAlreadyKnownTxError(new Error('txn-mempool-conflict'))).toBe(false);
    expect(isAlreadyKnownTxError(new Error('insufficient fee'))).toBe(false);
  });
});
