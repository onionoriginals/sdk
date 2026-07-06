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

  // createProof must be symmetric with verifyProof: bbs-2023 is dispatched to
  // the BBS backend, not rejected as an unsupported cryptosuite.
  test('bbs-2023 on create dispatches to the BBS cryptosuite', async () => {
    // Missing privateKey → BBS backend throws its own error, proving dispatch
    // reached it rather than the "Unsupported cryptosuite" guard.
    await expect(DataIntegrityProofManager.createProof(
      { '@context': [], id: 'x', issuer: 'did:example:issuer' },
      {
        verificationMethod: 'did:example:issuer#k',
        proofPurpose: 'assertionMethod',
        type: 'DataIntegrityProof',
        cryptosuite: 'bbs-2023'
      } as any
    )).rejects.toThrow('Private key required for BBS+ proof creation');
  });

  test('unsupported cryptosuite on verify returns false', async () => {
    const res = await DataIntegrityProofManager.verifyProof({ id: 'x' }, {
      type: 'DataIntegrityProof', cryptosuite: 'unknown', verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', proofValue: 'z'
    } as any, { documentLoader: async () => ({ document: {}, documentUrl: '', contextUrl: null }) });
    expect(res.verified).toBe(false);
    expect(res.errors?.[0]).toContain('Unsupported cryptosuite');
  });

  // Issue #315: bbs-2023 must be routed to the BBS cryptosuite (with its
  // issuer↔verificationMethod binding), not rejected as unsupported.
  test('bbs-2023 on verify dispatches to the BBS cryptosuite', async () => {
    const res = await DataIntegrityProofManager.verifyProof(
      { id: 'x', issuer: 'did:example:victim' },
      {
        type: 'DataIntegrityProof', cryptosuite: 'bbs-2023',
        verificationMethod: 'did:example:attacker#k', proofPurpose: 'assertionMethod', proofValue: 'z'
      } as any,
      { documentLoader: async () => ({ document: {}, documentUrl: '', contextUrl: null }) }
    );
    expect(res.verified).toBe(false);
    // Rejected by the BBS issuer-binding check, not as an unknown cryptosuite.
    expect(res.errors?.[0]).toContain('does not match issuer');
  });
});
