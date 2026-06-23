/** Canonical test aggregator created by combine-tests script. */

/** Inlined from eddsa.branch-more.part.ts */
import { describe, test, expect } from 'bun:test';
import { EdDSACryptosuiteManager } from '../../../../src/vc/cryptosuites/eddsa';
import { multikey } from '../../../../src/crypto/Multikey';
import { PRELOADED_CONTEXTS } from '../../../../src/utils/serialization';

// Safe-mode canonicalization requires real context documents (issue #167);
// stub contexts would silently drop every term from the signed dataset.
const contextDocument = (iri: string) =>
  ({ document: PRELOADED_CONTEXTS[iri] ?? { '@context': {} }, documentUrl: iri, contextUrl: null }) as any;

describe('EdDSA additional branches', () => {
  test('createProof throws on invalid private key format', async () => {
    await expect(EdDSACryptosuiteManager.createProof({ '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'urn:x', name: 'test' }, {
      verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', cryptosuite: 'eddsa-rdfc-2022', privateKey: 123 as any,
      documentLoader: async (iri: string) => contextDocument(iri)
    } as any)).rejects.toThrow('Invalid private key format');
  });

  test('verifyProof returns error for non-Ed25519 VM', async () => {
    const pkMb = multikey.encodePublicKey(new Uint8Array(33).fill(1), 'Secp256k1');
    const res = await EdDSACryptosuiteManager.verifyProof({ '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'urn:x', name: 'test' }, {
      type: 'DataIntegrityProof', cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', proofValue: 'z1L'
    } as any, { documentLoader: async () => ({ document: { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:ex#k', publicKeyMultibase: pkMb }, documentUrl: '', contextUrl: null }) });
    expect(res.verified).toBe(false);
    expect(typeof res.errors?.[0]).toBe('string');
  });
});




/** Inlined from eddsa.coverage-extra.part.ts */

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
      return contextDocument(iri);
    };
    const doc: any = { '@context': goodContext, id: 'urn:doc-default-purpose', name: 'test' };
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
      return contextDocument(iri);
    };
    const proof = await EdDSACryptosuiteManager.createProof({ '@context': goodContext, id: 'urn:chal', name: 'test' }, { verificationMethod: vm, privateKey: sk, cryptosuite: 'eddsa-rdfc-2022', challenge: '123', documentLoader: loader });
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
      return contextDocument(iri);
    };
    const proof = await EdDSACryptosuiteManager.createProof({ '@context': goodContext, id: 'urn:domain', name: 'test' }, { verificationMethod: vm, privateKey: sk, cryptosuite: 'eddsa-rdfc-2022', domain: 'ex.org', documentLoader: loader });
    expect((proof as any).domain).toBe('ex.org');
    expect((proof as any).challenge).toBeUndefined();
  });

  test('verifyProof returns error message on thrown exception path', async () => {
    const pkMb = multikey.encodePublicKey(new Uint8Array(32).fill(3), 'Ed25519');
    const loader = async (iri: string) => {
      if (iri.includes('#')) {
        return { document: { '@context': goodContext, id: iri, publicKeyMultibase: pkMb }, documentUrl: iri, contextUrl: null };
      }
      return contextDocument(iri);
    };
    const doc: any = { '@context': goodContext, id: 'urn:doc', name: 'test' };
    const badProof: any = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', proofValue: 'not-multibase' };
    const res = await EdDSACryptosuiteManager.verifyProof(doc, badProof, { documentLoader: loader });
    expect(res.verified).toBe(false);
    expect(Array.isArray(res.errors)).toBe(true);
    expect(typeof res.errors![0]).toBe('string');
  });

  test('verifyProof uses Unknown verification error when thrown value lacks message', async () => {
    const pkMb = multikey.encodePublicKey(new Uint8Array(32).fill(4), 'Ed25519');
    const doc: any = { '@context': goodContext, id: 'urn:doc-unknown', name: 'test' };
    const proof: any = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:ex#vm-unknown', proofPurpose: 'assertionMethod', proofValue: 'z1L' };
    const loader = async (iri: string) => {
      if (iri.includes('#')) {
        // Throw a primitive string (no message property) only on VM fetch, after transform/hash succeeded
        throw '';
      }
      return contextDocument(iri);
    };
    const res = await EdDSACryptosuiteManager.verifyProof(doc, proof, { documentLoader: loader });
    expect(res.verified).toBe(false);
    expect(res.errors?.[0]).toBe('Unknown verification error');
  });
});




/** Inlined from eddsa.edgecases.part.ts */

