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
  /** BBS+ (bbs-2023) base-proof creation: pointers to make mandatory. */
  mandatoryPointers?: string[];
  /** BBS+ (bbs-2023): optional public key (derived from privateKey if omitted). */
  publicKey?: Uint8Array | string;
}

export class DataIntegrityProofManager {
  static async createProof(document: any, options: ProofOptions): Promise<DataIntegrityProof> {
    // Route bbs-2023 through the BBS backend so createProof is symmetric with
    // verifyProof (which already dispatches bbs-2023). Lazily imported to keep
    // the BBS backend out of the eddsa-only path.
    if (options.cryptosuite === 'bbs-2023') {
      const { BBSCryptosuiteManager } = await import('../cryptosuites/bbsCryptosuite.js');
      return await BBSCryptosuiteManager.createProof(document, options);
    }
    if (options.cryptosuite !== 'eddsa-rdfc-2022') {
      throw new Error(`Unsupported cryptosuite: ${options.cryptosuite}`);
    }
    return await EdDSACryptosuiteManager.createProof(document, options);
  }

  static async verifyProof(document: any, proof: DataIntegrityProof, options: any): Promise<VerificationResult> {
    // Route bbs-2023 through the same hardened path as eddsa-rdfc-2022 so
    // Verifier's issuer-binding, proofPurpose, validity-period, and status
    // checks apply to BBS credentials too (issue #315). Dynamically imported,
    // like CredentialManager, to keep the BBS backend lazy.
    if (proof.cryptosuite === 'bbs-2023') {
      const { BBSCryptosuiteManager } = await import('../cryptosuites/bbsCryptosuite.js');
      return await BBSCryptosuiteManager.verifyProof(document, proof, options);
    }
    if (proof.cryptosuite !== 'eddsa-rdfc-2022') {
      return { verified: false, errors: [`Unsupported cryptosuite: ${proof.cryptosuite}`] };
    }
    return await EdDSACryptosuiteManager.verifyProof(document, proof, options);
  }
}

