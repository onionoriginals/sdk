import { EdDSACryptosuiteManager, type DataIntegrityProof } from '../cryptosuites/eddsa';

export interface VerificationResult { verified: boolean; errors?: string[] }

export interface ProofOptions {
  verificationMethod: string;
  proofPurpose: string;
  privateKey?: Uint8Array | string;
  type: 'DataIntegrityProof';
  created?: string;
  cryptosuite: string;
  documentLoader?: (url: string) => Promise<any>;
  previousProof?: string | string[];
  challenge?: string;
  domain?: string;
}

export class DataIntegrityProofManager {
  static async createProof(document: any, options: ProofOptions): Promise<DataIntegrityProof> {
    if (options.cryptosuite !== 'eddsa-rdfc-2022') {
      throw new Error(`Unsupported cryptosuite: ${options.cryptosuite}`);
    }
    return await EdDSACryptosuiteManager.createProof(document, options);
  }

  static async verifyProof(document: any, proof: DataIntegrityProof, options: any): Promise<VerificationResult> {
    if (proof.cryptosuite !== 'eddsa-rdfc-2022') {
      return { verified: false, errors: [`Unsupported cryptosuite: ${proof.cryptosuite}`] };
    }
    return await EdDSACryptosuiteManager.verifyProof(document, proof, options);
  }
}

