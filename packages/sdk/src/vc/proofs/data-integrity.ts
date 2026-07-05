import { EdDSACryptosuiteManager, type DataIntegrityProof } from '../cryptosuites/eddsa.js';

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
    // Runtime guard: ProofOptions types `type` as the literal
    // 'DataIntegrityProof', but callers routinely cast, so enforce it here.
    if ((options as { type?: unknown }).type !== 'DataIntegrityProof') {
      throw new Error(`Unsupported proof type: ${String((options as { type?: unknown }).type)}`);
    }
    if (options.cryptosuite !== 'eddsa-rdfc-2022') {
      throw new Error(`Unsupported cryptosuite: ${options.cryptosuite}`);
    }
    return await EdDSACryptosuiteManager.createProof(document, options);
  }

  static async verifyProof(document: any, proof: DataIntegrityProof, options: any): Promise<VerificationResult> {
    // A Data Integrity proof MUST declare type "DataIntegrityProof"
    // (W3C VC Data Integrity §2.1). Checking only `cryptosuite` would accept
    // proofs claiming a different (or missing) proof type.
    if ((proof as { type?: unknown })?.type !== 'DataIntegrityProof') {
      return { verified: false, errors: [`Unsupported proof type: ${String((proof as { type?: unknown })?.type)}`] };
    }
    if (proof.cryptosuite !== 'eddsa-rdfc-2022') {
      return { verified: false, errors: [`Unsupported cryptosuite: ${proof.cryptosuite}`] };
    }
    return await EdDSACryptosuiteManager.verifyProof(document, proof, options);
  }
}

