/**
 * The stranded-funds fix (build-plan step 1): the signed commit + reveal pair
 * is persisted server-side BEFORE anything is broadcast, so a browser dying
 * between the two broadcasts can never orphan committed funds — the reveal
 * completes from server state via rebroadcast.
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
import { createBitcoinRoutes, isAlreadyKnownTxError, type OrdinalLookup } from '../bitcoin';
import { createInscriptionsStore, type InscriptionRecord } from '../inscriptions-store';

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
function buildPair(
  fundingTxid = 'a'.repeat(64),
  fundingVout = 0,
  opts: { changeTo?: string; revealTo?: string } = {}
) {
  const commit = new btc.Transaction();
  commit.addInput({
    txid: fundingTxid,
    index: fundingVout,
    sequence: 0xfffffffd,
    witnessUtxo: { script: USER_P2WPKH.script, amount: 50_000n },
  });
  commit.addOutputAddress(USER_ADDRESS, 20_000n, btc.TEST_NETWORK); // commit output
  commit.addOutputAddress(opts.changeTo ?? USER_ADDRESS, 29_000n, btc.TEST_NETWORK); // change
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
  reveal.addOutputAddress(opts.revealTo ?? USER_ADDRESS, 19_000n, btc.TEST_NETWORK);
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

/**
 * A signed commit spending SEVERAL funding UTXOs, in the declared order. The
 * first declared input is the identity input (its first sat becomes the
 * did:btco sat), which is why order — not just membership — is checked.
 */
