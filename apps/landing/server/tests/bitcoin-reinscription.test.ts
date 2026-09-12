import { test, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createLocalSigner, createNonce, signEvent, eventDigest, encodeDocument, prepareInscriptionOnSat } from '@originals/sdk';
import type { CelDocument, SatSnapshot } from '@originals/sdk/cel';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { serializeCookie } from '../cookies';
import { createBitcoinRoutes } from '../bitcoin';
import { createInscriptionsStore } from '../inscriptions-store';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const jwtSecret = 'regtest-reinscription-test-secret-at-least-32';
const key = new Uint8Array(32).fill(2);
const payment = btc.p2wpkh(secp256k1.getPublicKey(key), { ...btc.TEST_NETWORK, bech32: 'bcrt' });

/**
 * Fake indexer backing store for the inscribe route's independent input-value
 * lookup (#493 M07): `GET /tx/<txid>/hex` answers straight from this map with
 * a real, parseable transaction paying `value` sats to `scriptPubKey` at
 * `vout` — it need not hash to `txid` itself, mirroring how the route already
 * trusts the indexer's answer for a given txid without re-deriving the id.
 */
const FUNDING_TX_HEX = new Map<string, string>();
let fundingSeq = 0;
function registerFundingUtxo(txid: string, vout: number, value: number, scriptPubKey: Uint8Array): void {
  fundingSeq++;
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  tx.addInput({
    txid: fundingSeq.toString(16).padStart(64, '0'),
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: payment.script, amount: BigInt(value) + 10_000n },
  });
  for (let i = 0; i < vout; i++) {
    tx.addOutputAddress(payment.address!, 1_000n, { ...btc.TEST_NETWORK, bech32: 'bcrt' });
  }
  tx.addOutput({ script: scriptPubKey, amount: BigInt(value) });
  tx.sign(key);
  tx.finalize();
  FUNDING_TX_HEX.set(txid.toLowerCase(), hex.encode(tx.extract()));
}
function fakeIndexerFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const m = url.match(/\/tx\/([0-9a-fA-F]+)\/hex$/);
    const raw = m ? FUNDING_TX_HEX.get(m[1].toLowerCase()) : undefined;
    return raw ? new Response(raw, { status: 200 }) : new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}
