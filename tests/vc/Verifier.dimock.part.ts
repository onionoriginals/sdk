describe('Verifier with mocked DataIntegrityProofManager', () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock('../../src/vc/proofs/data-integrity');
  });

  test('verifyCredential success branch (verified=true)', async () => {
    jest.doMock('../../src/vc/proofs/data-integrity', () => ({
      DataIntegrityProofManager: {
        verifyProof: async () => ({ verified: true })
      }
    }));
    const { Verifier } = await import('../../src/vc/Verifier');
    const { DIDManager } = await import('../../src/did/DIDManager');
    const verifier = new Verifier(new DIDManager({} as any));
    const res = await verifier.verifyCredential({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiableCredential'], proof: {} } as any, {
      documentLoader: async () => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: '', contextUrl: null })
    });
    expect(res.verified).toBe(true);
  });

  test('verifyPresentation failure branch (no errors provided -> default)', async () => {
    jest.doMock('../../src/vc/proofs/data-integrity', () => ({
      DataIntegrityProofManager: {
        verifyProof: async () => ({ verified: false })
      }
    }));
    const { Verifier } = await import('../../src/vc/Verifier');
    const { DIDManager } = await import('../../src/did/DIDManager');
    const verifier = new Verifier(new DIDManager({} as any));
    const res = await verifier.verifyPresentation({ '@context': ['https://www.w3.org/ns/credentials/v2'], type: ['VerifiablePresentation'], proof: {} } as any, {
      documentLoader: async () => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: '', contextUrl: null })
    });
    expect(res.verified).toBe(false);
    expect(res.errors[0]).toBe('Verification failed');
  });
});

