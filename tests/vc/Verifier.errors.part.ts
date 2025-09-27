import { Verifier } from '../../src/vc/Verifier';
import { DIDManager } from '../../src/did/DIDManager';

describe('Verifier error branches', () => {
  const dm = new DIDManager({} as any);
  const verifier = new Verifier(dm);

  test('verifyCredential catches loader error', async () => {
    const res = await verifier.verifyCredential({ '@context': ['bad'], type: ['VerifiableCredential'], proof: {} } as any, {
      documentLoader: async () => { throw new Error('loader boom'); }
    });
    expect(res.verified).toBe(false);
    expect(res.errors[0]).toContain('loader boom');
  });

  test('verifyPresentation catches nested VC failure', async () => {
    const vp: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation'],
      verifiableCredential: [{ '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'] }],
      proof: {}
    };
    const res = await verifier.verifyPresentation(vp, { documentLoader: async () => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: '', contextUrl: null }) });
    expect(res.verified).toBe(false);
  });

  test('verifyPresentation returns nested vc error early', async () => {
    const vp: any = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation'],
      verifiableCredential: [{ '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], proof: {} }],
      proof: {}
    };
    const res = await verifier.verifyPresentation(vp, { documentLoader: async () => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: '', contextUrl: null }) });
    expect(res.verified).toBe(false);
  });

  test('verifyPresentation catches loader error', async () => {
    const vp: any = {
      '@context': ['bad'],
      type: ['VerifiablePresentation'],
      proof: {}
    };
    const res = await verifier.verifyPresentation(vp, { documentLoader: async () => { throw new Error('vp loader boom'); } });
    expect(res.verified).toBe(false);
    expect(res.errors[0]).toContain('vp loader boom');
  });

  test('verifyCredential returns Verification failed when proof manager returns false', async () => {
    const mod = require('../../src/vc/proofs/data-integrity');
    const orig = mod.DataIntegrityProofManager.verifyProof;
    mod.DataIntegrityProofManager.verifyProof = async () => ({ verified: false, errors: undefined });
    const res = await verifier.verifyCredential({ '@context': ['https://www.w3.org/2018/credentials/v1'], type: ['VerifiableCredential'], proof: {} } as any, { documentLoader: async () => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: '', contextUrl: null }) });
    expect(res.verified).toBe(false);
    expect(res.errors[0]).toBe('Verification failed');
    mod.DataIntegrityProofManager.verifyProof = orig;
  });
});

