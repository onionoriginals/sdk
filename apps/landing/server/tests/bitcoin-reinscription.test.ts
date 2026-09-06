import { test, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
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
  const snapshot: SatSnapshot = { network: 'regtest', sat: '5000000000', tipBefore: { height: 101, hash: blockHash }, tipAfter: { height: 101, hash: blockHash }, indexTip: { height: 101, hash: blockHash }, indexHealthy: true, enumerationComplete: true,
    blocks: [{ height: 101, hash: blockHash, txids: [previousTxid] }], ownership: { owner: payment.address!, satpoint: previousTxid + ':0:0' }, publications: [{ id: previousTxid + 'i0', revealTxid: previousTxid, network: 'regtest', sat: '5000000000', confirmed: true, creation: { height: 101, blockHash, transactionIndex: 0, inscriptionIndex: 0 }, body: { status: 'complete', mediaType: 'application/cel', bytes: encodeDocument(history, 'json'), metadata: null } }] };
  let broadcasts = 0;
  const provider = { getFirstSatOfOutput: async () => snapshot.sat, getSatSnapshot: async () => snapshot, broadcastTransaction: async (raw: unknown) => { broadcasts++; return btc.Transaction.fromRaw(Buffer.from(raw as string, 'hex'), { allowUnknownInputs: true, allowUnknownOutputs: true }).id; }, getTransactionStatus: async () => ({ confirmed: false }) } as unknown as Parameters<typeof createBitcoinRoutes>[0]['provider'];
  const store = createInscriptionsStore({ dataDir: mkdtempSync(join(tmpdir(), 'cel3-reinscription-')) });
  store.bindDepositAddress('creator', 'regtest', payment.address!);
  let feeInscribed = false, extraIdentitySat = false;
  const routes = createBitcoinRoutes({ jwtSecret, network: 'regtest', provider, inscriptions: store, ordinals: { outpointInscriptions: async outpoint => outpoint.txid === previousTxid || feeInscribed ? [outpoint.txid + 'i0', ...(extraIdentitySat ? ['99'.repeat(32) + 'i0'] : [])] : [] } });
  const invoke = async (document = delta, metadata = false, alter?: (raw: string) => string) => {
    const prepared = await prepareInscriptionOnSat({ provider, network: 'regtest', fundingUtxos: [{ txid: previousTxid, vout: 0, value: 546, scriptPubKey: Buffer.from(payment.script).toString('hex') }, { txid: feeTxid, vout: 0, value: 100000, scriptPubKey: Buffer.from(payment.script).toString('hex') }], changeAddress: payment.address!, feeRate: 2,
      satSigner: { signAndFinalizeCommitPsbt: async psbt => { const tx = btc.Transaction.fromPSBT(Buffer.from(psbt, 'base64'), { allowUnknownOutputs: true }); tx.sign(key); tx.finalize(); return tx.hex; } },
      buildContent: async () => metadata ? { content: new Uint8Array([1, 2, 3]), contentType: 'image/png', metadata: JSON.parse(new TextDecoder().decode(encodeDocument(document, 'json'))) } : { content: encodeDocument(document, 'json'), contentType: 'application/cel' } });
    const request = new Request('http://localhost/api/btc/inscribe', { method: 'POST', headers: { 'content-type': 'application/json', cookie: serializeCookie(getAuthCookieConfig(signToken('creator', 'local@example.com', undefined, { secret: jwtSecret }))) }, body: JSON.stringify({ ...prepared, revealTxHex: alter ? alter(prepared.revealTxHex) : prepared.revealTxHex }) });
    return routes.inscribe(request, new URL(request.url));
  };
  return { invoke, history, delta, snapshot, broadcasts: () => broadcasts, inscribeFee: () => { feeInscribed = true; }, extraSat: () => { extraIdentitySat = true; } };
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
