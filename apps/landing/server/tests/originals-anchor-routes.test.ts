/**
 * The landing's anchoring routes (plan 011, PR 10b): the money-path checks of
 * /api/btc/inscribe, then the writer's checked submit. The one input that may
 * carry inscriptions is input 0, and only when every inscription on it sits on
 * the Original's own sat: that is how an anchored Original is reinscribed, in
 * place of the old refusal of every inscribed input. Fee inputs stay free of
 * inscriptions. The chain is simulated (originals-chain-fixture.ts).
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base64 } from '@scure/base';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { prepareEntryInscription } from '@originals/sdk/originals/bitcoin';
import { serializeCookie } from '../cookies';
import { createBitcoinRoutes } from '../bitcoin';
import { createInscriptionsStore } from '../inscriptions-store';
import { createOriginalsAnchoring } from '../originals-anchoring';
import { createMoneyLogger } from '../money-log';
import { INDEX, NETWORK, SAT, WALLET_ADDRESS, authorWithOriginal, fakeChain, headerClock, walletSigner } from './originals-chain-fixture';

const JWT = 'test-secret-at-least-32-chars-long!!';
const SUB = 'sub-1';

function req(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', sub: string | null = SUB) {
  const cookie = sub ? serializeCookie(getAuthCookieConfig(signToken(sub, 'a@b.com', undefined, { secret: JWT }))) : '';
  return new Request(`http://host${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function harness(opts: { anchoring?: false; bind?: false } = {}) {
  const chain = fakeChain();
  const dataDir = mkdtempSync(join(tmpdir(), 'originals-routes-'));
  const store = createInscriptionsStore({ dataDir });
  if (opts.bind !== false) store.bindDepositAddress(SUB, NETWORK, WALLET_ADDRESS);
  const money: string[] = [];
  const moneyLog = createMoneyLogger((l) => money.push(l));
  const anchoring = opts.anchoring === false ? undefined
    : createOriginalsAnchoring({ dataDir, provider: chain.provider, clock: headerClock(), index: INDEX, money: moneyLog });
  const routes = createBitcoinRoutes({
    jwtSecret: JWT, provider: chain.provider, inscriptions: store, network: NETWORK,
    indexer: { api: 'https://fake-indexer.test' }, fetchImpl: chain.indexerFetch, ordinals: chain.ordinals,
    moneyLog, anchoring, headers: async (height) => ({ time: 1_700_000_000 + height, hash: height.toString(16).padStart(64, '0') }),
  });
  return { chain, routes, store, money };
}

type Harness = ReturnType<typeof harness>;
type Author = Awaited<ReturnType<typeof authorWithOriginal>>;

const prepare = (a: Author, chain: Harness['chain'], fundingUtxos = [chain.satUtxo, chain.fund(50_000)]) =>
  prepareEntryInscription({
    sdk: a.sdk, did: a.did, fundingUtxos, satSigner: walletSigner, changeAddress: WALLET_ADDRESS, feeRate: 2, network: NETWORK,
    provider: chain.provider, clock: headerClock(), index: INDEX, recoveryStore: null,
  });

async function submit(h: Harness, a: Author, pair: unknown, sub: string | null = SUB) {
  const r = req('/api/btc/originals/submit', { did: a.did, evidence: base64.encode((await a.sdk.package(a.did)).bytes), pair }, 'POST', sub);
  const res = await h.routes.originalsSubmit(r, new URL(r.url));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function status(h: Harness, did: string) {
  const r = req(`/api/btc/originals/status?did=${encodeURIComponent(did)}`);
  const res = await h.routes.originalsStatus(r, new URL(r.url));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('POST /api/btc/originals/submit', () => {
  test('is off unless the server enables Bitcoin anchoring, and needs a session', async () => {
    const off = harness({ anchoring: false });
    const a = await authorWithOriginal();
    const pair = await prepare(a, off.chain);
    expect(await submit(off, a, pair)).toMatchObject({ status: 404, body: { error: 'bitcoin_anchoring_off' } });
    expect((await status(off, a.did)).status).toBe(404);
    const on = harness();
    expect((await submit(on, a, pair, null)).status).toBe(401);
    expect(off.chain.sent.length + on.chain.sent.length).toBe(0);
  });

  test('anchors: the checked submit sends the pair, the status reads pending, then anchored on the account\'s own output (P9.18)', async () => {
    const h = harness();
    const a = await authorWithOriginal();
    const pair = await prepare(a, h.chain);
    expect(await submit(h, a, pair)).toMatchObject({ status: 200, body: { outcome: 'sent', versionId: a.anchoring, broadcast: 'reveal_broadcast' } });
    expect(h.chain.sent).toEqual([pair.prepared.signedCommitHex, pair.prepared.revealTxHex]);

    const pending = await status(h, a.did);
    expect(pending).toMatchObject({ status: 200, body: { publication: 'pending-bitcoin-acceptance', action: 'wait-for-confirmation', current: false } });
    expect(JSON.stringify(pending.body)).not.toContain(pair.prepared.revealTxHex);

    h.chain.mine();
    const anchored = await status(h, a.did);
    expect(anchored.body).toMatchObject({
      publication: 'anchored', action: 'done', sat: `did:btco:reg:${SAT}`,
      ownership: { output: `${pair.prepared.revealTxId}:0` },
      // The holder is this account's bound address, so the next inscription can spend it.
      satUtxo: { txid: pair.prepared.revealTxId, vout: 0, value: h.chain.holderUtxo().value },
    });
  });

  test('reinscribes the Original\'s own sat: an inscribed input 0 whose inscriptions are all on that sat (plan 011, PR 10b)', async () => {
    const h = harness();
    const a = await authorWithOriginal();
    await submit(h, a, await prepare(a, h.chain));
    h.chain.mine();
    const revised = await a.edit('Harbor, revised');
    const next = await prepare(a, h.chain, [h.chain.holderUtxo(), h.chain.fund(50_000)]);

    // The generic route still refuses any inscribed input.
    const legacy = req('/api/btc/inscribe', {
      signedCommitHex: next.prepared.signedCommitHex, revealTxHex: next.prepared.revealTxHex,
      fundingUtxos: next.prepared.fundingUtxos, changeAddress: WALLET_ADDRESS,
    });
    const refused = await h.routes.inscribe(legacy, new URL(legacy.url));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: 'funding_outpoint_inscribed' });

    expect(await submit(h, a, next)).toMatchObject({ status: 200, body: { outcome: 'sent', versionId: revised } });
    h.chain.mine();
    expect((await status(h, a.did)).body).toMatchObject({ publication: 'anchored', heads: { accepted: revised, committed: revised } });
  });

  test('an input 0 carrying an inscription on another sat is refused, nothing sent', async () => {
    const h = harness();
    const a = await authorWithOriginal();
    const pair = await prepare(a, h.chain);
    h.chain.foreign.set(`${h.chain.satUtxo.txid}:0`, ['f'.repeat(64) + 'i0']);
    expect(await submit(h, a, pair)).toMatchObject({ status: 400, body: { error: 'funding_outpoint_inscribed_foreign' } });
    expect(h.chain.sent.length).toBe(0);
  });

  test('a fee input carrying any inscription is refused, nothing sent', async () => {
    const h = harness();
    const a = await authorWithOriginal();
    const fee = h.chain.fund(50_000);
    h.chain.foreign.set(`${fee.txid}:0`, ['e'.repeat(64) + 'i0']);
    const pair = await prepare(a, h.chain, [h.chain.satUtxo, fee]);
    expect(await submit(h, a, pair)).toMatchObject({ status: 400, body: { error: 'fee_input_inscribed' } });
    expect(h.chain.sent.length).toBe(0);
  });

  test('the pair must pay the account\'s bound address, and its declared ids must be its bytes\'', async () => {
    const unbound = harness({ bind: false });
    const a = await authorWithOriginal();
    const pair = await prepare(a, unbound.chain);
    expect(await submit(unbound, a, pair)).toMatchObject({ status: 403, body: { error: 'address_not_bound' } });

    const h = harness();
    const pair2 = await prepare(a, h.chain);
    const lying = { ...pair2, prepared: { ...pair2.prepared, revealTxId: 'a'.repeat(64) } };
    expect(await submit(h, a, lying)).toMatchObject({ status: 400, body: { error: 'pair_ids_mismatch' } });
    expect(unbound.chain.sent.length + h.chain.sent.length).toBe(0);
  });

  test('the same bytes again are answered from the record, never resent (P9.6)', async () => {
    const h = harness();
    const a = await authorWithOriginal();
    const pair = await prepare(a, h.chain);
    await submit(h, a, pair);
    h.chain.mine();
    // The anchoring entry is on Bitcoin now: nothing is left to prepare for it.
    expect(await prepare(a, h.chain, [h.chain.holderUtxo(), h.chain.fund(50_000)]).catch((e) => e)).toMatchObject({ code: 'NOTHING_TO_INSCRIBE' });
    expect(await submit(h, a, pair)).toMatchObject({ status: 200, body: { outcome: 'recorded' } });
    expect(h.chain.sent.length).toBe(2);
  });
});

describe('the browser\'s chain reads for prepare', () => {
  test('GET /api/btc/tx and /api/btc/header are authenticated reads of the node', async () => {
    const h = harness();
    const txid = h.chain.satUtxo.txid;
    const t = req(`/api/btc/tx?txid=${txid}`);
    const tx = await h.routes.txStatus(t, new URL(t.url));
    expect(tx.status).toBe(200);
    expect(await tx.json()).toMatchObject({ confirmed: true });
    const hd = req('/api/btc/header?height=7');
    expect(await (await h.routes.blockHeader(hd, new URL(hd.url))).json()).toEqual({ time: 1_700_000_007, hash: (7).toString(16).padStart(64, '0') });
    const bad = req('/api/btc/header?height=-1');
    expect((await h.routes.blockHeader(bad, new URL(bad.url))).status).toBe(400);
    const anon = req(`/api/btc/tx?txid=${txid}`, undefined, 'GET', null);
    expect((await h.routes.txStatus(anon, new URL(anon.url))).status).toBe(401);
  });
});
