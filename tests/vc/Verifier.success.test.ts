import { Verifier } from '../../src/vc/Verifier';
import { DIDManager } from '../../src/did/DIDManager';

describe('Verifier success branches', () => {
  const dm = new DIDManager({} as any);
  const verifier = new Verifier(dm);

  test('verifyCredential returns verified=true when proof manager passes', async () => {
    const vc: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      proof: { cryptosuite: 'data-integrity' }
    };
    const mod = require('../../src/vc/proofs/data-integrity');
    const orig = mod.DataIntegrityProofManager.verifyProof;
    mod.DataIntegrityProofManager.verifyProof = async () => ({ verified: true, errors: [] });
    const res = await verifier.verifyCredential(vc, {
      documentLoader: async (iri: string) => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null })
    });
    expect(res.verified).toBe(true);
    expect(res.errors).toEqual([]);
    mod.DataIntegrityProofManager.verifyProof = orig;
  });

  test('verifyPresentation returns verified=true, with and without nested VC', async () => {
    const mod = require('../../src/vc/proofs/data-integrity');
    const orig = mod.DataIntegrityProofManager.verifyProof;
    mod.DataIntegrityProofManager.verifyProof = async () => ({ verified: true, errors: [] });

    // without nested VC
    const vp1: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation'],
      proof: { cryptosuite: 'data-integrity' }
    };
    const res1 = await verifier.verifyPresentation(vp1, {
      documentLoader: async (iri: string) => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null })
    });
    expect(res1.verified).toBe(true);

    // with nested VC
    const vp2: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation'],
      verifiableCredential: [
        { '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], proof: { cryptosuite: 'data-integrity' } }
      ],
      proof: { cryptosuite: 'data-integrity' }
    };
    const res2 = await verifier.verifyPresentation(vp2, {
      documentLoader: async (iri: string) => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null })
    });
    expect(res2.verified).toBe(true);

    mod.DataIntegrityProofManager.verifyProof = orig;
  });
});