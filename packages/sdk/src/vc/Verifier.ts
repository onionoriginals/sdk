import { VerifiableCredential, VerifiablePresentation, BitstringStatusListEntry, BitstringStatusListSubject, MultiSigPolicy } from '../types';
import type { MultiSigVerificationResult } from '../types';
import { DIDManager } from '../did/DIDManager';
import { createDocumentLoader } from './documentLoader';
import { DataIntegrityProofManager } from './proofs/data-integrity';
import type { DataIntegrityProof } from './cryptosuites/eddsa';
import { StatusListManager } from './StatusListManager';

export type VerificationResult = { verified: boolean; errors: string[] };

/**
 * Optional resolver for fetching status list credentials during verification.
 * Implementations should fetch the credential from the given URL and return it.
 */
export type StatusListResolver = (url: string) => Promise<VerifiableCredential | null>;

export class Verifier {
  private statusListResolver?: StatusListResolver;

  constructor(private didManager: DIDManager, options?: { statusListResolver?: StatusListResolver }) {
    this.statusListResolver = options?.statusListResolver;
  }

  async verifyCredential(vc: VerifiableCredential, options: { documentLoader?: (iri: string) => Promise<unknown>; checkStatus?: boolean } = {}): Promise<VerificationResult> {
    try {
      if (!vc || !vc['@context'] || !vc.type) throw new Error('Invalid credential');
      if (!vc.proof) throw new Error('Credential has no proof');
      const loader = options.documentLoader || createDocumentLoader(this.didManager);
      const vcContext = vc['@context'];
      const ctxs: string[] = Array.isArray(vcContext) ? vcContext.filter((c): c is string => typeof c === 'string') : [String(vcContext)];
      for (const c of ctxs) await loader(c);
      const proofValue = vc.proof;
      const proof = Array.isArray(proofValue) ? proofValue[0] : proofValue;
      const result = await DataIntegrityProofManager.verifyProof(vc, proof as unknown as DataIntegrityProof, { documentLoader: loader });
      if (!result.verified) {
        return { verified: false, errors: result.errors ?? ['Verification failed'] };
      }

      // Check credential status (revocation/suspension) if requested
      if (options.checkStatus !== false && vc.credentialStatus && this.statusListResolver) {
        const statusResult = await this.checkCredentialStatus(vc);
        if (!statusResult.verified) {
          return statusResult;
        }
      }

      return { verified: true, errors: [] };
    } catch (e) {
      const error = e as Error;
      return { verified: false, errors: [error?.message ?? 'Unknown error in verifyCredential'] };
    }
  }

  /**
   * Check a credential's revocation/suspension status against its status list.
   * Requires a statusListResolver to be configured.
   */
  async checkCredentialStatus(vc: VerifiableCredential): Promise<VerificationResult> {
    const status = vc.credentialStatus as BitstringStatusListEntry | undefined;
    if (!status || status.type !== 'BitstringStatusListEntry') {
      return { verified: true, errors: [] };
    }

    if (!this.statusListResolver) {
      return { verified: false, errors: ['No status list resolver configured'] };
    }

    const statusListVC = await this.statusListResolver(status.statusListCredential);
    if (!statusListVC) {
      return { verified: false, errors: [`Could not resolve status list credential: ${status.statusListCredential}`] };
    }

    const manager = new StatusListManager();
    try {
      const checkResult = manager.checkStatus(status, statusListVC);
      if (checkResult.isSet) {
        const action = checkResult.statusPurpose === 'revocation' ? 'revoked' : 'suspended';
        return { verified: false, errors: [`Credential has been ${action}`] };
      }
      return { verified: true, errors: [] };
    } catch (e) {
      const error = e as Error;
      return { verified: false, errors: [`Status check failed: ${error.message}`] };
    }
  }

