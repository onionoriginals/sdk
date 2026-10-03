import { describe, expect, test } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { serializeCookie } from '../cookies';
import { createBitcoinRoutes } from '../bitcoin';

const secret = 'faucet-test-secret-at-least-32-chars';
const key = hex.decode('3'.repeat(64));
const payment = btc.p2wpkh(secp256k1.getPublicKey(key, true), btc.TEST_NETWORK);
const recipient = btc.p2wpkh(secp256k1.getPublicKey(hex.decode('4'.repeat(64)), true), btc.TEST_NETWORK).address!;
const utxo = (n: number) => ({ txid: n.toString(16).padStart(64, '0'), vout: 0, value: 100_000, scriptPubKey: hex.encode(payment.script) });
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}
function fixture(network: 'testnet' | 'mainnet' | 'regtest' = 'testnet') {
  let reads = 0;
  const sent: string[] = [];
  const provider = {
    async getSpendableUtxos() { return [utxo(++reads)]; },
    async estimateFee() { return 3; },
    async broadcastTransaction(raw: string) { sent.push(raw); return btc.Transaction.fromRaw(hex.decode(raw)).id; },
  };
  const faucet = { address: payment.address!, async signFundingTx(tx: btc.Transaction) {
    tx.sign(key); tx.finalize(); return hex.encode(tx.extract());
  } };
  const routes = createBitcoinRoutes({ jwtSecret: secret, faucet, network,
    provider: provider as unknown as Parameters<typeof createBitcoinRoutes>[0]['provider'] });
  async function fund(sub = 'user-a', address = recipient) {
    const cookie = serializeCookie(getAuthCookieConfig(signToken(sub, `${sub}@test.invalid`, undefined, { secret })));
    const req = new Request('http://host/api/btc/funding', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ address }) });
    return routes.funding(req, new URL(req.url), sub);
  }
  return { provider, faucet, fund, sent };
}

async function expectBusy(response: Response) {
  expect(response.status).toBe(503);
  expect((await response.json()).error).toBe('faucet_busy');
  expect(response.headers.get('retry-after')).toBe('1');
}

