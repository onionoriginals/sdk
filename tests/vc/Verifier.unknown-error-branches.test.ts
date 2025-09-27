import { Verifier } from '../../src/vc/Verifier';
import { DIDManager } from '../../src/did/DIDManager';

describe('Verifier unknown-error fallback branches', () => {
  const dm = new DIDManager({} as any);
  const verifier = new Verifier(dm);

  test('verifyCredential returns Unknown error when non-Error thrown', async () => {
    const vc: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      proof: { cryptosuite: 'data-integrity' }
    };
    const res = await verifier.verifyCredential(vc, {
      documentLoader: async () => { throw 123 as any; }
    });
    expect(res.verified).toBe(false);
    expect(res.errors[0]).toBe('Unknown error in verifyCredential');
  });

  test('verifyPresentation returns Unknown error when non-Error thrown', async () => {
    const vp: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation'],
      proof: { cryptosuite: 'data-integrity' }
    };
    const res = await verifier.verifyPresentation(vp, {
      documentLoader: async () => { throw 456 as any; }
    });
    expect(res.verified).toBe(false);
    expect(res.errors[0]).toBe('Unknown error in verifyPresentation');
  });
});