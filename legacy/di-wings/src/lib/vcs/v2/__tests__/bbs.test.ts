import { expect, describe, it, beforeEach, beforeAll } from 'bun:test';
import { BBSCryptosuiteManager } from '../cryptosuites/bbs';
import type { DataIntegrityProof, ProofOptions } from '../proofs/data-integrity';
import { KeyType, Multikey } from '../../../crypto/keypairs/Multikey';
import { multibase } from '../../../crypto';
import { concatBytes } from '@noble/hashes/utils';
import * as cbor from 'cbor-js';
import { createDocumentLoader } from '../utils/document-loader';
import { selectJsonLd } from '../utils/selective-disclosure';

describe('BBSCryptosuiteManager', () => {
  let baseVC: any;
  let recovered: any;
  let revealDoc: any;
  let derived: any;
  let input: any;
  let disclosureData: any;
  let bbsManager: BBSCryptosuiteManager;
  let mockKeypair: Multikey;
  let documentLoader: (iri: string) => Promise<{ document: any; documentUrl: string; contextUrl: string | null }>;
  let mockOptions: ProofOptions;
  
  beforeAll(async () => {
    baseVC = (await import('./__fixtures__/derived/00-base-vc.json')).default;
    recovered = (await import('./__fixtures__/derived/02-recovered.json')).default;
    revealDoc = (await import('./__fixtures__/derived/03-reveal-doc.json')).default;
    derived = (await import('./__fixtures__/derived/07-derived-vc.json')).default;
    input = (await import('./__fixtures__/derived/01-input.json')).default;
    disclosureData = (await import('./__fixtures__/derived/06-disclosure-data.json')).default;
  })

  beforeEach(async () => {
    mockKeypair = await Multikey.generate(KeyType.Bls12381G2);
    bbsManager = new BBSCryptosuiteManager(mockKeypair);
    documentLoader = createDocumentLoader();
    mockOptions = {
      type: 'DataIntegrityProof',
      cryptosuite: 'bbs-2023',
      verificationMethod: mockKeypair.id,
      proofPurpose: 'assertionMethod',
      created: '2023-01-01T00:00:00Z',
      documentLoader
    };
  });

  const mockDocument = {
    '@context': [
      'https://www.w3.org/ns/credentials/v2',
      {
        'ex': 'https://example.org/examples#',
        'claim': 'ex:claim',
        'claimName': 'ex:name'
      }
    ],
    id: 'did:example:123',
    type: ['VerifiableCredential'],
    issuer: 'did:example:issuer',
    validFrom: '2023-01-01T00:00:00Z',
    validUntil: '2028-01-01T00:00:00Z',
    credentialSubject: {
      id: 'did:example:subject',
      claim: 'value',
      name: 'Alice'
    }
  };

  describe('spec fixtures', () => {
    it('should parse base proof from spec fixtures', async () => {
      const parsedProof = BBSCryptosuiteManager['parseBaseProofValue'](baseVC.proof.proofValue);

      expect(parsedProof.bbsSignature).toEqual(Uint8Array.from(Buffer.from(recovered.bbsSignature, 'hex')));
      expect(parsedProof.featureOption).toEqual('baseline');
      expect(parsedProof.hmacKey).toEqual(Uint8Array.from(Buffer.from(recovered.hmacKey, 'hex')));
      expect(parsedProof.mandatoryPointers).toEqual(recovered.mandatoryPointers);
    });

    it('should create reveal document from spec fixture', async () => {
      const { proof, ...document } = baseVC;
      const result = selectJsonLd([...recovered.mandatoryPointers, "/credentialSubject/boards/0", "/credentialSubject/boards/1"], document);

      expect(result).toStrictEqual(revealDoc);
    });
    
    it('should create disclosure data from spec fixture', async () => {
      const { proof, ...document } = baseVC;
      
      // Create a clean copy of the document to avoid context pollution
      const cleanDocument = JSON.parse(JSON.stringify(document));
      
      // Ensure context is properly structured
      cleanDocument['@context'] = [
        'https://www.w3.org/ns/credentials/v2',
        {
          '@vocab': 'https://windsurf.grotto-networking.com/selective#'
        }
      ];

      const result = await BBSCryptosuiteManager['createDisclosureData'](
        cleanDocument,
        proof as DataIntegrityProof,
        ['/credentialSubject/boards/0', '/credentialSubject/boards/1'],
        'baseline',
        { 
          documentLoader: async (url: string) => {
            // Create a fresh document loader for each test
            const loader = createDocumentLoader();
            return loader(url);
          }
        },
        Uint8Array.from(Buffer.from(input.presentationHeaderHex, 'hex'))
      );
      
      expect(result.labelMap).toEqual(Object.fromEntries(disclosureData.labelMap.value));
      expect(result.mandatoryIndexes).toEqual(disclosureData.mandatoryIndexes);
      expect(result.selectiveIndexes).toEqual(disclosureData.adjSelectiveIndexes);
      expect(result.presentationHeader[0]).toEqual(disclosureData.presentationHeader[0]);
      expect(result.presentationHeader[1]).toEqual(disclosureData.presentationHeader[1]);
      expect(result.presentationHeader[2]).toEqual(disclosureData.presentationHeader[2]);
      expect(result.presentationHeader[3]).toEqual(disclosureData.presentationHeader[3]);
    });

    it('should verify derived proof from spec fixture', async () => {
      const result = await BBSCryptosuiteManager.verifyDerivedProof(
        derived,
        { documentLoader } as any
      );

      expect(result.verified).toBeTrue();
    });

    it('should verify derived proof from add derived proof of spec fixture', async () => {
      const { proof, ...document } = baseVC;
      const result = await BBSCryptosuiteManager.addDerivedProof(
        document,
        proof as DataIntegrityProof,
        ['/credentialSubject/boards/0', '/credentialSubject/boards/1'],
        'baseline',
        { documentLoader } as any
      );

      const verified = await BBSCryptosuiteManager.verifyDerivedProof(result, { documentLoader } as any);

      expect(verified.verified).toBeTrue();
    });

  });

  describe('baseProofConfiguration', () => {
    it('should generate valid proof configuration', async () => {
      const config = await BBSCryptosuiteManager.baseProofConfiguration(
        mockOptions,
        mockDocument['@context'] as string[]
      );
      expect(config).toBeTruthy();
      expect(typeof config).toBe('string');
    });

    it('should throw error for invalid proof type', async () => {
      const invalidOptions = { ...mockOptions, type: 'InvalidType' };
      expect(BBSCryptosuiteManager.baseProofConfiguration(
        invalidOptions as any,
        mockDocument['@context'] as string[]
      )).rejects.toThrow('Invalid proof type');
    });

    it('should throw error for invalid cryptosuite', async () => {
      const invalidOptions = { ...mockOptions, cryptosuite: 'invalid-suite' };
      expect(BBSCryptosuiteManager.baseProofConfiguration(
        invalidOptions as any,
        mockDocument['@context'] as string[]
      )).rejects.toThrow('Invalid cryptosuite');
    });

    it('should throw error for invalid created date format', async () => {
      const invalidOptions = { ...mockOptions, created: 'invalid-date' };
      expect(BBSCryptosuiteManager.baseProofConfiguration(
        invalidOptions as any,
        mockDocument['@context'] as string[]
      )).rejects.toThrow('Invalid created date');
    });
  });

  describe('baseProofTransformation', () => {
    it('should transform document with mandatory pointers', async () => {
      const mandatoryPointers = ['/credentialSubject/claim'];
      const options = { 
        ...mockOptions, 
        mandatoryPointers,
        type: 'DataIntegrityProof',
        cryptosuite: 'bbs-2023',
        verificationMethod: 'did:example:issuer#key-1'
      };
      
      const result = await BBSCryptosuiteManager.baseProofTransformation(mockDocument, options);
      
      expect(result).toBeTruthy();
      expect(result.mandatory).toBeDefined();
      expect(result.nonMandatory).toBeDefined();
      expect(result.hmacKey).toBeDefined();
      expect(result.hmacKey).toBeInstanceOf(Uint8Array);
      expect(result.hmacKey.length).toBe(32);
      expect(result.mandatoryPointers).toEqual(mandatoryPointers);
    });

    it('should handle empty mandatory pointers', async () => {
      const options = { 
        ...mockOptions,
        type: 'DataIntegrityProof',
        cryptosuite: 'bbs-2023',
        verificationMethod: 'did:example:issuer#key-1'
      };
      
      const result = await BBSCryptosuiteManager.baseProofTransformation(mockDocument, options);
      
      expect(result).toBeTruthy();
      expect(result.mandatory).toBeDefined();
      expect(result.nonMandatory).toBeDefined();
      expect(result.mandatoryPointers).toEqual([]);
    });

    it('should throw error for missing required options', async () => {
      const invalidOptions = {
        mandatoryPointers: ['/credentialSubject/claim']
      };
      
      expect(() => BBSCryptosuiteManager.baseProofTransformation(
        mockDocument, 
        invalidOptions as any
      )).toThrow('Missing required transformation options');
    });

    it('should throw error for invalid document', async () => {
      const options = { 
        ...mockOptions,
        type: 'DataIntegrityProof',
        cryptosuite: 'bbs-2023',
        verificationMethod: 'did:example:issuer#key-1'
      };
      
      expect(() => BBSCryptosuiteManager.baseProofTransformation(
        null,
        options
      )).toThrow('Failed to transform document');
    });

    it('should use provided document loader', async () => {
      const options = { 
        ...mockOptions,
        type: 'DataIntegrityProof',
        cryptosuite: 'bbs-2023',
        verificationMethod: 'did:example:123#key-1',
        documentLoader
      };
      
      const result = await BBSCryptosuiteManager.baseProofTransformation(mockDocument, options);
      
      expect(result).toBeTruthy();
    });
  });

  describe('createBaseProof', () => {
    it('should create valid base proof', async () => {
      const mandatoryPointers = ['/credentialSubject/claim'];
      
      const proof = await bbsManager.createBaseProof(
        mockDocument,
        mockOptions,
        mandatoryPointers
      );

      expect(proof).toBeTruthy();
      expect(proof.type).toBe('DataIntegrityProof');
      expect(proof.cryptosuite).toBe('bbs-2023');
      expect(proof.proofValue).toBeTruthy();
      expect(typeof proof.proofValue).toBe('string');
    });

    it('should create base proof with anonymous_holder_binding feature option', async () => {
      const mandatoryPointers = ['/credentialSubject/claim'];
      const featureOption = 'anonymous_holder_binding';
      const commitment = new Uint8Array([1, 2, 3, 4]);

      const proof = await bbsManager.createBaseProof(
        mockDocument,
        mockOptions,
        mandatoryPointers,
        featureOption,
        commitment
      );

      expect(proof).toBeTruthy();
      expect(proof.type).toBe('DataIntegrityProof');
      expect(proof.cryptosuite).toBe('bbs-2023');
      expect(proof.proofValue).toBeTruthy();
      expect(typeof proof.proofValue).toBe('string');
    });

    it('should create base proof with pseudonym_issuer_pid feature option', async () => {
      const mandatoryPointers = ['/credentialSubject/claim'];
      const featureOption = 'pseudonym_issuer_pid';

      const proof = await bbsManager.createBaseProof(
        mockDocument,
        mockOptions,
        mandatoryPointers,
        featureOption
      );

      expect(proof).toBeTruthy();
      expect(proof.type).toBe('DataIntegrityProof');
      expect(proof.cryptosuite).toBe('bbs-2023');
      expect(proof.proofValue).toBeTruthy();
      expect(typeof proof.proofValue).toBe('string');
    });

    it('should create base proof with pseudonym_hidden_pid feature option and commitment', async () => {
      const mandatoryPointers = ['/credentialSubject/claim'];
      const featureOption = 'pseudonym_hidden_pid';
      const commitment = new Uint8Array([5, 6, 7, 8]);

      const proof = await bbsManager.createBaseProof(
        mockDocument,
        mockOptions,
        mandatoryPointers,
        featureOption,
        commitment
      );

      expect(proof).toBeTruthy();
      expect(proof.type).toBe('DataIntegrityProof');
      expect(proof.cryptosuite).toBe('bbs-2023');
      expect(proof.proofValue).toBeTruthy();
      expect(typeof proof.proofValue).toBe('string');
    });

    it('should throw error when using anonymous_holder_binding without commitment', async () => {
      const mandatoryPointers = ['/credentialSubject/claim'];
      const featureOption = 'anonymous_holder_binding';

      expect(
        bbsManager.createBaseProof(
          mockDocument,
          mockOptions,
          mandatoryPointers,
          featureOption
          // Missing commitment_with_proof
        )
      ).rejects.toThrow('commitment_with_proof is required for anonymous_holder_binding');
    });

    it('should throw error when using unsupported feature option', async () => {
      const mandatoryPointers = ['/credentialSubject/claim'];
      const featureOption = 'unsupported_option';

      expect(
        bbsManager.createBaseProof(
          mockDocument,
          mockOptions,
          mandatoryPointers,
          featureOption
        )
      ).rejects.toThrow('Unsupported feature option: unsupported_option');
    });

    it('should throw error when required options are missing', async () => {
      const mandatoryPointers = ['/credentialSubject/claim'];
      const incompleteOptions = { ...mockOptions, type: undefined };

      expect(
        bbsManager.createBaseProof(
          mockDocument,
          incompleteOptions as any,
          mandatoryPointers
        )
      ).rejects.toThrow('https://w3id.org/security#PROOF_GENERATION_ERROR');
    });

    it('should throw error when unsecuredDocument is invalid', async () => {
      const mandatoryPointers = ['/credentialSubject/claim'];

      expect(
        bbsManager.createBaseProof(
          null,
          mockOptions,
          mandatoryPointers
        )
      ).rejects.toThrow('Failed to create base proof');
    });
  });

  describe('addDerivedProof', () => {
    let baseProof: DataIntegrityProof;

    beforeEach(async () => {
      const mockOptions: ProofOptions = {
        type: 'DataIntegrityProof',
        cryptosuite: 'bbs-2023',
        verificationMethod: mockKeypair.id,
        proofPurpose: 'assertionMethod',
        created: '2023-01-01T00:00:00Z',
        documentLoader
      };

      // Create base proof with mandatory pointers
      baseProof = await bbsManager.createBaseProof(
        mockDocument,
        mockOptions,
        ['/credentialSubject/id']
      );
    });

    it('should create valid derived proof', async () => {
      const selectivePointers = ['/credentialSubject/claim'];
      const derivedDoc = await BBSCryptosuiteManager.addDerivedProof(
        mockDocument,
        baseProof,
        selectivePointers,
        'baseline',
        { documentLoader } as any
      );
      
      expect(derivedDoc).toBeTruthy();
      expect(derivedDoc.proof?.type).toBe('DataIntegrityProof');
      expect(derivedDoc.proof?.cryptosuite).toBe('bbs-2023');
      expect(derivedDoc.proof?.proofValue).toBeTruthy();
      expect(typeof derivedDoc.proof?.proofValue).toBe('string');
      expect(derivedDoc.proof?.proofValue.startsWith('u')).toBeTrue();

      // Verify the derived proof works
      const verifyResult = await BBSCryptosuiteManager.verifyDerivedProof(
        derivedDoc,
        { documentLoader } as any
      );

      expect(verifyResult.verified).toBeTrue();
    });

    it('should create baseline derived proof with selective disclosure', async () => {
      const selectivePointers = ['/credentialSubject/name'];
      const derivedDoc = await BBSCryptosuiteManager.addDerivedProof(
        mockDocument,
        baseProof,
        selectivePointers,
        'baseline',
        { documentLoader } as any
      );

      // Check that selective disclosure worked
      expect(derivedDoc.credentialSubject.name).toBe('Alice');
      expect(derivedDoc.credentialSubject.id).toBe('did:example:subject'); // Mandatory field
      expect(derivedDoc.credentialSubject.age).toBeUndefined(); // Should be hidden
      
      // Verify the derived proof
      const verifyResult = await BBSCryptosuiteManager.verifyDerivedProof(
        derivedDoc,
        { documentLoader } as any
      );
      expect(verifyResult.verified).toBeTrue();
    });

    it('should throw error for missing required parameters', async () => {
      const selectivePointers = ['/credentialSubject/name'];
      
      expect(BBSCryptosuiteManager.addDerivedProof(
        null,
        baseProof,
        selectivePointers,
        'baseline',
        { documentLoader } as any 
      )).rejects.toThrow('Failed to create disclosure data');
    });

    it('should throw error for invalid document', async () => {
      const selectivePointers = ['/credentialSubject/name'];
      
      expect(BBSCryptosuiteManager.addDerivedProof(
        null,
        baseProof,
        selectivePointers,
        'baseline',
        { documentLoader } as any
      )).rejects.toThrow('Failed to create disclosure data');
    });

    it('should throw error for invalid base proof', async () => {
      const invalidProof = {
        ...baseProof,
        proofValue: 'invalid'
      };

      const selectivePointers = ['/credentialSubject/name'];
      
      expect(BBSCryptosuiteManager.addDerivedProof(
        mockDocument,
        invalidProof,
        selectivePointers,
        'baseline',
        { documentLoader } as any
      )).rejects.toThrow('Proof value must be multibase-base64url-no-pad-encoded');
    });
  });

  describe('verifyDerivedProof', () => {
    it('should verify valid derived proof', async () => {
      const baseProof = await bbsManager.createBaseProof(
        mockDocument,
        mockOptions,
        ['/credentialSubject/id']
      );
      
      const selectivePointers = ['/credentialSubject/claim'];
      const derivedDocument = await BBSCryptosuiteManager.addDerivedProof(
        mockDocument,
        baseProof,
        selectivePointers,
        'baseline',
        mockOptions
      );

      const result = await BBSCryptosuiteManager.verifyDerivedProof(derivedDocument, { documentLoader } as any);
      expect(result.verified).toBeTrue();
      expect((result as any).errors).toBeEmpty();
    });

    it('should fail verification for invalid proof', async () => {
      const invalidDocument = {
        ...mockDocument,
        proof: {
          verificationMethod: mockKeypair.id,
          type: 'DataIntegrityProof',
          cryptosuite: 'bbs-2023',
          proofValue: 'invalid'
        }
      };

      const result = await BBSCryptosuiteManager.verifyDerivedProof(invalidDocument, { documentLoader } as any);
      expect(result.verified).toBeFalse();
      expect(result.verifiedDocument).toBeNull();
    });
  });

  describe('baseProofHashing', () => {
    it('should generate valid hash data', () => {
      const transformedDocument = {
        mandatory: [
          '_:c14n0 <http://schema.org/name> "Test Name" .',
          '_:c14n1 <http://schema.org/value> "123" .'
        ],
        nonMandatory: [
          '_:c14n2 <http://schema.org/description> "Test Description" .'
        ]
      };

      const canonicalProofConfig = '_:c14n0 <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://w3id.org/security#DataIntegrityProof> .';

      const hashData = BBSCryptosuiteManager.baseProofHashing(
        transformedDocument,
        canonicalProofConfig
      );

      expect(hashData).toBeTruthy();
      expect(hashData.proofHash).toBeDefined();
      expect(hashData.mandatoryHash).toBeDefined();
      expect(typeof hashData.proofHash).toBe('string');
      expect(typeof hashData.mandatoryHash).toBe('string');
      expect(hashData.mandatory).toEqual(transformedDocument.mandatory);
      expect(hashData.nonMandatory).toEqual(transformedDocument.nonMandatory);
    });

    it('should throw error for invalid input', () => {
      const invalidDocument = null;
      const canonicalProofConfig = '_:c14n0 <type> <DataIntegrityProof> .';

      expect(() => BBSCryptosuiteManager.baseProofHashing(
        invalidDocument,
        canonicalProofConfig
      )).toThrow('Failed to create hash data');
    });
  });

  describe('serializeBaseProofValue', () => {
    const mockBbsSignature = new Uint8Array([1, 2, 3]);
    const mockBbsHeader = new Uint8Array([1, 2, 3]);
    const mockPublicKey = new Uint8Array([1, 2, 3]);
    const mockHmacKey = new Uint8Array([4, 5, 6]);
    const mockMandatoryPointers = ['/credentialSubject/claim'];

    it('should serialize baseline proof value correctly', () => {
      const result = BBSCryptosuiteManager.serializeBaseProofValue(
        mockBbsSignature,
        mockBbsHeader,
        mockPublicKey,
        mockHmacKey,
        mockMandatoryPointers,
        'baseline'
      );

      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      // Should start with multibase prefix for base64url
      expect(result.startsWith('u')).toBeTrue();
    });

    it('should serialize anonymous holder binding proof value correctly', () => {
      const result = BBSCryptosuiteManager.serializeBaseProofValue(
        mockBbsSignature,
        mockBbsHeader,
        mockPublicKey,
        mockHmacKey,
        mockMandatoryPointers,
        'anonymous_holder_binding',
        undefined,
        new Uint8Array([1, 2, 3])
      );

      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      expect(result.startsWith('u')).toBeTrue();
    });

    it('should serialize pseudonym issuer pid proof value correctly', () => {
      const result = BBSCryptosuiteManager.serializeBaseProofValue(
        mockBbsSignature,
        mockBbsHeader,
        mockPublicKey,
        mockHmacKey,
        mockMandatoryPointers,
        'pseudonym_issuer_pid',
        new Uint8Array([1, 2, 3])
      );

      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      expect(result.startsWith('u')).toBeTrue();
    });

    it('should serialize pseudonym hidden pid proof value correctly', () => {
      const result = BBSCryptosuiteManager.serializeBaseProofValue(
        mockBbsSignature,
        mockBbsHeader,
        mockPublicKey,
        mockHmacKey,
        mockMandatoryPointers,
        'pseudonym_hidden_pid',
        undefined,
        new Uint8Array([1, 2, 3])
      );

      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
      expect(result.startsWith('u')).toBeTrue();
    });

    it('should throw error for unsupported feature option', () => {
      expect(() => BBSCryptosuiteManager.serializeBaseProofValue(
        mockBbsSignature,
        mockBbsHeader,
        mockPublicKey,
        mockHmacKey,
        mockMandatoryPointers,
        'unsupported_option'
      )).toThrow('Unsupported feature option: unsupported_option');
    });
  });

  describe('baseProofSerialization', () => {
    const mockHashData = {
      proofHash: '1234',
      mandatoryPointers: ['/credentialSubject/claim'],
      mandatoryHash: '5678',
      nonMandatory: ['statement1', 'statement2'],
      hmacKey: new Uint8Array([1, 2, 3])
    };

    it('should create baseline proof successfully', async () => {
      const result = await bbsManager.baseProofSerialization(
        mockHashData,
        'baseline'
      );
      
      expect(result).toBeTruthy();
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it('should create anonymous holder binding proof with commitment', async () => {
      const commitment = new Uint8Array([4, 5, 6]);
      
      const result = await bbsManager.baseProofSerialization(
        mockHashData,
        'anonymous_holder_binding',
        commitment
      );
      
      expect(result).toBeTruthy();
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it('should throw error for anonymous holder binding without commitment', async () => {
      expect(() => bbsManager.baseProofSerialization(
        mockHashData,
        'anonymous_holder_binding'
      )).toThrow('Missing commitment_with_proof');
    });

    it('should create pseudonym issuer pid proof successfully', async () => {
      const result = await bbsManager.baseProofSerialization(
        mockHashData,
        'pseudonym_issuer_pid'
      );
      
      expect(result).toBeTruthy();
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it('should create pseudonym hidden pid proof with commitment', async () => {
      const commitment = new Uint8Array([7, 8, 9]);
      
      const result = await bbsManager.baseProofSerialization(
        mockHashData,
        'pseudonym_hidden_pid',
        commitment
      );
      
      expect(result).toBeTruthy();
      expect(result).toBeInstanceOf(Uint8Array);
    });

    it('should throw error for pseudonym hidden pid without commitment', () => {
      expect(() => bbsManager.baseProofSerialization(
        mockHashData,
        'pseudonym_hidden_pid'
      )).toThrow('Missing commitment_with_proof');
    });

    it('should throw error for unsupported feature option', () => {
      expect(() => bbsManager.baseProofSerialization(
        mockHashData,
        'unsupported_option'
      )).toThrow('Unsupported feature option');
    });
  });

  describe('serializeDerivedProofValue', () => {
    const mockBbsProof = new Uint8Array([1, 2, 3]);
    const mockLabelMap = {
      'c14n0': 'b1',
      'c14n1': 'b2',
      'c14n2': 'b3'
    };
    const mockMandatoryIndexes = [0, 1];
    const mockSelectiveIndexes = [2];
    const mockPresentationHeader = new Uint8Array([4, 5, 6]);

    it('should serialize baseline derived proof value', () => {
      const result = BBSCryptosuiteManager.serializeDerivedProofValue(
        mockBbsProof,
        mockLabelMap,
        mockMandatoryIndexes,
        mockSelectiveIndexes,
        mockPresentationHeader,
        'baseline'
      );

      expect(result).toBeTruthy();
      expect(result).toStartWith('u')
    });

    it.skip('should serialize anonymous holder binding derived proof value', () => {
      const result = BBSCryptosuiteManager.serializeDerivedProofValue(
        mockBbsProof,
        mockLabelMap,
        mockMandatoryIndexes,
        mockSelectiveIndexes,
        mockPresentationHeader,
        'anonymous_holder_binding',
        undefined,
        5 // lengthBBSMessages
      );

      expect(result).toBeTruthy();
      expect(result).toStartWith('u');
    });

    it.skip('should serialize pseudonym issuer pid derived proof value', () => {
      const result = BBSCryptosuiteManager.serializeDerivedProofValue(
        mockBbsProof,
        mockLabelMap,
        mockMandatoryIndexes,
        mockSelectiveIndexes,
        mockPresentationHeader,
        'pseudonym_issuer_pid',
        'mockPseudonym',
        5 // lengthBBSMessages
      );

      expect(result).toBeTruthy();
      expect(result).toStartWith('u');
    });

    it.skip('should serialize pseudonym hidden pid derived proof value', () => {
      const result = BBSCryptosuiteManager.serializeDerivedProofValue(
        mockBbsProof,
        mockLabelMap,
        mockMandatoryIndexes,
        mockSelectiveIndexes,
        mockPresentationHeader,
        'pseudonym_hidden_pid',
        'mockPseudonym',
        5 // lengthBBSMessages
      );

      expect(result).toBeTruthy();
      expect(result).toStartWith('u');
      expect(result[0]).toBe('0xd9');
    });

    it.skip('should throw error for missing lengthBBSMessages with anonymous_holder_binding', () => {
      expect(() => BBSCryptosuiteManager.serializeDerivedProofValue(
        mockBbsProof,
        mockLabelMap,
        mockMandatoryIndexes,
        mockSelectiveIndexes,
        mockPresentationHeader,
        'anonymous_holder_binding'
      )).toThrow('lengthBBSMessages is required for anonymous_holder_binding');
    });

    it.skip('should throw error for missing pseudonym with pseudonym features', () => {
      expect(() => BBSCryptosuiteManager.serializeDerivedProofValue(
        mockBbsProof,
        mockLabelMap,
        mockMandatoryIndexes,
        mockSelectiveIndexes,
        mockPresentationHeader,
        'pseudonym_issuer_pid',
        undefined,
        5
      )).toThrow('pseudonym is required for pseudonym features');
    });

    it.skip('should throw error for missing lengthBBSMessages with pseudonym features', () => {
      expect(() => BBSCryptosuiteManager.serializeDerivedProofValue(
        mockBbsProof,
        mockLabelMap,
        mockMandatoryIndexes,
        mockSelectiveIndexes,
        mockPresentationHeader,
        'pseudonym_issuer_pid',
        'mockPseudonym'
      )).toThrow('lengthBBSMessages is required');
    });

    it('should throw error for unsupported feature option', () => {
      expect(() => BBSCryptosuiteManager.serializeDerivedProofValue(
        mockBbsProof,
        mockLabelMap,
        mockMandatoryIndexes,
        mockSelectiveIndexes,
        mockPresentationHeader,
        'unsupported_option'
      )).toThrow('Unsupported feature option: unsupported_option');
    });

    it('should handle empty presentation header', () => {
      const result = BBSCryptosuiteManager.serializeDerivedProofValue(
        mockBbsProof,
        mockLabelMap,
        mockMandatoryIndexes,
        mockSelectiveIndexes,
        new Uint8Array(0),
        'baseline'
      );

      expect(result).toBeTruthy();
      expect(result).toStartWith('u');
    });
  });

  describe('compressLabelMap', () => {
    it('should compress valid label map entries', () => {
      const labelMap = {
        'c14n0': 'b1',
        'c14n1': 'b2',
        'c14n2': 'b3'
      };

      const result = BBSCryptosuiteManager['compressLabelMap'](labelMap);

      expect(result).toBeTruthy();
      expect(result).toEqual({
        '0': '1',
        '1': '2',
        '2': '3'
      });
    });

    it('should handle single digit and multi-digit numbers', () => {
      const labelMap = {
        'c14n0': 'b1',
        'c14n10': 'b20',
        'c14n999': 'b1000'
      };

      const result = BBSCryptosuiteManager['compressLabelMap'](labelMap);

      expect(result).toEqual({
        '0': '1',
        '10': '20',
        '999': '1000'
      });
    });

    it('should throw error for invalid c14n prefix', () => {
      const labelMap = {
        'invalid0': 'b1',
        'c14n1': 'b2'
      };

      expect(() => BBSCryptosuiteManager['compressLabelMap'](labelMap))
        .toThrow('Invalid label map entry');
    });

    it('should throw error for invalid b prefix', () => {
      const labelMap = {
        'c14n0': 'invalid1',
        'c14n1': 'b2'
      };

      expect(() => BBSCryptosuiteManager['compressLabelMap'](labelMap))
        .toThrow('Invalid label map entry');
    });

    it('should throw error for non-numeric values', () => {
      const labelMap = {
        'c14nabc': 'b1',
        'c14n1': 'bdef'
      };

      expect(() => BBSCryptosuiteManager['compressLabelMap'](labelMap))
        .toThrow('Invalid label map entry');
    });

    it('should handle empty label map', () => {
      const labelMap = {};

      const result = BBSCryptosuiteManager['compressLabelMap'](labelMap);

      expect(result).toEqual({});
    });
  });

  describe('decompressLabelMap', () => {
    it('should decompress valid compressed label map entries', () => {
      const compressedMap = {
        '0': '1',
        '1': '2',
        '2': '3'
      };

      const result = BBSCryptosuiteManager['decompressLabelMap'](compressedMap);

      expect(result).toBeTruthy();
      expect(result).toEqual({
        'c14n0': 'b1',
        'c14n1': 'b2',
        'c14n2': 'b3'
      });
    });

    it('should handle single digit and multi-digit numbers', () => {
      const compressedMap = {
        '0': '1',
        '10': '20',
        '999': '1000'
      };

      const result = BBSCryptosuiteManager['decompressLabelMap'](compressedMap);

      expect(result).toEqual({
        'c14n0': 'b1',
        'c14n10': 'b20',
        'c14n999': 'b1000'
      });
    });

    it('should handle empty compressed map', () => {
      const compressedMap = {};

      const result = BBSCryptosuiteManager['decompressLabelMap'](compressedMap);

      expect(result).toEqual({});
    });

    it('should throw error for invalid input', () => {
      const invalidMap = null;

      expect(() => BBSCryptosuiteManager['decompressLabelMap'](invalidMap as any))
        .toThrow('Failed to decompress label map');
    });

    it('should handle zero values', () => {
      const compressedMap = {
        '0': '0'
      };

      const result = BBSCryptosuiteManager['decompressLabelMap'](compressedMap);

      expect(result).toEqual({
        'c14n0': 'b0'
      });
    });

    it('should preserve ordering of entries', () => {
      const compressedMap = {
        '2': '3',
        '0': '1',
        '1': '2'
      };

      const result = BBSCryptosuiteManager['decompressLabelMap'](compressedMap);
      const entries = Object.entries(result);

      expect(entries).toEqual([
        ['c14n0', 'b1'],
        ['c14n1', 'b2'],
        ['c14n2', 'b3']
      ]);
    });
  });

  describe('createDisclosureData', () => {
    const mockProof: DataIntegrityProof = {
      type: 'DataIntegrityProof',
      cryptosuite: 'bbs-2023',
      proofValue: 'u2V0ChVhQpqkkG8r3CyY9fsTjhZ7tHj_mkQmF_oVnNw7kUInI8leYLbB6DZ8BN9HQwI5e747OFu58RtMnGqmvHuA4JX9ltr5Laubm7L-78XZ_0RJZ06ZYQNBqLvyH1brCX3Pn7sikwSlO7I6xmzal3dNtuJVOGU8B5vUmiOXBxv2iKqyp-9jzM5LsLfcA-70FsJhjNkMlfFFYYIeg2sTKzuTPTITuNcpvqnSP7MBEfGuWqXGKtrtcGoH5LkePFzl6lHSoXSrKB4EHOhDjppFORlI2oue8oyTsz68qhL01mzoIWM7yxiQqkRe63oa75XB_9Bf0tBPlpqsZdLggYTAYfGExFGEyGC1hMxhqYTQYnGE1DmE2GMhhNxh6YTgYVmE5GL9iMTAYhGIxMRheYjEyGGdiMTMYOWIxNBjFYjE1GHJiMTYY52IxNxg0YjE4GNpiMTkYkWIyMBhaYjIxGMhiMjIY-GIyMxi_YjI0GHtiMjUYm2IyNhh3YjI3GN1iMjgRYjI5GEFiMzAYY2IzMRgngXgYL2NyZWRlbnRpYWxTdWJqZWN0L2NsYWlt',
      verificationMethod: 'did:example:issuer#key-1',
      created: '2023-01-01T00:00:00Z',
      proofPurpose: 'assertionMethod'
    };

    const mockSelectivePointers = ['/credentialSubject/name'];
    const mockPresentationHeader = new Uint8Array([1, 2, 3]);

    it('should create baseline disclosure data', async () => {
      const result = await BBSCryptosuiteManager['createDisclosureData'](
        mockDocument,
        mockProof,
        mockSelectivePointers,
        'baseline',
        { documentLoader },
        mockPresentationHeader
      );

      expect(result).toBeTruthy();
      expect(result.bbsProof).toBeInstanceOf(Uint8Array);
      expect(result.labelMap).toBeDefined();
      expect(result.mandatoryIndexes).toBeInstanceOf(Array);
      expect(result.selectiveIndexes).toBeInstanceOf(Array);
      expect(result.presentationHeader).toEqual(mockPresentationHeader);
      expect(result.revealDocument).toBeDefined();
      expect(result.pseudonym).toBeUndefined();
    });

    it.skip('should create anonymous holder binding disclosure data', async () => {
      const result = await BBSCryptosuiteManager['createDisclosureData'](
        mockDocument,
        mockProof,
        mockSelectivePointers,
        'anonymous_holder_binding',
        {},
        mockPresentationHeader,
        {
          holderSecret: 'mockSecret',
          proverBlind: 'mockBlind'
        }
      );

      expect(result).toBeTruthy();
      expect(result.bbsProof).toBeInstanceOf(Uint8Array);
      expect(result.pseudonym).toBeUndefined();
    });

    it.skip('should create pseudonym issuer pid disclosure data', async () => {
      const result = await BBSCryptosuiteManager['createDisclosureData'](
        mockDocument,
        mockProof,
        mockSelectivePointers,
        'pseudonym_issuer_pid',
        {},
        mockPresentationHeader,
        {
          verifier_id: 'mockVerifierId'
        }
      );

      expect(result).toBeTruthy();
      expect(result.bbsProof).toBeInstanceOf(Uint8Array);
      expect(result.pseudonym).toBeDefined();
    });

    it.skip('should create pseudonym hidden pid disclosure data', async () => {
      const result = await BBSCryptosuiteManager['createDisclosureData'](
        mockDocument,
        mockProof,
        mockSelectivePointers,
        'pseudonym_hidden_pid',
        {},
        mockPresentationHeader,
        {
          verifier_id: 'mockVerifierId',
          proverBlind: 'mockProverBlind'
        }
      );

      expect(result).toBeTruthy();
      expect(result.bbsProof).toBeInstanceOf(Uint8Array);
      expect(result.pseudonym).toBeDefined();
    });

    it.skip('should throw error for missing holder binding parameters', async () => {
      expect(BBSCryptosuiteManager['createDisclosureData'](
        mockDocument,
        mockProof,
        mockSelectivePointers,
        'anonymous_holder_binding',
        {},
        mockPresentationHeader
      )).rejects.toThrow('holderSecret and proverBlind are required');
    });

    it.skip('should throw error for missing verifier_id in pseudonym features', async () => {
      expect(BBSCryptosuiteManager['createDisclosureData'](
        mockDocument,
        mockProof,
        mockSelectivePointers,
        'pseudonym_issuer_pid',
        {},
        mockPresentationHeader
      )).rejects.toThrow('verifier_id is required');
    });

    it.skip('should throw error for missing proverBlind in pseudonym_hidden_pid', async () => {
      expect(BBSCryptosuiteManager['createDisclosureData'](
        mockDocument,
        mockProof,
        mockSelectivePointers,
        'pseudonym_hidden_pid',
        {},
        mockPresentationHeader,
        {
          verifier_id: 'mockVerifierId'
        }
      )).rejects.toThrow('proverBlind is required');
    });

    it('should throw error for unsupported feature option', async () => {
      expect(BBSCryptosuiteManager['createDisclosureData'](
        mockDocument,
        mockProof,
        mockSelectivePointers,
        'unsupported_option',
        { documentLoader }
      )).rejects.toThrow('Unsupported feature option');
    });
  });

  describe('parseBaseProofValue', () => {
    // Helper function to create mock proof values
    const createMockProofValue = (headerBytes: number[], components: any[]): string => {
      const header = new Uint8Array(headerBytes);
      const encodedComponents = new Uint8Array(cbor.encode(components));
      return multibase.encode(
        concatBytes(header, encodedComponents),
        'base64url'
      );
    };

    const mockBaselineComponents = [
      new Uint8Array([1, 2, 3]), // bbsSignature
      new Uint8Array([4, 5, 6]), // bbsHeader
      new Uint8Array([7, 8, 9]), // publicKey
      new Uint8Array([10, 11, 12]), // hmacKey
      ['/credentialSubject/claim'] // mandatoryPointers
    ];

    const mockAnonymousComponents = [
      ...mockBaselineComponents,
      new Uint8Array([13, 14, 15]) // signer_blind
    ];

    const mockPseudonymComponents = [
      ...mockBaselineComponents,
      new Uint8Array([16, 17, 18]) // pid
    ];

    it('should parse baseline proof value', () => {
      const proofValue = createMockProofValue(
        [0xd9, 0x5d, 0x02],
        mockBaselineComponents
      );

      const result = BBSCryptosuiteManager['parseBaseProofValue'](proofValue);

      expect(result).toBeTruthy();
      expect(result.featureOption).toBe('baseline');
      expect(result.bbsSignature).toEqual(mockBaselineComponents[0] as Uint8Array);
      expect(result.bbsHeader).toEqual(mockBaselineComponents[1] as Uint8Array);
      expect(result.publicKey).toEqual(mockBaselineComponents[2] as Uint8Array);
      expect(result.hmacKey).toEqual(mockBaselineComponents[3] as Uint8Array);
      expect(result.mandatoryPointers).toEqual(mockBaselineComponents[4] as string[]);
      expect(result.signer_blind).toBeUndefined();
      expect(result.pid).toBeUndefined();
    });

    it.skip('should parse anonymous holder binding proof value', () => {
      const proofValue = createMockProofValue(
        [0xd9, 0x5d, 0x04],
        mockAnonymousComponents
      );

      const result = BBSCryptosuiteManager['parseBaseProofValue'](proofValue);

      expect(result).toBeTruthy();
      expect(result.featureOption).toBe('anonymous_holder_binding');
      expect(result.signer_blind).toEqual(mockAnonymousComponents[5] as any);
    });

    it.skip('should parse pseudonym issuer pid proof value', () => {
      const proofValue = createMockProofValue(
        [0xd9, 0x5d, 0x06],
        mockPseudonymComponents
      );

      const result = BBSCryptosuiteManager['parseBaseProofValue'](proofValue);

      expect(result).toBeTruthy();
      expect(result.featureOption).toBe('pseudonym_issuer_pid');
      expect(result.pid).toEqual(mockPseudonymComponents[5] as any);
    });

    it.skip('should parse pseudonym hidden pid proof value', () => {
      const proofValue = createMockProofValue(
        [0xd9, 0x5d, 0x08],
        mockPseudonymComponents
      );

      const result = BBSCryptosuiteManager['parseBaseProofValue'](proofValue);

      expect(result).toBeTruthy();
      expect(result.featureOption).toBe('pseudonym_hidden_pid');
      expect(result.signer_blind).toEqual(mockPseudonymComponents[5] as any);
    });

    it('should throw error for invalid multibase prefix', () => {
      const proofValue = 'x' + multibase.encode(new Uint8Array([1, 2, 3]), 'base64url');

      expect(() => BBSCryptosuiteManager['parseBaseProofValue'](proofValue))
        .toThrow('Proof value must be multibase-base64url-no-pad-encoded');
    });

    it('should throw error for invalid header bytes', () => {
      const proofValue = createMockProofValue(
        [0x00, 0x00, 0x00],
        mockBaselineComponents
      );

      expect(() => BBSCryptosuiteManager['parseBaseProofValue'](proofValue))
        .toThrow('Proof value must start with a valid BBS header sequence');
    });

    it('should throw error for invalid CBOR data', () => {
      // Create an invalid CBOR encoding
      const proofValue = multibase.encode(
        concatBytes(
          new Uint8Array([0xd9, 0x5d, 0x02]),
          new Uint8Array([0x00]) // Invalid CBOR data
        ),
        'base64url'
      );

      expect(() => BBSCryptosuiteManager['parseBaseProofValue'](proofValue))
        .toThrow('Invalid proof header');
    });

    it('should throw error for missing components', () => {
      const proofValue = createMockProofValue(
        [0xd9, 0x5d, 0x02],
        [] // Empty components array
      );

      expect(() => BBSCryptosuiteManager['parseBaseProofValue'](proofValue))
        .toThrow('Invalid proof header');
    });
  });

  describe('parseDerivedProofValue', () => {
    // Helper function to create mock derived proof values
    const createMockDerivedProofValue = (headerBytes: number[], components: any[]): string => {
      const header = new Uint8Array(headerBytes);
      const encodedComponents = new Uint8Array(cbor.encode(components));
      return multibase.encode(
        concatBytes(header, encodedComponents),
        'base64url'
      );
    };

    const mockBaselineComponents = [
      new Uint8Array([1, 2, 3]), // bbsProof
      { '0': '1', '1': '2' }, // compressed labelMap
      [0, 1], // mandatoryIndexes
      [2], // selectiveIndexes
      new Uint8Array([4, 5, 6]) // presentationHeader
    ];

    const mockAnonymousComponents = [
      ...mockBaselineComponents,
      5 // lengthBBSMessages
    ];

    const mockPseudonymComponents = [
      ...mockBaselineComponents,
      'mockPseudonym', // pseudonym
      7 // lengthBBSMessages
    ];

    it('should parse baseline derived proof value', () => {
      const proofValue = createMockDerivedProofValue(
        [0xd9, 0x5d, 0x03],
        mockBaselineComponents
      );

      const result = BBSCryptosuiteManager['parseDerivedProofValue'](proofValue);

      expect(result).toBeTruthy();
      expect(result.featureOption).toBe('baseline');
      expect(result.bbsProof).toEqual(mockBaselineComponents[0] as any);
      expect(result.labelMap).toEqual({
        'c14n0': 'b1',
        'c14n1': 'b2'
      });
      expect(result.mandatoryIndexes).toEqual(mockBaselineComponents[2] as any);
      expect(result.selectiveIndexes).toEqual(mockBaselineComponents[3] as any);
      expect(result.presentationHeader).toEqual(mockBaselineComponents[4] as any);
      expect(result.lengthBBSMessages).toBeUndefined();
      expect(result.pseudonym).toBeUndefined();
    });

    it('should parse anonymous holder binding derived proof value', () => {
      const proofValue = createMockDerivedProofValue(
        [0xd9, 0x5d, 0x05],
        mockAnonymousComponents
      );

      const result = BBSCryptosuiteManager['parseDerivedProofValue'](proofValue);

      expect(result).toBeTruthy();
      expect(result.featureOption).toBe('anonymous_holder_binding');
      expect(result.lengthBBSMessages).toBe(5);
      expect(result.pseudonym).toBeUndefined();
    });

    it('should parse pseudonym derived proof value', () => {
      const proofValue = createMockDerivedProofValue(
        [0xd9, 0x5d, 0x07],
        mockPseudonymComponents
      );

      const result = BBSCryptosuiteManager['parseDerivedProofValue'](proofValue);

      expect(result).toBeTruthy();
      expect(result.featureOption).toBe('pseudonym');
      expect(result.pseudonym).toBe('mockPseudonym');
      expect(result.lengthBBSMessages).toBe(7);
    });

    it('should throw error for invalid multibase prefix', () => {
      const proofValue = 'x' + multibase.encode(new Uint8Array([1, 2, 3]), 'base64url');

      expect(() => BBSCryptosuiteManager['parseDerivedProofValue'](proofValue))
        .toThrow('Proof value must be multibase-base64url-no-pad-encoded');
    });

    it('should throw error for invalid header bytes', () => {
      const proofValue = createMockDerivedProofValue(
        [0x00, 0x00, 0x00],
        mockBaselineComponents
      );

      expect(() => BBSCryptosuiteManager['parseDerivedProofValue'](proofValue))
        .toThrow('Proof value must start with a valid BBS disclosure proof header sequence');
    });

    it('should throw error for invalid components structure', () => {
      const invalidComponents = [
        'not a byte array', // Invalid bbsProof
        { '0': '1' }, // Valid labelMap
        [0, 1], // Valid mandatoryIndexes
        [2], // Valid selectiveIndexes
        new Uint8Array([4, 5, 6]) // Valid presentationHeader
      ];

      const proofValue = createMockDerivedProofValue(
        [0xd9, 0x5d, 0x03],
        invalidComponents
      );

      expect(() => BBSCryptosuiteManager['parseDerivedProofValue'](proofValue))
        .toThrow('Components must be an array of 5-7 elements with specific types');
    });

    it('should throw error for wrong number of components', () => {
      const tooFewComponents = mockBaselineComponents.slice(0, 4);
      const proofValue = createMockDerivedProofValue(
        [0xd9, 0x5d, 0x03],
        tooFewComponents
      );

      expect(() => BBSCryptosuiteManager['parseDerivedProofValue'](proofValue))
        .toThrow('Components must be an array of 5-7 elements with specific types');
    });

    it('should throw error for invalid CBOR data', () => {
      const proofValue = multibase.encode(
        concatBytes(
          new Uint8Array([0xd9, 0x5d, 0x03]),
          new Uint8Array([0x00]) // Invalid CBOR data
        ),
        'base64url'
      );

      expect(() => BBSCryptosuiteManager['parseDerivedProofValue'](proofValue))
        .toThrow('Invalid components structure');
    });
  });

  describe('createVerifyData', () => {
    // Helper function to create mock proof values
    const createMockProofValue = (headerBytes: number[], components: any[]): string => {
      const header = new Uint8Array(headerBytes);
      const encodedComponents = new Uint8Array(cbor.encode(components));
      return multibase.encode(
        concatBytes(header, encodedComponents),
        'base64url'
      );
    };

    // Create valid mock components for derived proof
    const mockComponents = [
      new Uint8Array([1, 2, 3]), // bbsProof
      { '0': '1', '1': '2' }, // compressed labelMap
      [0, 1], // mandatoryIndexes
      [2], // selectiveIndexes
      new Uint8Array([4, 5, 6]) // presentationHeader
    ];

    const mockProof: DataIntegrityProof = {
      type: 'DataIntegrityProof',
      cryptosuite: 'bbs-2023',
      proofValue: createMockProofValue([0xd9, 0x5d, 0x03], mockComponents), // baseline header
      verificationMethod: 'did:example:issuer#key-1',
      created: '2023-01-01T00:00:00Z',
      proofPurpose: 'assertionMethod'
    };


    it('should create verify data for baseline proof', async () => {
      const result = await BBSCryptosuiteManager.createVerifyData(
        mockDocument,
        mockProof,
        { documentLoader }
      );

      expect(result).toBeTruthy();
      expect(result.bbsProof).toBeInstanceOf(Uint8Array);
      expect(result.bbsProof).toEqual(mockComponents[0] as any);
      expect(result.proofHash).toBeInstanceOf(Uint8Array);
      expect(result.mandatoryHash).toBeInstanceOf(Uint8Array);
      expect(result.selectiveIndexes).toEqual(mockComponents[3] as any);
      expect(result.presentationHeader).toEqual(mockComponents[4] as any);
      expect(result.nonMandatory).toBeInstanceOf(Array);
      expect(result.featureOption).toBe('baseline');
      expect(result.pseudonym).toBeUndefined();
      expect(result.lengthBBSMessages).toBeUndefined();
    });

    it('should create verify data with pseudonym and lengthBBSMessages', async () => {
      const mockPseudonymComponents = [
        ...mockComponents.slice(0, 5),
        'mockPseudonym', // pseudonym
        7 // lengthBBSMessages
      ];

      const proofWithPseudonym: DataIntegrityProof = {
        ...mockProof,
        proofValue: createMockProofValue([0xd9, 0x5d, 0x07], mockPseudonymComponents)
      };

      const result = await BBSCryptosuiteManager.createVerifyData(
        mockDocument,
        proofWithPseudonym,
        { documentLoader }
      );

      expect(result).toBeTruthy();
      expect(result.bbsProof).toEqual(mockPseudonymComponents[0] as any);
      expect(result.pseudonym).toBe('mockPseudonym');
      expect(result.lengthBBSMessages).toBe(7);
      expect(result.featureOption).toBe('pseudonym');
    });

    it('should throw error for invalid proof value', async () => {
      const invalidProof = {
        ...mockProof,
        proofValue: 'invalid'
      };

      expect(BBSCryptosuiteManager.createVerifyData(
        mockDocument,
        invalidProof,
        { documentLoader }
      )).rejects.toThrow('Proof value must be multibase-base64url-no-pad-encoded');
    });

    it('should throw error for invalid document', async () => {
      expect(BBSCryptosuiteManager.createVerifyData(
        null,
        mockProof,
        { documentLoader }
      )).rejects.toThrow('Failed to create verify data');
    });

    it('should correctly separate mandatory and non-mandatory statements', async () => {
      const result = await BBSCryptosuiteManager.createVerifyData(
        mockDocument,
        mockProof,
        { documentLoader }
      );

      expect(result.nonMandatory).toBeInstanceOf(Array);
      result.nonMandatory.forEach(nq => {
        expect(nq).toBeInstanceOf(Uint8Array);
      });
    });

    it('should handle invalid header bytes', async () => {
      const invalidProof = {
        ...mockProof,
        proofValue: createMockProofValue([0x00, 0x00, 0x00], mockComponents)
      };

      expect(BBSCryptosuiteManager.createVerifyData(
        mockDocument,
        invalidProof,
        { documentLoader }
      )).rejects.toThrow('Proof value must start with a valid BBS disclosure proof header sequence');
    });
  });

  describe('verifyDerivedProof', () => {
    let mockKeypair: Multikey;
    let bbsManager: BBSCryptosuiteManager;
  
    beforeEach(async () => {
      mockKeypair = await Multikey.generate(KeyType.Bls12381G2);
      bbsManager = new BBSCryptosuiteManager(mockKeypair);
    });
  
    const mockSecuredDocument = {
      '@context': ['https://www.w3.org/ns/credentials/v2'],
      id: 'did:example:123',
      type: ['VerifiableCredential'],
      issuer: 'did:example:issuer',
      credentialSubject: {
        id: 'did:example:subject',
        name: 'Alice'
      },
      proof: {
        type: 'DataIntegrityProof',
        cryptosuite: 'bbs-2023',
        verificationMethod: 'did:example:issuer#key-1',
        proofValue: 'mockProofValue'
      }
    };
  
    it('should verify baseline derived proof', async () => {
      const result = await BBSCryptosuiteManager.verifyDerivedProof(
        derived,
        { documentLoader } as any
      );
  
      expect(result.verified).toBeTrue();
      expect(result.verifiedDocument).toBeDefined();
    });
  
    it.skip('should verify anonymous holder binding derived proof', async () => {
      const docWithAnonymousProof = {
        ...mockSecuredDocument,
        proof: {
          ...mockSecuredDocument.proof,
          proofValue: 'mockAnonymousProofValue'
        }
      };
  
      const result = await BBSCryptosuiteManager.verifyDerivedProof(
        docWithAnonymousProof,
        { documentLoader } as any
      );
  
      expect(result.verified).toBeTrue();
      expect(result.verifiedDocument).toBeDefined();
    });
  
    it.skip('should verify pseudonym derived proof', async () => {
      const docWithPseudonymProof = {
        ...mockSecuredDocument,
        proof: {
          ...mockSecuredDocument.proof,
          proofValue: 'mockPseudonymProofValue'
        }
      };
  
      const result = await BBSCryptosuiteManager.verifyDerivedProof(
        docWithPseudonymProof,
        { documentLoader } as any
      );
  
      expect(result.verified).toBeTrue();
      expect(result.verifiedDocument).toBeDefined();
    });
  
    it('should fail verification for invalid proof', async () => {
      const docWithInvalidProof = {
        ...mockSecuredDocument,
        proof: {
          ...mockSecuredDocument.proof,
          proofValue: 'invalid'
        }
      };
  
      const result = await BBSCryptosuiteManager.verifyDerivedProof(
        docWithInvalidProof,
        { documentLoader } as any
      );
  
      expect(result.verified).toBeFalse();
      expect(result.verifiedDocument).toBeNull();
    });
  
    it('should fail verification for missing proof', async () => {
      const docWithoutProof: any = { ...mockSecuredDocument };
      delete docWithoutProof.proof;
  
      const result = await BBSCryptosuiteManager.verifyDerivedProof(
        docWithoutProof,
        { documentLoader } as any
      );
  
      expect(result.verified).toBeFalse();
      expect(result.verifiedDocument).toBeNull();
    });
  
    it('should fail verification for missing document loader', async () => {
      const verified = await BBSCryptosuiteManager.verifyDerivedProof(
        mockSecuredDocument
      );
      expect(verified.verified).toBeFalse();
    });
  }); 
}); 