import { describe, it, expect, beforeAll, afterEach, mock } from 'bun:test';
import { Issuer } from '../issuance/issuer';
import { Multikey, KeyType } from '../../../crypto/keypairs/Multikey';
import { createDocumentLoader } from '../utils/document-loader';
import type { Credential } from '../models/credential';

describe('Issuer', () => {
  let issuer: Issuer;
  let key: Multikey;
  let documentLoader: ReturnType<typeof createDocumentLoader>;

  beforeAll(async () => {
    key = await Multikey.generate(KeyType.Ed25519);
    issuer = new Issuer(key);
    documentLoader = createDocumentLoader();
  });

  it('should issue a valid verifiable credential', async () => {
    const credential: Credential = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential'],
      issuer: 'https://example.edu/issuers/14',
      validFrom: '2023-06-15T00:00:00Z',
      credentialSubject: {
        id: 'did:example:ebfeb1f712ebc6f1c276e12ec21'
      }
    };

    const verifiableCredential = await issuer.issueCredential(credential, {
      proofPurpose: 'assertionMethod',
      documentLoader: documentLoader
    });

    expect(verifiableCredential).toHaveProperty('proof');
    expect(verifiableCredential.proof).toHaveProperty('type', 'DataIntegrityProof');
    expect(verifiableCredential.proof).toHaveProperty('cryptosuite', 'eddsa-rdfc-2022');
    expect(verifiableCredential.proof).toHaveProperty('proofPurpose', 'assertionMethod');
    expect(verifiableCredential.proof).toHaveProperty('verificationMethod');
    expect(verifiableCredential.proof).toHaveProperty('created');
    expect(verifiableCredential.proof).toHaveProperty('proofValue');
  });

  it('should add missing properties to the credential', async () => {
    const minimalCredential: Credential = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      credentialSubject: {
        id: 'did:example:ebfeb1f712ebc6f1c276e12ec21'
      },
      type: ['VerifiableCredential'],
      issuer: 'https://example.edu/issuers/14'
    };

    const verifiableCredential = await issuer.issueCredential(minimalCredential, {
      proofPurpose: 'assertionMethod',
      documentLoader
    });

    expect(verifiableCredential).toHaveProperty('@context');
    expect(verifiableCredential['@context']).toContain('https://www.w3.org/ns/credentials/v2');
    expect(verifiableCredential).toHaveProperty('type');
    expect(verifiableCredential.type).toContain('VerifiableCredential');
    expect(verifiableCredential).toHaveProperty('issuer', 'https://example.edu/issuers/14');
    expect(new Date(verifiableCredential.validFrom!)).toBeInstanceOf(Date);
  });

  it('should throw an error if credentialSubject is missing', async () => {
    const invalidCredential: any = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      type: ['VerifiableCredential']
    };

    await expect(issuer.issueCredential(invalidCredential, {
      proofPurpose: 'assertionMethod',
      documentLoader
    })).rejects.toThrow('Invalid input');
  });
});
