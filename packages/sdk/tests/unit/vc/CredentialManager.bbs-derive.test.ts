import { describe, test, expect } from 'bun:test';
import * as bbs from '@digitalbazaar/bbs-signatures';
import { CredentialManager, type VerifiableCredential } from '../../../src';
import { BBSCryptosuiteManager } from '../../../src/vc/cryptosuites/bbsCryptosuite';
import { multikey } from '../../../src/crypto/Multikey';
import { PRELOADED_CONTEXTS } from '../../../src/utils/serialization';

const CIPHERSUITE = 'BLS12-381-SHA-256';
const config: any = { network: 'regtest', defaultKeyType: 'Ed25519', enableLogging: false };

/**
 * The BBS derive reveals the base proof's MANDATORY pointers in addition to the
 * caller's selective fields, so deriveSelectiveProof must account for what the
 * derived document actually contains — a mandatory '/issuer' the caller did not
 * list must be reported as disclosed, not hidden.
 */
describe('CredentialManager.deriveSelectiveProof (bbs-2023) disclosure accounting', () => {
  test('mandatory revealed fields are reported disclosed, not hidden', async () => {
    const { secretKey, publicKey } = await bbs.generateKeyPair({ ciphersuite: CIPHERSUITE });
    const publicKeyMultibase = multikey.encodePublicKey(publicKey, 'Bls12381G2');
    const did = 'did:example:issuer';
    const vm = `${did}#bbs-key-1`;

    const documentLoader = async (url: string) => {
      const ctx = (PRELOADED_CONTEXTS as Record<string, unknown>)[url];
      if (ctx) return { document: ctx, documentUrl: url, contextUrl: null };
      if (url === vm || url === did) {
        return {
          document: { id: vm, type: 'Multikey', controller: did, publicKeyMultibase },
          documentUrl: url,
          contextUrl: null
        };
      }
      throw new Error(`Unexpected load: ${url}`);
    };

    const credential = {
      '@context': ['https://www.w3.org/ns/credentials/v2', { '@vocab': 'https://example.org/vocab#' }],
      type: ['VerifiableCredential'],
      issuer: did,
      validFrom: '2024-01-01T00:00:00Z',
      credentialSubject: { id: 'did:example:subject', name: 'Alice', email: 'alice@example.com' }
    } as unknown as VerifiableCredential;

    // Base proof makes '/issuer' mandatory; the holder discloses only name.
    const baseProof = await BBSCryptosuiteManager.createProof(credential, {
      verificationMethod: vm,
      proofPurpose: 'assertionMethod',
      privateKey: secretKey,
      publicKey,
      documentLoader,
      mandatoryPointers: ['/issuer']
    });

    // Stub DIDManager so CredentialManager's internal documentLoader resolves
    // the issuer DID document (with the BBS verification method).
    const didManager = {
      resolveDID: async () => ({
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: did,
        verificationMethod: [{ id: vm, type: 'Multikey', controller: did, publicKeyMultibase }]
      })
    };
    const cm = new CredentialManager(config, didManager as any);

    const result = await cm.deriveSelectiveProof(
      { ...credential, proof: baseProof } as VerifiableCredential,
      ['/credentialSubject/name']
    );

    // '/issuer' is mandatory → present in the revealed credential → disclosed.
    expect((result.credential as any).issuer).toBe(did);
    expect(result.disclosedFields).toContain('/issuer');
    expect(result.hiddenFields).not.toContain('/issuer');
    // A genuinely withheld field stays hidden.
    expect(result.hiddenFields).toContain('/credentialSubject/email');
    // Accounting is disjoint.
    const disclosed = new Set(result.disclosedFields);
    for (const f of result.hiddenFields) expect(disclosed.has(f)).toBe(false);
  });
});
