import { describe, test, expect } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { signToken, getAuthCookieConfig } from '@originals/auth/server';
import { serializeCookie } from '../cookies';
import { createBitcoinRoutes } from '../bitcoin';

const JWT = 'test-secret-at-least-32-chars-long!!';

function authedReq(path: string, body: unknown) {
  const token = signToken('sub-1', 'a@b.com', undefined, { secret: JWT });
  const cookie = serializeCookie(getAuthCookieConfig(token));
  return new Request(`http://host${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}

// A real, fully-signed-but-not-finalized P2WPKH PSBT (hex) — the shape Turnkey
// signTransaction returns, which the funding route finalizes before broadcast.
function signedFaucetPsbtHex(): string {
  const priv = hex.decode('2222222222222222222222222222222222222222222222222222222222222222');
  const pub = secp256k1.getPublicKey(priv, true);
  const p2wpkh = btc.p2wpkh(pub, btc.TEST_NETWORK);
  const tx = new btc.Transaction();
  tx.addInput({ txid: hex.decode('c'.repeat(64)), index: 0, witnessUtxo: { script: p2wpkh.script, amount: 100_000n } });
  tx.addOutputAddress('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 20_000n, btc.TEST_NETWORK);
  tx.sign(priv); // signs, does NOT finalize
  return hex.encode(tx.toPSBT());
}

function fakeProvider() {
  return {
    async getFirstSatOfOutput() { return '5000000000'; },
    async estimateFee() { return 3; },
    async broadcastTransaction() { return 'f'.repeat(64); },
    async getSpendableUtxos() {
      return [{ txid: 'a'.repeat(64), vout: 0, value: 100_000, scriptPubKey: '0014' + '0'.repeat(40) }];
    },
  } as unknown as Parameters<typeof createBitcoinRoutes>[0]['provider'];
}

function fakeTurnkey() {
  const signedTransaction = signedFaucetPsbtHex();
  return {
    apiClient: () => ({
      signTransaction: async () => ({ activity: { result: { signTransactionResult: { signedTransaction } } } }),
    }),
  } as unknown as Parameters<typeof createBitcoinRoutes>[0]['turnkey'];
}

// A real (valid-checksum) testnet4 P2WPKH faucet address — the change output
// is sent here, so it must decode.
const FAUCET_ADDRESS = btc.p2wpkh(
  secp256k1.getPublicKey(hex.decode('3'.repeat(64)), true),
  btc.TEST_NETWORK
).address!;

const deps = () => ({
  turnkey: fakeTurnkey(),
  jwtSecret: JWT,
  provider: fakeProvider(),
  faucet: { walletId: 'w-faucet', address: FAUCET_ADDRESS },
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
