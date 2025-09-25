import { expect, describe, it, beforeEach, afterEach } from 'bun:test';
import { DataIntegrityProofManager, type ProofOptions, type DataIntegrityProof } from '../proofs/data-integrity';
import { EdDSACryptosuiteManager } from './__mocks__/eddsa-mock';
import { ModuleMocker } from '../../../../tests/mocks/ModuleMocker';
import { createDocumentLoader } from '../utils/document-loader';

describe('DataIntegrityProofManager', () => {
  let moduleMocker: ModuleMocker;

  const mockDocument = {
    '@context': ['https://www.w3.org/ns/credentials/v2', {
      'ex': 'https://example.org/vocab#'
    }],
    id: 'did:example:123',
    type: ['VerifiableCredential'],
    issuer: 'did:example:issuer',
    validFrom: '2023-01-01T00:00:00Z',
    credentialSubject: {
      id: 'did:example:subject',
      'ex:claim': 'value'
    }
  };

  const mockOptions: ProofOptions = {
    verificationMethod: 'did:example:issuer#key-1',
    proofPurpose: 'assertionMethod',
    type: 'DataIntegrityProof',
    privateKey: new Uint8Array(32),
    cryptosuite: 'eddsa-rdfc-2022',
    documentLoader: createDocumentLoader()
  };

  beforeEach(() => {
    // Mock the module to use our mock implementation
    moduleMocker = new ModuleMocker();
    moduleMocker.mock('../../lib/vcs/v2/cryptosuites/eddsa', () => ({
      EdDSACryptosuiteManager
    }));
  });

  afterEach(() => {
    moduleMocker.clear();
  });

  it('should create a proof', async () => {
    const proof = await DataIntegrityProofManager.createProof(mockDocument, mockOptions);
    if (Array.isArray(proof)) {
      throw new Error('Expected single proof, got array');
    }
    expect(proof).toHaveProperty('type', 'DataIntegrityProof');
    expect(proof).toHaveProperty('cryptosuite', 'eddsa-rdfc-2022');
    expect(proof).toHaveProperty('created');
    expect(proof).toHaveProperty('verificationMethod', mockOptions.verificationMethod);
    expect(proof).toHaveProperty('proofPurpose', mockOptions.proofPurpose);
    expect(proof).toHaveProperty('proofValue');
    expect(proof.proofValue).toBe('mockSignature');
  });

  it('should verify a proof', async () => {
    const mockProof: DataIntegrityProof = {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-rdfc-2022',
      created: '2023-01-01T00:00:00Z',
      verificationMethod: 'did:example:issuer#key-1',
      proofPurpose: 'assertionMethod',
      proofValue: 'mockSignature'
    };

    const {verified, errors} = await DataIntegrityProofManager.verifyProof(mockDocument, mockProof, { documentLoader: createDocumentLoader() });
    expect(verified).toBeTrue();
    expect(errors).toEqual([]);
  });
});
