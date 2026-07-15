/**
 * Shared Bitcoin test fixtures — a funded, spendable regtest P2WPKH utxo +
 * change address, mirroring the inline fixtures used across bitcoin tests.
 */
import type { Utxo } from '../../src/types/bitcoin';

export const sampleUtxo: Utxo = {
  txid: `${'a'.repeat(62)}00`,
  vout: 0,
  value: 100000,
  scriptPubKey: '0014' + 'b'.repeat(40), // Mock P2WPKH scriptPubKey
  address: 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080'
};

export const sampleChangeAddress = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
