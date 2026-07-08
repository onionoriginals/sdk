import { VerifiableCredential, VerifiablePresentation, BitstringStatusListEntry, MultiSigPolicy } from '../types/index.js';
import type { MultiSigVerificationResult } from '../types/index.js';
import { describeMultiSigProofFailure } from './multiSigProofFormat.js';
import { DIDManager } from '../did/DIDManager.js';
import { createDocumentLoader } from './documentLoader.js';
import { DataIntegrityProofManager } from './proofs/data-integrity.js';
import type { DataIntegrityProof } from './cryptosuites/eddsa.js';
import { StatusListManager } from './StatusListManager.js';
import { validateStatusListCredentialTrust } from './statusListTrust.js';

export type VerificationResult = { verified: boolean; errors: string[] };

/**
 * Enforce a credential's validity window: expirationDate/validUntil in the past,
 * or validFrom/issuanceDate in the future, fail. A present-but-unparseable date
 * fails closed. Shared between the Data Integrity and legacy verification paths
 * so both reject expired credentials identically.
 */
export function checkCredentialValidityPeriod(vc: VerifiableCredential): VerificationResult {
  const now = Date.now();
  const doc = vc as unknown as Record<string, unknown>;

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

  const startField = validFrom !== null ? 'validFrom' : 'issuanceDate';
  const start = validFrom !== null ? validFrom : issuanceDate;
  if (start !== null && start > now) {
    return { verified: false, errors: [`Credential is not yet valid (${startField}: ${String(doc[startField])})`] };
  }

  return { verified: true, errors: [] };
}

/**
 * Optional resolver for fetching status list credentials during verification.
 * Implementations should fetch the credential from the given URL and return it.
 */
export type StatusListResolver = (url: string) => Promise<VerifiableCredential | null>;

export class Verifier {
  private statusListResolver?: StatusListResolver;

  /**
   * Memoizes the expensive proof verification of resolved status list
   * credentials (issue #304). Verifying N credentials that share one status
   * list (the normal deployment — one list covers up to 131,072 credentials)
   * otherwise re-runs RDF canonicalization + issuer DID resolution + signature
   * verification of the same (often tens-of-KB) document N times.
   *
   * Security-critical keying (see the #304 self-review): the cache MUST key on
   * the FULL resolved document, not on `id + proofValue`. The stored verdict is
   * a property of the entire (body + proof) credential; the caller reads the
   * revocation bits from the PRESENTED document. Keying on `id + proofValue`
   * let a poisoned resolver / holder swap a forged all-zeros body under a
   * legitimate `id + proofValue` (both are public) and reuse a cached
   * "verified" verdict without the proof ever being checked against that body —
   * a revocation bypass (#238). A full-document key collides only on
   * byte-identical content, so reusing the verdict is sound.
   *
   * Only VERIFIED (`true`) verdicts are cached: a `false` result may be a
   * transient issuer-DID-resolution failure, and caching it would fail-closed a
   * legitimate list until eviction. A short TTL bounds staleness (e.g. a signer
   * key revoked after a positive verdict was cached).
   */
  private statusListProofCache = new Map<string, { at: number; result: VerificationResult }>();
  private static readonly STATUS_LIST_PROOF_CACHE_MAX = 256;
  private static readonly STATUS_LIST_PROOF_CACHE_TTL_MS = 5 * 60 * 1000;

  constructor(private didManager: DIDManager, options?: { statusListResolver?: StatusListResolver }) {
    this.statusListResolver = options?.statusListResolver;
  }