describe('EdDSA cryptosuite edge cases', () => {
  const goodContext = ['https://www.w3.org/ns/credentials/v2'];

  const pk32 = new Uint8Array(32).fill(7);
  const pk32b = new Uint8Array(32).fill(8);
  const pkMb = multikey.encodePublicKey(pk32b, 'Ed25519');

  const okLoader = async (iri: string) => {
    if (iri.includes('#')) {
      return { document: { '@context': goodContext, id: iri, publicKeyMultibase: pkMb }, documentUrl: iri, contextUrl: null };
    }
    return contextDocument(iri);
  };

  test('createProof signs with raw Uint8Array 32-byte private key', async () => {
    const proof = await EdDSACryptosuiteManager.createProof({ '@context': goodContext, id: 'urn:test:raw32', name: 'test' }, {
      verificationMethod: 'did:ex#key-raw', proofPurpose: 'assertionMethod', privateKey: pk32,
      cryptosuite: 'eddsa-rdfc-2022', documentLoader: okLoader
    });
    expect(proof.type).toBe('DataIntegrityProof');
    expect(typeof proof.proofValue).toBe('string');
  });

  test('createProof includes challenge and domain options', async () => {
    const proof = await EdDSACryptosuiteManager.createProof({ '@context': goodContext, id: 'urn:test:opts', name: 'test' }, {
      verificationMethod: 'did:ex#key-opts', proofPurpose: 'assertionMethod', privateKey: pk32,
      cryptosuite: 'eddsa-rdfc-2022', challenge: 'abc', domain: 'example.org', documentLoader: okLoader
    });
    expect((proof as any).challenge).toBe('abc');
    expect((proof as any).domain).toBe('example.org');
  });

  test('createProof invalid private key length 33 throws', async () => {
    const bad33 = new Uint8Array(33);
    await expect(EdDSACryptosuiteManager.createProof({ '@context': goodContext, id: 'urn:test:bad33', name: 'test' }, {
      verificationMethod: 'did:ex#key-bad33', proofPurpose: 'assertionMethod', privateKey: bad33,
      cryptosuite: 'eddsa-rdfc-2022', documentLoader: okLoader
    })).rejects.toThrow('Invalid private key length');
  });

  test('createProof invalid private key length 63 throws', async () => {
    const bad63 = new Uint8Array(63);
    await expect(EdDSACryptosuiteManager.createProof({ '@context': goodContext, id: 'urn:test:bad63', name: 'test' }, {
      verificationMethod: 'did:ex#key-bad63', proofPurpose: 'assertionMethod', privateKey: bad63,
      cryptosuite: 'eddsa-rdfc-2022', documentLoader: okLoader
    })).rejects.toThrow('Invalid private key length');
  });

  test('createProof with non-Ed25519 multikey string errors', async () => {
    const secpSk = new Uint8Array(32).fill(5);
    const secpSkMb = multikey.encodePrivateKey(secpSk, 'Secp256k1');
    await expect(EdDSACryptosuiteManager.createProof({ '@context': goodContext, id: 'urn:test:secpSk', name: 'test' }, {
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
      return contextDocument(iri);
    };
    const doc = { '@context': goodContext, id: 'urn:test:verify-wrong-pk', name: 'test' };
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
      return contextDocument(iri);
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
      return contextDocument(iri);
    };
    const doc = { '@context': goodContext, id: 'urn:test:verify-ok', name: 'test' };
    const proof = await EdDSACryptosuiteManager.createProof(doc, {
      verificationMethod: vm, proofPurpose: 'assertionMethod', privateKey: sk, cryptosuite: 'eddsa-rdfc-2022', documentLoader: loader
    });
    const res = await EdDSACryptosuiteManager.verifyProof(doc, proof as any, { documentLoader: loader });
    expect(res.verified).toBe(true);
  });

  test('createProof propagates canonizeProof/hash-stage exception via loader', async () => {
    // Fail only during proof canonization stage (hash path), not during transform.
    // The proof config is canonicalized with the document's @context, so the
    // context is loaded once for transform and again for the proof config.
    let contextLoads = 0;
    const loader = async (iri: string) => {
      if (iri.includes('#')) {
        return { document: { '@context': goodContext, id: iri, publicKeyMultibase: pkMb }, documentUrl: iri, contextUrl: null };
      }
      contextLoads++;
      if (contextLoads > 1) {
        throw new Error('hash-stage canonize fail');
      }
      return contextDocument(iri);
    };
    await expect(EdDSACryptosuiteManager.createProof({ '@context': goodContext, id: 'urn:test:hash-fail', name: 'test' }, {
      verificationMethod: 'did:ex#key-hash', proofPurpose: 'assertionMethod', privateKey: pk32,
      cryptosuite: 'eddsa-rdfc-2022', documentLoader: loader
    } as any)).rejects.toThrow();
  });
});




/** Inlined from eddsa.errors.part.ts */

describe('EdDSA error branches', () => {
  test('createProof throws on non-Ed25519 multikey private key', async () => {
    const sk = new Uint8Array(32).fill(7);
    const skMbSecp = multikey.encodePrivateKey(sk, 'Secp256k1');
    const loader = async (iri: string) => {
      if (iri.includes('#')) return { document: { '@context': ['https://www.w3.org/ns/credentials/v2'], id: iri }, documentUrl: iri, contextUrl: null } as any;
      return contextDocument(iri);
    };
    await expect(EdDSACryptosuiteManager.createProof({ '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'urn:x', name: 'test' }, {
      verificationMethod: 'did:ex#key-1', proofPurpose: 'assertionMethod', privateKey: skMbSecp, cryptosuite: 'eddsa-rdfc-2022', documentLoader: loader
    })).rejects.toThrow('Invalid key type for EdDSA');
  });

  test('verifyProof returns error for non-Ed25519 publicKeyMultibase', async () => {
    const pkSecp = new Uint8Array(33).fill(8);
    const pkMbSecp = multikey.encodePublicKey(pkSecp, 'Secp256k1');
    const loader = async (iri: string) => {
      if (iri.includes('#')) return { document: { '@context': ['https://www.w3.org/ns/credentials/v2'], id: iri, publicKeyMultibase: pkMbSecp }, documentUrl: iri, contextUrl: null } as any;
      return contextDocument(iri);
    };
    const proof = {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-rdfc-2022',
      verificationMethod: 'did:ex#key-1',
      proofPurpose: 'assertionMethod',
      proofValue: 'z1L'
    } as any;
    const res = await EdDSACryptosuiteManager.verifyProof({ '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'urn:x', name: 'test' }, proof, { documentLoader: loader });
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




/** Inlined from eddsa.more.part.ts */

describe('EdDSACryptosuiteManager extra branches', () => {
  const pkRaw = new Uint8Array(32).fill(7);
  const skMb = multikey.encodePrivateKey(pkRaw, 'Ed25519');
  const pubMb = multikey.encodePublicKey(new Uint8Array(32).fill(8), 'Ed25519');

  const loader = async (iri: string) => {
    if (iri.includes('#')) {
      return { document: { '@context': ['https://www.w3.org/ns/credentials/v2'], id: iri, publicKeyMultibase: pubMb }, documentUrl: iri, contextUrl: null };
    }
    return contextDocument(iri);
  };

  test('sign with 64-byte private key slices to 32', async () => {
    const sixtyFour = new Uint8Array(64);
    sixtyFour.set(pkRaw);
    const proof = await EdDSACryptosuiteManager.createProof({ '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'urn:x', name: 'test' }, {
      verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', privateKey: sixtyFour, cryptosuite: 'eddsa-rdfc-2022', documentLoader: loader
    });
    expect(proof.proofValue).toBeTruthy();
  });

  test('invalid private key length throws', async () => {
    await expect(EdDSACryptosuiteManager.createProof({ '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'urn:x', name: 'test' }, {
      verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', privateKey: new Uint8Array(31), cryptosuite: 'eddsa-rdfc-2022', documentLoader: loader
    })).rejects.toThrow('Invalid private key length');
  });

  test('verify returns false on signature mismatch', async () => {
    const res = await EdDSACryptosuiteManager.verifyProof({ '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'urn:x', name: 'test' }, {
      type: 'DataIntegrityProof', cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', proofValue: 'z1L' // invalid base58btc
    } as any, { documentLoader: loader });
    expect(res.verified).toBe(false);
  });

  test('verifyProof returns error on canonizeProof failure path', async () => {
    const badLoader = async (iri: string) => {
      if (iri.includes('#')) {
        return { document: { '@context': ['https://www.w3.org/ns/credentials/v2'], id: iri, publicKeyMultibase: pubMb }, documentUrl: iri, contextUrl: null };
      }
      return contextDocument(iri);
    };
    const proof: any = { type: 'DataIntegrityProof', cryptosuite: 'eddsa-rdfc-2022', verificationMethod: 'did:ex#k', proofPurpose: 'assertionMethod', proofValue: 'z1L' };
    const doc: any = { '@context': ['https://www.w3.org/ns/credentials/v2'] };
    doc.self = doc;
    const res = await EdDSACryptosuiteManager.verifyProof(doc, proof, { documentLoader: badLoader });
    expect(res.verified).toBe(false);
  });
});




/** Inlined from eddsa.privatekey-string.part.ts */

describe('EdDSA createProof with multikey string', () => {
  test('signs using multibase multicodec private key', async () => {
    const sk = new Uint8Array(32).fill(9);
    const pk = new Uint8Array(32).fill(8);
    const skMb = multikey.encodePrivateKey(sk, 'Ed25519');
    const pkMb = multikey.encodePublicKey(pk, 'Ed25519');
    const loader = async (iri: string) => {
      if (iri.includes('#')) return { document: { '@context': ['https://www.w3.org/ns/credentials/v2'], id: iri, publicKeyMultibase: pkMb }, documentUrl: iri, contextUrl: null };
      return contextDocument(iri);
    };
    const proof = await EdDSACryptosuiteManager.createProof({ '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'urn:x', name: 'test' }, {
      verificationMethod: 'did:ex#key-1', proofPurpose: 'assertionMethod', privateKey: skMb, cryptosuite: 'eddsa-rdfc-2022', documentLoader: loader
    });
    expect(proof.type).toBe('DataIntegrityProof');
  });
});




/** Inlined from eddsa.success.part.ts */
// Initialize noble crypto libraries (uses shared initialization module)
import '../../../../src/crypto/noble-init.js';

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
      return contextDocument(iri);
    };
    const doc: any = { '@context': ['https://www.w3.org/ns/credentials/v2'], id: 'urn:doc', name: 'test' };
    const proof = await EdDSACryptosuiteManager.createProof(doc, { verificationMethod: vmId, proofPurpose: 'assertionMethod', privateKey: skMb, cryptosuite: 'eddsa-rdfc-2022', documentLoader: loader });
    const res = await EdDSACryptosuiteManager.verifyProof({ ...doc, proof }, proof as any, { documentLoader: loader });
    expect(res.verified).toBe(true);
  });
});




/** Regression: revoked / compromised verification methods must fail closed. */

describe('EdDSA verifyProof rejects retired verification methods', () => {
  const goodContext = ['https://www.w3.org/ns/credentials/v2'];

  // Build a credential with a genuinely valid Ed25519 signature, then verify it
  // through a loader that returns the SAME public key with various retired-state
  // flags. The signature itself is always valid, so the only thing that can make
  // verification fail is the revoked/compromised check.
  async function makeSignedCredential() {
    const ed = await import('@noble/ed25519');
    const sk = ed.utils.randomPrivateKey();
    const pk = await ed.getPublicKeyAsync(sk);
    const pkMb = multikey.encodePublicKey(new Uint8Array(pk), 'Ed25519');
    const skMb = multikey.encodePrivateKey(new Uint8Array(sk), 'Ed25519');
    const vmId = 'did:ex:retired#key-0';
    const baseLoader = async (iri: string) => {
      if (iri.includes('#')) {
        return { document: { '@context': goodContext, id: iri, publicKeyMultibase: pkMb }, documentUrl: iri, contextUrl: null };
      }
      return contextDocument(iri);
    };
    const doc: any = { '@context': goodContext, id: 'urn:test:retired', name: 'test' };
    const proof = await EdDSACryptosuiteManager.createProof(doc, {
      verificationMethod: vmId, proofPurpose: 'assertionMethod', privateKey: skMb,
      cryptosuite: 'eddsa-rdfc-2022', documentLoader: baseLoader
    });
    return { doc, proof, pkMb, vmId };
  }

  const loaderWith = (pkMb: string, extra: Record<string, unknown>) =>
    async (iri: string) => {
      if (iri.includes('#')) {
        return { document: { '@context': goodContext, id: iri, publicKeyMultibase: pkMb, ...extra }, documentUrl: iri, contextUrl: null };
      }
      return contextDocument(iri);
    };

  test('control: active VM verifies successfully (no over-rejection)', async () => {
    const { doc, proof, pkMb } = await makeSignedCredential();
    const res = await EdDSACryptosuiteManager.verifyProof(doc, proof as any, { documentLoader: loaderWith(pkMb, {}) });
    expect(res.verified).toBe(true);
  });

  test('rejects VM marked revoked even with an otherwise valid signature', async () => {
    const { doc, proof, pkMb } = await makeSignedCredential();
    const res = await EdDSACryptosuiteManager.verifyProof(doc, proof as any, {
      documentLoader: loaderWith(pkMb, { revoked: '2024-01-01T00:00:00Z' })
    });
    expect(res.verified).toBe(false);
    expect(res.errors?.[0]).toBe('Verification method has been revoked');
  });

  test('rejects VM marked compromised even with an otherwise valid signature', async () => {
    const { doc, proof, pkMb } = await makeSignedCredential();
    const res = await EdDSACryptosuiteManager.verifyProof(doc, proof as any, {
      documentLoader: loaderWith(pkMb, { compromised: '2024-02-02T00:00:00Z' })
    });
    expect(res.verified).toBe(false);
    expect(res.errors?.[0]).toBe('Verification method has been marked as compromised');
  });
});
