import { EdDSACryptosuiteManager } from '../../../src/vc/cryptosuites/eddsa';
import { multikey } from '../../../src/crypto/Multikey';

describe('EdDSA createProof with multikey string', () => {
  test('signs using multibase multicodec private key', async () => {
    const sk = new Uint8Array(32).fill(9);
    const pk = new Uint8Array(32).fill(8);
    const skMb = multikey.encodePrivateKey(sk, 'Ed25519');
    const pkMb = multikey.encodePublicKey(pk, 'Ed25519');
    const loader = async (iri: string) => {
      if (iri.includes('#')) return { document: { '@context': ['https://www.w3.org/ns/credentials/v2'], id: iri, publicKeyMultibase: pkMb }, documentUrl: iri, contextUrl: null };
      return { document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null } as any;
    };
    const proof = await EdDSACryptosuiteManager.createProof({ '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'urn:x' }, {
      verificationMethod: 'did:ex#key-1', proofPurpose: 'assertionMethod', privateKey: skMb, cryptosuite: 'eddsa-rdfc-2022', documentLoader: loader
    });
    expect(proof.type).toBe('DataIntegrityProof');
  });
});

