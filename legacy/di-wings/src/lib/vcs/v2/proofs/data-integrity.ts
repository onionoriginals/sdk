import { EdDSACryptosuiteManager } from '../cryptosuites/eddsa';
import { BBSCryptosuiteManager } from '../cryptosuites/bbs';
import { ProofError } from '../errors';
import type { ILinkedDataProof } from '../../../common/interfaces';
import type { VerificationResult } from '../../../crypto';

export interface DataIntegrityProof extends ILinkedDataProof {
  type: 'DataIntegrityProof';
  cryptosuite: string;
  created?: string;
  verificationMethod: string;
  proofPurpose: string;
  proofValue: string;
  id?: string;
  previousProof?: string | string[];
}

export type ProofType = DataIntegrityProof;

export interface ProofOptions {
  verificationMethod: string;
  proofPurpose: string;
  privateKey?: Uint8Array;
  type: 'DataIntegrityProof';
  created?: string;
  cryptosuite: string;
  documentLoader?: (url: string) => Promise<any>;
  previousProof?: string | string[];
  challenge?: string;
  domain?: string;
  mandatoryPointers?: string[];
  featureOption?: string;
  commitment_with_proof?: Uint8Array;
}

export class DataIntegrityProofManager {
  static async createSingleProof(document: any, options: ProofOptions): Promise<DataIntegrityProof> {
    try {
      const {
        verificationMethod, proofPurpose, privateKey, cryptosuite,
        documentLoader, previousProof, challenge, domain
      } = options;

      let cryptosuiteManager;
      switch (cryptosuite) {
        case 'eddsa-rdfc-2022':
          cryptosuiteManager = EdDSACryptosuiteManager;
          break;
        case 'bbs-2023':
          cryptosuiteManager = BBSCryptosuiteManager;
          break;
        default:
          throw new ProofError(`Unsupported cryptosuite: ${cryptosuite}`);
      }
      const proof = await cryptosuiteManager.createProof(document, {
        ...options,
        verificationMethod,
        proofPurpose,
        privateKey: privateKey ?? Uint8Array.from([]),
        documentLoader,
        previousProof: previousProof ?? [],
        challenge,
        domain
      });

      if (previousProof) {
        proof.previousProof = previousProof;
      }

      return proof;
    } catch (error: any) {
      
      throw new ProofError(`Failed to create proof: ${error.message}`);
    }
  }

  static async verifySingleProof(
    document: any,
    proof: DataIntegrityProof,
    options: any
  ): Promise<VerificationResult> {
    try {
      if (!proof.type || !proof.verificationMethod || !proof.proofPurpose || !proof.cryptosuite || !proof.proofValue) {
        throw new ProofError('Proof is missing required properties: type, verificationMethod, proofPurpose, cryptosuite or proofValue');
      }
      let cryptosuiteManager;
      switch (proof.cryptosuite) {
        case 'eddsa-rdfc-2022':
          cryptosuiteManager = EdDSACryptosuiteManager;
          break;
        case 'bbs-2023':
          cryptosuiteManager = BBSCryptosuiteManager;
          break;
        default:
          throw new ProofError(`Unsupported cryptosuite: ${proof.cryptosuite}`);
      }
      const result = await cryptosuiteManager.verifyProof(document, proof, {
        ...options,
        ...(proof.previousProof && { previousProof: proof.previousProof }),
        preserveProof: options.preserveProof
      });
      return result;
    } catch (error: any) {
      return {
        verified: false,
        errors: [`Failed to verify proof: ${error.message}`]
      };
    }
  }

  static async createProof(document: any, options: ProofOptions | ProofOptions[]): Promise<DataIntegrityProof | DataIntegrityProof[]> {
    if (Array.isArray(options)) {
      return this.createProofSet(document, options);
    } else {
      const proof = await this.createSingleProof(document, options);
      return proof;
    }
  }

  static async verifyProof(
    document: any,
    proof: DataIntegrityProof | DataIntegrityProof[],
    options: any
  ): Promise<VerificationResult> {
    if (!Array.isArray(proof)) {
      proof = [proof];
    }

    // Check if it's a proof chain
    const isChain = proof.length > 1 && proof.every((p, i) => {
      if (i === 0) return true;
      const prevProofId = proof[i-1].id;
      return prevProofId && (p.previousProof === prevProofId || 
             (Array.isArray(p.previousProof) && p.previousProof.includes(prevProofId)));
    });
    if (isChain) {
      return this.verifyProofChain(document, proof, options);
    }
    return this.verifyProofSet(document, proof, options);
  }

  static async createProofSet(document: any, proofs: ProofOptions[]): Promise<DataIntegrityProof[]> {
    const proofSet: DataIntegrityProof[] = [];
    for (const proofOptions of proofs) {
      const proof = await this.createSingleProof(document, proofOptions);
      proofSet.push(proof);
    }
    return proofSet;
  }

  static async createProofChain(document: any, proofs: ProofOptions[]): Promise<DataIntegrityProof[]> {
    const proofChain: DataIntegrityProof[] = [];
    let previousProofId: string | undefined;

    for (const proofOptions of proofs) {
      const proof = await this.createSingleProof(document, {
        ...proofOptions,
        previousProof: previousProofId
      });

      if (!proof.id) {
        proof.id = `urn:uuid:${crypto.randomUUID()}`;
      }

      proofChain.push(proof);
      previousProofId = proof.id;
    }

    return proofChain;
  }

  static async verifyProofSet(document: any, proofs: DataIntegrityProof[], options: any): Promise<VerificationResult> {
    const results: VerificationResult[] = [];
    for (const proof of proofs) {
      const result = await this.verifySingleProof(document, proof, options);
      results.push(result);
      if (!result.verified) {
        return {
          verified: false,
          errors: result.errors
        };
      }
    }
    return {
      verified: true,
      errors: []
    };
  }

  static async verifyProofChain(
    document: any,
    proofs: DataIntegrityProof[],
    options: any
  ): Promise<VerificationResult> {
    let verificationResults: VerificationResult[] = [];
    for (const proof of proofs) {
      let matchingProofs: DataIntegrityProof[] = [];
      if (proof.previousProof) {
        if (typeof proof.previousProof === 'string') {
          const matchingProof = proofs.find(p => p.id === proof.previousProof);
          if (matchingProof) matchingProofs.push(matchingProof);
        } else if (Array.isArray(proof.previousProof)) {
          matchingProofs = proofs.filter(p => p.id && proof.previousProof!.includes(p.id));
        }

        const expectedCount = Array.isArray(proof.previousProof) ? proof.previousProof.length : 1;
        if (matchingProofs.length !== expectedCount) {
          return { verified: false, errors: ['One or more previous proofs not found'] };
        }
      }

      let inputDocument = { ...document };
      if (matchingProofs.length > 0) {
        inputDocument.proof = matchingProofs.length === 1 ? matchingProofs[0] : matchingProofs;
      }
      const result = await this.verifySingleProof(inputDocument, proof, { ...options, preserveProof: true });
      verificationResults.push(result);
      if (!result.verified) {
        console.error(`Proof verification failed for: ${proof.id}`);
        return result;
      }
    }

    let successfulVerificationResults = verificationResults.filter(r => r.verified);
    if (successfulVerificationResults.length !== proofs.length) {
      console.warn(`Not all proofs in the chain were verified. Verified: ${successfulVerificationResults.length}, Total: ${proofs.length}`);
      return { verified: false, errors: ['Not all proofs in the chain were verified'] };
    }

    return { verified: true, errors: [] };
  }
}