async function fixture() {
  const signer = createLocalSigner('Ed25519', new Uint8Array(32).fill(3));
  const genesis = await signEvent({ operation: { type: 'create', data: { profile: 'originals/cel/3', controller: signer.controller, createdAt: new Date().toISOString(), nonce: createNonce(), resources: [] } } }, signer);
  const did = 'did:cel:' + eventDigest(genesis.event);
  const webDid = 'did:webvh:QmYwAPJzv5CZsnAzt8auVZRnGiVvJzUuWPuJHGMNYWcJ7V:example.com';
  const web = await signEvent({ previousEvent: eventDigest(genesis.event), operation: { type: 'migrate', data: { profile: 'originals/cel/3', from: did, to: webDid, layer: 'webvh', migratedAt: new Date().toISOString() } } }, signer);
  const boundary = await signEvent({ previousEvent: eventDigest(web.event), operation: { type: 'migrate', data: { profile: 'originals/cel/3', from: webDid, to: 'did:btco:reg:5000000000', layer: 'btco', migratedAt: new Date().toISOString() } } }, signer);
  const history: CelDocument = { log: [genesis, web, boundary] };
  const delta: CelDocument = { log: [await signEvent({ previousEvent: eventDigest(boundary.event), operation: { type: 'update', data: { profile: 'originals/cel/3', name: 'authorized delta' } } }, signer)] };
  const blockHash = '11'.repeat(32), previousTxid = '22'.repeat(32), feeTxid = '44'.repeat(32);
  registerFundingUtxo(previousTxid, 0, 546, payment.script);
  registerFundingUtxo(feeTxid, 0, 100_000, payment.script);
  const snapshot: SatSnapshot = { network: 'regtest', sat: '5000000000', tipBefore: { height: 101, hash: blockHash }, tipAfter: { height: 101, hash: blockHash }, indexTip: { height: 101, hash: blockHash }, indexHealthy: true, enumerationComplete: true,
    blocks: [{ height: 101, hash: blockHash, txids: [previousTxid] }], ownership: { owner: payment.address!, satpoint: previousTxid + ':0:0' }, publications: [{ id: previousTxid + 'i0', revealTxid: previousTxid, network: 'regtest', sat: '5000000000', confirmed: true, creation: { height: 101, blockHash, transactionIndex: 0, inscriptionIndex: 0 }, body: { status: 'complete', mediaType: 'application/cel', bytes: encodeDocument(history, 'json'), metadata: null } }] };
  let broadcasts = 0, scans = 0, classifications = 0;
  const provider = { getFirstSatOfOutput: async () => snapshot.sat, getSatSnapshot: async () => { scans++; return snapshot; }, broadcastTransaction: async (raw: unknown) => { broadcasts++; return btc.Transaction.fromRaw(Buffer.from(raw as string, 'hex'), { allowUnknownInputs: true, allowUnknownOutputs: true }).id; }, getTransactionStatus: async () => ({ confirmed: false }), estimateFee: async () => 2 } as unknown as Parameters<typeof createBitcoinRoutes>[0]['provider'];
  const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'cel3-reinscription-')) });
  store.bindDepositAddress('creator', 'regtest', payment.address!);
  let feeInscribed = false, extraIdentitySat = false;
  const routes = createBitcoinRoutes({ jwtSecret, network: 'regtest', provider, inscriptions: store, ordinals: { outpointInscriptions: async outpoint => { classifications++; return outpoint.txid === previousTxid || feeInscribed ? [outpoint.txid + 'i0', ...(extraIdentitySat ? ['99'.repeat(32) + 'i0'] : [])] : []; } }, indexer: { api: 'https://fake-indexer.test' }, fetchImpl: fakeIndexerFetch() });
  const invoke = async (document = delta, metadata = false, alter?: (raw: string) => string) => {
    const prepared = await prepareInscriptionOnSat({ provider, network: 'regtest', fundingUtxos: [{ txid: previousTxid, vout: 0, value: 546, scriptPubKey: Buffer.from(payment.script).toString('hex') }, { txid: feeTxid, vout: 0, value: 100000, scriptPubKey: Buffer.from(payment.script).toString('hex') }], changeAddress: payment.address!, feeRate: 2,
      satSigner: { signAndFinalizeCommitPsbt: async psbt => { const tx = btc.Transaction.fromPSBT(Buffer.from(psbt, 'base64'), { allowUnknownOutputs: true }); tx.sign(key); tx.finalize(); return tx.hex; } },
      buildContent: async () => metadata ? { content: new Uint8Array([1, 2, 3]), contentType: 'image/png', metadata: JSON.parse(new TextDecoder().decode(encodeDocument(document, 'json'))) } : { content: encodeDocument(document, 'json'), contentType: 'application/cel' } });
    const request = new Request('http://localhost/api/btc/inscribe', { method: 'POST', headers: { 'content-type': 'application/json', cookie: serializeCookie(getAuthCookieConfig(signToken('creator', 'local@example.com', undefined, { secret: jwtSecret }))) }, body: JSON.stringify({ ...prepared, revealTxHex: alter ? alter(prepared.revealTxHex) : prepared.revealTxHex }) });
    return routes.inscribe(request, new URL(request.url));
  };
  const quotaRequest = async (clientIp: string) => {
    const req = new Request('http://localhost/api/btc/fee', { headers: { cookie: serializeCookie(getAuthCookieConfig(signToken('creator', 'local@example.com', undefined, { secret: jwtSecret }))) } });
    return routes.fee(req, new URL(req.url), clientIp);
  };
  return { invoke, quotaRequest, stored: () => store.list('creator'), scans: () => scans, classifications: () => classifications, history, delta, snapshot, broadcasts: () => broadcasts, inscribeFee: () => { feeInscribed = true; }, extraSat: () => { extraIdentitySat = true; } };
}

