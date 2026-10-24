/**
 * The anchoring switch (plan 011, PR 10b): off unless the server sets
 * ORIGINALS_BITCOIN_ANCHORING=1 and the bundle was built with
 * VITE_ORIGINALS_BITCOIN_ANCHORING=1. A deployment that turns it on is
 * reported: the owner's release gate (#975) decides that, not a variable.
 */
import { describe, expect, test } from 'bun:test';
import { serverAnchoringEnabled } from '../bitcoin';
import { validateConfig } from '../config';

const REGTEST = {
  BTC_NETWORK: 'regtest', REGTEST_RPC_URL: 'http://127.0.0.1:18443', REGTEST_ORD_URL: 'http://127.0.0.1:8080',
  REGTEST_RPC_AUTH: 'u:p', BTC_INDEXER_API: 'http://127.0.0.1:3002', VITE_BTC_NETWORK: 'regtest',
};
const keys = (env: Record<string, string>) => validateConfig({ env }).filter((i) => i.key.includes('ANCHORING'));

describe('the bitcoinAnchoring switch', () => {
  test('is off by default, and on only for the exact value 1', () => {
    expect(serverAnchoringEnabled({})).toBe(false);
    expect(serverAnchoringEnabled({ ORIGINALS_BITCOIN_ANCHORING: 'true' })).toBe(false);
    expect(serverAnchoringEnabled({ ORIGINALS_BITCOIN_ANCHORING: '1' })).toBe(true);
    expect(keys(REGTEST)).toEqual([]);
  });

  test('on without the Bitcoin routes configured is reported by name', () => {
    expect(keys({ ORIGINALS_BITCOIN_ANCHORING: '1', VITE_ORIGINALS_BITCOIN_ANCHORING: '1' }).map((i) => i.key)).toContain('ORIGINALS_BITCOIN_ANCHORING');
  });

  test('the bundle and the server must agree, in both directions', () => {
    expect(keys({ ...REGTEST, ORIGINALS_BITCOIN_ANCHORING: '1' }).map((i) => i.key)).toEqual(['VITE_ORIGINALS_BITCOIN_ANCHORING']);
    expect(keys({ ...REGTEST, VITE_ORIGINALS_BITCOIN_ANCHORING: '1' }).map((i) => i.key)).toEqual(['VITE_ORIGINALS_BITCOIN_ANCHORING']);
    expect(keys({ ...REGTEST, ORIGINALS_BITCOIN_ANCHORING: '1', VITE_ORIGINALS_BITCOIN_ANCHORING: '1' })).toEqual([]);
  });

  test('a deployment that turns it on is reported as an error: the owner release gate decides (#975)', () => {
    const issues = keys({ ...REGTEST, ORIGINALS_BITCOIN_ANCHORING: '1', VITE_ORIGINALS_BITCOIN_ANCHORING: '1', RAILWAY_ENVIRONMENT: 'production', NODE_ENV: 'production' });
    expect(issues).toEqual([expect.objectContaining({ key: 'ORIGINALS_BITCOIN_ANCHORING', severity: 'error' })]);
  });
});
