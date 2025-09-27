import { EdDSACryptosuiteManager } from '../../../src/vc/cryptosuites/eddsa';
import { multikey } from '../../../src/crypto/Multikey';

describe('EdDSACryptosuiteManager extra branches', () => {
  const pkRaw = new Uint8Array(32).fill(7);
  const skMb = multikey.encodePrivateKey(pkRaw, 'Ed25519');
  const pubMb = multikey.encodePublicKey(new Uint8Array(32).fill(8), 'Ed25519');

  const loader = async (iri: string) => {
    if (iri.includes('#')) {
      return { document: { '@context': ['https://www.w3.org/ns/credentials/v2'], id: iri, publicKeyMultibase: pubMb }, documentUrl: iri, contextUrl: null };
    }
    return { document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null } as any;
  };

  test('sign with 64-byte private key slices to 32', async () => {
    const sixtyFour = new Uint8Array(64);
    sixtyFour.set(pkRaw);
    const proof = await EdDSACryptosuiteManager.createProof({ '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'x' }, {
      verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', privateKey: sixtyFour, cryptosuite: 'eddsa-rdfc-2022', documentLoader: loader
    });
    expect(proof.proofValue).toBeTruthy();
  });

  test('invalid private key length throws', async () => {
    await expect(EdDSACryptosuiteManager.createProof({ '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'x' }, {
      verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', privateKey: new Uint8Array(31), cryptosuite: 'eddsa-rdfc-2022', documentLoader: loader
    })).rejects.toThrow('Invalid private key length');
  });

  test('verify returns false on signature mismatch', async () => {
    const res = await EdDSACryptosuiteManager.verifyProof({ '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'x' }, {
      type: 'DataIntegrityProof', cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', proofValue: 'z1L' // invalid base58btc
    } as any, { documentLoader: loader });
    expect(res.verified).toBe(false);
  });

  test('verifyProof returns error on canonizeProof failure path', async () => {
    const badLoader = async (iri: string) => {
      if (iri.includes('#')) {
        return { document: { '@context': ['https://www.w3.org/ns/credentials/v2'], id: iri, publicKeyMultibase: pubMb }, documentUrl: iri, contextUrl: null };
      }
      return { document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null } as any;
    };
    const proof: any = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', proofValue: 'z1L' };
    const doc: any = { '@context': ['https://www.w3.org/ns/credentials/v2'] };
    doc.self = doc;
    const res = await EdDSACryptosuiteManager.verifyProof(doc, proof, { documentLoader: badLoader });
    expect(res.verified).toBe(false);
  });
});

