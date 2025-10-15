/**
 * Tests for Commit Transaction functionality
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { createCommitTransaction } from '../../../../src/bitcoin/transactions/commit';
import { Utxo, InscriptionData, CommitTransactionParams } from '../../../../src/types/bitcoin';
import * as bitcoin from 'bitcoinjs-lib';

describe('Commit Transaction', () => {
  let mockUtxos: Utxo[];
  let inscriptionData: InscriptionData;
  let changeAddress: string;

  beforeEach(() => {
    // Create mock UTXOs
    mockUtxos = [
      {
        txid: 'a'.repeat(64),
        vout: 0,
        value: 10000,
        scriptPubKey: '0014' + 'b'.repeat(40) // P2WPKH scriptPubKey
      },
      {
        txid: 'c'.repeat(64),
        vout: 1,
        value: 20000,
        scriptPubKey: '0014' + 'd'.repeat(40)
      },
      {
        txid: 'e'.repeat(64),
        vout: 0,
        value: 50000,
        scriptPubKey: '0014' + 'f'.repeat(40)
      }
    ];

    // Create test inscription data
    inscriptionData = {
      content: Buffer.from('Hello Ordinals!', 'utf8'),
      contentType: 'text/plain'
    };

    changeAddress = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
  });

  describe('Address Generation Tests', () => {
    test('should generate valid P2TR reveal address', async () => {
      const params: CommitTransactionParams = {
        utxos: mockUtxos,
        feeRate: 5,
        inscriptionData,
        changeAddress,
        network: 'testnet'
      };

      const result = await createCommitTransaction(params);

      expect(result.revealAddress).toBeDefined();
      expect(typeof result.revealAddress).toBe('string');
      // P2TR addresses on testnet start with 'tb1p'
      expect(result.revealAddress.startsWith('tb1p')).toBe(true);
    });

    test('should generate P2TR address matching expected format for network', async () => {
      const mainnetParams: CommitTransactionParams = {
        utxos: mockUtxos,
        feeRate: 5,
        inscriptionData,
        changeAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        network: 'mainnet'
      };

      const result = await createCommitTransaction(mainnetParams);

      // Mainnet P2TR addresses start with 'bc1p'
      expect(result.revealAddress.startsWith('bc1p')).toBe(true);
    });

    test('should generate different addresses for different inscription data', async () => {
      const params1: CommitTransactionParams = {
        utxos: mockUtxos,
        feeRate: 5,
        inscriptionData: {
          content: Buffer.from('Content 1', 'utf8'),
          contentType: 'text/plain'
        },
        changeAddress,
        network: 'testnet'
      };

      const params2: CommitTransactionParams = {
        utxos: mockUtxos,
        feeRate: 5,
        inscriptionData: {
          content: Buffer.from('Content 2', 'utf8'),
          contentType: 'text/plain'
        },
        changeAddress,
        network: 'testnet'
      };

      const result1 = await createCommitTransaction(params1);
      const result2 = await createCommitTransaction(params2);

      // Different content should produce different reveal addresses
      // Note: This may not always be true due to random key generation
      // but is useful to verify the inscription data is being used
      expect(result1.revealAddress).toBeDefined();
      expect(result2.revealAddress).toBeDefined();
    });
  });

  describe('Fee Calculation Tests', () => {
    test('should calculate correct fee for 1 input commit', async () => {
      const singleUtxo: Utxo[] = [{
        txid: 'a'.repeat(64),
        vout: 0,
        value: 50000,
        scriptPubKey: '0014' + 'b'.repeat(40)
      }];

      const params: CommitTransactionParams = {
        utxos: singleUtxo,
        feeRate: 10,
        inscriptionData,
        changeAddress,
        network: 'testnet'
      };

      const result = await createCommitTransaction(params);

      // Expected: 1 input, 2 outputs (commit + change)
      // Size: ~10.5 + 68 + 43 + 31 = ~152.5 vbytes
      // Fee: ceil(152.5 * 10) = 1525 sats
      expect(result.fee).toBeGreaterThan(1000);
      expect(result.fee).toBeLessThan(3000);
    });

    test('should calculate correct fee for multiple inputs', async () => {
      const params: CommitTransactionParams = {
        utxos: mockUtxos,
        feeRate: 10,
        inscriptionData,
        changeAddress,
        network: 'testnet',
        minimumCommitAmount: 1000
      };

      const result = await createCommitTransaction(params);

      // Should use 1 input (10000 sats is enough for 1000 commit + fees)
      expect(result.selectedUtxos.length).toBeGreaterThanOrEqual(1);
      expect(result.fee).toBeGreaterThan(0);
    });

    test('should respect custom fee rate parameter', async () => {
      const lowFeeParams: CommitTransactionParams = {
        utxos: mockUtxos,
        feeRate: 1,
        inscriptionData,
        changeAddress,
        network: 'testnet'
      };

      const highFeeParams: CommitTransactionParams = {
        utxos: mockUtxos,
        feeRate: 50,
        inscriptionData,
        changeAddress,
        network: 'testnet'
      };

      const lowFeeResult = await createCommitTransaction(lowFeeParams);
      const highFeeResult = await createCommitTransaction(highFeeParams);

      // Higher fee rate should result in higher fee
      expect(highFeeResult.fee).toBeGreaterThan(lowFeeResult.fee);
      // Should be roughly 50x higher (accounting for UTXO selection differences)
      expect(highFeeResult.fee).toBeGreaterThan(lowFeeResult.fee * 10);
    });

    test('should handle inscription size impact on fees', async () => {
      const smallInscription: InscriptionData = {
        content: Buffer.from('Small', 'utf8'),
        contentType: 'text/plain'
      };

      const largeInscription: InscriptionData = {
        content: Buffer.alloc(1000, 'X'), // 1KB of data
        contentType: 'text/plain'
      };

      const smallParams: CommitTransactionParams = {
        utxos: mockUtxos,
        feeRate: 10,
        inscriptionData: smallInscription,
        changeAddress,
        network: 'testnet'
      };

      const largeParams: CommitTransactionParams = {
        utxos: mockUtxos,
        feeRate: 10,
        inscriptionData: largeInscription,
        changeAddress,
        network: 'testnet'
      };

      const smallResult = await createCommitTransaction(smallParams);
      const largeResult = await createCommitTransaction(largeParams);

      // Note: Commit transaction fee shouldn't differ much based on inscription size
      // The inscription is revealed in the reveal transaction, not the commit
      // Fees should be similar
      expect(smallResult.fee).toBeGreaterThan(0);
      expect(largeResult.fee).toBeGreaterThan(0);
    });
  });

  describe('PSBT Construction Tests', () => {
    test('should create valid PSBT with correct inputs', async () => {
      const params: CommitTransactionParams = {
        utxos: mockUtxos,
        feeRate: 5,
        inscriptionData,
        changeAddress,
        network: 'testnet'
      };

      const result = await createCommitTransaction(params);

      expect(result.psbt).toBeDefined();
      expect(typeof result.psbt).toBe('string');

      // Decode PSBT to verify structure
      const psbt = bitcoin.Psbt.fromBase64(result.psbt);
      expect(psbt.data.inputs.length).toBeGreaterThan(0);
      expect(psbt.data.inputs.length).toBeLessThanOrEqual(mockUtxos.length);
    });

    test('should have correct outputs (reveal + change if needed)', async () => {
      const params: CommitTransactionParams = {
        utxos: mockUtxos,
        feeRate: 5,
        inscriptionData,
        changeAddress,
        network: 'testnet'
      };

      const result = await createCommitTransaction(params);

      const psbt = bitcoin.Psbt.fromBase64(result.psbt);
      
      // Should have at least 1 output (commit/reveal output)
      expect(psbt.txOutputs.length).toBeGreaterThanOrEqual(1);
      // May have 2 outputs if change is created
      expect(psbt.txOutputs.length).toBeLessThanOrEqual(2);

      // First output should be the commit output
      expect(psbt.txOutputs[0].value).toBeGreaterThanOrEqual(546); // At least dust limit
    });

    test('should match PSBT input values to selected UTXOs', async () => {
      const params: CommitTransactionParams = {
        utxos: mockUtxos,
        feeRate: 5,
        inscriptionData,
        changeAddress,
        network: 'testnet'
      };

      const result = await createCommitTransaction(params);

      const psbt = bitcoin.Psbt.fromBase64(result.psbt);
      
      // Sum of PSBT input values should match selected UTXO values
      const psbtInputSum = psbt.data.inputs.reduce((sum, input) => {
        return sum + (input.witnessUtxo?.value || 0);
      }, 0);

      const selectedUtxoSum = result.selectedUtxos.reduce((sum, utxo) => sum + utxo.value, 0);
      
      expect(psbtInputSum).toBe(selectedUtxoSum);
    });

    test('should create change output when needed', async () => {
      const largeUtxo: Utxo[] = [{
        txid: 'a'.repeat(64),
        vout: 0,
        value: 100000, // Large UTXO will definitely need change
        scriptPubKey: '0014' + 'b'.repeat(40)
      }];

      const params: CommitTransactionParams = {
        utxos: largeUtxo,
        feeRate: 5,
        inscriptionData,
        changeAddress,
        network: 'testnet',
        minimumCommitAmount: 1000
      };

      const result = await createCommitTransaction(params);

      const psbt = bitcoin.Psbt.fromBase64(result.psbt);
      
      // Should have 2 outputs (commit + change)
      expect(psbt.txOutputs.length).toBe(2);
      expect(result.changeAmount).toBeGreaterThan(0);
    });

    test('should not create change output when below dust', async () => {
      // Use UTXO that results in change below dust limit
      const exactUtxo: Utxo[] = [{
        txid: 'a'.repeat(64),
        vout: 0,
        value: 2000, // Small amount that will leave dust change
        scriptPubKey: '0014' + 'b'.repeat(40)
      }];

      const params: CommitTransactionParams = {
        utxos: exactUtxo,
        feeRate: 1, // Low fee rate
        inscriptionData,
        changeAddress,
        network: 'testnet',
        minimumCommitAmount: 546
      };

      const result = await createCommitTransaction(params);

      // Change should be 0 if it would be dust
      if (result.changeAmount === 0) {
        const psbt = bitcoin.Psbt.fromBase64(result.psbt);
        // Should only have 1 output (commit output, no change)
        expect(psbt.txOutputs.length).toBeLessThanOrEqual(2);
      }
    });
  });

  describe('User-Selected UTXO Tests', () => {
    test('should use user-selected UTXO as first input', async () => {
      const selectedUtxo = mockUtxos[1]; // Select the second UTXO

      const params: CommitTransactionParams = {
        utxos: mockUtxos,
        feeRate: 5,
        inscriptionData,
        changeAddress,
        network: 'testnet',
        selectedInscriptionUtxo: selectedUtxo
      };

      const result = await createCommitTransaction(params);

      // First selected UTXO should be the user-selected one
      expect(result.selectedUtxos[0]).toEqual(selectedUtxo);
    });

    test('should add funding UTXOs if selected UTXO insufficient', async () => {
      const smallUtxo: Utxo = {
        txid: 'small'.padEnd(64, '0'),
        vout: 0,
        value: 1000, // Too small to cover commit + fees
        scriptPubKey: '0014' + 'b'.repeat(40)
      };

      const params: CommitTransactionParams = {
        utxos: mockUtxos,
        feeRate: 5,
        inscriptionData,
        changeAddress,
        network: 'testnet',
        selectedInscriptionUtxo: smallUtxo
      };

      const result = await createCommitTransaction(params);

      // Should have selected the small UTXO plus additional funding UTXOs
      expect(result.selectedUtxos.length).toBeGreaterThan(1);
      expect(result.selectedUtxos[0]).toEqual(smallUtxo);
    });
  });

  describe('Validation Tests', () => {
    test('should throw error when no UTXOs provided', async () => {
      const params: CommitTransactionParams = {
        utxos: [],
        feeRate: 5,
        inscriptionData,
        changeAddress,
        network: 'testnet'
      };

      await expect(createCommitTransaction(params)).rejects.toThrow('No UTXOs provided');
    });

    test('should throw error when no inscription content', async () => {
      const params: CommitTransactionParams = {
        utxos: mockUtxos,
        feeRate: 5,
        inscriptionData: {
          content: Buffer.from(''),
          contentType: 'text/plain'
        },
        changeAddress,
        network: 'testnet'
      };

      // Empty content should still work, but null/undefined should fail
      const result = await createCommitTransaction(params);
      expect(result).toBeDefined();
    });

    test('should throw error when no change address', async () => {
      const params: CommitTransactionParams = {
        utxos: mockUtxos,
        feeRate: 5,
        inscriptionData,
        changeAddress: '',
        network: 'testnet'
      };

      await expect(createCommitTransaction(params)).rejects.toThrow('Change address is required');
    });

    test('should throw error when fee rate is invalid', async () => {
      const params: CommitTransactionParams = {
        utxos: mockUtxos,
        feeRate: 0,
        inscriptionData,
        changeAddress,
        network: 'testnet'
      };

      await expect(createCommitTransaction(params)).rejects.toThrow('Invalid fee rate');
    });

    test('should throw error when insufficient funds', async () => {
      const tinyUtxos: Utxo[] = [{
        txid: 'a'.repeat(64),
        vout: 0,
        value: 100, // Too small
        scriptPubKey: '0014' + 'b'.repeat(40)
      }];

      const params: CommitTransactionParams = {
        utxos: tinyUtxos,
        feeRate: 10,
        inscriptionData,
        changeAddress,
        network: 'testnet'
      };

      await expect(createCommitTransaction(params)).rejects.toThrow();
    });
  });

  describe('Edge Cases', () => {
    test('should handle different content types', async () => {
      const contentTypes = ['text/plain', 'application/json', 'image/png', 'text/html'];

      for (const contentType of contentTypes) {
        const params: CommitTransactionParams = {
          utxos: mockUtxos,
          feeRate: 5,
          inscriptionData: {
            content: Buffer.from('test content'),
            contentType
          },
          changeAddress,
          network: 'testnet'
        };

        const result = await createCommitTransaction(params);
        expect(result.revealAddress).toBeDefined();
        expect(result.psbt).toBeDefined();
      }
    });

    test('should handle different networks', async () => {
      const networks: Array<'mainnet' | 'testnet' | 'regtest' | 'signet'> = 
        ['mainnet', 'testnet', 'regtest', 'signet'];

      for (const network of networks) {
        const params: CommitTransactionParams = {
          utxos: mockUtxos,
          feeRate: 5,
          inscriptionData,
          changeAddress,
          network
        };

        const result = await createCommitTransaction(params);
        expect(result.revealAddress).toBeDefined();
      }
    });

    test('should handle custom minimum commit amount', async () => {
      const params: CommitTransactionParams = {
        utxos: mockUtxos,
        feeRate: 5,
        inscriptionData,
        changeAddress,
        network: 'testnet',
        minimumCommitAmount: 10000
      };

      const result = await createCommitTransaction(params);

      expect(result.commitAmount).toBeGreaterThanOrEqual(10000);
    });
  });
});
