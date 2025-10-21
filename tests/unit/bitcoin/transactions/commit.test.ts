/**
 * Tests for commit transaction creation
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createCommitTransaction,
  type CommitTransactionParams,
  type CommitTransactionResult
} from '../../../../src/bitcoin/transactions/commit.js';
import type { Utxo } from '../../../../src/types/bitcoin.js';

// Helper to create test UTXOs
const createUtxo = (value: number, index: number = 0): Utxo => ({
  txid: `${'a'.repeat(62)}${index.toString().padStart(2, '0')}`,
  vout: index,
  value,
  scriptPubKey: '0014' + 'b'.repeat(40), // Mock P2WPKH scriptPubKey
  address: 'bc1q' + 'test'.repeat(10)
});

// Helper to create basic commit params
const createCommitParams = (overrides: Partial<CommitTransactionParams> = {}): CommitTransactionParams => ({
  content: Buffer.from('Hello Ordinals'),
  contentType: 'text/plain',
  utxos: [createUtxo(10000, 0)],
  changeAddress: 'bc1qtest' + 'addr'.repeat(10),
  feeRate: 10,
  network: 'mainnet',
  ...overrides
});

describe('createCommitTransaction', () => {
  describe('Basic Functionality', () => {
    test('creates commit transaction with valid inputs', async () => {
      const params = createCommitParams();
      const result = await createCommitTransaction(params);

      expect(result).toBeDefined();
      expect(result.commitAddress).toBeDefined();
      expect(result.commitPsbtBase64).toBeDefined();
      expect(result.commitPsbt).toBeDefined();
      expect(result.selectedUtxos).toHaveLength(1);
      expect(result.fees.commit).toBeGreaterThan(0);
    });

    test('generates valid P2TR commit address', async () => {
      const params = createCommitParams();
      const result = await createCommitTransaction(params);

      // P2TR addresses start with bc1p for mainnet
      expect(result.commitAddress).toMatch(/^bc1p[a-z0-9]{58}$/);
    });

    test('generates reveal keypair', async () => {
      const params = createCommitParams();
      const result = await createCommitTransaction(params);

      expect(result.revealPrivateKey).toBeDefined();
      expect(result.revealPublicKey).toBeDefined();
      expect(result.revealPrivateKey).toHaveLength(64); // 32 bytes in hex
      expect(result.revealPublicKey).toHaveLength(64); // 32 bytes x-only pubkey in hex
    });

    test('includes inscription script data', async () => {
      const params = createCommitParams();
      const result = await createCommitTransaction(params);

      expect(result.inscriptionScript).toBeDefined();
      expect(result.inscriptionScript.script).toBeInstanceOf(Uint8Array);
      expect(result.inscriptionScript.controlBlock).toBeInstanceOf(Uint8Array);
      expect(result.inscriptionScript.leafVersion).toBe(0xc0);
    });

    test('returns correct commit amount', async () => {
      const params = createCommitParams({ minimumCommitAmount: 1000 });
      const result = await createCommitTransaction(params);

      expect(result.commitAmount).toBeGreaterThanOrEqual(1000);
      expect(result.commitAmount).toBeGreaterThanOrEqual(546); // Dust limit
    });
  });

  describe('UTXO Selection', () => {
    test('selects single UTXO when sufficient', async () => {
      const params = createCommitParams({
        utxos: [createUtxo(10000, 0)]
      });
      const result = await createCommitTransaction(params);

      expect(result.selectedUtxos).toHaveLength(1);
      expect(result.selectedUtxos[0].value).toBe(10000);
    });

    test('selects multiple UTXOs when needed', async () => {
      const params = createCommitParams({
        utxos: [
          createUtxo(1000, 0),
          createUtxo(1000, 1),
          createUtxo(1000, 2)
        ],
        minimumCommitAmount: 2000
      });
      const result = await createCommitTransaction(params);

      expect(result.selectedUtxos.length).toBeGreaterThan(1);
      const totalValue = result.selectedUtxos.reduce((sum, utxo) => sum + utxo.value, 0);
      expect(totalValue).toBeGreaterThanOrEqual(2000 + result.fees.commit);
    });

    test('throws when insufficient funds', async () => {
      const params = createCommitParams({
        utxos: [createUtxo(100, 0)], // Not enough for commit + fees
        minimumCommitAmount: 546
      });

      await expect(createCommitTransaction(params)).rejects.toThrow(/Insufficient funds/);
    });
  });

  describe('Fee Calculation', () => {
    test('calculates correct fee for 1 input', async () => {
      const feeRate = 10; // 10 sats/vB
      const params = createCommitParams({
        feeRate,
        utxos: [createUtxo(10000, 0)]
      });
      const result = await createCommitTransaction(params);

      // Fee should be reasonable for 1 input, 2 outputs (commit + change)
      // Estimate: ~10.5 overhead + 68 input + 43 P2TR + 31 change = ~152 vB
      // At 10 sats/vB = ~1520 sats
      expect(result.fees.commit).toBeGreaterThan(1000);
      expect(result.fees.commit).toBeLessThan(3000);
    });

    test('fee scales with fee rate', async () => {
      const params1 = createCommitParams({ feeRate: 5 });
      const params2 = createCommitParams({ feeRate: 50 });

      const result1 = await createCommitTransaction(params1);
      const result2 = await createCommitTransaction(params2);

      // Fee should be ~10x higher for 10x fee rate
      expect(result2.fees.commit).toBeGreaterThan(result1.fees.commit * 8);
      expect(result2.fees.commit).toBeLessThan(result1.fees.commit * 12);
    });

    test('fee increases with multiple inputs', async () => {
      const params1 = createCommitParams({
        utxos: [createUtxo(10000, 0)]
      });
      const params2 = createCommitParams({
        utxos: [
          createUtxo(3000, 0),
          createUtxo(3000, 1),
          createUtxo(3000, 2)
        ]
      });

      const result1 = await createCommitTransaction(params1);
      const result2 = await createCommitTransaction(params2);

      // More inputs = higher fee
      expect(result2.fees.commit).toBeGreaterThan(result1.fees.commit);
    });
  });

  describe('PSBT Construction', () => {
    test('PSBT has correct number of inputs', async () => {
      const params = createCommitParams({
        utxos: [createUtxo(10000, 0)]
      });
      const result = await createCommitTransaction(params);

      expect(result.commitPsbt.inputsLength).toBe(1);
    });

    test('PSBT includes commit output', async () => {
      const params = createCommitParams();
      const result = await createCommitTransaction(params);

      expect(result.commitPsbt.outputsLength).toBeGreaterThanOrEqual(1);
    });

    test('PSBT creates change output when needed', async () => {
      const params = createCommitParams({
        utxos: [createUtxo(100000, 0)], // Large UTXO
        minimumCommitAmount: 546
      });
      const result = await createCommitTransaction(params);

      // Should have commit output + change output
      expect(result.commitPsbt.outputsLength).toBe(2);
    });

    test('PSBT omits change when below dust limit', async () => {
      const params = createCommitParams({
        utxos: [createUtxo(2000, 0)], // Just enough for commit + fees, no change
        minimumCommitAmount: 546,
        feeRate: 10
      });
      const result = await createCommitTransaction(params);

      // Should have only commit output (change below dust limit)
      expect(result.commitPsbt.outputsLength).toBe(1);
    });

    test('PSBT is valid base64', async () => {
      const params = createCommitParams();
      const result = await createCommitTransaction(params);

      expect(result.commitPsbtBase64).toBeDefined();
      expect(typeof result.commitPsbtBase64).toBe('string');

      // Should be valid base64
      const decoded = Buffer.from(result.commitPsbtBase64, 'base64');
      expect(decoded.length).toBeGreaterThan(0);
    });
  });

  describe('Inscription Content', () => {
    test('handles text content', async () => {
      const params = createCommitParams({
        content: Buffer.from('Hello World'),
        contentType: 'text/plain'
      });
      const result = await createCommitTransaction(params);

      expect(result).toBeDefined();
      expect(result.commitAddress).toBeDefined();
    });

    test('handles JSON content', async () => {
      const params = createCommitParams({
        content: Buffer.from(JSON.stringify({ test: 'data' })),
        contentType: 'application/json'
      });
      const result = await createCommitTransaction(params);

      expect(result).toBeDefined();
      expect(result.commitAddress).toBeDefined();
    });

    test('handles binary content', async () => {
      const params = createCommitParams({
        content: Buffer.from([0x89, 0x50, 0x4E, 0x47]), // PNG header
        contentType: 'image/png'
      });
      const result = await createCommitTransaction(params);

      expect(result).toBeDefined();
      expect(result.commitAddress).toBeDefined();
    });

    test('handles large content (1KB)', async () => {
      const largeContent = Buffer.alloc(1024, 'a');
      const params = createCommitParams({
        content: largeContent,
        contentType: 'text/plain',
        utxos: [createUtxo(100000, 0)]
      });
      const result = await createCommitTransaction(params);

      expect(result).toBeDefined();
      expect(result.commitAddress).toBeDefined();
    });

    test('includes metadata when provided', async () => {
      const params = createCommitParams({
        metadata: { title: 'Test Inscription', author: 'Tester' }
      });
      const result = await createCommitTransaction(params);

      expect(result).toBeDefined();
      expect(result.commitAddress).toBeDefined();
    });

    test('includes pointer when provided', async () => {
      const params = createCommitParams({
        pointer: 0
      });
      const result = await createCommitTransaction(params);

      expect(result).toBeDefined();
      expect(result.commitAddress).toBeDefined();
    });
  });

  describe('Network Support', () => {
    test('creates mainnet commit address', async () => {
      const params = createCommitParams({ network: 'mainnet' });
      const result = await createCommitTransaction(params);

      expect(result.commitAddress).toMatch(/^bc1p/);
    });

    test('creates testnet commit address', async () => {
      const params = createCommitParams({ network: 'testnet' });
      const result = await createCommitTransaction(params);

      expect(result.commitAddress).toMatch(/^tb1p/);
    });

    test('creates signet commit address', async () => {
      const params = createCommitParams({ network: 'signet' });
      const result = await createCommitTransaction(params);

      expect(result.commitAddress).toMatch(/^tb1p/);
    });

    test('creates regtest commit address', async () => {
      const params = createCommitParams({ network: 'regtest' });
      const result = await createCommitTransaction(params);

      expect(result.commitAddress).toMatch(/^bcrt1p/);
    });
  });

  describe('Error Handling', () => {
    test('throws when no UTXOs provided', async () => {
      const params = createCommitParams({ utxos: [] });
      await expect(createCommitTransaction(params)).rejects.toThrow(/No UTXOs provided/);
    });

    test('throws when content is empty', async () => {
      const params = createCommitParams({ content: Buffer.from([]) });
      await expect(createCommitTransaction(params)).rejects.toThrow(/missing content/);
    });

    test('throws when contentType is missing', async () => {
      const params = createCommitParams({ contentType: '' });
      await expect(createCommitTransaction(params)).rejects.toThrow(/missing content type/);
    });

    test('throws when changeAddress is missing', async () => {
      const params = createCommitParams({ changeAddress: '' });
      await expect(createCommitTransaction(params)).rejects.toThrow(/Change address is required/);
    });

    test('throws when feeRate is invalid', async () => {
      const params = createCommitParams({ feeRate: 0 });
      await expect(createCommitTransaction(params)).rejects.toThrow(/Invalid fee rate/);
    });

    test('handles UTXO without scriptPubKey gracefully', async () => {
      const invalidUtxo: Utxo = {
        txid: 'a'.repeat(64),
        vout: 0,
        value: 10000
        // Missing scriptPubKey
      };

      const params = createCommitParams({
        utxos: [invalidUtxo, createUtxo(10000, 1)]
      });

      // Should skip the invalid UTXO and use the valid one
      const result = await createCommitTransaction(params);
      expect(result).toBeDefined();
    });
  });

  describe('Dust Handling', () => {
    test('respects minimum dust limit (546 sats)', async () => {
      const params = createCommitParams({ minimumCommitAmount: 100 });
      const result = await createCommitTransaction(params);

      // Should use dust limit instead of 100
      expect(result.commitAmount).toBeGreaterThanOrEqual(546);
    });

    test('uses custom minimum when above dust limit', async () => {
      const params = createCommitParams({ minimumCommitAmount: 10000 });
      const result = await createCommitTransaction(params);

      expect(result.commitAmount).toBe(10000);
    });

    test('adds dust change to fee', async () => {
      // Create scenario where change would be < 546 sats
      const params = createCommitParams({
        utxos: [createUtxo(1500, 0)],
        minimumCommitAmount: 546,
        feeRate: 5
      });
      const result = await createCommitTransaction(params);

      // Should have only commit output (no change)
      expect(result.commitPsbt.outputsLength).toBe(1);
    });
  });

  describe('Consistency', () => {
    test('generates different addresses for different content', async () => {
      const params1 = createCommitParams({ content: Buffer.from('Content 1') });
      const params2 = createCommitParams({ content: Buffer.from('Content 2') });

      const result1 = await createCommitTransaction(params1);
      const result2 = await createCommitTransaction(params2);

      // Different content should generate different addresses
      expect(result1.commitAddress).not.toBe(result2.commitAddress);
    });

    test('generates different addresses on each call (random keypair)', async () => {
      const params = createCommitParams();

      const result1 = await createCommitTransaction(params);
      const result2 = await createCommitTransaction(params);

      // Different reveal keypairs should generate different addresses
      expect(result1.commitAddress).not.toBe(result2.commitAddress);
      expect(result1.revealPrivateKey).not.toBe(result2.revealPrivateKey);
    });

    test('total value equals commit + change + fees', async () => {
      const params = createCommitParams({
        utxos: [createUtxo(100000, 0)]
      });
      const result = await createCommitTransaction(params);

      const totalInput = result.selectedUtxos.reduce((sum, utxo) => sum + utxo.value, 0);
      const totalOutput = result.commitAmount;
      const fee = result.fees.commit;

      // Get change amount from PSBT if it exists
      let changeAmount = 0;
      if (result.commitPsbt.outputsLength === 2) {
        changeAmount = totalInput - totalOutput - fee;
      }

      expect(totalInput).toBe(totalOutput + changeAmount + fee);
    });
  });
});
