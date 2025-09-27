import { EdDSACryptosuiteManager } from '../../../src/vc/cryptosuites/eddsa';
import { multikey } from '../../../src/crypto/Multikey';

describe('EdDSA error branches', () => {
  test('createProof throws on non-Ed25519 multikey private key', async () => {
    const sk = new Uint8Array(32).fill(7);
    const skMbSecp = multikey.encodePrivateKey(sk, 'Secp256k1');
    const loader = async (iri: string) => {
      if (iri.includes('#')) return { document: { '@context': ['https://www.w3.org/ns/credentials/v2'], id: iri }, documentUrl: iri, contextUrl: null } as any;
      return { document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null } as any;
    };
    await expect(EdDSACryptosuiteManager.createProof({ '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'urn:x' }, {
      verificationMethod: 'did:ex#key-1', proofPurpose: 'assertionMethod', privateKey: skMbSecp, cryptosuite: 'eddsa-rdfc-2022', documentLoader: loader
    })).rejects.toThrow('Invalid key type for EdDSA');
  });

  test('verifyProof returns error for non-Ed25519 publicKeyMultibase', async () => {
    const pkSecp = new Uint8Array(33).fill(8);
    const pkMbSecp = multikey.encodePublicKey(pkSecp, 'Secp256k1');
    const loader = async (iri: string) => {
      if (iri.includes('#')) return { document: { '@context': ['https://www.w3.org/ns/credentials/v2'], id: iri, publicKeyMultibase: pkMbSecp }, documentUrl: iri, contextUrl: null } as any;
      return { document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null } as any;
    };
    const proof = {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-rdfc-2022',
      verificationMethod: 'did:ex#key-1',
      proofPurpose: 'assertionMethod',
      proofValue: 'z1L'
    } as any;
    const res = await EdDSACryptosuiteManager.verifyProof({ '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'urn:x' }, proof, { documentLoader: loader });
    expect(res.verified).toBe(false);
    expect(res.errors?.[0]).toBe('Invalid key type for EdDSA');
  });
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

