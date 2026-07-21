import { describe, test, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { hex, base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { serializeCookie } from '../cookies';
import { createBitcoinRoutes, rawKeyFaucetSigner, fetchFaucetUtxos } from '../bitcoin';

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
});
