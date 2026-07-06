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
    // Runtime guard: ProofOptions types `type` as the literal
    // 'DataIntegrityProof', but callers routinely cast, so enforce it here.
    // A MISSING type is defaulted rather than rejected — the cryptosuite
    // managers have always synthesized type: 'DataIntegrityProof' on the
    // created proof, so callers omitting `type` are valid. Only a WRONG
    // explicit type is an error. (verifyProof stays strict: it must validate
    // the actual proof's declared type.)
    const declaredType = (options as { type?: unknown }).type;
    if (declaredType !== undefined && declaredType !== 'DataIntegrityProof') {
      throw new Error(`Unsupported proof type: ${String(declaredType)}`);
    }
    const opts: ProofOptions = { ...options, type: 'DataIntegrityProof' };
    // Route bbs-2023 through the BBS backend so createProof is symmetric with
    // verifyProof (which already dispatches bbs-2023). Lazily imported to keep
    // the BBS backend out of the eddsa-only path.
    if (opts.cryptosuite === 'bbs-2023') {
      const { BBSCryptosuiteManager } = await import('../cryptosuites/bbsCryptosuite.js');
      return await BBSCryptosuiteManager.createProof(document, opts);
    }
    if (opts.cryptosuite !== 'eddsa-rdfc-2022') {
      throw new Error(`Unsupported cryptosuite: ${opts.cryptosuite}`);
    }
    return await EdDSACryptosuiteManager.createProof(document, opts);
  }

  static async verifyProof(document: any, proof: DataIntegrityProof, options: any): Promise<VerificationResult> {
    // A Data Integrity proof MUST declare type "DataIntegrityProof"
    // (W3C VC Data Integrity §2.1). Checking only `cryptosuite` would accept
    // proofs claiming a different (or missing) proof type.
    if ((proof as { type?: unknown })?.type !== 'DataIntegrityProof') {
      return { verified: false, errors: [`Unsupported proof type: ${String((proof as { type?: unknown })?.type)}`] };
    }
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

