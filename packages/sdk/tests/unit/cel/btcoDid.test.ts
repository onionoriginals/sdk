import { describe, test, expect } from 'bun:test';
import { btcoDidPrefix, btcoDidFromSatoshi } from '../../../src/cel/btcoDid';

describe('btcoDid helpers', () => {
  test('derives network-scoped prefixes', () => {
    expect(btcoDidFromSatoshi('123', 'mainnet')).toBe('did:btco:123');
    expect(btcoDidFromSatoshi('123', 'signet')).toBe('did:btco:sig:123');
    expect(btcoDidFromSatoshi('123', 'regtest')).toBe('did:btco:reg:123');
  });

  test('undefined network (legacy log) defaults to the bare mainnet form', () => {
    expect(btcoDidFromSatoshi('123', undefined)).toBe('did:btco:123');
  });

  test('throws on unrecognized networks instead of silently minting a mainnet DID', () => {
    expect(() => btcoDidPrefix('testnet')).toThrow('Unsupported Bitcoin network');
    expect(() => btcoDidFromSatoshi('123', 'mainet')).toThrow('Unsupported Bitcoin network');
  });
});