  async verifyCredential(vc: VerifiableCredential, options: {
    documentLoader?: (iri: string) => Promise<unknown>;
    checkStatus?: boolean;
    /** Forwarded to the proof cryptosuite (used by bbs-2023 anti-replay/binding). */
    expectedChallenge?: string;
    expectedDomain?: string;
    expectedPresentationHeader?: Uint8Array;
    expectedController?: string;
  } = {}): Promise<VerificationResult> {
    try {
      if (!vc || !vc['@context'] || !vc.type) throw new Error('Invalid credential');
      if (!vc.proof) throw new Error('Credential has no proof');
      const loader = options.documentLoader || createDocumentLoader(this.didManager);
      const vcContext = vc['@context'];
      // Only string contexts need pre-loading into the loader cache; jsonld
      // handles inline-object contexts natively. A single inline-object
      // `@context` must NOT be String()-ified to "[object Object]" (which the
      // loader can't resolve → spurious verified:false). Normalize to an array
      // and keep only the string entries in both the array and scalar cases.
      const ctxs: string[] = (Array.isArray(vcContext) ? vcContext : [vcContext])
        .filter((c): c is string => typeof c === 'string');
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

      // A credential proof must be an assertion. proofPurpose is bound into
      // the signed proof-config hash, so it cannot be flipped after signing —
      // but without this check a credential signed for a different purpose
      // (e.g. `authentication`) would still verify as a valid assertion.
      const purposeCheck = await this.checkProofPurpose(proof, 'assertionMethod');
      if (!purposeCheck.verified) {
        return purposeCheck;
      }

      const result = await DataIntegrityProofManager.verifyProof(vc, proof as unknown as DataIntegrityProof, {
        documentLoader: loader,
        expectedChallenge: options.expectedChallenge,
        expectedDomain: options.expectedDomain,
        expectedPresentationHeader: options.expectedPresentationHeader,
        expectedController: options.expectedController
      });
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
   * Enforce that the proof was created for the contextually required purpose:
   * `assertionMethod` for credentials, `authentication` for presentations.
   * When the verification method's DID document is resolvable and declares the
   * corresponding relationship, the verification method must also be listed
   * (by reference or embedded) under that relationship. Unresolvable DIDs
   * skip the relationship check — the key itself is still authenticated by
   * the controller binding plus signature verification.
   */
  private async checkProofPurpose(
    proof: unknown,
    expectedPurpose: 'assertionMethod' | 'authentication'
  ): Promise<VerificationResult> {
    const proofRecord = proof as { proofPurpose?: unknown; verificationMethod?: unknown };
    const purpose = proofRecord?.proofPurpose;
    if (purpose !== expectedPurpose) {
      return {
        verified: false,
        errors: [`Proof proofPurpose (${String(purpose)}) does not match the required purpose (${expectedPurpose})`]
      };
    }

    const verificationMethod = proofRecord?.verificationMethod;
    if (typeof verificationMethod !== 'string') {
      return { verified: false, errors: ['Proof is missing a verificationMethod'] };
    }

    const vmDid = verificationMethod.split('#')[0];
    let didDoc: { [k: string]: unknown } | null = null;
    try {
      didDoc = (await this.didManager.resolveDID(vmDid)) as { [k: string]: unknown } | null;
    } catch {
      didDoc = null;
    }
    if (!didDoc) {
      return { verified: true, errors: [] };
    }

    const relationship = didDoc[expectedPurpose];
    if (!Array.isArray(relationship)) {
      // Document resolves but declares no such relationship: the key is not
      // authorized for this purpose.
      return {
        verified: false,
        errors: [`DID document for ${vmDid} does not authorize any key for ${expectedPurpose}`]
      };
    }

    const fragment = verificationMethod.split('#')[1];
    const matches = (id: unknown): boolean =>
      typeof id === 'string' &&
      (id === verificationMethod || (fragment !== undefined && id.split('#')[1] === fragment));
    const authorized = relationship.some((entry) =>
      typeof entry === 'string' ? matches(entry) : matches((entry as { id?: unknown })?.id)
    );
    if (!authorized) {
      return {
        verified: false,
        errors: [`Verification method ${verificationMethod} is not authorized for ${expectedPurpose} in ${vmDid}`]
      };
    }
    return { verified: true, errors: [] };
  }

  /**
   * Enforce the credential's validity window (delegates to the shared
   * checkCredentialValidityPeriod so the legacy verify path stays in sync).
   */
  private checkValidityPeriod(vc: VerifiableCredential): VerificationResult {
    return checkCredentialValidityPeriod(vc);
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

    // The status list credential itself must be trustworthy before its bits
    // decide revocation. Without these checks a holder (or a poisoned
    // resolver channel) can supply a fabricated all-zeros list and bypass
    // revocation entirely (issue #238). Per the W3C Bitstring Status List
    // algorithm the verifier must validate the status list credential.
    const trust = await this.validateStatusListCredential(vc, status, statusListVC);
    if (!trust.verified) {
      return trust;
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
   * Trust checks for a resolved status list credential (issue #238), shared
   * with CredentialManager.verifyCredentialWithStatus via
   * validateStatusListCredentialTrust (issue #301). The list's own proof is
   * verified with checkStatus: false because the list's own status (if any)
   * is out of scope here and would recurse.
   */
  private async validateStatusListCredential(
    vc: VerifiableCredential,
    entry: BitstringStatusListEntry,
    statusListVC: VerifiableCredential
  ): Promise<VerificationResult> {
    return validateStatusListCredentialTrust(vc, entry, statusListVC, (listVC) =>
      this.verifyStatusListProofCached(listVC)
    );
  }

  /**
   * Verify a status list credential's own proof, memoized on the FULL resolved
   * document so repeated status checks against the same immutable list don't
   * re-run the expensive canonicalization + signature verification (issue
   * #304). Only the list-only proof verification is cached; the id-match and
   * issuer-equality trust checks (which depend on the credential being checked)
   * still run every call in validateStatusListCredentialTrust.
   */
  private async verifyStatusListProofCached(listVC: VerifiableCredential): Promise<VerificationResult> {
    const key = this.statusListCacheKey(listVC);
    if (key !== null) {
      const cached = this.statusListProofCache.get(key);
      if (cached) {
        if (Date.now() - cached.at < Verifier.STATUS_LIST_PROOF_CACHE_TTL_MS) {
          return cached.result;
        }
        this.statusListProofCache.delete(key); // expired
      }
    }
    const result = await this.verifyCredential(listVC, { checkStatus: false });
    // Cache ONLY verified lists (see the field docstring): a false verdict may
    // be a transient issuer-resolution failure, and the document key already
    // guarantees a cached true corresponds to this exact body.
    if (key !== null && result.verified) {
      if (this.statusListProofCache.size >= Verifier.STATUS_LIST_PROOF_CACHE_MAX) {
        const oldest = this.statusListProofCache.keys().next().value;
        if (oldest !== undefined) this.statusListProofCache.delete(oldest);
      }
      this.statusListProofCache.set(key, { at: Date.now(), result });
    }
    return result;
  }

  /**
   * Cache key for a resolved status list credential: a serialization of the
   * ENTIRE document. Two documents collide only when byte-identical, so a
   * cached verdict is only ever reused for the exact body it was computed over
   * -- a forged body (even with a matching id/proofValue) serializes
   * differently and is re-verified. Returns null if the credential is not
   * serializable (then it is never cached).
   */
  private statusListCacheKey(listVC: VerifiableCredential): string | null {
    try {
      return JSON.stringify(listVC);
    } catch {
      return null;
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

      // Verify the proofs concurrently, then account for them in a
      // deterministic post-collection pass (issue #305). The independent
      // per-proof verifications — RDF canonicalization + a possibly-networked
      // signer DID resolution — previously ran strictly in sequence, so
      // wall-clock latency was the SUM of the signer resolutions instead of
      // the MAX. The shared `loader` (built once above) is reused across all
      // proofs, and the seen-signer dedupe / threshold accounting runs below
      // over results in original order, so the outcome is identical and
      // order-independent. Only authorized, correct-purpose proofs incur the
      // expensive verification, exactly as the sequential path did.
      const evaluations = await Promise.all(proofs.map(async (proof) => {
        const vm = proof.verificationMethod;
        if (!policy.signerVerificationMethods.includes(vm)) {
          return { kind: 'unauthorized' as const, vm };
        }
        // A multi-sig member proof is an ASSERTION (issuance assent). Without
        // this check, a signature an authorized signer produced for another
        // purpose (e.g. `authentication`) would count toward the assertion
        // threshold — cross-purpose signature reuse. proofPurpose is bound
        // into the signed proof-config hash, so it cannot be flipped after
        // signing; rejecting the wrong purpose here refuses the reuse.
        if ((proof as { proofPurpose?: unknown }).proofPurpose !== 'assertionMethod') {
          return { kind: 'wrong-purpose' as const, vm, proof };
        }
        try {
          // Every proof this SDK emits is a Data Integrity eddsa-rdfc-2022
          // proof; there is no legacy proof format. Anything else fails
          // closed inside DataIntegrityProofManager.
          const proofResult = await DataIntegrityProofManager.verifyProof(
            vc,
            proof as unknown as DataIntegrityProof,
            { documentLoader: loader }
          );
          return { kind: proofResult.verified === true ? ('verified' as const) : ('invalid' as const), vm, proof };
        } catch (e) {
          return { kind: 'error' as const, vm, error: (e as Error).message };
        }
      }));

      const seenSigners = new Set<string>();
      for (const ev of evaluations) {
        const vm = ev.vm;
        if (ev.kind === 'unauthorized') {
          result.invalidSigners.push(vm);
          result.errors.push(`Signer ${vm} is not authorized by the policy`);
        } else if (ev.kind === 'wrong-purpose') {
          result.invalidSigners.push(vm);
          result.errors.push(`Proof from ${vm} has proofPurpose ${String((ev.proof as { proofPurpose?: unknown }).proofPurpose)}, expected assertionMethod`);
        } else if (ev.kind === 'verified') {
          // Dedupe only after successful verification: an invalid proof must
          // not consume the signer's slot and suppress a later valid proof
          // from the same signer.
          if (seenSigners.has(vm)) {
            result.errors.push(`Duplicate proof from ${vm} (ignored)`);
            continue;
          }
          seenSigners.add(vm);
          result.validSignatures++;
          result.validSigners.push(vm);
        } else if (ev.kind === 'invalid') {
          result.invalidSigners.push(vm);
          // Distinguish a legacy/unsupported proof format from a genuine bad
          // signature (issue #306).
          result.errors.push(describeMultiSigProofFailure(ev.proof, vm));
        } else {
          result.invalidSigners.push(vm);
          result.errors.push(`Verification error for ${vm}: ${ev.error}`);
        }
      }

      // Check threshold
      result.verified = result.validSignatures >= policy.required;
      if (!result.verified) {
        result.errors.push(
          `Threshold not met: ${result.validSignatures}/${policy.required} valid signatures`
        );
      }

      // Enforce the credential's validity window. A valid m-of-n proof set
      // over an expired (or not-yet-valid) credential must not verify — the
      // single-sig path and MultiSigManager.verifyMultiSig both enforce this
      // window; skipping it here let multi-sig credentials verified through
      // the Verifier bypass expiration entirely (issue #340).
      const validity = checkCredentialValidityPeriod(vc);
      if (!validity.verified) {
        result.verified = false;
        result.errors.push(...validity.errors);
      }

      // Enforce revocation. When this verifier has a status list resolver,
      // check the declared status like the single-sig path does; without one,
      // fail closed on a declared BitstringStatusListEntry rather than
      // silently accepting a possibly-revoked credential (issue #340).
      const statusType = (vc.credentialStatus as BitstringStatusListEntry | undefined)?.type;
      if (statusType === 'BitstringStatusListEntry') {
        if (this.statusListResolver) {
          const statusResult = await this.checkCredentialStatus(vc);
          if (!statusResult.verified) {
            result.verified = false;
            result.errors.push(...statusResult.errors);
          }
        } else {
          result.verified = false;
          result.errors.push(
            'Credential declares credentialStatus but no statusListResolver is configured. ' +
            'Provide a statusListResolver to check revocation for multi-sig credentials.'
          );
        }
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

      // A presentation proof must be an authentication by the holder, not a
      // re-used assertion proof.
      const purposeCheck = await this.checkProofPurpose(proof, 'authentication');
      if (!purposeCheck.verified) {
        return purposeCheck;
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

