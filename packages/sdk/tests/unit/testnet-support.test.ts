import { describe, test, expect } from 'bun:test';
import { btcoDidPrefix, btcoDidFromSatoshi } from '../../src/cel/btcoDid.js';
import { createBtcoDidDocument } from '../../src/did/createBtcoDidDocument.js';
import { validateBitcoinAddress, isValidBitcoinAddress } from '../../src/utils/bitcoin-address.js';

describe('SDK testnet (testnet4) support', () => {
  test('btcoDidPrefix maps testnet to did:btco:test', () => {
    expect(btcoDidPrefix('testnet')).toBe('did:btco:test');
    expect(btcoDidFromSatoshi('123456', 'testnet')).toBe('did:btco:test:123456');
  });

  test('createBtcoDidDocument mints a did:btco:test id on testnet', () => {
    const doc = createBtcoDidDocument('123456', 'testnet', {
      publicKey: '02'.padEnd(66, '0'),
      keyType: 'ES256K',
    });
    expect(doc.id).toBe('did:btco:test:123456');
  });

  test('validateBitcoinAddress accepts a testnet4 tb1 P2WPKH address under "testnet"', () => {
    // Canonical BIP-173 testnet P2WPKH vector (tb1 prefix; testnet4 shares it).
    const tb1 = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
    expect(isValidBitcoinAddress(tb1, 'testnet')).toBe(true);
    // A mainnet bc1 address must NOT validate as testnet.
    expect(isValidBitcoinAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'testnet')).toBe(false);
  });
});
