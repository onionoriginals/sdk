import { Verifier } from '../../src/vc/Verifier';
import { DIDManager } from '../../src/did/DIDManager';

describe('Verifier branches for string context and single proof', () => {
  const dm = new DIDManager({} as any);
  const verifier = new Verifier(dm);

  test('verifyCredential with string context runs loader loop with one item', async () => {
    const vc: any = {
      '@context': 'https://www.w3.org/2018/credentials/v1',
      type: ['VerifiableCredential'],
      proof: { cryptosuite: 'data-integrity' }
    };
    const res = await verifier.verifyCredential(vc, {
      documentLoader: async (iri: string) => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null })
    });
    expect(res.verified).toBe(false);
  });

  test('verifyPresentation with string context runs loader loop with one item', async () => {
    const vp: any = {
      '@context': 'https://www.w3.org/2018/credentials/v1',
      type: ['VerifiablePresentation'],
      proof: { cryptosuite: 'data-integrity' }
    };
    const res = await verifier.verifyPresentation(vp, {
      documentLoader: async (iri: string) => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null })
    });
    expect(res.verified).toBe(false);
  });
});