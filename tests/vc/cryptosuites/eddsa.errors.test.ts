import { EdDSACryptosuiteManager } from '../../../src/vc/cryptosuites/eddsa';

describe('EdDSA error branches', () => {
  test('createProof propagates transform error (canonize)', async () => {
    await expect(EdDSACryptosuiteManager.createProof({ '@context': ['https://www.w3.org/ns/credentials/v2'] }, {
      verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', cryptosuite: 'eddsa-rdfc-2022', privateKey: new Uint8Array(32),
      documentLoader: async () => { throw new Error('canonize fail'); }
    } as any)).rejects.toThrow();
  });

  test('verifyProof returns error on loader failure', async () => {
    const res = await EdDSACryptosuiteManager.verifyProof({ '@context': ['https://www.w3.org/ns/credentials/v2'] }, {
      type: 'DataIntegrityProof', cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', proofValue: 'z1L'
    } as any, { documentLoader: async () => { throw new Error('load fail'); } });
    expect(res.verified).toBe(false);
    expect(typeof res.errors?.[0]).toBe('string');
  });
});

