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

/**
 * BBS+ selective disclosure (`bbs-2023`) is parked. The cryptosuite let a
 * holder derive a proof that hid `validUntil` / `credentialStatus` and still
 * verified (#591), and the base-proof pointer contract needed to close that
 * cannot be retrofitted onto already-issued credentials. Rather than ship a
 * verifier that has to guess which disclosures a proof was allowed to omit,
 * the suite is disabled end to end: nothing signs, derives, or verifies it.
 *
 * Both dispatch points below name the suite explicitly so a `bbs-2023` proof
 * fails as "disabled", not as an unknown string a caller might think is a
 * typo. The rejection is the whole contract: a BBS proof is never `verified`.
 */
export const BBS_CRYPTOSUITE = 'bbs-2023';
export const BBS_DISABLED_MESSAGE =
  'Cryptosuite bbs-2023 is disabled: BBS+ selective disclosure is parked (see onionoriginals/sdk#591). Sign and verify credentials with eddsa-rdfc-2022.';

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
      throw new Error(
        `Unsupported proof type: ${typeof declaredType === 'string' ? declaredType : JSON.stringify(declaredType)}`
      );
    }
    const opts: ProofOptions = { ...options, type: 'DataIntegrityProof' };
    // Fail loudly rather than silently drop caller intent. No code in this
    // SDK creates or verifies a Data Integrity proof chain (issue #604): a
    // caller who supplies `previousProof` would otherwise believe this proof
    // was chained to a prior one when nothing of the sort happened. `created`
    // is different — the cryptosuite layer now honors a caller-supplied
    // value (falling back to the current time), so it does not need the same
    // guard.
    if (opts.previousProof !== undefined) {
      throw new Error(
        'ProofOptions.previousProof is not supported: this SDK does not create or verify Data Integrity proof chains.'
      );
    }
    if (opts.cryptosuite === BBS_CRYPTOSUITE) {
      throw new Error(BBS_DISABLED_MESSAGE);
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
    // Fail closed on the parked suite before the generic guard so the error
    // says why. A base proof and a derived proof both carry this cryptosuite,
    // so neither form can reach a `verified: true` (#591).
    if (proof.cryptosuite === BBS_CRYPTOSUITE) {
      return { verified: false, errors: [BBS_DISABLED_MESSAGE] };
    }
    if (proof.cryptosuite !== 'eddsa-rdfc-2022') {
      return { verified: false, errors: [`Unsupported cryptosuite: ${proof.cryptosuite}`] };
    }
    return await EdDSACryptosuiteManager.verifyProof(document, proof, options);
  }
}

