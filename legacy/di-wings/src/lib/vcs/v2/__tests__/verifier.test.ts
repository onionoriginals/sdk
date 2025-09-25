import { expect, describe, it, afterEach, beforeAll, beforeEach } from 'bun:test';
import type { VerifiableCredential } from '../models/credential';
import type { VerifiablePresentation } from '../models/presentation';
import { Verifier } from '../verification/verifier';
import { ModuleMocker } from '../../../../tests/mocks/ModuleMocker';
import { BBSCryptosuiteManager } from '../cryptosuites/bbs';
import { createDocumentLoader } from '../utils/document-loader';
import { KeyType, Multikey } from '../../../crypto/keypairs/Multikey';

describe('Verifier', () => {
  let moduleMocker: ModuleMocker;
  let mockKeypair: Multikey;
  let bbsManager: BBSCryptosuiteManager;
  let documentLoader: any;

  beforeAll(() => {
    moduleMocker = new ModuleMocker();
  }); 

  afterEach(() => {
    moduleMocker.clear();
  });

  beforeEach(async () => {
    mockKeypair = await Multikey.generate(KeyType.Bls12381G2);
    bbsManager = new BBSCryptosuiteManager(mockKeypair);
    documentLoader = createDocumentLoader();
  });

  it.skip('should verify a valid credential', async () => {
    // Create an unsigned VC
    const unsignedVC = {
      '@context': [
        'https://www.w3.org/ns/credentials/v2',
        {
          '@vocab': 'https://example.org/vocab#'
        }
      ],
      'type': ['VerifiableCredential'],
      'issuer': mockKeypair.controller,
      'validFrom': '2023-01-01T00:00:00Z',
      'credentialSubject': {
        'id': 'did:example:456',
        'claim': 'value'
      }
    };

    // Create a proof using BBS
    const proof = await bbsManager.createBaseProof(
      unsignedVC,
      {
        type: 'DataIntegrityProof',
        cryptosuite: 'bbs-2023',
        verificationMethod: mockKeypair.id,
        proofPurpose: 'assertionMethod',
        created: '2023-01-01T00:00:00Z',
        documentLoader
      },
      ['/credentialSubject/id'] // Make the subject ID mandatory
    );

    // Create the signed VC
    const mockCredential = {
      ...unsignedVC,
      proof
    };

    const result = await Verifier.verifyCredential(mockCredential as unknown as VerifiableCredential, { documentLoader });
    expect(result.verified).toBeTrue();
    expect(result.errors).toBeEmpty();
  });

  it.skip('should verify a valid presentation', async () => {
    // First create a VC
    const unsignedVC = {
      '@context': [
        'https://www.w3.org/ns/credentials/v2',
        {
          '@vocab': 'https://windsurf.grotto-networking.com/selective#'
        }
      ],
      'type': ['VerifiableCredential'],
      'issuer': 'did:example:issuer',
      'credentialSubject': {
        'id': 'did:example:subject',
        'name': 'Alice',
        'age': 25
      }
    };

    // Issue the VC
    const mandatoryPointers = ['/credentialSubject/id'];
    const proof = await bbsManager.createBaseProof(
      unsignedVC,
      {
        type: 'DataIntegrityProof',
        cryptosuite: 'bbs-2023',
        verificationMethod: mockKeypair.id,
        proofPurpose: 'assertionMethod',
        created: '2023-01-01T00:00:00Z',
        documentLoader
      },
      mandatoryPointers
    );

    const vc = {
      ...unsignedVC,
      proof
    };

    // Create a VP with selective disclosure
    const selectivePointers = ['/credentialSubject/name'];
    const derivedVC = await BBSCryptosuiteManager.addDerivedProof(
      unsignedVC,
      proof,
      selectivePointers,
      'baseline',
      { documentLoader }
    );

    const vp = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      'type': ['VerifiablePresentation'],
      'verifiableCredential': [derivedVC]
    };

    // Verify the VP
    const result: any = await Verifier.verifyPresentation(vp as unknown as VerifiablePresentation, { documentLoader });

    expect(result.verified).toBeTrue();
    expect(result.presentationResult?.verified).toBeTrue();
    expect(result.credentialResults?.[0].verified).toBeTrue();
  });

  it('should return VerificationResult with error when credential has no proof', async () => {
    const invalidCredential = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential'],
      issuer: 'did:example:123',
      issuanceDate: '2023-01-01T00:00:00Z',
      credentialSubject: { id: 'did:example:456', claim: 'value' }
    };

    const options = { documentLoader: () => Promise.resolve({}) };
    const result = await Verifier.verifyCredential(invalidCredential as unknown as VerifiableCredential, options);
    expect(result.verified).toBeFalse();
    expect(result.errors).toBeDefined();
    expect(result.errors?.length).toBeGreaterThan(0);
  });

  it('should return VerificationResult with error when presentation has no proof', async () => {
    const invalidPresentation = {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation'],
      verifiableCredential: []
    };

    const options = { documentLoader: () => Promise.resolve({}) };
    const result = await Verifier.verifyPresentation(invalidPresentation as unknown as VerifiablePresentation, options);
    expect(result.verified).toBeFalse();
    expect(result.errors).toBeDefined();
    expect(result.errors?.length).toBeGreaterThan(0);
  });
});