describe('faucet admission', () => {
  for (const pauseAt of ['read', 'broadcast'] as const) test(`excludes both users during paused ${pauseAt}; busy retries preserve budget`, async () => {
    const f = fixture();
    const entered = gate(); const resume = gate();
    const originalRead = f.provider.getSpendableUtxos;
    let reads = 0;
    f.provider.getSpendableUtxos = async () => {
      reads++;
      if (pauseAt === 'read' && reads === 1) { entered.release(); await resume.promise; }
      return originalRead();
    };
    const originalBroadcast = f.provider.broadcastTransaction;
    f.provider.broadcastTransaction = async (raw) => {
      if (pauseAt === 'broadcast' && f.sent.length === 0) { entered.release(); await resume.promise; }
      return originalBroadcast(raw);
    };
    const first = f.fund();
    await entered.promise;
    try {
      for (let i = 0; i < 6; i++) await expectBusy(await f.fund(i % 2 ? 'user-a' : 'user-b'));
      expect(reads).toBe(1);
    } finally { resume.release(); await first; }
    expect((await first).status).toBe(200);
    for (let i = 0; i < 5; i++) expect((await f.fund('user-b')).status).toBe(200);
    expect((await f.fund('user-b')).status).toBe(429);
    for (let i = 0; i < 4; i++) expect((await f.fund()).status).toBe(200);
    expect((await f.fund()).status).toBe(429);
  });

  test('each admitted request reads current provider inputs', async () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) expect((await f.fund()).status).toBe(200);
    const inputs = f.sent.map(raw => hex.encode(btc.Transaction.fromRaw(hex.decode(raw)).getInput(0).txid!));
    expect(inputs).toEqual([1, 2, 3, 4, 5].map(n => utxo(n).txid));
  });

  test('a stale sequential provider view can still fail at broadcast without claiming success', async () => {
    const f = fixture(); let reads = 0;
    f.provider.getSpendableUtxos = async () => { reads++; return [utxo(1)]; };
    expect((await f.fund()).status).toBe(200);
    f.provider.broadcastTransaction = async () => { throw new Error('txn-mempool-conflict'); };
    const response = await f.fund('user-b');
    expect(reads).toBe(2);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'faucet_broadcast_failed', message: 'txn-mempool-conflict' });
  });

  test('releases admission on an empty snapshot and an unexpected build error', async () => {
    const f = fixture();
    const read = f.provider.getSpendableUtxos;
    f.provider.getSpendableUtxos = async () => [];
    expect((await f.fund()).status).toBe(507);
    f.provider.getSpendableUtxos = async () => [{ ...utxo(1), txid: 'invalid' }];
    await expect(f.fund()).rejects.toThrow();
    f.provider.getSpendableUtxos = read;
    expect((await f.fund()).status).toBe(200);
  });

  test('invalid addresses do not consume the five-funding budget', async () => {
    const f = fixture();
    for (let i = 0; i < 6; i++) expect((await f.fund('user-a', 'invalid')).status).toBe(400);
    for (let i = 0; i < 5; i++) expect((await f.fund()).status).toBe(200);
    expect((await f.fund()).status).toBe(429);
  });

  for (const network of ['mainnet', 'regtest'] as const) test(`never funds on ${network} even with a miswired faucet`, async () => {
    const f = fixture(network);
    expect((await f.fund()).status).toBe(404);
    expect(f.sent).toHaveLength(0);
  });

  for (const stage of ['read', 'sign', 'broadcast'] as const) test(`releases admission after ${stage} failure`, async () => {
    const f = fixture();
    const original = { ...f.provider, ...f.faucet };
    if (stage === 'read') f.provider.getSpendableUtxos = async () => { throw new Error('read failed'); };
    if (stage === 'sign') f.faucet.signFundingTx = async () => { throw new Error('sign failed'); };
    if (stage === 'broadcast') f.provider.broadcastTransaction = async () => { throw new Error('timeout'); };
    expect((await f.fund()).status).toBe(502);
    f.provider.getSpendableUtxos = original.getSpendableUtxos;
    f.provider.broadcastTransaction = original.broadcastTransaction;
    f.faucet.signFundingTx = original.signFundingTx;
    expect((await f.fund('user-b')).status).toBe(200);
  });
});

describe('faucet broadcast acknowledgement', () => {
  for (const message of ['txn-already-in-mempool', 'txn-already-known', 'transaction already in block chain', 'transaction already in mempool']) {
    test(`returns signed transaction ID for ${message}`, async () => {
      const f = fixture(); let signed = '';
      f.provider.broadcastTransaction = async raw => { signed = raw; throw new Error(message); };
      const response = await f.fund();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ fundingUtxo: { txid: btc.Transaction.fromRaw(hex.decode(signed)).id, vout: 0, value: 20_000,
        scriptPubKey: hex.encode(btc.Transaction.fromRaw(hex.decode(signed)).getOutput(0).script!) }, changeAddress: recipient });
    });
  }
  for (const message of ['timeout', 'connection already closed', 'txn-mempool-conflict', 'bad-txns-inputs-missingorspent']) {
    test(`does not claim success for ${message} or permanently reserve its inputs`, async () => {
      const f = fixture(); let broadcasts = 0;
      f.provider.getSpendableUtxos = async () => [utxo(1)];
      f.provider.broadcastTransaction = async () => { broadcasts++; throw new Error(message); };
      const response = await f.fund();
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: 'faucet_broadcast_failed', message });
      // A later provider read may still offer the input. Admission does not
      // maintain a local spent-input ledger, even after an ambiguous failure.
      f.provider.broadcastTransaction = async raw => { broadcasts++; return btc.Transaction.fromRaw(hex.decode(raw)).id; };
      expect((await f.fund('user-b')).status).toBe(200);
      expect(broadcasts).toBe(2);
    });
  }
});
