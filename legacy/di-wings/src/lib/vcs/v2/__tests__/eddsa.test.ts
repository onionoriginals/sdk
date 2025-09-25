import { describe, it, expect, beforeEach } from 'bun:test';
import type { DataIntegrityProof } from '../proofs/data-integrity';
import { EdDSACryptosuiteManager } from '../cryptosuites/eddsa';

describe('EdDSACryptosuiteManager', () => {
  let vc: any;


  it('should have required static methods', () => {
    expect(typeof EdDSACryptosuiteManager.createProof).toBe('function');
    expect(typeof EdDSACryptosuiteManager.verifyProof).toBe('function');
    expect(EdDSACryptosuiteManager.name).toBe('eddsa-rdfc-2022');
  });

  // it('should create a proof', async () => {
  //   const document = { 
  //     '@context': ['https://www.w3.org/ns/credentials/v2'],
  //     foo: 'bar' 
  //   };
    
  //   const mockOptions = {
  //     type: 'DataIntegrityProof',
  //     cryptosuite: 'eddsa-rdfc-2022',
  //     verificationMethod: 'did:example:issuer#key-1',
  //     proofPurpose: 'assertionMethod',
  //     privateKey: new Uint8Array(32).fill(1),
  //     documentLoader: async () => ({ 
  //       document: {
  //         publicKeyMultibase: 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
  //       } 
  //     })
  //   };

  //   const proof = await EdDSACryptosuiteManager.createProof(document, mockOptions);
    
  //   expect(proof).toHaveProperty('type', 'DataIntegrityProof');
  //   expect(proof).toHaveProperty('cryptosuite', 'eddsa-rdfc-2022');
  //   expect(proof).toHaveProperty('verificationMethod', mockOptions.verificationMethod);
  //   expect(proof).toHaveProperty('proofPurpose', 'assertionMethod');
  //   expect(proof).toHaveProperty('proofValue');

  //   vc = {...document, proof};
  // });

  // it('should verify a proof', async () => {
  //   const result = await EdDSACryptosuiteManager.verifyProof(vc, vc.proof, {
  //     documentLoader: () => Promise.resolve({
  //       document: {
  //         publicKeyMultibase: 'z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK'
  //       },
  //       documentUrl: '',
  //       contextUrl: ''
  //     })
  //   });

  //   expect(result.verified).toBe(false);
  // });
});