function buildMultiPair(
  utxos: Array<{ txid: string; vout: number; value: number }>,
  commitValue = 20_000
) {
  const commit = new btc.Transaction();
  for (const u of utxos) {
    commit.addInput({
      txid: u.txid,
      index: u.vout,
      sequence: 0xfffffffd,
      witnessUtxo: { script: USER_P2WPKH.script, amount: BigInt(u.value) },
    });
  }
  const total = utxos.reduce((n, u) => n + u.value, 0);
  commit.addOutputAddress(USER_ADDRESS, BigInt(commitValue), btc.TEST_NETWORK);
  commit.addOutputAddress(USER_ADDRESS, BigInt(total - commitValue - 1_000), btc.TEST_NETWORK);
  commit.sign(USER_PRIV);
  commit.finalize();

  const reveal = new btc.Transaction();
  reveal.addInput({
    txid: commit.id,
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: USER_P2WPKH.script, amount: BigInt(commitValue) },
  });
  reveal.addOutputAddress(USER_ADDRESS, BigInt(commitValue - 1_000), btc.TEST_NETWORK);
  reveal.sign(USER_PRIV);
  reveal.finalize();

  return {
    signedCommitHex: hex.encode(commit.extract()),
    commitTxId: commit.id,
    revealTxHex: hex.encode(reveal.extract()),
    revealTxId: reveal.id,
    fundingUtxos: utxos.map((u) => ({ ...u, scriptPubKey: USER_SCRIPT })),
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

/** Every outpoint is clean — what a well-behaved lookup says about ordinary coins. */
const CLEAN_ORDINALS: OrdinalLookup = { outpointInscriptions: async () => [] };

function harness(opts?: {
  /** Skip the deposit binding, to exercise the UNBOUND refusal (#493). */
  bind?: false;
  broadcast?: (txHex: string) => Promise<string>;
  txStatus?: { confirmed: boolean } | ((txid: string) => { confirmed: boolean });
  /** Resolve the status lookup on a LATER macrotask — the concurrency window. */
  txStatusDelayMs?: number;
  /** The ordinal lookup the route classifies with; `null` = none configured. */
  ordinals?: OrdinalLookup | null;
}) {
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
    async getTransactionStatus(txid: string) {
      if (opts?.txStatusDelayMs !== undefined) {
        await new Promise((r) => setTimeout(r, opts.txStatusDelayMs));
      }
      if (typeof opts?.txStatus === 'function') return opts.txStatus(txid);
      if (opts?.txStatus) return opts.txStatus;
      return { confirmed: false };
    },
    async estimateFee() { return 3; },
  } as unknown as Parameters<typeof createBitcoinRoutes>[0]['provider'];
  const dataDir = mkdtempSync(join(tmpdir(), 'insc-'));
  const store = createInscriptionsStore({ dataDir });
  // Bind the deposit address up front, as the real flow does when a creator
  // reads it before funding. Without this the route refuses (#493): an unbound
  // account may not name its own change address. Cases that need the UNBOUND
  // state assert it explicitly rather than relying on the harness.
  if (opts?.bind !== false) store.bindDepositAddress('sub-1', 'testnet', USER_ADDRESS);
  const routes = createBitcoinRoutes({
    jwtSecret: JWT,
    provider,
    faucet: { address: USER_ADDRESS, signFundingTx: async () => '00' },
    inscriptions: store,
    ordinals: opts?.ordinals === null ? undefined : (opts?.ordinals ?? CLEAN_ORDINALS),
  });
  return { routes, store, broadcasts, dataDir };
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

  test('a never-broadcast pair (status signed) is SUPERSEDED by a rebuilt pair on the same outpoint — no deadlock', async () => {
    const pair = buildPair();
    let failCommit = true;
    const { routes, store } = harness({
      broadcast: async (txHex) => {
        if (failCommit && txHex === pair.signedCommitHex) throw new Error('min relay fee not met');
        return 'f'.repeat(64);
      },
    });
    // First attempt: commit rejected → 502, record persists as 'signed'.
    expect((await post(routes, pair)).status).toBe(502);
    expect(store.get('sub-1', pair.commitTxId)!.status).toBe('signed');

    // Rebuilt pair (fresh reveal keypair → different commit txid), same outpoint:
    // must replace the dead pair instead of 409ing forever.
    const rebuilt = (() => {
      const commit = new btc.Transaction();
      commit.addInput({ txid: pair.fundingUtxo.txid, index: 0, sequence: 0xfffffffd, witnessUtxo: { script: USER_P2WPKH.script, amount: 50_000n } });
      commit.addOutputAddress(USER_ADDRESS, 30_000n, btc.TEST_NETWORK);
      commit.sign(USER_PRIV);
      commit.finalize();
      const reveal = new btc.Transaction();
      reveal.addInput({ txid: commit.id, index: 0, sequence: 0xfffffffd, witnessUtxo: { script: USER_P2WPKH.script, amount: 30_000n } });
      reveal.addOutputAddress(USER_ADDRESS, 29_000n, btc.TEST_NETWORK);
      reveal.sign(USER_PRIV);
      reveal.finalize();
      return { ...pair, signedCommitHex: hex.encode(commit.extract()), revealTxHex: hex.encode(reveal.extract()), commitTxId: commit.id };
    })();
    const res = await post(routes, rebuilt);
    expect(res.status).toBe(200);
    // The dead pair is PRESERVED (its broadcast failure could have been
    // ambiguous — its reveal must stay recoverable), just flagged so the
    // outpoint frees up.
    const old = store.get('sub-1', pair.commitTxId)!;
    expect(old.superseded).toBe(true);
    expect(old.revealTxHex).toBe(pair.revealTxHex);
    expect(store.get('sub-1', rebuilt.commitTxId)!.status).toBe('reveal_broadcast');
    expect(store.findByOutpoint('sub-1', `${pair.fundingUtxo.txid}:0`)!.commitTxId).toBe(rebuilt.commitTxId);
  });

  test('superseding is REFUSED when the old commit is already confirmed on-chain (ambiguous broadcast that landed)', async () => {
    const pair = buildPair();
    const { routes, store } = harness({
      // The commit "fails" at broadcast time but actually reached the network…
      broadcast: async (txHex) => {
        if (txHex === pair.signedCommitHex) throw new Error('connection reset mid-response');
        return 'f'.repeat(64);
      },
      // …and has since confirmed.
      txStatus: { confirmed: true },
    });
    expect((await post(routes, pair)).status).toBe(502);
    expect(store.get('sub-1', pair.commitTxId)!.status).toBe('signed');

    const rebuilt = (() => {
      const commit = new btc.Transaction();
      commit.addInput({ txid: pair.fundingUtxo.txid, index: 0, sequence: 0xfffffffd, witnessUtxo: { script: USER_P2WPKH.script, amount: 50_000n } });
      commit.addOutputAddress(USER_ADDRESS, 30_000n, btc.TEST_NETWORK);
      commit.sign(USER_PRIV);
      commit.finalize();
      const reveal = new btc.Transaction();
      reveal.addInput({ txid: commit.id, index: 0, sequence: 0xfffffffd, witnessUtxo: { script: USER_P2WPKH.script, amount: 30_000n } });
      reveal.addOutputAddress(USER_ADDRESS, 29_000n, btc.TEST_NETWORK);
      reveal.sign(USER_PRIV);
      reveal.finalize();
      return { ...pair, signedCommitHex: hex.encode(commit.extract()), revealTxHex: hex.encode(reveal.extract()) };
    })();
    const res = await post(routes, rebuilt);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('outpoint_pending');
    // The old pair is promoted to commit_broadcast — its reveal (still
    // stored, never superseded) is the one true recovery path.
    const old = store.get('sub-1', pair.commitTxId)!;
    expect(old.status).toBe('commit_broadcast');
    expect(old.superseded).toBeUndefined();
  });

  test('malformed submissions do not consume the per-user inscribe cap', async () => {
    const { routes } = harness();
    // Burn well past the 10/hour cap with garbage — every one must 400, and
    // the eventual VALID pair must still get through.
    for (let i = 0; i < 12; i++) {
      const res = await post(routes, { ...buildPair(), signedCommitHex: 'abcd' });
      expect(res.status).toBe(400);
    }
    expect((await post(routes, buildPair())).status).toBe(200);
  });

  test('the body cap holds for chunked requests without Content-Length', async () => {
    const { routes } = harness();
    const token = signToken('sub-1', 'a@b.com', undefined, { secret: JWT });
    const cookie = serializeCookie(getAuthCookieConfig(token));
    const big = new TextEncoder().encode(JSON.stringify({ ...buildPair(), signedCommitHex: 'ab'.repeat(60 * 1024) }));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < big.length; i += 8192) controller.enqueue(big.slice(i, i + 8192));
        controller.close();
      },
    });
    // No content-length header: the streaming reader must cut it off anyway.
    const req = new Request('http://host/api/btc/inscribe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: stream,
    });
    expect((await routes.inscribe(req, new URL(req.url))).status).toBe(413);
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
    store.bindDepositAddress('sub-1', 'testnet', USER_ADDRESS); // #493: unbound cannot inscribe
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
      ordinals: CLEAN_ORDINALS,
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

  test('auto-recovers a superseded pair whose commit WON the outpoint: reveal broadcast from server state, roles swapped', async () => {
    const pairA = buildPair();
    let aConfirmed = false;
    let failACommit = true;
    const h = harness({
      broadcast: async (txHex) => {
        // Pair A's commit "fails" ambiguously — it actually reached the network.
        if (failACommit && txHex === pairA.signedCommitHex) throw new Error('connection reset mid-response');
        return 'f'.repeat(64);
      },
      txStatus: (txid) => ({ confirmed: aConfirmed && txid === pairA.commitTxId }),
    });

    // 1) Pair A: ambiguous commit failure → persisted as 'signed'.
    expect((await post(h.routes, pairA)).status).toBe(502);

    // 2) Rebuilt pair B on the same outpoint supersedes A (A's commit not yet
    //    visible as confirmed) and broadcasts fully.
    const pairB = (() => {
      const commit = new btc.Transaction();
      commit.addInput({ txid: pairA.fundingUtxo.txid, index: 0, sequence: 0xfffffffd, witnessUtxo: { script: USER_P2WPKH.script, amount: 50_000n } });
      commit.addOutputAddress(USER_ADDRESS, 30_000n, btc.TEST_NETWORK);
      commit.sign(USER_PRIV);
      commit.finalize();
      const reveal = new btc.Transaction();
      reveal.addInput({ txid: commit.id, index: 0, sequence: 0xfffffffd, witnessUtxo: { script: USER_P2WPKH.script, amount: 30_000n } });
      reveal.addOutputAddress(USER_ADDRESS, 29_000n, btc.TEST_NETWORK);
      reveal.sign(USER_PRIV);
      reveal.finalize();
      return { ...pairA, signedCommitHex: hex.encode(commit.extract()), revealTxHex: hex.encode(reveal.extract()), commitTxId: commit.id };
    })();
    expect((await post(h.routes, pairB)).status).toBe(200);
    expect(h.store.get('sub-1', pairA.commitTxId)!.superseded).toBe(true);

    // 3) A's commit confirms on-chain — it won the outpoint race; B's commit
    //    can never land. The routine list poll must recover A by itself.
    aConfirmed = true;
    const req = authedReq('/api/btc/inscribe', undefined, 'GET');
    const res = await h.routes.inscribeList(req, new URL(req.url));
    expect(res.status).toBe(200);
    const { inscriptions } = (await res.json()) as {
      inscriptions: Array<{ commitTxId: string; status: string; superseded?: boolean }>;
    };
    const a = inscriptions.find((r) => r.commitTxId === pairA.commitTxId)!;
    const b = inscriptions.find((r) => r.commitTxId === pairB.commitTxId)!;
    expect(a.superseded).toBeUndefined(); // reinstated as the live pair
    expect(a.status).toBe('reveal_broadcast');
    expect(b.superseded).toBe(true); // rival retired
    // A's reveal — the only one that can complete the inscription — was
    // broadcast from the persisted copy, no client involved.
    expect(h.broadcasts.filter((x) => x === pairA.revealTxHex)).toHaveLength(1);
    expect(h.store.findByOutpoint('sub-1', `${pairA.fundingUtxo.txid}:0`)!.commitTxId).toBe(pairA.commitTxId);
  });

  test('superseded reconciliation is PRIORITIZED — newer unconfirmed records cannot starve it out of the lookup budget', async () => {
    const supersededCommit = '9a'.repeat(32);
    const supersededReveal = '9b'.repeat(32);
    const h = harness({
      txStatus: (txid) => ({ confirmed: txid === supersededCommit }),
    });
    const rec = (over: Partial<InscriptionRecord>): InscriptionRecord => ({
      commitTxId: 'c'.repeat(64),
      revealTxId: 'r'.repeat(64),
      inscriptionId: `${'r'.repeat(64)}i0`,
      signedCommitHex: '02aa',
      revealTxHex: '02bb',
      fundingOutpoints: [`${'a'.repeat(64)}:0`],
      changeAddress: USER_ADDRESS,
      status: 'signed',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      ...over,
    });
    // OLDEST record: a superseded pair whose commit has since confirmed.
    h.store.create('sub-1', rec({
      commitTxId: supersededCommit,
      revealTxId: supersededReveal,
      revealTxHex: '02ee',
      fundingOutpoints: ['old:0'],
    }));
    h.store.supersede('sub-1', supersededCommit);
    // Then SIX newer live records stuck at reveal_broadcast (never confirm) —
    // more than the whole lookup budget on their own.
    for (let i = 0; i < 6; i++) {
      h.store.create('sub-1', rec({
        commitTxId: String(i).repeat(64).slice(0, 64),
        revealTxId: `f${i}`.repeat(32),
        status: 'reveal_broadcast',
        fundingOutpoints: [`live${i}:0`],
      }));
    }

    const req = authedReq('/api/btc/inscribe', undefined, 'GET');
    const res = await h.routes.inscribeList(req, new URL(req.url));
    const { inscriptions } = (await res.json()) as {
      inscriptions: Array<{ commitTxId: string; status: string; superseded?: boolean }>;
    };
    const old = inscriptions.find((r) => r.commitTxId === supersededCommit)!;
    expect(old.superseded).toBeUndefined(); // reconciled despite 6 newer records
    expect(old.status).toBe('reveal_broadcast');
    // Its reveal went out exactly once, and FIRST — before the budget was
    // spent on the newer records (whose own ancient reveals get re-pushed by
    // the staleness pass, which is a different concern).
    expect(h.broadcasts[0]).toBe('02ee');
    expect(h.broadcasts.filter((b) => b === '02ee')).toEqual(['02ee']);
  });

  test('manual rebroadcast of a superseded pair reinstates it and retires the rival', async () => {
    const pair = buildPair();
    let failCommit = true;
    const { routes, store } = harness({
      broadcast: async (txHex) => {
        if (failCommit && txHex === pair.signedCommitHex) throw new Error('upstream 502');
        return 'f'.repeat(64);
      },
    });
    // Pair A fails ambiguously, rebuilt pair B supersedes it and completes.
    expect((await post(routes, pair)).status).toBe(502);
    const pairB = (() => {
      const commit = new btc.Transaction();
      commit.addInput({ txid: pair.fundingUtxo.txid, index: 0, sequence: 0xfffffffd, witnessUtxo: { script: USER_P2WPKH.script, amount: 50_000n } });
      commit.addOutputAddress(USER_ADDRESS, 30_000n, btc.TEST_NETWORK);
      commit.sign(USER_PRIV);
      commit.finalize();
      const reveal = new btc.Transaction();
      reveal.addInput({ txid: commit.id, index: 0, sequence: 0xfffffffd, witnessUtxo: { script: USER_P2WPKH.script, amount: 30_000n } });
      reveal.addOutputAddress(USER_ADDRESS, 29_000n, btc.TEST_NETWORK);
      reveal.sign(USER_PRIV);
      reveal.finalize();
      return { ...pair, signedCommitHex: hex.encode(commit.extract()), revealTxHex: hex.encode(reveal.extract()), commitTxId: commit.id };
    })();
    expect((await post(routes, pairB)).status).toBe(200);
    expect(store.get('sub-1', pair.commitTxId)!.superseded).toBe(true);

    // The user explicitly rebroadcasts the superseded pair A and it succeeds:
    // A must become the live pair (not superseded+reveal_broadcast limbo that
    // reconciliation would skip), and rival B must be retired.
    failCommit = false;
    const req = authedReq('/api/btc/inscribe/rebroadcast', { commitTxId: pair.commitTxId });
    const res = await routes.inscribeRebroadcast(req, new URL(req.url));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('reveal_broadcast');
    const a = store.get('sub-1', pair.commitTxId)!;
    const b = store.get('sub-1', pairB.commitTxId)!;
    expect(a.superseded).toBeUndefined();
    expect(a.status).toBe('reveal_broadcast');
    expect(b.superseded).toBe(true);
    expect(store.findByOutpoint('sub-1', `${pair.fundingUtxo.txid}:0`)!.commitTxId).toBe(pair.commitTxId);
  });

  test('rotating cursor: a backlog larger than the lookup budget is fully covered across polls', async () => {
    const winnerCommit = '9a'.repeat(32);
    const h = harness({ txStatus: (txid) => ({ confirmed: txid === winnerCommit }) });
    const rec = (over: Partial<InscriptionRecord>): InscriptionRecord => ({
      commitTxId: 'c'.repeat(64),
      revealTxId: 'r'.repeat(64),
      inscriptionId: `${'r'.repeat(64)}i0`,
      signedCommitHex: '02aa',
      revealTxHex: '02bb',
      fundingOutpoints: [`${'a'.repeat(64)}:0`],
      changeAddress: USER_ADDRESS,
      status: 'signed',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      ...over,
    });
    // OLDEST: the winner (its commit confirmed). Then six newer superseded
    // pairs that never confirm — alone they exceed the whole 5-lookup budget.
    h.store.create('sub-1', rec({ commitTxId: winnerCommit, revealTxHex: '02ee', fundingOutpoints: ['win:0'] }));
    h.store.supersede('sub-1', winnerCommit);
    for (let i = 0; i < 6; i++) {
      const id = String(i).repeat(64).slice(0, 64);
      h.store.create('sub-1', rec({ commitTxId: id, fundingOutpoints: [`lose${i}:0`] }));
      h.store.supersede('sub-1', id);
    }

    const poll = async () => {
      const req = authedReq('/api/btc/inscribe', undefined, 'GET');
      const res = await h.routes.inscribeList(req, new URL(req.url));
      return ((await res.json()) as { inscriptions: Array<{ commitTxId: string; status: string; superseded?: boolean }> }).inscriptions;
    };
    // Poll 1: budget spent on the 5 newest superseded pairs — winner not yet
    // examined (this is exactly the starvation scenario)…
    let rows = await poll();
    expect(rows.find((r) => r.commitTxId === winnerCommit)!.superseded).toBe(true);
    // …but the cursor advanced, so poll 2 starts where poll 1 stopped and
    // reaches the winner: reconciled, reveal broadcast.
    rows = await poll();
    const winner = rows.find((r) => r.commitTxId === winnerCommit)!;
    expect(winner.superseded).toBeUndefined();
    expect(winner.status).toBe('reveal_broadcast');
    expect(h.broadcasts).toEqual(['02ee']);
  });

  test('superseded pair at reveal_broadcast with a confirmed commit but unconfirmed reveal is still recovered', async () => {
    const winnerCommit = '9a'.repeat(32);
    const winnerReveal = '9b'.repeat(32);
    const h = harness({
      // Commit confirmed; the reveal is NOT (dropped from the mempool).
      txStatus: (txid) => ({ confirmed: txid === winnerCommit }),
    });
    const base = {
      revealTxId: winnerReveal,
      inscriptionId: `${winnerReveal}i0`,
      signedCommitHex: '02aa',
      revealTxHex: '02ee',
      fundingOutpoints: ['x:0'],
      changeAddress: USER_ADDRESS,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    h.store.create('sub-1', { ...base, commitTxId: winnerCommit, status: 'reveal_broadcast' });
    h.store.supersede('sub-1', winnerCommit);
    h.store.create('sub-1', {
      ...base,
      commitTxId: 'd'.repeat(64),
      revealTxId: 'e'.repeat(64),
      inscriptionId: `${'e'.repeat(64)}i0`,
      status: 'commit_broadcast',
    });

    const req = authedReq('/api/btc/inscribe', undefined, 'GET');
    const res = await h.routes.inscribeList(req, new URL(req.url));
    const { inscriptions } = (await res.json()) as {
      inscriptions: Array<{ commitTxId: string; status: string; superseded?: boolean }>;
    };
    const winner = inscriptions.find((r) => r.commitTxId === winnerCommit)!;
    expect(winner.superseded).toBeUndefined(); // recovered despite reveal_broadcast status
    expect(winner.status).toBe('reveal_broadcast');
    expect(h.broadcasts).toEqual(['02ee']); // the dropped reveal was retried
    expect(inscriptions.find((r) => r.commitTxId === 'd'.repeat(64))!.superseded).toBe(true);
  });

  test('a superseded pair on an outpoint with a CONFIRMED record is terminally dead — no lookups wasted on it', async () => {
    let lookups = 0;
    const h = harness({ txStatus: () => { lookups++; return { confirmed: false }; } });
    const base = {
      signedCommitHex: '02aa',
      revealTxHex: '02bb',
      fundingOutpoints: ['x:0'],
      changeAddress: USER_ADDRESS,
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    };
    h.store.create('sub-1', {
      ...base,
      commitTxId: 'a1'.repeat(32),
      revealTxId: 'a2'.repeat(32),
      inscriptionId: `${'a2'.repeat(32)}i0`,
      status: 'signed',
    });
    h.store.supersede('sub-1', 'a1'.repeat(32));
    h.store.create('sub-1', {
      ...base,
      commitTxId: 'b1'.repeat(32),
      revealTxId: 'b2'.repeat(32),
      inscriptionId: `${'b2'.repeat(32)}i0`,
      status: 'confirmed',
    });
    const req = authedReq('/api/btc/inscribe', undefined, 'GET');
    await h.routes.inscribeList(req, new URL(req.url));
    expect(lookups).toBe(0); // dead rival skipped; confirmed record needs no check
  });

  test('cursors are PER USER: interleaved polls from another user cannot re-starve a worklist', async () => {
    const winnerCommit = '9a'.repeat(32);
    const h = harness({ txStatus: (txid) => ({ confirmed: txid === winnerCommit }) });
    const rec = (over: Partial<InscriptionRecord>): InscriptionRecord => ({
      commitTxId: 'c'.repeat(64),
      revealTxId: 'r'.repeat(64),
      inscriptionId: `${'r'.repeat(64)}i0`,
      signedCommitHex: '02aa',
      revealTxHex: '02bb',
      fundingOutpoints: [`${'a'.repeat(64)}:0`],
      changeAddress: USER_ADDRESS,
      status: 'signed',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      ...over,
    });
    // User A: 7 superseded pairs, only the OLDEST one's commit confirmed.
    h.store.create('sub-1', rec({ commitTxId: winnerCommit, revealTxHex: '02ee', fundingOutpoints: ['win:0'] }));
    h.store.supersede('sub-1', winnerCommit);
    for (let i = 0; i < 6; i++) {
      const id = String(i).repeat(64).slice(0, 64);
      h.store.create('sub-1', rec({ commitTxId: id, fundingOutpoints: [`a${i}:0`] }));
      h.store.supersede('sub-1', id);
    }
    // User B: 2 superseded pairs, unconfirmed. With a SHARED cursor, B's
    // interleaved poll would advance it by 2 — A's cursor residue would land
    // back at 0 mod 7 (5 + 2 = 7) and A's winner would be starved forever.
    for (let i = 0; i < 2; i++) {
      const id = `b${i}`.repeat(32);
      h.store.create('sub-2', rec({ commitTxId: id, fundingOutpoints: [`b${i}:0`] }));
      h.store.supersede('sub-2', id);
    }

    const poll = async (sub: string) => {
      const req = authedReq('/api/btc/inscribe', undefined, 'GET', sub);
      const res = await h.routes.inscribeList(req, new URL(req.url));
      return ((await res.json()) as { inscriptions: Array<{ commitTxId: string; status: string; superseded?: boolean }> }).inscriptions;
    };

    let rows = await poll('sub-1'); // A: budget on the 5 newest — winner untouched
    expect(rows.find((r) => r.commitTxId === winnerCommit)!.superseded).toBe(true);
    await poll('sub-2'); // B interleaves — must not perturb A's rotation
    rows = await poll('sub-1'); // A again: starts where ITS OWN cursor left off
    const winner = rows.find((r) => r.commitTxId === winnerCommit)!;
    expect(winner.superseded).toBeUndefined();
    expect(winner.status).toBe('reveal_broadcast');
    expect(h.broadcasts).toEqual(['02ee']);
  });

  test('a LIVE pair stuck at commit_broadcast is auto-completed once its commit confirms', async () => {
    const pair = buildPair();
    let failReveal = true;
    let commitConfirmed = false;
    const h = harness({
      broadcast: async (txHex) => {
        if (failReveal && txHex === pair.revealTxHex) throw new Error('mempool hiccup');
        return 'f'.repeat(64);
      },
      txStatus: (txid) => ({ confirmed: commitConfirmed && txid === pair.commitTxId }),
    });
    // Submission: commit lands, reveal fails → live pair at commit_broadcast.
    const res = await post(h.routes, pair);
    expect(((await res.json()) as { status: string }).status).toBe('commit_broadcast');

    const poll = async () => {
      const req = authedReq('/api/btc/inscribe', undefined, 'GET');
      const r = await h.routes.inscribeList(req, new URL(req.url));
      return ((await r.json()) as { inscriptions: Array<{ commitTxId: string; status: string }> }).inscriptions;
    };
    // Commit not yet confirmed: nothing is retried, state unchanged.
    failReveal = false;
    let rows = await poll();
    expect(rows.find((r) => r.commitTxId === pair.commitTxId)!.status).toBe('commit_broadcast');
    expect(h.broadcasts.filter((x) => x === pair.revealTxHex)).toHaveLength(0);
    // Commit confirms → the routine poll completes the reveal automatically,
    // no Finish button involved.
    commitConfirmed = true;
    rows = await poll();
    expect(rows.find((r) => r.commitTxId === pair.commitTxId)!.status).toBe('reveal_broadcast');
    expect(h.broadcasts.filter((x) => x === pair.revealTxHex)).toHaveLength(1);
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

  /**
   * F1 — the terminal deadlock. A commit that broadcast fine can still be
   * EVICTED from every mempool by a fee spike, and with no reveal child there
   * is no CPFP to pull it back. It will never confirm, so the list poll's
   * liveStuck pass (gated on a confirmed commit) never fires, and the reveal
   * is rejected for missing inputs forever. Without re-pushing the commit the
   * creator's confirmed UTXO is unusable through the app for good.
   */
  test('a commit evicted from the mempool is RE-PUSHED before the reveal retry', async () => {
    const pair = buildPair();
    let commitInMempool = false;
    let failReveal = true;
    const h = harness({
      broadcast: async (txHex) => {
        if (txHex === pair.signedCommitHex) {
          commitInMempool = true;
          return 'f'.repeat(64);
        }
        if (txHex === pair.revealTxHex) {
          if (failReveal) throw new Error('connection reset');
          if (!commitInMempool) throw new Error('bad-txns-inputs-missingorspent');
        }
        return 'f'.repeat(64);
      },
    });
    // Commit lands; the reveal push fails on a provider hiccup.
    const res = await post(h.routes, pair);
    expect(((await res.json()) as { status: string }).status).toBe('commit_broadcast');
    // A fee spike evicts the lone, childless commit.
    commitInMempool = false;
    failReveal = false;

    const req = authedReq('/api/btc/inscribe/rebroadcast', { commitTxId: pair.commitTxId });
    const res2 = await h.routes.inscribeRebroadcast(req, new URL(req.url));
    expect(res2.status).toBe(200);
    expect(((await res2.json()) as { status: string }).status).toBe('reveal_broadcast');
    expect(h.store.get('sub-1', pair.commitTxId)!.status).toBe('reveal_broadcast');
    // The commit went out a SECOND time — that is what un-bricks the UTXO.
    expect(h.broadcasts.filter((x) => x === pair.signedCommitHex)).toHaveLength(2);
  });

  test('a reveal rejected for an unrelated reason does NOT re-push the commit', async () => {
    const pair = buildPair();
    let failReveal = true;
    const h = harness({
      broadcast: async (txHex) => {
        if (failReveal && txHex === pair.revealTxHex) throw new Error('connection reset');
        return 'f'.repeat(64);
      },
    });
    await post(h.routes, pair);
    const before = h.broadcasts.filter((x) => x === pair.signedCommitHex).length;
    const req = authedReq('/api/btc/inscribe/rebroadcast', { commitTxId: pair.commitTxId });
    const res = await h.routes.inscribeRebroadcast(req, new URL(req.url));
    expect(((await res.json()) as { status: string }).status).toBe('commit_broadcast');
    expect(h.broadcasts.filter((x) => x === pair.signedCommitHex)).toHaveLength(before);
  });
});

/**
 * R3 — one torn file must not turn every recovery endpoint into a bare,
 * unnamed 500. The routes read the store outside any try/catch, and a 500 with
 * no code and no money line is exactly the state where the automatic
 * reconciliation that would complete a stranded reveal is dead for that user
 * with nothing to tell the operator so.
 */
describe('an unreadable records file', () => {
  function corrupt(h: ReturnType<typeof harness>) {
    mkdirSync(join(h.dataDir, 'inscriptions'), { recursive: true });
    writeFileSync(join(h.dataDir, 'inscriptions', 'sub-1.json'), '[{"commitTxId":');
  }

  test('the list route answers a NAMED 503, not an untyped 500', async () => {
    const h = harness();
    await post(h.routes, buildPair());
    corrupt(h);
    const req = authedReq('/api/btc/inscribe', undefined, 'GET');
    const res = await h.routes.inscribeList(req, new URL(req.url));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('records_unreadable');
  });

  test('the rebroadcast route answers a NAMED 503, not an untyped 500', async () => {
    const h = harness();
    const pair = buildPair();
    await post(h.routes, pair);
    corrupt(h);
    const req = authedReq('/api/btc/inscribe/rebroadcast', { commitTxId: pair.commitTxId });
    const res = await h.routes.inscribeRebroadcast(req, new URL(req.url));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('records_unreadable');
  });

  test('the store REFUSES rather than reading a torn file as an empty list', () => {
    const h = harness();
    corrupt(h);
    expect(() => h.store.list('sub-1')).toThrow(/RECORDS_UNREADABLE/);
  });
});

describe('persist-before-broadcast is load-bearing', () => {
  /**
   * The whole ordering guarantee in one assertion: the store write precedes
   * the commit broadcast, so if persistence fails for ANY reason the commit
   * must never go out. That is what makes the store's durability strictness
   * safe — fsync failing closed (see inscriptions-store) can only ever cost a
   * 500, never a real-BTC commit whose signed reveal was not written down.
   */
  test('a store write that fails means NOTHING is broadcast', async () => {
    const h = harness();
    const failing = {
      ...h.store,
      create() { throw new Error('EIO: directory fsync failed'); },
    };
    const routes = createBitcoinRoutes({
      jwtSecret: JWT,
      provider: {
        broadcastTransaction: async (txHex: string) => { h.broadcasts.push(txHex); return 'f'.repeat(64); },
        getTransactionStatus: async () => ({ confirmed: false }),
        estimateFee: async () => 3,
      } as unknown as Parameters<typeof createBitcoinRoutes>[0]['provider'],
      faucet: { address: USER_ADDRESS, signFundingTx: async () => '00' },
      inscriptions: failing,
      ordinals: CLEAN_ORDINALS,
    });
    const pair = buildPair();
    const req = authedReq('/api/btc/inscribe', pair);
    const res = await routes.inscribe(req, new URL(req.url));

    expect(res.status).toBe(500);
    expect((await res.json() as { error: string }).error).toBe('store_error');
    // The funding UTXO is untouched: the creator can simply retry.
    expect(h.broadcasts).toEqual([]);
  });
});

describe('isAlreadyKnownTxError', () => {
  test('matches already-known rejections, not conflicts', () => {
    expect(isAlreadyKnownTxError(new Error('txn-already-in-mempool'))).toBe(true);
    expect(isAlreadyKnownTxError(new Error('txn-already-known'))).toBe(true);
    expect(isAlreadyKnownTxError(new Error('Transaction already in block chain'))).toBe(true);
    expect(isAlreadyKnownTxError(new Error('txn-mempool-conflict'))).toBe(false);
    expect(isAlreadyKnownTxError(new Error('insufficient fee'))).toBe(false);
  });

  test('a transport error that merely CONTAINS "already" is not a broadcast', () => {
    // The whole point of the closed set: counting these as success marks a
    // record broadcast when nothing went out, parking real funds.
    expect(isAlreadyKnownTxError(new Error('socket connection already closed'))).toBe(false);
    expect(isAlreadyKnownTxError(new Error('429: rate limit already exceeded'))).toBe(false);
    expect(isAlreadyKnownTxError(new Error('request already aborted'))).toBe(false);
  });
});

describe('evicted-reveal recovery', () => {
  /** A record parked at reveal_broadcast, last touched `ageMs` ago. */
  function parked(store: ReturnType<typeof harness>['store'], ageMs: number, over: Partial<InscriptionRecord> = {}) {
    const at = new Date(Date.now() - ageMs).toISOString();
    const rec: InscriptionRecord = {
      commitTxId: 'c'.repeat(64),
      revealTxId: 'r'.repeat(64),
      inscriptionId: `${'r'.repeat(64)}i0`,
      signedCommitHex: '02aa',
      revealTxHex: '02bb',
      fundingOutpoints: [`${'a'.repeat(64)}:0`],
      changeAddress: USER_ADDRESS,
      status: 'reveal_broadcast',
      createdAt: at,
      updatedAt: at,
      ...over,
    };
    store.create('sub-1', rec);
    return rec;
  }

  async function poll(h: ReturnType<typeof harness>) {
    const req = authedReq('/api/btc/inscribe', undefined, 'GET');
    return h.routes.inscribeList(req, new URL(req.url));
  }

  test('a reveal unconfirmed for over 30 minutes is re-pushed from the persisted copy', async () => {
    // The eviction case: the reveal went out, a fee spike pushed it out of the
    // mempool, and nothing else in the system would ever push it again — the
    // commit's funds would sit in a P2TR output whose key no longer exists.
    const h = harness();
    parked(h.store, 45 * 60_000);
    await poll(h);
    expect(h.broadcasts).toEqual(['02bb']);
    // rebroadcastAt is the throttle: an immediate second poll must not re-push.
    await poll(h);
    expect(h.broadcasts).toEqual(['02bb']);
  });

  test('a re-push does NOT reset the status clock the manual retry reads', async () => {
    // updatedAt is how long the record has been stuck at reveal_broadcast, and
    // /me offers the manual "Finish inscription" retry once that passes 6h. If
    // the 30-minute re-push refreshed updatedAt, the server would reset that
    // clock twelve times over before it could ever elapse and the manual
    // escape hatch would never appear.
    const h = harness();
    const before = parked(h.store, 8 * 60 * 60_000);
    await poll(h);
    expect(h.broadcasts).toEqual(['02bb']); // it did re-push…
    const rec = h.store.get('sub-1', 'c'.repeat(64))!;
    expect(rec.updatedAt).toBe(before.updatedAt); // …without touching the status clock
    expect(rec.status).toBe('reveal_broadcast');
    // …and stamped the throttle on its own field instead.
    expect(Date.now() - Date.parse(rec.rebroadcastAt!)).toBeLessThan(60_000);
  });

  test('a reveal simply waiting for the next block is NOT re-pushed', async () => {
    const h = harness();
    parked(h.store, 5 * 60_000);
    await poll(h);
    expect(h.broadcasts).toEqual([]);
  });

  test('a confirmed reveal wins over the re-push and retires the record', async () => {
    const h = harness({ txStatus: { confirmed: true } });
    parked(h.store, 45 * 60_000);
    await poll(h);
    expect(h.broadcasts).toEqual([]); // confirmation short-circuits
    const rec = h.store.get('sub-1', 'c'.repeat(64))!;
    expect(rec.status).toBe('confirmed');
    expect(rec.retired).toBe(true);
    expect(rec.revealTxHex).toBeUndefined(); // artifacts dropped once terminal
  });

  test('a stale reveal is surfaced to the monitoring sweep', () => {
    const h = harness();
    parked(h.store, 48 * 60 * 60_000);
    expect(h.store.sweepStale(24 * 60 * 60_000).stale.map((x) => x.status)).toEqual(['reveal_broadcast']);
  });
});

describe('terminal records', () => {
  test('a terminally-dead superseded pair is retired on the next poll, freeing its pending slot', async () => {
    const h = harness();
    const dead = buildPair('1'.repeat(64), 0);
    const winner = buildPair('2'.repeat(64), 0);
    const base = (p: ReturnType<typeof buildPair>, over: Partial<InscriptionRecord>): InscriptionRecord => ({
      commitTxId: p.commitTxId,
      revealTxId: p.revealTxId,
      inscriptionId: `${p.revealTxId}i0`,
      signedCommitHex: p.signedCommitHex,
      revealTxHex: p.revealTxHex,
      fundingOutpoints: [`${'a'.repeat(64)}:0`],
      changeAddress: USER_ADDRESS,
      status: 'signed',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      ...over,
    });
    h.store.create('sub-1', base(dead, {}));
    h.store.supersede('sub-1', dead.commitTxId);
    h.store.create('sub-1', base(winner, { status: 'confirmed' }));

    const req = authedReq('/api/btc/inscribe', undefined, 'GET');
    await h.routes.inscribeList(req, new URL(req.url));

    const rec = h.store.get('sub-1', dead.commitTxId)!;
    // Its commit double-spends a confirmed tx: it can never land, so holding
    // ~100 KB of un-broadcastable hex against the user's cap forever is waste.
    expect(rec.retired).toBe(true);
    expect(rec.revealTxHex).toBeUndefined();
    expect(h.broadcasts).toEqual([]); // and it costs no provider lookup
  });

  test('rebroadcasting a retired record is 410, not a silent no-op', async () => {
    const h = harness();
    const pair = buildPair();
    await post(h.routes, pair);
    h.store.setStatus('sub-1', pair.commitTxId, 'confirmed'); // terminal → retired
    h.store.setStatus('sub-1', pair.commitTxId, 'commit_broadcast'); // status only; hex is gone

    const req = authedReq('/api/btc/inscribe/rebroadcast', { commitTxId: pair.commitTxId });
    const res = await h.routes.inscribeRebroadcast(req, new URL(req.url));
    expect(res.status).toBe(410);
    expect((await res.json() as { error: string }).error).toBe('not_recoverable');
  });
});

describe('malformed reveal shapes', () => {
  test('an input-less reveal is rejected before anything is indexed or broadcast', async () => {
    const h = harness();
    const pair = buildPair();
    // fromRaw can't parse a 0-input tx at all (the 0x00 input count reads as
    // the segwit marker), so this lands on bad_reveal_tx rather than the
    // inputsLength guard — both are 400, and neither indexes getInput(0).
    const empty = new btc.Transaction({ allowUnknownOutputs: true });
    empty.addOutputAddress(USER_ADDRESS, 1_000n, btc.TEST_NETWORK);
    const res = await post(h.routes, { ...pair, revealTxHex: hex.encode(empty.toBytes(true)) });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('bad_reveal_tx');
    expect(h.broadcasts).toEqual([]);
  });

  test('a reveal with two inputs is rejected (shape checked before indexing)', async () => {
    const h = harness();
    const pair = buildPair();
    const two = new btc.Transaction();
    for (const txid of ['1'.repeat(64), '2'.repeat(64)]) {
      two.addInput({
        txid,
        index: 0,
        sequence: 0xfffffffd,
        witnessUtxo: { script: USER_P2WPKH.script, amount: 20_000n },
      });
    }
    two.addOutputAddress(USER_ADDRESS, 30_000n, btc.TEST_NETWORK);
    two.sign(USER_PRIV);
    two.finalize();
    const res = await post(h.routes, { ...pair, revealTxHex: hex.encode(two.extract()) });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('reveal_invariant_violation');
    expect(h.broadcasts).toEqual([]);
  });
});

/**
 * R26 — a creator who deposited twice, or topped up after a fee rise, funds
 * one inscription from several UTXOs. Relaxing the input-count invariant must
 * not weaken the guard that stops a stranded reveal: the declared set is what
 * the commit must spend, and ANY overlap with a live record is a double-spend.
 */
describe('POST /api/btc/inscribe — multi-input funding', () => {
  const A = { txid: 'a'.repeat(64), vout: 0, value: 30_000 };
  const B = { txid: 'b'.repeat(64), vout: 1, value: 25_000 };
  const C = { txid: 'c'.repeat(64), vout: 0, value: 40_000 };

  test('accepts a two-input commit matching its declared funding set', async () => {
    const { routes, store, broadcasts } = harness();
    const pair = buildMultiPair([A, B]);
    const res = await post(routes, pair);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('reveal_broadcast');
    expect(broadcasts).toEqual([pair.signedCommitHex, pair.revealTxHex]);
    const rec = store.get('sub-1', pair.commitTxId)!;
    expect(rec.fundingOutpoints).toEqual([`${A.txid}:0`, `${B.txid}:1`]);
    // Both outpoints are claimed by the live record.
    expect(store.findByOutpoint('sub-1', `${B.txid}:1`)!.commitTxId).toBe(pair.commitTxId);
  });

  test('rejects a commit whose inputs do not match the declared funding set', async () => {
    const { routes, broadcasts } = harness();
    const pair = buildMultiPair([A, B]);
    // Declares a THIRD outpoint the commit does not spend.
    const res = await post(routes, { ...pair, fundingUtxos: [...pair.fundingUtxos, { ...C, scriptPubKey: USER_SCRIPT }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('commit_invariant_violation');
    expect(broadcasts).toHaveLength(0);
  });

  test('rejects a commit whose inputs are the declared set in a DIFFERENT order (the identity sat would move)', async () => {
    const { routes, broadcasts } = harness();
    const pair = buildMultiPair([A, B]);
    const res = await post(routes, { ...pair, fundingUtxos: [pair.fundingUtxos[1], pair.fundingUtxos[0]] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('commit_invariant_violation');
    expect(broadcasts).toHaveLength(0);
  });

  test('refuses a second pair that claims one ALREADY-CLAIMED outpoint plus a fresh one', async () => {
    const { routes, store } = harness();
    expect((await post(routes, buildMultiPair([A, B]))).status).toBe(200);
    // Overlapping but UNEQUAL set: a single-outpoint lookup on the identity
    // input alone would miss this and let both pairs spend B.
    const overlapping = buildMultiPair([C, B]);
    const res = await post(routes, overlapping);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('outpoint_pending');
    expect(store.get('sub-1', overlapping.commitTxId)).toBeNull();
  });

  test('refuses a second pair whose only overlap is a NON-identity input of the live record', async () => {
    const { routes } = harness();
    expect((await post(routes, buildMultiPair([A, B]))).status).toBe(200);
    const res = await post(routes, buildMultiPair([B, C]));
    expect(res.status).toBe(409);
  });

  test('a rebuilt pair over the SAME outpoint set supersedes an unbroadcast record', async () => {
    const first = buildMultiPair([A, B]);
    let failCommit = true;
    const { routes, store } = harness({
      broadcast: async (txHex) => {
        if (failCommit && txHex === first.signedCommitHex) throw new Error('min relay fee not met');
        return 'f'.repeat(64);
      },
    });
    expect((await post(routes, first)).status).toBe(502);
    expect(store.get('sub-1', first.commitTxId)!.status).toBe('signed');

    const rebuilt = buildMultiPair([A, B], 22_000); // different split → different txid
    expect((await post(routes, rebuilt)).status).toBe(200);
    expect(store.get('sub-1', first.commitTxId)!.superseded).toBe(true);
    expect(store.get('sub-1', first.commitTxId)!.revealTxHex).toBe(first.revealTxHex);
    expect(store.findByOutpoint('sub-1', `${B.txid}:1`)!.commitTxId).toBe(rebuilt.commitTxId);
  });

  /**
   * C4 — the safety property the supersede gate rests on is "the new commit
   * conflicts with the old on EVERY input the old spends, so at most one can
   * land". That holds for a strict superset too. Refusing it 409s a creator
   * who must top up after a fee rise, permanently: nothing else ever frees a
   * live `signed` record.
   */
  test('a rebuilt pair funding from a SUPERSET of a stuck record supersedes it', async () => {
    const first = buildMultiPair([A]);
    let failCommit = true;
    const { routes, store } = harness({
      broadcast: async (txHex) => {
        if (failCommit && txHex === first.signedCommitHex) throw new Error('min relay fee not met');
        return 'f'.repeat(64);
      },
    });
    expect((await post(routes, first)).status).toBe(502);
    expect(store.get('sub-1', first.commitTxId)!.status).toBe('signed');

    // The fee rose: the rebuild has to pull in B as well.
    const rebuilt = buildMultiPair([A, B]);
    expect((await post(routes, rebuilt)).status).toBe(200);
    const old = store.get('sub-1', first.commitTxId)!;
    expect(old.superseded).toBe(true);
    expect(old.revealTxHex).toBe(first.revealTxHex); // both reveals retained
    expect(store.get('sub-1', rebuilt.commitTxId)!.revealTxHex).toBe(rebuilt.revealTxHex);
    expect(store.findByOutpoint('sub-1', `${A.txid}:0`)!.commitTxId).toBe(rebuilt.commitTxId);
  });

  test('a rebuilt pair whose set merely OVERLAPS (neither superset nor equal) is still refused', async () => {
    const first = buildMultiPair([A, B]);
    const { routes } = harness({
      broadcast: async (txHex) => {
        if (txHex === first.signedCommitHex) throw new Error('min relay fee not met');
        return 'f'.repeat(64);
      },
    });
    expect((await post(routes, first)).status).toBe(502);
    // {B, C} does not contain A — the two commits would not conflict on A, so
    // both could land and one reveal would be stranded.
    const res = await post(routes, buildMultiPair([B, C]));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('outpoint_pending');
  });

  /**
   * C5/F2 — the rival set is read, then awaited on, then acted on. Two
   * concurrent submissions both supersede the same rival off a STALE snapshot
   * and both go live on one outpoint set. Money stays safe (the commits
   * conflict) but every later submission then sees rivals.length > 1 and 409s
   * with no supersede path, forever.
   */
  test('two concurrent rebuilds cannot both go live on one outpoint set', async () => {
    const stuck = buildMultiPair([A], 21_000);
    const one = buildMultiPair([A], 22_000);
    const two = buildMultiPair([A], 23_000);
    const { routes, store } = harness({
      broadcast: async (txHex) => {
        if (txHex === stuck.signedCommitHex) throw new Error('min relay fee not met');
        return 'f'.repeat(64);
      },
      txStatusDelayMs: 5, // the window the stale read straddles
    });
    expect((await post(routes, stuck)).status).toBe(502);

    const results = await Promise.all([post(routes, one), post(routes, two)]);
    expect(results.some((r) => r.status === 200)).toBe(true);
    // Exactly ONE live record claims the set — whichever lost either
    // superseded the other or was refused; neither leaves two live rivals.
    expect(store.findByOutpoints('sub-1', [`${A.txid}:0`])).toHaveLength(1);
  });

  test('a rebuilt pair over the same set does NOT supersede once the first pair is broadcast', async () => {
    const { routes } = harness();
    expect((await post(routes, buildMultiPair([A, B]))).status).toBe(200);
    const res = await post(routes, buildMultiPair([A, B], 22_000));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('outpoint_pending');
  });

  test('a LEGACY single-outpoint record still blocks a multi-input pair that overlaps it', async () => {
    const { routes, store } = harness();
    // Written in the pre-multi-input shape, as records on the live volume are.
    store.create('sub-1', {
      commitTxId: '9'.repeat(64),
      revealTxId: '8'.repeat(64),
      inscriptionId: `${'8'.repeat(64)}i0`,
      signedCommitHex: '02aa',
      revealTxHex: '02bb',
      fundingOutpoint: `${A.txid}:0`,
      changeAddress: USER_ADDRESS,
      status: 'commit_broadcast',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    } as unknown as InscriptionRecord);
    const res = await post(routes, buildMultiPair([A, B]));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { commitTxId: string }).commitTxId).toBe('9'.repeat(64));
  });

  test('a LEGACY single-outpoint record is still completable via rebroadcast', async () => {
    const { routes, store, broadcasts } = harness();
    store.create('sub-1', {
      commitTxId: '7'.repeat(64),
      revealTxId: '6'.repeat(64),
      inscriptionId: `${'6'.repeat(64)}i0`,
      signedCommitHex: '02aa',
      revealTxHex: '02bb',
      fundingOutpoint: `${C.txid}:0`,
      changeAddress: USER_ADDRESS,
      status: 'commit_broadcast',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    } as unknown as InscriptionRecord);
    const req = authedReq('/api/btc/inscribe/rebroadcast', { commitTxId: '7'.repeat(64) });
    const res = await routes.inscribeRebroadcast(req, new URL(req.url));
    expect(res.status).toBe(200);
    expect(broadcasts).toContain('02bb');
    expect(store.get('sub-1', '7'.repeat(64))!.status).toBe('reveal_broadcast');
  });

  test('resubmitting the SAME multi-input pair is idempotent (its own claim is not a rival)', async () => {
    const { routes, store } = harness();
    const pair = buildMultiPair([A, B]);
    expect((await post(routes, pair)).status).toBe(200);
    expect((await post(routes, pair)).status).toBe(200);
    expect(store.list('sub-1')).toHaveLength(1);
  });

  test('the LEGACY singular fundingUtxo body shape is still accepted (cached browser bundle)', async () => {
    const { routes, store } = harness();
    const pair = buildPair();
    const { fundingUtxo, ...rest } = pair;
    const res = await post(routes, { ...rest, fundingUtxo });
    expect(res.status).toBe(200);
    expect(store.get('sub-1', pair.commitTxId)!.fundingOutpoints).toEqual([`${pair.fundingUtxo.txid}:0`]);
  });
});

/**
 * #493 — the checks the browser used to carry alone. Each one is a place the
 * server trusted the client for a fact it can establish itself.
 */
describe('POST /api/btc/inscribe — server-side defence-in-depth (#493)', () => {
  const OTHER_PRIV = hex.decode('7'.repeat(64));
  const OTHER_ADDRESS = btc.p2wpkh(secp256k1.getPublicKey(OTHER_PRIV, true), btc.TEST_NETWORK).address!;

  test('refuses a commit whose declared funding outpoint carries an inscription', async () => {
    const pair = buildPair();
    const inscribed: OrdinalLookup = {
      async outpointInscriptions({ txid, vout }) {
        return txid === pair.fundingUtxo.txid && vout === pair.fundingUtxo.vout ? [`${txid}i0`] : [];
      },
    };
    const { routes, store, broadcasts } = harness({ ordinals: inscribed });
    const res = await post(routes, pair);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('funding_outpoint_inscribed');
    expect(broadcasts).toEqual([]);
    expect(store.get('sub-1', pair.commitTxId)).toBeNull();
  });

  test('refuses when no ordinal lookup is configured — unclassified is not clean', async () => {
    const pair = buildPair();
    const { routes, broadcasts } = harness({ ordinals: null });
    const res = await post(routes, pair);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('ordinal_check_unavailable');
    expect(broadcasts).toEqual([]);
  });

  test('refuses when the lookup itself fails — a partial classification never broadcasts', async () => {
    const pair = buildPair();
    const failing: OrdinalLookup = { outpointInscriptions: async () => { throw new Error('ord down'); } };
    const { routes, broadcasts } = harness({ ordinals: failing });
    const res = await post(routes, pair);
    expect(res.status).toBe(503);
    expect(broadcasts).toEqual([]);
  });

  test('refuses a commit whose change output pays somewhere other than changeAddress', async () => {
    const pair = buildPair('a'.repeat(64), 0, { changeTo: OTHER_ADDRESS });
    const { routes, broadcasts } = harness();
    const res = await post(routes, pair);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('commit_invariant_violation');
    expect(body.message).toMatch(/change/i);
    expect(broadcasts).toEqual([]);
  });

  test('refuses a reveal whose output pays somewhere other than changeAddress', async () => {
    const pair = buildPair('a'.repeat(64), 0, { revealTo: OTHER_ADDRESS });
    const { routes, broadcasts } = harness();
    const res = await post(routes, pair);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('reveal_invariant_violation');
    expect(broadcasts).toEqual([]);
  });

  test('refuses a changeAddress that is not the address bound to this account', async () => {
    const pair = buildPair();
    // bind:false — bindDepositAddress is FIRST-USE-WINS, so binding OTHER here
    // after the harness bound USER would be a silent no-op and this test would
    // assert nothing.
    const { routes, store, broadcasts } = harness({ bind: false });
    store.bindDepositAddress('sub-1', 'testnet', OTHER_ADDRESS);
    const res = await post(routes, pair);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('address_not_bound');
    expect(broadcasts).toEqual([]);
  });

  /**
   * The guard was `bound && bound !== changeAddress`, so an account with NO
   * binding skipped it entirely. Nothing forces the deposit route — the only
   * thing that binds — to run first, so a caller could go straight here, never
   * bind, and name any change address it liked: the commit change AND the
   * inscribed sat both pay `changeAddress`. That is the browser-shaped
   * adversary this whole route exists to stop, so unbound must fail closed.
   */
  test('refuses an UNBOUND account outright — an absent binding is not a pass', async () => {
    const pair = buildPair();
    const { routes, broadcasts } = harness({ bind: false });
    const res = await post(routes, pair);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('address_not_bound');
    // Nothing signed, nothing sent: the refusal precedes any broadcast.
    expect(broadcasts).toEqual([]);
  });

  test('an unbound account cannot redirect the money to an address it names', async () => {
    // The attack the truthiness guard permitted: never bind, then point both
    // the commit change and the reveal's inscribed sat at your own address.
    const pair = buildPair('a'.repeat(64), 0, { changeTo: OTHER_ADDRESS, revealTo: OTHER_ADDRESS });
    const { routes, broadcasts } = harness({ bind: false });
    const res = await post(routes, { ...pair, changeAddress: OTHER_ADDRESS });
    expect(res.status).toBe(403);
    expect(broadcasts).toEqual([]);
  });

  test('an honest pair — clean coins, change and reveal back to the bound address — still broadcasts', async () => {
    const pair = buildPair();
    const { routes, store, broadcasts } = harness();
    store.bindDepositAddress('sub-1', 'testnet', USER_ADDRESS);
    const res = await post(routes, pair);
    expect(res.status).toBe(200);
    expect(broadcasts).toEqual([pair.signedCommitHex, pair.revealTxHex]);
  });
});
