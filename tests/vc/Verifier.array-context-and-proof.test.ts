import { Verifier } from '../../src/vc/Verifier';
import { DIDManager } from '../../src/did/DIDManager';

describe('Verifier array handling branches', () => {
  const dm = new DIDManager({} as any);
  const verifier = new Verifier(dm);

  test('verifyCredential with array proof and array contexts', async () => {
    const vc: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1', 'https://w3id.org/security/data-integrity/v2'],
      type: ['VerifiableCredential'],
      proof: [{ cryptosuite: 'data-integrity' }]
    };
    const res = await verifier.verifyCredential(vc, {
      documentLoader: async (iri: string) => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null })
    });
    expect(res.verified).toBe(false);
  });

  test('verifyPresentation with array proof and array contexts', async () => {
    const vp: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1', 'https://w3id.org/security/data-integrity/v2'],
      type: ['VerifiablePresentation'],
      proof: [{ cryptosuite: 'data-integrity' }]
    };
    const res = await verifier.verifyPresentation(vp, {
      documentLoader: async (iri: string) => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null })
    });
    expect(res.verified).toBe(false);
  });
});