import { describe, test, expect } from 'bun:test';
import * as bbs from '@digitalbazaar/bbs-signatures';
import { BBSCryptosuiteManager } from '../../../../src/vc/cryptosuites/bbsCryptosuite';
import { multikey } from '../../../../src/crypto/Multikey';
import { PRELOADED_CONTEXTS } from '../../../../src/utils/serialization';

/**
 * End-to-end BBS+ (bbs-2023) selective disclosure against real BLS12-381 keys:
 * sign a base proof, verify it, derive a selective-disclosure proof, and verify
 * the derived proof reveals only the chosen statements.
 */

const CIPHERSUITE = 'BLS12-381-SHA-256';
const vm = 'did:example:issuer#bbs-key-1';

const credential = {
  '@context': [
    'https://www.w3.org/ns/credentials/v2',
    { '@vocab': 'https://example.org/vocab#' }
  ],
  type: ['VerifiableCredential'],
  issuer: 'did:example:issuer',
  validFrom: '2024-01-01T00:00:00Z',
  credentialSubject: {
    id: 'did:example:subject',
    name: 'Alice',
    age: 30,
    country: 'US'
  }
};

const mandatoryPointers = ['/issuer', '/credentialSubject/id'];

async function makeLoader(publicKey: Uint8Array) {
  const publicKeyMultibase = multikey.encodePublicKey(publicKey, 'Bls12381G2');
  return async (url: string) => {
    const ctx = (PRELOADED_CONTEXTS as Record<string, unknown>)[url];
    if (ctx) return { document: ctx, documentUrl: url, contextUrl: null };
    if (url === vm) {
      return {
        document: {
          id: vm,
          type: 'Multikey',
          controller: 'did:example:issuer',
          publicKeyMultibase
        },
        documentUrl: url,
        contextUrl: null
      };
    }
    throw new Error(`Unexpected document load: ${url}`);
  };
}

describe('BBS+ bbs-2023 selective disclosure round-trip', () => {
  test('sign → verify base → derive → verify derived (real BLS12-381)', async () => {
    const { secretKey, publicKey } = await bbs.generateKeyPair({ ciphersuite: CIPHERSUITE });
    const documentLoader = await makeLoader(publicKey);

    // 1) Issuer creates the BBS base proof.
    const baseProof = await BBSCryptosuiteManager.createProof(credential, {
      verificationMethod: vm,
      proofPurpose: 'assertionMethod',
      privateKey: secretKey,
      publicKey,
      documentLoader,
      mandatoryPointers
    });
    expect(baseProof.cryptosuite).toBe('bbs-2023');
    expect(baseProof.proofValue.startsWith('u')).toBe(true);

    // 2) Anyone can verify the base proof.
    const baseResult = await BBSCryptosuiteManager.verifyProof(credential, baseProof, { documentLoader });
    expect(baseResult.verified).toBe(true);

    // 3) Holder derives a selective-disclosure proof revealing only `name`.
    const { document: revealed, proof: derivedProof } = await BBSCryptosuiteManager.deriveProof(
      { ...credential, proof: baseProof },
      baseProof,
      { documentLoader, selectivePointers: ['/credentialSubject/name'] }
    );

    // Mandatory + selected fields are present; hidden fields are not.
    expect(revealed.issuer).toBe('did:example:issuer');
    expect(revealed.credentialSubject.id).toBe('did:example:subject');
    expect(revealed.credentialSubject.name).toBe('Alice');
    expect(revealed.credentialSubject.age).toBeUndefined();
    expect(revealed.credentialSubject.country).toBeUndefined();

    // 4) Verifier verifies the derived proof.
    const derivedResult = await BBSCryptosuiteManager.verifyDerivedProof(
      { ...revealed, proof: derivedProof },
      { documentLoader }
    );
    expect(derivedResult.verified).toBe(true);
    expect(derivedResult.verifiedDocument).toBeTruthy();

    // verifyProof dispatches derived proofs too.
    const derivedViaVerifyProof = await BBSCryptosuiteManager.verifyProof(revealed, derivedProof, { documentLoader });
    expect(derivedViaVerifyProof.verified).toBe(true);
  });

  test('tampering with a disclosed value fails derived verification', async () => {
    const { secretKey, publicKey } = await bbs.generateKeyPair({ ciphersuite: CIPHERSUITE });
    const documentLoader = await makeLoader(publicKey);

    const baseProof = await BBSCryptosuiteManager.createProof(credential, {
      verificationMethod: vm,
      privateKey: secretKey,
      publicKey,
      documentLoader,
      mandatoryPointers
    });

    const { document: revealed, proof: derivedProof } = await BBSCryptosuiteManager.deriveProof(
      { ...credential, proof: baseProof },
      baseProof,
      { documentLoader, selectivePointers: ['/credentialSubject/name'] }
    );

    const tampered = { ...revealed, credentialSubject: { ...revealed.credentialSubject, name: 'Mallory' } };
    const result = await BBSCryptosuiteManager.verifyDerivedProof(
      { ...tampered, proof: derivedProof },
      { documentLoader }
    );
    expect(result.verified).toBe(false);
  });

  test('a wrong verification key fails verification', async () => {
    const { secretKey, publicKey } = await bbs.generateKeyPair({ ciphersuite: CIPHERSUITE });
    const documentLoader = await makeLoader(publicKey);

    const baseProof = await BBSCryptosuiteManager.createProof(credential, {
      verificationMethod: vm,
      privateKey: secretKey,
      publicKey,
      documentLoader,
      mandatoryPointers
    });

    // Resolve the VM to a *different* key.
    const other = await bbs.generateKeyPair({ ciphersuite: CIPHERSUITE });
    const wrongLoader = await makeLoader(other.publicKey);

    const result = await BBSCryptosuiteManager.verifyProof(credential, baseProof, { documentLoader: wrongLoader });
    expect(result.verified).toBe(false);
  });
});
