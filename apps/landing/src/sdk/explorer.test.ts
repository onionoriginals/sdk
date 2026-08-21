import { describe, test, expect } from 'bun:test';
import { explorerTxUrl } from './explorer';

const TXID = 'ebcd9386dcf02aa3f58e279cf3a72368c56578bf0ad25099c9389ac2dc360c9a';

describe('the explorer link points at the right chain, or nowhere', () => {
  test('mainnet and testnet4 go to their own explorers', () => {
    expect(explorerTxUrl('mainnet', TXID)).toBe(`https://mempool.space/tx/${TXID}`);
    expect(explorerTxUrl('testnet4', TXID)).toBe(`https://mempool.space/testnet4/tx/${TXID}`);
  });

  // A mainnet txid on a testnet explorer (or vice versa) shows "not found",
  // which reads as "my money is gone" at exactly the wrong moment.
  test('the two never share a URL', () => {
    expect(explorerTxUrl('mainnet', TXID)).not.toBe(explorerTxUrl('testnet4', TXID));
  });

  test('an unknown network gets no link rather than a guessed one', () => {
    expect(explorerTxUrl('off', TXID)).toBeNull();
  });

  // The txid reaches this from a server response; it ends up in an href.
  test('anything that is not a txid is refused', () => {
    for (const bad of ['', 'not-a-txid', TXID.slice(0, 63), `${TXID}00`, 'javascript:alert(1)']) {
      expect(explorerTxUrl('mainnet', bad)).toBeNull();
    }
  });
});