  /**
   * Verify a credential with multi-sig threshold requirements.
   * Checks all proofs and ensures the threshold is met.
   *
   * @param vc - The credential with multiple proofs
   * @param policy - The multi-sig policy defining threshold requirements
   * @param options - Optional document loader
   * @returns Multi-sig verification result with threshold details
   */
  async verifyCredentialMultiSig(
    vc: VerifiableCredential,
    policy: MultiSigPolicy,
    options: { documentLoader?: (iri: string) => Promise<unknown> } = {}
  ): Promise<MultiSigVerificationResult> {
    const result: MultiSigVerificationResult = {
      verified: false,
      policy,
      validSignatures: 0,
      validSigners: [],
      invalidSigners: [],
      errors: [],
    };

    try {
      if (!vc || !vc['@context'] || !vc.type) {
        result.errors.push('Invalid credential');
        return result;
      }
      if (!vc.proof) {
        result.errors.push('Credential has no proofs');
        return result;
      }

      const proofs = Array.isArray(vc.proof) ? vc.proof : [vc.proof];
      const loader = options.documentLoader || createDocumentLoader(this.didManager);

      // Load contexts
      const vcContext = vc['@context'];
      const ctxs: string[] = Array.isArray(vcContext)
        ? vcContext.filter((c): c is string => typeof c === 'string')
        : [String(vcContext)];
      for (const c of ctxs) await loader(c);

      // Verify each proof
      for (const proof of proofs) {
        const vm = proof.verificationMethod;
        if (!policy.signerVerificationMethods.includes(vm)) {
          result.invalidSigners.push(vm);
          result.errors.push(`Signer ${vm} is not authorized by the policy`);
          continue;
        }

        try {
          const proofResult = await DataIntegrityProofManager.verifyProof(
            vc,
            proof as unknown as DataIntegrityProof,
            { documentLoader: loader }
          );
          if (proofResult.verified) {
            result.validSignatures++;
            result.validSigners.push(vm);
          } else {
            result.invalidSigners.push(vm);
            result.errors.push(`Invalid signature from ${vm}`);
          }
        } catch (e) {
          result.invalidSigners.push(vm);
          result.errors.push(`Verification error for ${vm}: ${(e as Error).message}`);
        }
      }

      // Check threshold
      result.verified = result.validSignatures >= policy.required;
      if (!result.verified) {
        result.errors.push(
          `Threshold not met: ${result.validSignatures}/${policy.required} valid signatures`
        );
      }

      // Check timelock
      if (policy.timelockStart || policy.timelockEnd) {
        const now = new Date();
        if (policy.timelockStart && now < new Date(policy.timelockStart)) {
          result.verified = false;
          result.timelockValid = false;
          result.errors.push('Timelock has not started yet');
        } else if (policy.timelockEnd && now > new Date(policy.timelockEnd)) {
          result.verified = false;
          result.timelockValid = false;
          result.errors.push('Timelock has expired');
        } else {
          result.timelockValid = true;
        }
      }
    } catch (e) {
      result.errors.push((e as Error).message || 'Unknown error in multi-sig verification');
    }

    return result;
  }

  async verifyPresentation(vp: VerifiablePresentation, options: { documentLoader?: (iri: string) => Promise<unknown> } = {}): Promise<VerificationResult> {
    try {
      if (!vp || !vp['@context'] || !vp.type) throw new Error('Invalid presentation');
      if (!vp.proof) throw new Error('Presentation has no proof');
      const loader = options.documentLoader || createDocumentLoader(this.didManager);
      const vpContext = vp['@context'];
      const ctxs: string[] = Array.isArray(vpContext) ? vpContext.filter((c): c is string => typeof c === 'string') : [String(vpContext)];
      for (const c of ctxs) await loader(c);
      if (vp.verifiableCredential) {
        for (const c of vp.verifiableCredential) {
          const res = await this.verifyCredential(c, { documentLoader: loader });
          if (!res.verified) return res;
        }
      }
      const proofValue = vp.proof;
      const proof = Array.isArray(proofValue) ? proofValue[0] : proofValue;
      const result = await DataIntegrityProofManager.verifyProof(vp, proof as unknown as DataIntegrityProof, { documentLoader: loader });
      return result.verified ? { verified: true, errors: [] } : { verified: false, errors: result.errors ?? ['Verification failed'] };
    } catch (e) {
      const error = e as Error;
      return { verified: false, errors: [error?.message ?? 'Unknown error in verifyPresentation'] };
    }
  }
}

