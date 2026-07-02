import { VerifiableCredential, VerifiablePresentation, BitstringStatusListEntry, MultiSigPolicy } from '../types/index.js';
import type { MultiSigVerificationResult } from '../types/index.js';
import { DIDManager } from '../did/DIDManager.js';
import { createDocumentLoader } from './documentLoader.js';
import { DataIntegrityProofManager } from './proofs/data-integrity.js';
import type { DataIntegrityProof } from './cryptosuites/eddsa.js';
import { StatusListManager } from './StatusListManager.js';

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

      // Bind the signing key to the credential issuer. The proof is verified
      // against whatever key `proof.verificationMethod` resolves to, so without
      // this check an attacker can sign a credential that names a trusted
      // `issuer` with their own key (setting verificationMethod to their own
      // DID) and have it verify — full issuer impersonation. The signing side
      // (Issuer) and the legacy verify path both enforce this binding; the Data
      // Integrity path must too. Mirrors CredentialManager.resolveVerificationMethodMultibase.
      const issuerBinding = this.checkVerificationMethodController(
        (proof as { verificationMethod?: unknown })?.verificationMethod,
        typeof vc.issuer === 'string' ? vc.issuer : (vc.issuer as { id?: string } | undefined)?.id,
        'issuer'
      );
      if (!issuerBinding.verified) {
        return issuerBinding;
      }

      const result = await DataIntegrityProofManager.verifyProof(vc, proof as unknown as DataIntegrityProof, { documentLoader: loader });
      if (!result.verified) {
        return { verified: false, errors: result.errors ?? ['Verification failed'] };
      }

      // Enforce the credential's validity period. A cryptographically valid
      // proof over an expired credential must not verify.
      const validityResult = this.checkValidityPeriod(vc);
      if (!validityResult.verified) {
        return validityResult;
      }

      // Check credential status (revocation/suspension) if requested. Only
      // BitstringStatusListEntry is evaluable by this verifier; unknown
      // status types are ignored (checkCredentialStatus treats them as
      // no-ops), so they must not trip the fail-closed resolver check.
      const statusType = (vc.credentialStatus as BitstringStatusListEntry | undefined)?.type;
      if (options.checkStatus !== false && statusType === 'BitstringStatusListEntry') {
        if (!this.statusListResolver) {
          // Fail closed: the credential declares a status entry but this
          // verifier has no way to check it. Silently returning verified
          // would accept revoked credentials.
          return {
            verified: false,
            errors: [
              'Credential declares credentialStatus but no statusListResolver is configured. ' +
              'Provide a statusListResolver, or pass checkStatus: false to explicitly skip revocation checking.'
            ]
          };
        }
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
   * Enforce that a proof's verification method is controlled by the expected
   * DID subject (the credential `issuer` or the presentation `holder`). The DID
   * that owns the verification method is the portion of the VM id before the
   * fragment. When the expected subject is absent we cannot bind, so we fail
   * closed rather than accept a signature from an arbitrary key.
   */
  private checkVerificationMethodController(
    verificationMethod: unknown,
    expectedSubject: string | undefined,
    subjectLabel: 'issuer' | 'holder'
  ): VerificationResult {
    if (typeof verificationMethod !== 'string' || verificationMethod.length === 0) {
      return { verified: false, errors: ['Proof is missing a verificationMethod'] };
    }
    if (!expectedSubject) {
      return { verified: false, errors: [`Credential is missing an ${subjectLabel} to bind the proof to`] };
    }
    const vmDid = verificationMethod.split('#')[0];
    if (vmDid !== expectedSubject) {
      return {
        verified: false,
        errors: [`Proof verificationMethod (${vmDid}) does not match credential ${subjectLabel} (${expectedSubject})`]
      };
    }
    return { verified: true, errors: [] };
  }

  /**
   * Enforce the credential's validity window: expirationDate/validUntil in
   * the past, or validFrom/issuanceDate in the future, fail verification.
   */
  private checkValidityPeriod(vc: VerifiableCredential): VerificationResult {
    const now = Date.now();
    const doc = vc as unknown as Record<string, unknown>;

    // A present-but-unparseable date fails closed: a signed but malformed
    // expirationDate/validFrom must not bypass the time-window check by
    // being silently treated as absent.
    const invalid: string[] = [];
    const parse = (field: string): number | null => {
      const value = doc[field];
      if (value === undefined || value === null) return null;
      if (typeof value !== 'string') { invalid.push(field); return null; }
      const t = Date.parse(value);
      if (Number.isNaN(t)) { invalid.push(field); return null; }
      return t;
    };

    const expiration = parse('expirationDate');
    const validUntil = parse('validUntil');
    const validFrom = parse('validFrom');
    const issuanceDate = parse('issuanceDate');

    if (invalid.length > 0) {
      return { verified: false, errors: [`Credential has unparseable date field(s): ${invalid.join(', ')}`] };
    }

    for (const [field, t] of [['expirationDate', expiration], ['validUntil', validUntil]] as const) {
      if (t !== null && t < now) {
        return { verified: false, errors: [`Credential expired (${field}: ${String(doc[field])})`] };
      }
    }

    // validFrom (VCDM 2.0) takes precedence; fall back to issuanceDate
    // (VCDM 1.1) as the validity start.
    const startField = validFrom !== null ? 'validFrom' : 'issuanceDate';
    const start = validFrom !== null ? validFrom : issuanceDate;
    if (start !== null && start > now) {
      return { verified: false, errors: [`Credential is not yet valid (${startField}: ${String(doc[startField])})`] };
    }

    return { verified: true, errors: [] };
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

      // Verify each proof, counting each authorized signer at most once so a
      // replicated proof cannot satisfy the threshold on its own.
      const seenSigners = new Set<string>();
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
            // Dedupe only after successful verification: an invalid proof
            // must not consume the signer's slot and suppress a later valid
            // proof from the same signer.
            if (seenSigners.has(vm)) {
              result.errors.push(`Duplicate proof from ${vm} (ignored)`);
              continue;
            }
            seenSigners.add(vm);
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

  async verifyPresentation(
    vp: VerifiablePresentation,
    options: {
      documentLoader?: (iri: string) => Promise<unknown>;
      /** When set, the presentation proof's challenge must match exactly (anti-replay). */
      expectedChallenge?: string;
      /** When set, the presentation proof's domain must match exactly. */
      expectedDomain?: string;
    } = {}
  ): Promise<VerificationResult> {
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

      // Bind the presentation proof to the holder: the key that signs the
      // presentation must be controlled by the DID named as `holder`. Without
      // this an attacker can present a self-signed VP claiming any holder.
      const holderBinding = this.checkVerificationMethodController(
        (proof as { verificationMethod?: unknown })?.verificationMethod,
        typeof vp.holder === 'string' ? vp.holder : (vp.holder as { id?: string } | undefined)?.id,
        'holder'
      );
      if (!holderBinding.verified) {
        return holderBinding;
      }

      // Validate challenge/domain BEFORE signature verification so a replayed
      // presentation with a stale challenge is rejected even when its proof
      // is cryptographically valid.
      const proofRecord = proof as unknown as { challenge?: string; domain?: string };
      if (options.expectedChallenge !== undefined && proofRecord.challenge !== options.expectedChallenge) {
        return { verified: false, errors: ['Presentation challenge mismatch (possible replay)'] };
      }
      if (options.expectedDomain !== undefined && proofRecord.domain !== options.expectedDomain) {
        return { verified: false, errors: ['Presentation domain mismatch'] };
      }

      const result = await DataIntegrityProofManager.verifyProof(vp, proof as unknown as DataIntegrityProof, { documentLoader: loader });
      return result.verified ? { verified: true, errors: [] } : { verified: false, errors: result.errors ?? ['Verification failed'] };
    } catch (e) {
      const error = e as Error;
      return { verified: false, errors: [error?.message ?? 'Unknown error in verifyPresentation'] };
    }
  }
}

