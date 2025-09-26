import { EdDSACryptosuiteManager } from '../../../src/vc/cryptosuites/eddsa';
import { multikey } from '../../../src/crypto/Multikey';

describe('EdDSA coverage extras', () => {
  const goodContext = ['https://www.w3.org/ns/credentials/v2'];

  test('createProofConfiguration defaults proofPurpose to assertionMethod', async () => {
    const sk = new Uint8Array(32).fill(1);
    const pkMb = multikey.encodePublicKey(new Uint8Array(32).fill(2), 'Ed25519');
    const vm = 'did:ex#vm';
    const loader = async (iri: string) => {
      if (iri.includes('#')) {
        return { document: { '@context': goodContext, id: iri, publicKeyMultibase: pkMb }, documentUrl: iri, contextUrl: null };
      }
      return { document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null } as any;
    };
    const doc: any = { '@context': goodContext, id: 'urn:doc-default-purpose' };
    const proof = await EdDSACryptosuiteManager.createProof(doc, { verificationMethod: vm, privateKey: sk, cryptosuite: 'eddsa-rdfc-2022', documentLoader: loader });
    // The method deletes @context before returning, so we assert the purpose value
    expect(proof.proofPurpose).toBe('assertionMethod');
  });

  test('createProof includes only challenge when provided', async () => {
    const sk = new Uint8Array(32).fill(7);
    const pkMb = multikey.encodePublicKey(new Uint8Array(32).fill(6), 'Ed25519');
    const vm = 'did:ex#vm-chal';
    const loader = async (iri: string) => {
      if (iri.includes('#')) {
        return { document: { '@context': goodContext, id: iri, publicKeyMultibase: pkMb }, documentUrl: iri, contextUrl: null };
      }
      return { document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null } as any;
    };
    const proof = await EdDSACryptosuiteManager.createProof({ '@context': goodContext, id: 'urn:chal' }, { verificationMethod: vm, privateKey: sk, cryptosuite: 'eddsa-rdfc-2022', challenge: '123', documentLoader: loader });
    expect((proof as any).challenge).toBe('123');
    expect((proof as any).domain).toBeUndefined();
  });

  test('createProof includes only domain when provided', async () => {
    const sk = new Uint8Array(32).fill(9);
    const pkMb = multikey.encodePublicKey(new Uint8Array(32).fill(8), 'Ed25519');
    const vm = 'did:ex#vm-domain';
    const loader = async (iri: string) => {
      if (iri.includes('#')) {
        return { document: { '@context': goodContext, id: iri, publicKeyMultibase: pkMb }, documentUrl: iri, contextUrl: null };
      }
      return { document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null } as any;
    };
    const proof = await EdDSACryptosuiteManager.createProof({ '@context': goodContext, id: 'urn:domain' }, { verificationMethod: vm, privateKey: sk, cryptosuite: 'eddsa-rdfc-2022', domain: 'ex.org', documentLoader: loader });
    expect((proof as any).domain).toBe('ex.org');
    expect((proof as any).challenge).toBeUndefined();
  });

  test('verifyProof returns error message on thrown exception path', async () => {
    const pkMb = multikey.encodePublicKey(new Uint8Array(32).fill(3), 'Ed25519');
    const loader = async (iri: string) => {
      if (iri.includes('#')) {
        return { document: { '@context': goodContext, id: iri, publicKeyMultibase: pkMb }, documentUrl: iri, contextUrl: null };
      }
      return { document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null } as any;
    };
    const doc: any = { '@context': goodContext, id: 'urn:doc' };
    const badProof: any = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', proofValue: 'not-multibase' };
    const res = await EdDSACryptosuiteManager.verifyProof(doc, badProof, { documentLoader: loader });
    expect(res.verified).toBe(false);
    expect(Array.isArray(res.errors)).toBe(true);
    expect(typeof res.errors![0]).toBe('string');
  });

  test('verifyProof uses Unknown verification error when thrown value lacks message', async () => {
    const pkMb = multikey.encodePublicKey(new Uint8Array(32).fill(4), 'Ed25519');
    const doc: any = { '@context': goodContext, id: 'urn:doc-unknown' };
    const proof: any = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:ex#vm-unknown', proofPurpose: 'assertionMethod', proofValue: 'z1L' };
    const loader = async (iri: string) => {
      if (iri.includes('#')) {
        // Throw a primitive string (no message property) only on VM fetch, after transform/hash succeeded
        throw '';
      }
      return { document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null } as any;
    };
    const res = await EdDSACryptosuiteManager.verifyProof(doc, proof, { documentLoader: loader });
    expect(res.verified).toBe(false);
    expect(res.errors?.[0]).toBe('Unknown verification error');
  });
});

