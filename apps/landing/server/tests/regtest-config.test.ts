import { describe, expect, test } from 'bun:test';
import * as btc from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hex } from '@scure/base';
import { isBitcoinConfigured, p2wpkhScriptHex, resolveIndexer, serverBtcNetwork } from '../bitcoin';
import { validateConfig } from '../config';

const env = { BTC_NETWORK: 'regtest', VITE_BTC_NETWORK: 'regtest', REGTEST_RPC_URL: 'http://127.0.0.1:18443', REGTEST_ORD_URL: 'http://127.0.0.1:8080', REGTEST_RPC_AUTH: 'local:secret', BTC_INDEXER_API: 'http://127.0.0.1:8081/api' };

describe('explicit local regtest', () => {
  test('rejects node URL protocols the provider cannot use', () => {
    const issues = validateConfig({ env: { ...env, REGTEST_RPC_URL: 'https://localhost:18443', REGTEST_ORD_URL: 'https://localhost:8080' }, dataDir: null });
    expect(issues.filter(i => i.key.startsWith('REGTEST_')).map(i => i.key)).toEqual(['REGTEST_RPC_URL', 'REGTEST_ORD_URL']);
  });
  test('uses local services without QuickNode or a testnet faucet', () => {
    expect(serverBtcNetwork(env)).toBe('regtest');
    expect(isBitcoinConfigured(env)).toBe(true);
    expect(validateConfig({ env, dataDir: null }).filter(i => i.key.startsWith('BTC_') || i.key.startsWith('REGTEST_') || i.key === 'VITE_BTC_NETWORK')).toEqual([]);
  });
  test('requires an explicit loopback indexer and ignores public legacy defaults', () => {
    expect(resolveIndexer(env)).toEqual({ api: env.BTC_INDEXER_API });
    expect(() => resolveIndexer({ BTC_NETWORK: 'regtest', MEMPOOL_API: 'https://mempool.space/api' })).toThrow(/regtest/i);
    expect(() => resolveIndexer({ ...env, BTC_INDEXER_API: 'https://mempool.space/api' })).toThrow(/loopback/i);
  });
  test('derives the same witness script for a bcrt address and refuses tb1 on regtest', () => {
    const pub = secp256k1.getPublicKey(new Uint8Array(32).fill(3), true);
    const payment = btc.p2wpkh(pub, { ...btc.TEST_NETWORK, bech32: 'bcrt' });
    expect(p2wpkhScriptHex(payment.address!, 'regtest')).toBe(hex.encode(payment.script));
    expect(() => p2wpkhScriptHex(btc.p2wpkh(pub, btc.TEST_NETWORK).address!, 'regtest')).toThrow();
  });
});
