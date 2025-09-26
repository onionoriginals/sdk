import { EdDSACryptosuiteManager } from '../../../src/vc/cryptosuites/eddsa';
import { multikey } from '../../../src/crypto/Multikey';

describe('EdDSA cryptosuite edge cases', () => {
  const goodContext = ['https://www.w3.org/ns/credentials/v2'];

  const pk32 = new Uint8Array(32).fill(7);
  const pk32b = new Uint8Array(32).fill(8);
  const pkMb = multikey.encodePublicKey(pk32b, 'Ed25519');

  const okLoader = async (iri: string) => {
    if (iri.includes('#')) {
      return { document: { '@context': goodContext, id: iri, publicKeyMultibase: pkMb }, documentUrl: iri, contextUrl: null };
    }
    return { document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null } as any;
  };

  test('createProof signs with raw Uint8Array 32-byte private key', async () => {
    const proof = await EdDSACryptosuiteManager.createProof({ '@context': goodContext, id: 'urn:test:raw32' }, {
      verificationMethod: 'did:ex#key-raw', proofPurpose: 'assertionMethod', privateKey: pk32,
      cryptosuite: 'eddsa-rdfc-2022', documentLoader: okLoader
    });
    expect(proof.type).toBe('DataIntegrityProof');
    expect(typeof proof.proofValue).toBe('string');
  });

  test('createProof includes challenge and domain options', async () => {
    const proof = await EdDSACryptosuiteManager.createProof({ '@context': goodContext, id: 'urn:test:opts' }, {
      verificationMethod: 'did:ex#key-opts', proofPurpose: 'assertionMethod', privateKey: pk32,
      cryptosuite: 'eddsa-rdfc-2022', challenge: 'abc', domain: 'example.org', documentLoader: okLoader
    });
    expect((proof as any).challenge).toBe('abc');
    expect((proof as any).domain).toBe('example.org');
  });

  test('createProof invalid private key length 33 throws', async () => {
    const bad33 = new Uint8Array(33);
    await expect(EdDSACryptosuiteManager.createProof({ '@context': goodContext, id: 'urn:test:bad33' }, {
      verificationMethod: 'did:ex#key-bad33', proofPurpose: 'assertionMethod', privateKey: bad33,
      cryptosuite: 'eddsa-rdfc-2022', documentLoader: okLoader
    })).rejects.toThrow('Invalid private key length');
  });

  test('createProof invalid private key length 63 throws', async () => {
    const bad63 = new Uint8Array(63);
    await expect(EdDSACryptosuiteManager.createProof({ '@context': goodContext, id: 'urn:test:bad63' }, {
      verificationMethod: 'did:ex#key-bad63', proofPurpose: 'assertionMethod', privateKey: bad63,
      cryptosuite: 'eddsa-rdfc-2022', documentLoader: okLoader
    })).rejects.toThrow('Invalid private key length');
  });

  test('createProof with non-Ed25519 multikey string errors', async () => {
    const secpSk = new Uint8Array(32).fill(5);
    const secpSkMb = multikey.encodePrivateKey(secpSk, 'Secp256k1');
    await expect(EdDSACryptosuiteManager.createProof({ '@context': goodContext, id: 'urn:test:secpSk' }, {
      verificationMethod: 'did:ex#key-non-ed', proofPurpose: 'assertionMethod', privateKey: secpSkMb,
      cryptosuite: 'eddsa-rdfc-2022', documentLoader: okLoader
    })).rejects.toThrow('Invalid key type for EdDSA');
  });

  test('verifyProof returns false with wrong public key', async () => {
    // Sign with one keypair
    const signingSk = new Uint8Array(32).fill(9);
    const signingPk = new Uint8Array(32).fill(1);
    const signingPkMb = multikey.encodePublicKey(signingPk, 'Ed25519');
    const vmId = 'did:ex#vm-1';
    const signingLoader = async (iri: string) => {
      if (iri.includes('#')) {
        return { document: { '@context': goodContext, id: iri, publicKeyMultibase: signingPkMb }, documentUrl: iri, contextUrl: null };
      }
      return { document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null } as any;
    };
    const doc = { '@context': goodContext, id: 'urn:test:verify-wrong-pk' };
    const proof = await EdDSACryptosuiteManager.createProof(doc, {
      verificationMethod: vmId, proofPurpose: 'assertionMethod', privateKey: signingSk,
      cryptosuite: 'eddsa-rdfc-2022', documentLoader: signingLoader
    });

    // Verify with different public key
    const wrongPkMb = multikey.encodePublicKey(new Uint8Array(32).fill(2), 'Ed25519');
    const wrongLoader = async (iri: string) => {
      if (iri.includes('#')) {
        return { document: { '@context': goodContext, id: iri, publicKeyMultibase: wrongPkMb }, documentUrl: iri, contextUrl: null };
      }
      return { document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null } as any;
    };
    const res = await EdDSACryptosuiteManager.verifyProof(doc, proof as any, { documentLoader: wrongLoader });
    expect(res.verified).toBe(false);
  });

  test('verifyProof succeeds with matching verificationMethod', async () => {
    const ed = await import('@noble/ed25519');
    const sk = new Uint8Array(32).fill(11);
    const pk = await ed.getPublicKeyAsync(sk);
    const pkMbLocal = multikey.encodePublicKey(new Uint8Array(pk), 'Ed25519');
    const vm = 'did:ex#vm-ok';
    const loader = async (iri: string) => {
      if (iri.includes('#')) {
        return { document: { '@context': goodContext, id: iri, publicKeyMultibase: pkMbLocal }, documentUrl: iri, contextUrl: null };
      }
      return { document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null } as any;
    };
    const doc = { '@context': goodContext, id: 'urn:test:verify-ok' };
    const proof = await EdDSACryptosuiteManager.createProof(doc, {
      verificationMethod: vm, proofPurpose: 'assertionMethod', privateKey: sk, cryptosuite: 'eddsa-rdfc-2022', documentLoader: loader
    });
    const res = await EdDSACryptosuiteManager.verifyProof(doc, proof as any, { documentLoader: loader });
    expect(res.verified).toBe(true);
  });

  test('createProof propagates canonizeProof/hash-stage exception via loader', async () => {
    // Fail only during proof canonization stage (hash path), not during transform
    const loader = async (iri: string) => {
      if (iri.includes('w3id.org/security/data-integrity')) {
        throw new Error('hash-stage canonize fail');
      }
      if (iri.includes('#')) {
        return { document: { '@context': goodContext, id: iri, publicKeyMultibase: pkMb }, documentUrl: iri, contextUrl: null };
      }
      return { document: { '@context': { '@version': 1.1 } }, documentUrl: iri, contextUrl: null } as any;
    };
    await expect(EdDSACryptosuiteManager.createProof({ '@context': goodContext, id: 'urn:test:hash-fail' }, {
      verificationMethod: 'did:ex#key-hash', proofPurpose: 'assertionMethod', privateKey: pk32,
      cryptosuite: 'eddsa-rdfc-2022', documentLoader: loader
    } as any)).rejects.toThrow();
  });
});

