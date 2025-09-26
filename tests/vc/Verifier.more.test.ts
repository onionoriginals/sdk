import { Verifier } from '../../src/vc/Verifier';
import { DIDManager } from '../../src/did/DIDManager';

describe('Verifier branches', () => {
  const dm = new DIDManager({} as any);
  const verifier = new Verifier(dm);

  test('verifyCredential returns error on invalid vc', async () => {
    const res = await verifier.verifyCredential({} as any);
    expect(res.verified).toBe(false);
  });

  test('verifyPresentation returns error on invalid vp', async () => {
    const res = await verifier.verifyPresentation({} as any);
    expect(res.verified).toBe(false);
  });

  test('verifyPresentation missing proof triggers error', async () => {
    const res = await verifier.verifyPresentation({ '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiablePresentation'] } as any);
    expect(res.verified).toBe(false);
  });

  test('verifyCredential unknown error message fallback', async () => {
    const dm2 = new DIDManager({} as any);
    const v2: any = new Verifier(dm2);
    const orig = (require('../../src/vc/proofs/data-integrity').DataIntegrityProofManager as any).verifyProof;
    (require('../../src/vc/proofs/data-integrity').DataIntegrityProofManager as any).verifyProof = async () => { throw { not: 'error' }; };
    const res = await v2.verifyCredential({ '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], proof: {} } as any, { documentLoader: async () => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: '', contextUrl: null }) });
    expect(res.verified).toBe(false);
    ;(require('../../src/vc/proofs/data-integrity').DataIntegrityProofManager as any).verifyProof = orig;
  });
});

