import { EdDSACryptosuiteManager } from '../../../src/vc/cryptosuites/eddsa';
import { multikey } from '../../../src/crypto/Multikey';
import * as ed25519 from '@noble/ed25519';

describe('EdDSA verifyProof success path', () => {
  test('createProof then verifyProof returns verified=true', async () => {
    const sk = ed25519.utils.randomPrivateKey();
    const pk = ed25519.getPublicKey(sk);
    const skMb = multikey.encodePrivateKey(sk, 'Ed25519');
    const pkMb = multikey.encodePublicKey(pk, 'Ed25519');
    const vmId = 'did:ex:succ#k';
    const loader = async (iri: string) => {
      if (iri.includes('#')) {
        return { document: { '@context': ['https://www.w3.org/ns/credentials/v2'], id: iri, publicKeyMultibase: pkMb }, documentUrl: iri, contextUrl: null };
      }
      return { document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null } as any;
    };
    const doc: any = { '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'urn:doc' };
    const proof = await EdDSACryptosuiteManager.createProof(doc, { verificationMethod: vmId, proofPurpose: 'assertionMethod', privateKey: skMb, cryptosuite: 'eddsa-rdfc-2022', documentLoader: loader });
    const res = await EdDSACryptosuiteManager.verifyProof({ ...doc, proof }, proof as any, { documentLoader: loader });
    expect(res.verified).toBe(true);
  });
});

