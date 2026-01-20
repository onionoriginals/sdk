/**
 * BitcoinWitness Unit Tests
 * 
 * Tests for the Bitcoin-based witness service implementation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BitcoinWitness, BitcoinWitnessError } from '../../../src/cel/witnesses/BitcoinWitness';
import type { BitcoinWitnessProof } from '../../../src/cel/witnesses/BitcoinWitness';
import type { BitcoinManager } from '../../../src/bitcoin/BitcoinManager';
import type { OrdinalsInscription } from '../../../src/types';

describe('BitcoinWitness', () => {
  // Test digest (multibase base64url-nopad prefix 'u')
  const testDigest = 'uEiDf4P8v1...base64urlEncoded';
  
  // Mock inscription result
  const mockInscription: OrdinalsInscription = {
    satoshi: '1234567890',
    inscriptionId: 'abc123i0',
    content: { '@context': 'https://w3id.org/cel/v1' },
    contentType: 'application/json',
    txid: 'def456789012345678901234567890123456789012345678901234567890abcd',
    vout: 0,
    blockHeight: 800000,
  };

  // Create a mock BitcoinManager
  const createMockBitcoinManager = (
    overrides: Partial<{
      inscribeData: typeof mockBitcoinManager.inscribeData;
    }> = {}
  ) => {
    const mockBitcoinManager = {
      inscribeData: vi.fn().mockResolvedValue(mockInscription),
      ...overrides,
    } as unknown as BitcoinManager;
    return mockBitcoinManager;
  };

  let mockBitcoinManager: BitcoinManager;

  beforeEach(() => {
    mockBitcoinManager = createMockBitcoinManager();
  });

  describe('constructor', () => {
    it('accepts a valid BitcoinManager instance', () => {
      const witness = new BitcoinWitness(mockBitcoinManager);
      expect(witness).toBeInstanceOf(BitcoinWitness);
    });

    it('throws error for null BitcoinManager', () => {
      expect(() => new BitcoinWitness(null as unknown as BitcoinManager))
        .toThrow('BitcoinManager instance is required');
    });

    it('throws error for undefined BitcoinManager', () => {
      expect(() => new BitcoinWitness(undefined as unknown as BitcoinManager))
        .toThrow('BitcoinManager instance is required');
    });

    it('accepts custom options', () => {
      const witness = new BitcoinWitness(mockBitcoinManager, {
        feeRate: 10,
        verificationMethod: 'did:btco:custom#key-1',
      });
      expect(witness.configuredFeeRate).toBe(10);
    });

    it('uses default verificationMethod when not provided', () => {
      const witness = new BitcoinWitness(mockBitcoinManager);
      expect(witness.configuredFeeRate).toBeUndefined();
    });
  });

  describe('witness()', () => {
    it('calls BitcoinManager.inscribeData with correct parameters', async () => {
      const witness = new BitcoinWitness(mockBitcoinManager);
      
      await witness.witness(testDigest);

      expect(mockBitcoinManager.inscribeData).toHaveBeenCalledWith(
        expect.objectContaining({
          '@context': 'https://w3id.org/cel/v1',
          type: 'BitcoinWitnessAttestation',
          digestMultibase: testDigest,
        }),
        'application/json',
        undefined
      );
    });

    it('passes feeRate to inscribeData when configured', async () => {
      const witness = new BitcoinWitness(mockBitcoinManager, { feeRate: 15 });
      
      await witness.witness(testDigest);

      expect(mockBitcoinManager.inscribeData).toHaveBeenCalledWith(
        expect.anything(),
        'application/json',
        15
      );
    });

    it('returns a valid BitcoinWitnessProof', async () => {
      const witness = new BitcoinWitness(mockBitcoinManager);
      
      const proof = await witness.witness(testDigest);

      expect(proof.type).toBe('DataIntegrityProof');
      expect(proof.cryptosuite).toBe('bitcoin-ordinals-2024');
      expect(proof.proofPurpose).toBe('assertionMethod');
      expect(proof.witnessedAt).toBeDefined();
      expect(proof.created).toBeDefined();
    });

    it('includes Bitcoin-specific fields in proof', async () => {
      const witness = new BitcoinWitness(mockBitcoinManager);
      
      const proof = await witness.witness(testDigest) as BitcoinWitnessProof;

      expect(proof.txid).toBe(mockInscription.txid);
      expect(proof.blockHeight).toBe(mockInscription.blockHeight);
      expect(proof.satoshi).toBe(mockInscription.satoshi);
      expect(proof.inscriptionId).toBe(mockInscription.inscriptionId);
    });

    it('uses inscriptionId as proofValue with multibase prefix', async () => {
      const witness = new BitcoinWitness(mockBitcoinManager);
      
      const proof = await witness.witness(testDigest);

      expect(proof.proofValue).toBe(`z${mockInscription.inscriptionId}`);
    });

    it('uses custom verificationMethod when provided', async () => {
      const witness = new BitcoinWitness(mockBitcoinManager, {
        verificationMethod: 'did:btco:12345#key-1',
      });
      
      const proof = await witness.witness(testDigest);

      expect(proof.verificationMethod).toBe('did:btco:12345#key-1');
    });

    it('uses default verificationMethod when not provided', async () => {
      const witness = new BitcoinWitness(mockBitcoinManager);
      
      const proof = await witness.witness(testDigest);

      expect(proof.verificationMethod).toBe('did:btco:witness');
    });

    it('throws error for empty digestMultibase', async () => {
      const witness = new BitcoinWitness(mockBitcoinManager);

      await expect(witness.witness('')).rejects.toThrow('digestMultibase must be a non-empty string');
    });

    it('throws error for null digestMultibase', async () => {
      const witness = new BitcoinWitness(mockBitcoinManager);

      await expect(witness.witness(null as unknown as string))
        .rejects.toThrow('digestMultibase must be a non-empty string');
    });

    it('throws error for invalid multibase prefix', async () => {
      const witness = new BitcoinWitness(mockBitcoinManager);

      await expect(witness.witness('xInvalidPrefix'))
        .rejects.toThrow("Invalid digestMultibase encoding: expected prefix 'u' or 'z'");
    });

    it('accepts base64url-nopad encoded digests (prefix u)', async () => {
      const witness = new BitcoinWitness(mockBitcoinManager);
      
      const proof = await witness.witness('uEiDbase64urlDigest');

      expect(proof).toBeDefined();
      expect(proof.txid).toBe(mockInscription.txid);
    });

    it('accepts base58btc encoded digests (prefix z)', async () => {
      const witness = new BitcoinWitness(mockBitcoinManager);
      
      const proof = await witness.witness('z7WwTsLQi...base58btcDigest');

      expect(proof).toBeDefined();
      expect(proof.txid).toBe(mockInscription.txid);
    });
  });

  describe('error handling', () => {
    it('throws BitcoinWitnessError when inscription fails', async () => {
      const errorManager = createMockBitcoinManager({
        inscribeData: vi.fn().mockRejectedValue(new Error('Inscription failed')),
      });
      const witness = new BitcoinWitness(errorManager);

      await expect(witness.witness(testDigest))
        .rejects.toThrow(BitcoinWitnessError);
      await expect(witness.witness(testDigest))
        .rejects.toThrow('Failed to inscribe witness on Bitcoin');
    });

    it('includes digest in error', async () => {
      const errorManager = createMockBitcoinManager({
        inscribeData: vi.fn().mockRejectedValue(new Error('Inscription failed')),
      });
      const witness = new BitcoinWitness(errorManager);

      try {
        await witness.witness(testDigest);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BitcoinWitnessError);
        const btcError = error as BitcoinWitnessError;
        expect(btcError.digest).toBe(testDigest);
      }
    });

    it('includes cause error when available', async () => {
      const originalError = new Error('Original error');
      const errorManager = createMockBitcoinManager({
        inscribeData: vi.fn().mockRejectedValue(originalError),
      });
      const witness = new BitcoinWitness(errorManager);

      try {
        await witness.witness(testDigest);
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(BitcoinWitnessError);
        const btcError = error as BitcoinWitnessError;
        expect(btcError.cause).toBe(originalError);
      }
    });

    it('throws error when inscription returns no inscriptionId', async () => {
      const badManager = createMockBitcoinManager({
        inscribeData: vi.fn().mockResolvedValue({
          ...mockInscription,
          inscriptionId: '',
        }),
      });
      const witness = new BitcoinWitness(badManager);

      await expect(witness.witness(testDigest))
        .rejects.toThrow('did not return a valid inscription ID');
    });

    it('throws error when inscription returns no txid', async () => {
      const badManager = createMockBitcoinManager({
        inscribeData: vi.fn().mockResolvedValue({
          ...mockInscription,
          txid: '',
        }),
      });
      const witness = new BitcoinWitness(badManager);

      await expect(witness.witness(testDigest))
        .rejects.toThrow('did not return a transaction ID');
    });

    it('wraps non-Error throws', async () => {
      const errorManager = createMockBitcoinManager({
        inscribeData: vi.fn().mockRejectedValue('String error'),
      });
      const witness = new BitcoinWitness(errorManager);

      await expect(witness.witness(testDigest))
        .rejects.toThrow(BitcoinWitnessError);
      await expect(witness.witness(testDigest))
        .rejects.toThrow('String error');
    });
  });

  describe('BitcoinWitnessError', () => {
    it('has correct properties', () => {
      const cause = new Error('Root cause');
      const error = new BitcoinWitnessError('Test error message', testDigest, cause);

      expect(error.name).toBe('BitcoinWitnessError');
      expect(error.message).toBe('Test error message');
      expect(error.digest).toBe(testDigest);
      expect(error.cause).toBe(cause);
    });

    it('works without optional properties', () => {
      const error = new BitcoinWitnessError('Test error');

      expect(error.name).toBe('BitcoinWitnessError');
      expect(error.digest).toBeUndefined();
      expect(error.cause).toBeUndefined();
    });

    it('is instanceof Error', () => {
      const error = new BitcoinWitnessError('Test');
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('integration with WitnessService interface', () => {
    it('implements WitnessService interface correctly', async () => {
      const witness = new BitcoinWitness(mockBitcoinManager);

      // Should have witness method that matches interface
      expect(typeof witness.witness).toBe('function');

      const proof = await witness.witness(testDigest);
      expect(proof.witnessedAt).toBeDefined();
    });

    it('can be used with multiple digests sequentially', async () => {
      const digests = ['uEiD111...', 'uEiD222...', 'uEiD333...'];
      let callCount = 0;
      
      const sequentialManager = createMockBitcoinManager({
        inscribeData: vi.fn().mockImplementation(async () => ({
          ...mockInscription,
          inscriptionId: `inscription-${++callCount}i0`,
          txid: `txid-${callCount}`,
          satoshi: `${1000000 + callCount}`,
        })),
      });

      const witness = new BitcoinWitness(sequentialManager);

      for (let i = 0; i < digests.length; i++) {
        const proof = await witness.witness(digests[i]) as BitcoinWitnessProof;
        expect(proof.inscriptionId).toBe(`inscription-${i + 1}i0`);
        expect(proof.txid).toBe(`txid-${i + 1}`);
        expect(proof.satoshi).toBe(`${1000000 + i + 1}`);
      }

      expect(sequentialManager.inscribeData).toHaveBeenCalledTimes(3);
    });
  });

  describe('witness attestation data', () => {
    it('includes @context in witness data', async () => {
      const localManager = createMockBitcoinManager();
      const witness = new BitcoinWitness(localManager);
      
      await witness.witness(testDigest);

      const calls = (localManager.inscribeData as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBe(1);
      const inscribedData = calls[0][0] as Record<string, unknown>;
      expect(inscribedData['@context']).toBe('https://w3id.org/cel/v1');
    });

    it('includes type: BitcoinWitnessAttestation in witness data', async () => {
      const localManager = createMockBitcoinManager();
      const witness = new BitcoinWitness(localManager);
      
      await witness.witness(testDigest);

      const calls = (localManager.inscribeData as ReturnType<typeof vi.fn>).mock.calls;
      const inscribedData = calls[0][0] as Record<string, unknown>;
      expect(inscribedData.type).toBe('BitcoinWitnessAttestation');
    });

    it('includes digestMultibase in witness data', async () => {
      const localManager = createMockBitcoinManager();
      const witness = new BitcoinWitness(localManager);
      
      await witness.witness(testDigest);

      const calls = (localManager.inscribeData as ReturnType<typeof vi.fn>).mock.calls;
      const inscribedData = calls[0][0] as Record<string, unknown>;
      expect(inscribedData.digestMultibase).toBe(testDigest);
    });

    it('includes witnessedAt timestamp in witness data', async () => {
      const localManager = createMockBitcoinManager();
      const witness = new BitcoinWitness(localManager);
      
      await witness.witness(testDigest);

      const calls = (localManager.inscribeData as ReturnType<typeof vi.fn>).mock.calls;
      const inscribedData = calls[0][0] as Record<string, unknown>;
      expect(inscribedData.witnessedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });

  describe('inscription without blockHeight', () => {
    it('handles inscription without blockHeight (unconfirmed)', async () => {
      const unconfirmedManager = createMockBitcoinManager({
        inscribeData: vi.fn().mockResolvedValue({
          ...mockInscription,
          blockHeight: undefined,
        }),
      });
      const witness = new BitcoinWitness(unconfirmedManager);
      
      const proof = await witness.witness(testDigest) as BitcoinWitnessProof;

      expect(proof.blockHeight).toBeUndefined();
      expect(proof.txid).toBe(mockInscription.txid);
    });
  });

  describe('configuredFeeRate getter', () => {
    it('returns configured feeRate', () => {
      const witness = new BitcoinWitness(mockBitcoinManager, { feeRate: 25 });
      expect(witness.configuredFeeRate).toBe(25);
    });

    it('returns undefined when feeRate not configured', () => {
      const witness = new BitcoinWitness(mockBitcoinManager);
      expect(witness.configuredFeeRate).toBeUndefined();
    });
  });
});
