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

  // Regression: challenge/domain on the base proof must survive derivation, or
  // the derived proofHash diverges from the signed bbsHeader (PR #219 review).
  test('challenge/domain on the base proof survive derivation and verify', async () => {
    const { secretKey, publicKey } = await bbs.generateKeyPair({ ciphersuite: CIPHERSUITE });
    const documentLoader = await makeLoader(publicKey);

    const baseProof = await BBSCryptosuiteManager.createProof(credential, {
      verificationMethod: vm,
      privateKey: secretKey,
      publicKey,
      documentLoader,
      mandatoryPointers,
      challenge: 'nonce-123',
      domain: 'https://verifier.example'
    });
    expect(baseProof.challenge).toBe('nonce-123');
    expect((await BBSCryptosuiteManager.verifyProof(credential, baseProof, { documentLoader })).verified).toBe(true);

    const { document: revealed, proof: derivedProof } = await BBSCryptosuiteManager.deriveProof(
      { ...credential, proof: baseProof },
      baseProof,
      { documentLoader, selectivePointers: ['/credentialSubject/name'] }
    );
    expect(derivedProof.challenge).toBe('nonce-123');
    expect(derivedProof.domain).toBe('https://verifier.example');

    const result = await BBSCryptosuiteManager.verifyDerivedProof({ ...revealed, proof: derivedProof }, { documentLoader });
    expect(result.verified).toBe(true);
  });

  // Regression: deriving with no mandatory and no selective pointers must fail
  // loudly rather than emit an unverifiable, context-less proof (PR #219 review).
  test('deriving with no pointers throws instead of producing an unverifiable proof', async () => {
    const { secretKey, publicKey } = await bbs.generateKeyPair({ ciphersuite: CIPHERSUITE });
    const documentLoader = await makeLoader(publicKey);

    const baseProof = await BBSCryptosuiteManager.createProof(credential, {
      verificationMethod: vm,
      privateKey: secretKey,
      publicKey,
      documentLoader,
      mandatoryPointers: [] // no mandatory pointers
    });

    await expect(
      BBSCryptosuiteManager.deriveProof(
        { ...credential, proof: baseProof },
        baseProof,
        { documentLoader, selectivePointers: [] } // ...and no selective pointers
      )
    ).rejects.toThrow(/at least one mandatory or selective pointer/i);
  });

  // Regression (issue #316): an id-less credential with anonymous nested nodes
  // across sibling branches must round-trip. The per-level skolemization
  // counter copy collapsed distinct blank nodes into one skolem URN, so the
  // base proof verified but the derived proof did not.
  test('id-less credential with multiple anonymous nested nodes round-trips', async () => {
    const { secretKey, publicKey } = await bbs.generateKeyPair({ ciphersuite: CIPHERSUITE });
    const documentLoader = await makeLoader(publicKey);

    const anonCred = {
      '@context': [
        'https://www.w3.org/ns/credentials/v2',
        { '@vocab': 'https://example.org/vocab#' }
      ],
      type: ['VerifiableCredential'],
      // no top-level `id`: the credential root itself is a blank node
      issuer: 'did:example:issuer',
      validFrom: '2024-01-01T00:00:00Z',
      credentialSubject: {
        id: 'did:example:subject', // @id-bearing node with anonymous descendants
        employment: { employer: { name: 'Acme' } }
      },
      evidence: { note: 'anonymous sibling branch' }
    };

    const baseProof = await BBSCryptosuiteManager.createProof(anonCred, {
      verificationMethod: vm,
      privateKey: secretKey,
      publicKey,
      documentLoader,
      mandatoryPointers
    });
    expect((await BBSCryptosuiteManager.verifyProof(anonCred, baseProof, { documentLoader })).verified).toBe(true);

    const { document: revealed, proof: derivedProof } = await BBSCryptosuiteManager.deriveProof(
      { ...anonCred, proof: baseProof },
      baseProof,
      { documentLoader, selectivePointers: ['/credentialSubject/employment'] }
    );
    expect(revealed.credentialSubject.employment.employer.name).toBe('Acme');
    expect(revealed.evidence).toBeUndefined();

    const result = await BBSCryptosuiteManager.verifyDerivedProof(
      { ...revealed, proof: derivedProof },
      { documentLoader }
    );
    expect(result.errors).toBeUndefined();
    expect(result.verified).toBe(true);
  });

  // Regression (issue #315): the verification method must be controlled by the
  // credential issuer. An attacker signing with their own key while naming a
  // trusted issuer must be rejected on both the base and derived paths.
  test('rejects issuer impersonation via an attacker-controlled verificationMethod', async () => {
    const { secretKey, publicKey } = await bbs.generateKeyPair({ ciphersuite: CIPHERSUITE });
    const attackerVm = 'did:example:attacker#bbs-key-1';
    const publicKeyMultibase = multikey.encodePublicKey(publicKey, 'Bls12381G2');
    const documentLoader = async (url: string) => {
      const ctx = (PRELOADED_CONTEXTS as Record<string, unknown>)[url];
      if (ctx) return { document: ctx, documentUrl: url, contextUrl: null };
      if (url === attackerVm) {
        return {
          document: {
            id: attackerVm,
            type: 'Multikey',
            controller: 'did:example:attacker',
            publicKeyMultibase
          },
          documentUrl: url,
          contextUrl: null
        };
      }
      throw new Error(`Unexpected document load: ${url}`);
    };

    // Attacker signs a credential whose `issuer` names the victim, using the
    // attacker's own key and verificationMethod.
    const forgedProof = await BBSCryptosuiteManager.createProof(credential, {
      verificationMethod: attackerVm,
      privateKey: secretKey,
      publicKey,
      documentLoader,
      mandatoryPointers
    });

    const baseResult = await BBSCryptosuiteManager.verifyProof(credential, forgedProof, { documentLoader });
    expect(baseResult.verified).toBe(false);
    expect(baseResult.errors?.[0]).toContain('does not match issuer');

    const { document: revealed, proof: derivedProof } = await BBSCryptosuiteManager.deriveProof(
      { ...credential, proof: forgedProof },
      forgedProof,
      { documentLoader, selectivePointers: ['/credentialSubject/name'] }
    );
    const derivedResult = await BBSCryptosuiteManager.verifyDerivedProof(
      { ...revealed, proof: derivedProof },
      { documentLoader }
    );
    expect(derivedResult.verified).toBe(false);
    expect(derivedResult.errors?.[0]).toContain('does not match issuer');

    const derivedViaVerifyProof = await BBSCryptosuiteManager.verifyProof(revealed, derivedProof, { documentLoader });
    expect(derivedViaVerifyProof.verified).toBe(false);
    expect(derivedViaVerifyProof.errors?.[0]).toContain('does not match issuer');
  });

  // Issue #315: verification fails closed when the document names no issuer or
  // holder; expectedController is the explicit escape hatch.
  test('fails closed without an issuer/holder unless expectedController is supplied', async () => {
    const { secretKey, publicKey } = await bbs.generateKeyPair({ ciphersuite: CIPHERSUITE });
    const documentLoader = await makeLoader(publicKey);
    const { issuer: _issuer, ...issuerlessCred } = credential as any;

    const baseProof = await BBSCryptosuiteManager.createProof(issuerlessCred, {
      verificationMethod: vm,
      privateKey: secretKey,
      publicKey,
      documentLoader,
      mandatoryPointers: ['/credentialSubject/id']
    });

    const failClosed = await BBSCryptosuiteManager.verifyProof(issuerlessCred, baseProof, { documentLoader });
    expect(failClosed.verified).toBe(false);
    expect(failClosed.errors?.[0]).toContain('no issuer or holder');

    const bound = await BBSCryptosuiteManager.verifyProof(issuerlessCred, baseProof, {
      documentLoader,
      expectedController: 'did:example:issuer'
    });
    expect(bound.verified).toBe(true);

    const wrongController = await BBSCryptosuiteManager.verifyProof(issuerlessCred, baseProof, {
      documentLoader,
      expectedController: 'did:example:other'
    });
    expect(wrongController.verified).toBe(false);
  });

  // Issue #315 (related): a verifier that supplies challenge/domain
  // expectations must reject a replayed proof carrying different values.
  test('expectedChallenge/expectedDomain mismatches are rejected (anti-replay)', async () => {
    const { secretKey, publicKey } = await bbs.generateKeyPair({ ciphersuite: CIPHERSUITE });
    const documentLoader = await makeLoader(publicKey);

    const baseProof = await BBSCryptosuiteManager.createProof(credential, {
      verificationMethod: vm,
      privateKey: secretKey,
      publicKey,
      documentLoader,
      mandatoryPointers,
      challenge: 'nonce-123',
      domain: 'https://verifier.example'
    });

    const ok = await BBSCryptosuiteManager.verifyProof(credential, baseProof, {
      documentLoader,
      expectedChallenge: 'nonce-123',
      expectedDomain: 'https://verifier.example'
    });
    expect(ok.verified).toBe(true);

    const staleChallenge = await BBSCryptosuiteManager.verifyProof(credential, baseProof, {
      documentLoader,
      expectedChallenge: 'nonce-456'
    });
    expect(staleChallenge.verified).toBe(false);
    expect(staleChallenge.errors?.[0]).toContain('challenge mismatch');

    const { document: revealed, proof: derivedProof } = await BBSCryptosuiteManager.deriveProof(
      { ...credential, proof: baseProof },
      baseProof,
      { documentLoader, selectivePointers: ['/credentialSubject/name'] }
    );
    const replayed = await BBSCryptosuiteManager.verifyDerivedProof(
      { ...revealed, proof: derivedProof },
      { documentLoader, expectedChallenge: 'nonce-456' }
    );
    expect(replayed.verified).toBe(false);
    expect(replayed.errors?.[0]).toContain('challenge mismatch');

    const wrongDomain = await BBSCryptosuiteManager.verifyDerivedProof(
      { ...revealed, proof: derivedProof },
      { documentLoader, expectedDomain: 'https://other.example' }
    );
    expect(wrongDomain.verified).toBe(false);
    expect(wrongDomain.errors?.[0]).toContain('domain mismatch');
  });

  // Regression: a string value that looks like a blank node ("_:...") must not
  // corrupt canonicalization (PR #219 review).
  test('a credential value that looks like a blank node still round-trips', async () => {
    const { secretKey, publicKey } = await bbs.generateKeyPair({ ciphersuite: CIPHERSUITE });
    const documentLoader = await makeLoader(publicKey);

    const cred = {
      ...credential,
      credentialSubject: { ...credential.credentialSubject, note: '_:c14n0 looks like a bnode' }
    };

    const baseProof = await BBSCryptosuiteManager.createProof(cred, {
      verificationMethod: vm,
      privateKey: secretKey,
      publicKey,
      documentLoader,
      mandatoryPointers
    });
    expect((await BBSCryptosuiteManager.verifyProof(cred, baseProof, { documentLoader })).verified).toBe(true);

    const { document: revealed, proof: derivedProof } = await BBSCryptosuiteManager.deriveProof(
      { ...cred, proof: baseProof },
      baseProof,
      { documentLoader, selectivePointers: ['/credentialSubject/note'] }
    );
    expect(revealed.credentialSubject.note).toBe('_:c14n0 looks like a bnode');
    const result = await BBSCryptosuiteManager.verifyDerivedProof({ ...revealed, proof: derivedProof }, { documentLoader });
    expect(result.verified).toBe(true);
  });
});
