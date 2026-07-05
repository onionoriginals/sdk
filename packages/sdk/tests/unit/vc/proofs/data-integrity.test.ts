/** Canonical test aggregator created by combine-tests script. */

/** Inlined from data-integrity.branches.part.ts */
import { describe, test, expect } from 'bun:test';
import { DataIntegrityProofManager } from '../../../../src/vc/proofs/data-integrity';

describe('DataIntegrityProofManager branches', () => {
  test('unsupported cryptosuite on create throws', async () => {
    await expect(DataIntegrityProofManager.createProof({ id: 'x' }, {
      verificationMethod: 'did:ex#key-1',
      proofPurpose: 'assertionMethod',
      type: 'DataIntegrityProof',
      cryptosuite: 'unknown'
    } as any)).rejects.toThrow('Unsupported cryptosuite');
  });

  test('unsupported cryptosuite on verify returns false', async () => {
    const res = await DataIntegrityProofManager.verifyProof({ id: 'x' }, {
      type: 'DataIntegrityProof', cryptosuite: 'unknown', verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', proofValue: 'z'
    } as any, { documentLoader: async () => ({ document: {}, documentUrl: '', contextUrl: null }) });
    expect(res.verified).toBe(false);
    expect(res.errors?.[0]).toContain('Unsupported cryptosuite');
  });

  test('non-DataIntegrityProof proof type on verify returns false', async () => {
    const res = await DataIntegrityProofManager.verifyProof({ id: 'x' }, {
      type: 'Ed25519Signature2020', cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', proofValue: 'z'
    } as any, { documentLoader: async () => ({ document: {}, documentUrl: '', contextUrl: null }) });
    expect(res.verified).toBe(false);
    expect(res.errors?.[0]).toContain('Unsupported proof type');
  });

  test('missing proof type on verify returns false', async () => {
    const res = await DataIntegrityProofManager.verifyProof({ id: 'x' }, {
      cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', proofValue: 'z'
    } as any, { documentLoader: async () => ({ document: {}, documentUrl: '', contextUrl: null }) });
    expect(res.verified).toBe(false);
    expect(res.errors?.[0]).toContain('Unsupported proof type');
  });

  test('non-DataIntegrityProof type on create throws', async () => {
    await expect(DataIntegrityProofManager.createProof({ id: 'x' }, {
      verificationMethod: 'did:ex#key-1',
      proofPurpose: 'assertionMethod',
      type: 'Ed25519Signature2020',
      cryptosuite: 'eddsa-rdfc-2022'
    } as any)).rejects.toThrow('Unsupported proof type');
  });
});
