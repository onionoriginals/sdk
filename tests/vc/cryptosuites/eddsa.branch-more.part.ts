import { EdDSACryptosuiteManager } from '../../../src/vc/cryptosuites/eddsa';
import { multikey } from '../../../src/crypto/Multikey';

describe('EdDSA additional branches', () => {
  test('createProof throws on invalid private key format', async () => {
    await expect(EdDSACryptosuiteManager.createProof({ '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'x' }, {
      verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', cryptosuite: 'eddsa-rdfc-2022', privateKey: 123 as any,
      documentLoader: async () => ({ document: { '@context': { '@version': 1.1 } }, documentUrl: '', contextUrl: null })
    } as any)).rejects.toThrow('Invalid private key format');
  });

  test('verifyProof returns error for non-Ed25519 VM', async () => {
    const pkMb = multikey.encodePublicKey(new Uint8Array(33).fill(1), 'Secp256k1');
    const res = await EdDSACryptosuiteManager.verifyProof({ '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'x' }, {
      type: 'DataIntegrityProof', cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', proofValue: 'z1L'
    } as any, { documentLoader: async () => ({ document: { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:ex#k', publicKeyMultibase: pkMb }, documentUrl: '', contextUrl: null }) });
    expect(res.verified).toBe(false);
    expect(typeof res.errors?.[0]).toBe('string');
  });
});