test('accepts current-controller CEL delta on the first inscribed input and persists before submission', async () => {
  const f = await fixture(); const response = await f.invoke();
  expect(response.status).toBe(200); expect((await response.json()).status).toBe('reveal_broadcast'); expect(f.broadcasts()).toBe(2);
});
test('rejects snapshots, unbound media, stale or incomplete identity evidence, and inscribed fee inputs', async () => {
  for (const failure of ['snapshot', 'media', 'offset', 'incomplete', 'fee', 'extra-sat'] as const) {
    const f = await fixture();
    if (failure === 'offset') f.snapshot.ownership.satpoint = '22'.repeat(32) + ':0:1';
    if (failure === 'incomplete') f.snapshot.enumerationComplete = false;
    if (failure === 'fee') f.inscribeFee();
    if (failure === 'extra-sat') f.extraSat();
    const response = await f.invoke(failure === 'snapshot' ? f.history : f.delta, failure === 'media');
    expect(response.status).toBe(400); expect(f.broadcasts()).toBe(0);
  }
});


test('rejects holder-only signatures and ambiguous inscription scripts before broadcast', async () => {
  const unauthorized = await fixture();
  const holder = createLocalSigner('Ed25519', new Uint8Array(32).fill(9));
  const forged = { log: [await signEvent(unauthorized.delta.log[0].event, holder)] };
  expect((await unauthorized.invoke(forged)).status).toBe(400);
  expect(unauthorized.broadcasts()).toBe(0);
  for (const extra of ['pointer', 'duplicate-type', 'second-envelope', 'zero-postage'] as const) {
    const f = await fixture();
    const response = await f.invoke(f.delta, false, raw => {
      const tx = btc.Transaction.fromRaw(Buffer.from(raw, 'hex'), { allowUnknownInputs: true, allowUnknownOutputs: true });
      if (extra === 'zero-postage') { tx.updateOutput(0, { amount: 0n }, true); return tx.hex; }
      const witness = tx.getInput(0).finalScriptWitness!;
      const script = btc.Script.decode(witness[1]);
      if (extra === 'second-envelope') script.push(0, 'IF', new TextEncoder().encode('ord'), 0, new Uint8Array([1]), 'ENDIF');
      else script.splice(5, 0, new Uint8Array([extra === 'pointer' ? 2 : 1]), extra === 'pointer' ? new Uint8Array([1]) : new TextEncoder().encode('application/cel'));
      tx.updateInput(0, { finalScriptWitness: [witness[0], btc.Script.encode(script), witness[2]] }, true);
      return tx.hex;
    });
    expect(response.status).toBe(400); expect(f.broadcasts()).toBe(0);
  }
});


test('bounds refused controller continuations before expensive ordinal classification and full sat scans', async () => {
  const f = await fixture();
  const holder = createLocalSigner('Ed25519', new Uint8Array(32).fill(9));
  const forged = { log: [await signEvent(f.delta.log[0].event, holder)] };
  for (let i = 0; i < 10; i++) expect((await f.invoke(forged)).status).toBe(400);
  expect(f.scans()).toBe(10);
  const classifications = f.classifications();
  const refused = await f.invoke(forged);
  expect(refused.status).toBe(429);
  expect((await refused.json()).error).toBe('inscribe_user_cap');
  expect(f.scans()).toBe(10);
  expect(f.classifications()).toBe(classifications);
  expect(f.broadcasts()).toBe(0);
});

test('inscription admission shares the authenticated provider quota with adjacent routes', async () => {
  const f = await fixture();
  for (let i = 0; i < 120; i++) await f.quotaRequest(`192.0.2.${i}`);
  const response = await f.invoke();
  expect(response.status).toBe(429);
  expect((await response.json()).error).toBe('user_quota_cap');
  expect(f.scans()).toBe(0);
  expect(f.classifications()).toBe(0);
  expect(f.broadcasts()).toBe(0);
});


test('direct HTTP submission rejects witness signature corruption with unchanged transaction ids before persistence', async () => {
  const f = await fixture();
  const response = await f.invoke(f.delta, false, raw => {
    const tx = btc.Transaction.fromRaw(Buffer.from(raw, 'hex'), { allowUnknownInputs: true, allowUnknownOutputs: true });
    const id = tx.id;
    const witness = tx.getInput(0).finalScriptWitness!.map(item => new Uint8Array(item));
    witness[0][0] ^= 1;
    tx.updateInput(0, { finalScriptWitness: witness }, true);
    expect(tx.id).toBe(id);
    return tx.hex;
  });
  expect(response.status).toBe(400);
  expect((await response.json()).error).toBe('invalid_inscription_reveal');
  expect(f.broadcasts()).toBe(0);
  expect(f.stored()).toHaveLength(0);
  expect(f.classifications()).toBe(0);
});
