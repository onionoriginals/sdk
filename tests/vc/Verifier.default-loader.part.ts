import { Verifier } from '../../src/vc/Verifier';
import { DIDManager } from '../../src/did/DIDManager';

describe('Verifier with default document loader (no options)', () => {
  const dm = new DIDManager({} as any);
  const verifier = new Verifier(dm);

  test('verifyCredential uses default loader with v2 contexts', async () => {
    const vc: any = {
      '@context': ['https://www.w3.org/ns/credentials/v2', 'https://w3id.org/security/data-integrity/v2'],
      type: ['VerifiableCredential'],
      proof: { cryptosuite: 'data-integrity' }
    };
    const mod = require('../../src/vc/proofs/data-integrity');
    const orig = mod.DataIntegrityProofManager.verifyProof;
    mod.DataIntegrityProofManager.verifyProof = async () => ({ verified: false, errors: ['x'] });
    const res = await verifier.verifyCredential(vc);
    expect(res.verified).toBe(false);
    expect(res.errors[0]).toBe('x');
    mod.DataIntegrityProofManager.verifyProof = orig;
  });

  test('verifyPresentation uses default loader with v2 contexts', async () => {
    const vp: any = {
      '@context': ['https://www.w3.org/ns/credentials/v2', 'https://w3id.org/security/data-integrity/v2'],
      type: ['VerifiablePresentation'],
      proof: { cryptosuite: 'data-integrity' }
    };
    const mod = require('../../src/vc/proofs/data-integrity');
    const orig = mod.DataIntegrityProofManager.verifyProof;
    mod.DataIntegrityProofManager.verifyProof = async () => ({ verified: true, errors: [] });
    const res = await verifier.verifyPresentation(vp);
    expect(res.verified).toBe(true);
    mod.DataIntegrityProofManager.verifyProof = orig;
  });
});