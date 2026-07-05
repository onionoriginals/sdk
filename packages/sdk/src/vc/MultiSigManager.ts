import type {
  VerifiableCredential,
  Proof,
  ExternalSigner,
  MultiSigPolicy,
  MultiSigSignOptions,
  MultiSigVerificationResult,
  MultiSigSession,
  SignatureContribution,
  EscrowPolicy,
  CorporatePolicy,
} from '../types/index.js';
import type { OriginalsConfig } from '../types/common.js';
import type { DIDManager } from '../did/DIDManager.js';
import { checkCredentialValidityPeriod } from './Verifier.js';
import { withSecuringContext } from './Issuer.js';
import { DataIntegrityProofManager } from './proofs/data-integrity.js';
import { createDocumentLoader } from './documentLoader.js';
import type { DataIntegrityProof } from './cryptosuites/eddsa.js';

/**
 * MultiSigManager handles m-of-n multi-signature operations for verifiable credentials.
 *
 * Supports:
 * - Basic m-of-n threshold signing and verification
 * - Timelock constraints (signatures valid only within a time window)
 * - Escrow policies (third-party release authority)
 * - Corporate policies (role-based mandatory signatures)
 * - Async signature collection via sessions
 */
export class MultiSigManager {
  private sessions: Map<string, MultiSigSession> = new Map();

  /**
   * @param didManager - Enables resolution of non-did:key signer verification
   *   methods (did:webvh/did:btco/did:peer) and verification of
   *   `eddsa-rdfc-2022` (Data Integrity) proofs. Without it, only did:key
   *   signers with legacy (cryptosuite-less) proofs can be verified.
   */
  constructor(private config: OriginalsConfig, private didManager?: DIDManager) {}

  /**
   * Validate a multi-sig policy for correctness.
   * @throws Error if the policy is invalid
   */
  validatePolicy(policy: MultiSigPolicy): void {
    if (policy.required < 1) {
      throw new Error('MultiSig policy requires at least 1 signature (required must be >= 1)');
    }
    if (policy.total < 1) {
      throw new Error('MultiSig policy requires at least 1 signer (total must be >= 1)');
    }
    if (policy.required > policy.total) {
      throw new Error(
        `MultiSig threshold ${policy.required}-of-${policy.total} is invalid: required cannot exceed total`
      );
    }
    if (policy.signerVerificationMethods.length !== policy.total) {
      throw new Error(
        `MultiSig policy has ${policy.signerVerificationMethods.length} signer verification methods but total is ${policy.total}`
      );
    }
    const uniqueVMs = new Set(policy.signerVerificationMethods);
    if (uniqueVMs.size !== policy.signerVerificationMethods.length) {
      throw new Error('MultiSig policy contains duplicate signer verification methods');
    }

    if (policy.timelockStart && policy.timelockEnd) {
      const start = new Date(policy.timelockStart);
      const end = new Date(policy.timelockEnd);
      if (start >= end) {
        throw new Error('MultiSig timelock start must be before end');
      }
    }
  }

  /**
   * Validate an escrow policy.
   * @throws Error if the escrow policy is invalid
   */
  validateEscrowPolicy(policy: EscrowPolicy): void {
    this.validatePolicy(policy);
    if (!policy.escrowAgent) {
      throw new Error('Escrow policy must specify an escrow agent verification method');
    }
    if (!policy.releaseConditions) {
      throw new Error('Escrow policy must specify release conditions');
    }
    if (policy.escrowSignatureRequired && !policy.signerVerificationMethods.includes(policy.escrowAgent)) {
      throw new Error(
        'Escrow agent must be in signerVerificationMethods when escrowSignatureRequired is true'
      );
    }
  }

  /**
   * Validate a corporate policy.
   * @throws Error if the corporate policy is invalid
   */
  validateCorporatePolicy(policy: CorporatePolicy): void {
    this.validatePolicy(policy);
    if (!policy.roles || policy.roles.size === 0) {
      throw new Error('Corporate policy must assign at least one role');
    }
    if (policy.mandatoryRoles) {
      const assignedRoles = new Set(policy.roles.values());
      for (const role of policy.mandatoryRoles) {
        if (!assignedRoles.has(role)) {
          throw new Error(`Mandatory role "${role}" is not assigned to any signer`);
        }
      }
    }
  }

  /**
   * Check if a timelock constraint is currently valid.
   */
  isTimelockValid(policy: MultiSigPolicy, now: Date = new Date()): boolean {
    if (policy.timelockStart) {
      const start = new Date(policy.timelockStart);
      if (now < start) return false;
    }
    if (policy.timelockEnd) {
      const end = new Date(policy.timelockEnd);
      if (now > end) return false;
    }
    return true;
  }

  /**
   * Sign a credential with multiple signers to meet a threshold policy.
   * All required signatures are collected synchronously.
   *
   * @param credential - The unsigned credential to sign
   * @param options - Signing options including policy and keys
   * @returns The credential with multiple proofs attached
   */
  async signCredentialMultiSig(
    inputCredential: VerifiableCredential,
    options: MultiSigSignOptions
  ): Promise<VerifiableCredential> {
    const { policy, privateKeys, externalSigners } = options;
    this.validatePolicy(policy);

    if (!this.isTimelockValid(policy)) {
      throw new Error('MultiSig signing is outside the allowed timelock window');
    }

    // Data Integrity proofs are canonicalized in safe mode: a plain VCDM 1.1
    // credential (no data-integrity/v2 context) would fail with a
    // 'Safe mode validation error' on the proof config's DataIntegrityProof/
    // cryptosuite terms. Mirror Issuer.issueCredential and add the securing
    // context ONCE, so all parallel proofs sign — and the returned credential
    // is verified over — identical bytes.
    const credential = { ...inputCredential, '@context': withSecuringContext(inputCredential['@context']) };

    const availableSigners: string[] = [];
    if (privateKeys) {
      for (const vm of privateKeys.keys()) availableSigners.push(vm);
    }
    if (externalSigners) {
      for (const vm of externalSigners.keys()) availableSigners.push(vm);
    }

    // Filter to only authorized signers
    const authorizedAvailable = availableSigners.filter(
      vm => policy.signerVerificationMethods.includes(vm)
    );

    if (authorizedAvailable.length < policy.required) {
      throw new Error(
        `Not enough authorized signers available: have ${authorizedAvailable.length}, need ${policy.required}`
      );
    }

    // Collect proofs from the first `required` authorized signers
    const proofs: Proof[] = [];
    const signersUsed = authorizedAvailable.slice(0, policy.required);

    for (const vm of signersUsed) {
      let proof: Proof;
      if (externalSigners?.has(vm)) {
        proof = await this.signWithExternalSigner(credential, externalSigners.get(vm)!, vm);
      } else if (privateKeys?.has(vm)) {
        proof = await this.signWithPrivateKey(credential, privateKeys.get(vm)!, vm);
      } else {
        throw new Error(`No key or signer available for ${vm}`);
      }
      proofs.push(proof);
    }

    return { ...credential, proof: proofs };
  }

  /**
   * Verify a multi-sig credential against a policy.
   *
   * @param credential - The credential with multiple proofs
   * @param policy - The policy to verify against
   * @returns Detailed verification result
   */
  async verifyMultiSig(
    credential: VerifiableCredential,
    policy: MultiSigPolicy
  ): Promise<MultiSigVerificationResult> {
    this.validatePolicy(policy);

    const result: MultiSigVerificationResult = {
      verified: false,
      policy,
      validSignatures: 0,
      validSigners: [],
      invalidSigners: [],
      errors: [],
    };

    // Check timelock
    const timelockValid = this.isTimelockValid(policy);
    result.timelockValid = timelockValid;
    if (!timelockValid) {
      result.errors.push('Timelock constraint not satisfied');
      return result;
    }

    // Extract proofs
    const proofs = this.extractProofs(credential);
    if (proofs.length === 0) {
      result.errors.push('Credential has no proofs');
      return result;
    }

    // Verify each proof individually, tracking unique signers
    const seenSigners = new Set<string>();
    for (const proof of proofs) {
      const vm = proof.verificationMethod;
      if (!policy.signerVerificationMethods.includes(vm)) {
        result.invalidSigners.push(vm);
        result.errors.push(`Signer ${vm} is not authorized by the policy`);
        continue;
      }

      const valid = await this.verifyProof(credential, proof);
      if (valid) {
        // Reject duplicate proofs from the same signer. Dedupe only after
        // successful verification so an invalid proof cannot consume the
        // signer's slot and suppress a later valid proof from the same signer.
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
    }

    // Check threshold
    result.verified = result.validSignatures >= policy.required;
    if (!result.verified) {
      result.errors.push(
        `Threshold not met: ${result.validSignatures}/${policy.required} valid signatures`
      );
    }

    // Enforce the credential's validity window. A valid m-of-n proof set over an
    // expired (or not-yet-valid) credential must not verify — the single-sig path
    // (Verifier.verifyCredential) enforces the same window, and skipping it here
    // let multi-sig credentials bypass expiration entirely. Applies to all
    // multi-sig entry points (verifyMultiSig / verifyEscrow / verifyCorporate).
    const validity = checkCredentialValidityPeriod(credential);
    if (!validity.verified) {
      result.verified = false;
      result.errors.push(...(validity.errors ?? []));
    }

    // Fail closed on revocation. Single-sig verification refuses to accept a
    // credential that declares a BitstringStatusListEntry status it cannot check;
    // the multi-sig path has no status-list resolver, so silently ignoring a
    // declared status would let a revoked m-of-n credential verify. Refuse
    // instead and direct the caller to a resolver-backed status check.
    const credentialStatus = (credential as { credentialStatus?: { type?: unknown } }).credentialStatus;
    if (credentialStatus && credentialStatus.type === 'BitstringStatusListEntry') {
      result.verified = false;
      result.errors.push(
        'Credential declares a BitstringStatusListEntry status that the multi-sig verifier cannot check. ' +
        'Verify revocation via CredentialManager.verifyCredential with a configured statusListResolver.'
      );
    }

    return result;
  }

  /**
   * Verify a credential with an escrow policy.
   * Escrow agent's signature is checked separately when escrowSignatureRequired is true.
   */
  async verifyEscrow(
    credential: VerifiableCredential,
    policy: EscrowPolicy
  ): Promise<MultiSigVerificationResult> {
    this.validateEscrowPolicy(policy);
    const result = await this.verifyMultiSig(credential, policy);

    if (policy.escrowSignatureRequired) {
      const escrowSigned = result.validSigners.includes(policy.escrowAgent);
      if (!escrowSigned) {
        result.verified = false;
        result.errors.push(`Escrow agent ${policy.escrowAgent} signature is required but missing`);
      }
    }

    return result;
  }

  /**
   * Verify a credential with a corporate policy.
   * Mandatory roles must have provided valid signatures.
   */
  async verifyCorporate(
    credential: VerifiableCredential,
    policy: CorporatePolicy
  ): Promise<MultiSigVerificationResult> {
    this.validateCorporatePolicy(policy);
    const result = await this.verifyMultiSig(credential, policy);

    if (policy.mandatoryRoles) {
      for (const role of policy.mandatoryRoles) {
        // Find signers with this role
        const signersWithRole: string[] = [];
        for (const [vm, r] of policy.roles.entries()) {
          if (r === role) signersWithRole.push(vm);
        }

        // Check if at least one signer with this role has a valid signature
        const roleSatisfied = signersWithRole.some(vm => result.validSigners.includes(vm));
        if (!roleSatisfied) {
          result.verified = false;
          result.errors.push(`Mandatory role "${role}" has no valid signature`);
        }
      }
    }

    return result;
  }

  // === Session-based async signature collection ===

  /**
   * Create a new multi-sig signing session for async signature collection.
   *
   * @param credential - The unsigned credential to sign
   * @param policy - The multi-sig policy
   * @returns The session ID and session details
   */
  createSession(
    credential: VerifiableCredential,
    policy: MultiSigPolicy
  ): MultiSigSession {
    this.validatePolicy(policy);

    const now = new Date();
    const expiresAt = policy.timelockEnd || new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

    const session: MultiSigSession = {
      id: this.generateSessionId(),
      policy,
      // Secure the context up front so every contribution and the finalized
      // credential share the exact bytes verifiers will canonicalize.
      document: { ...credential, '@context': withSecuringContext(credential['@context']) },
      contributions: [],
      createdAt: now.toISOString(),
      expiresAt,
      status: 'collecting',
    };

    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Add a signature contribution to a session.
   *
   * @param sessionId - The session to add the contribution to
   * @param contribution - The signature contribution
   * @returns Updated session status
   */
  async addContribution(sessionId: string, contribution: SignatureContribution): Promise<MultiSigSession> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`MultiSig session ${sessionId} not found`);
    }

    if (session.status === 'expired') {
      throw new Error(`MultiSig session ${sessionId} has expired`);
    }
    if (session.status === 'finalized') {
      throw new Error(`MultiSig session ${sessionId} has already been finalized`);
    }

    // Check expiration
    if (new Date() > new Date(session.expiresAt)) {
      session.status = 'expired';
      throw new Error(`MultiSig session ${sessionId} has expired`);
    }

    // Validate contribution
    const vm = contribution.proof.verificationMethod;
    if (!session.policy.signerVerificationMethods.includes(vm)) {
      throw new Error(`Signer ${vm} is not authorized by the session policy`);
    }

    // Check for duplicate contributions from the same signer
    const existingContribution = session.contributions.find(
      c => c.proof.verificationMethod === vm
    );
    if (existingContribution) {
      throw new Error(`Signer ${vm} has already contributed to this session`);
    }

    // Verify the contribution actually signs the session document before it
    // counts toward the threshold (issue #287). Accepting unverified proofs
    // let a garbage contribution drive the session to a false "finalized"
    // state — and, because the duplicate check above keys on the signer,
    // permanently blocked that signer's corrected resubmission. Rejecting
    // here (before pushing) keeps the slot free for a valid retry.
    if (!this.didManager) {
      throw new Error(
        'Cannot verify contribution: MultiSigManager requires a DIDManager to verify session contributions'
      );
    }
    const proofValid = await this.verifyProof(
      session.document as unknown as VerifiableCredential,
      contribution.proof
    );
    if (!proofValid) {
      throw new Error(`Contribution from ${vm} has an invalid proof and was rejected`);
    }

    // Re-check the invariants that were validated before the `await` above.
    // Because this method is now async, the duplicate-signer check and the
    // push are no longer atomic: a concurrently-interleaved addContribution()
    // for the same signer could have run its check (also seeing no duplicate)
    // and pushed while we awaited verifyProof. Without this re-check both
    // would push, letting one physical key count twice toward the m-of-n
    // threshold. Re-validate against the now-current session state.
    // Cast: TS narrows session.status to the pre-await value, but a concurrent
    // finalizeSession() may have moved it to 'finalized' during the await.
    if ((session.status as MultiSigSession['status']) === 'finalized') {
      throw new Error(`MultiSig session ${sessionId} has already been finalized`);
    }
    if (session.contributions.some(c => c.proof.verificationMethod === vm)) {
      throw new Error(`Signer ${vm} has already contributed to this session`);
    }

    session.contributions.push(contribution);

    // Check if threshold is met
    if (session.contributions.length >= session.policy.required) {
      session.status = 'threshold_met';
    }

    return session;
  }

  /**
   * Finalize a session and produce the signed credential.
   * Requires that the threshold has been met.
   *
   * @param sessionId - The session to finalize
   * @returns The credential with all collected proofs
   */
  finalizeSession(sessionId: string): VerifiableCredential {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`MultiSig session ${sessionId} not found`);
    }

    if (session.status === 'expired') {
      throw new Error(`MultiSig session ${sessionId} has expired`);
    }

    if (session.contributions.length < session.policy.required) {
      throw new Error(
        `Cannot finalize: ${session.contributions.length}/${session.policy.required} signatures collected`
      );
    }

    const proofs = session.contributions.map(c => c.proof);
    session.status = 'finalized';

    const credential = session.document as unknown as VerifiableCredential;
    return { ...credential, proof: proofs };
  }

  /**
   * Get the current status of a session.
   */
  getSession(sessionId: string): MultiSigSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session && session.status !== 'finalized' && session.status !== 'expired') {
      if (new Date() > new Date(session.expiresAt)) {
        session.status = 'expired';
      }
    }
    return session;
  }

  /**
   * Create a single signature contribution for a session.
   * This is used by individual signers participating in a multi-sig flow.
   */
  async createContribution(
    sessionId: string,
    privateKeyMultibase: string,
    verificationMethod: string
  ): Promise<SignatureContribution> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`MultiSig session ${sessionId} not found`);
    }

    const signerIndex = session.policy.signerVerificationMethods.indexOf(verificationMethod);
    if (signerIndex === -1) {
      throw new Error(`Signer ${verificationMethod} is not authorized by the session policy`);
    }

    const credential = session.document as unknown as VerifiableCredential;
    const proof = await this.signWithPrivateKey(credential, privateKeyMultibase, verificationMethod);

    return {
      proof,
      signerIndex,
      signedAt: new Date().toISOString(),
    };
  }

  /**
   * Create a contribution using an external signer.
   */
  async createContributionWithExternalSigner(
    sessionId: string,
    signer: ExternalSigner
  ): Promise<SignatureContribution> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`MultiSig session ${sessionId} not found`);
    }

    const vm = signer.getVerificationMethodId();
    const signerIndex = session.policy.signerVerificationMethods.indexOf(vm);
    if (signerIndex === -1) {
      throw new Error(`Signer ${vm} is not authorized by the session policy`);
    }

    const credential = session.document as unknown as VerifiableCredential;
    const proof = await this.signWithExternalSigner(credential, signer, vm);

    return {
      proof,
      signerIndex,
      signedAt: new Date().toISOString(),
    };
  }

  // === Private helpers ===

  private async signWithPrivateKey(
    credential: VerifiableCredential,
    privateKeyMultibase: string,
    verificationMethod: string
  ): Promise<Proof> {
    // Multi-sig proofs are standard Data Integrity (eddsa-rdfc-2022) proofs
    // over the proof-less credential — a parallel proof set. SDK releases
    // before the #239 rework emitted a nonstandard digest-based proof format;
    // those proofs are intentionally NOT supported and fail verification
    // (credentials must be re-signed). Everything emitted since is
    // spec-conformant and verifiable by DataIntegrityProofManager.
    if (!this.didManager) {
      throw new Error(
        'MultiSigManager requires a DIDManager to create Data Integrity proofs; pass one to the constructor'
      );
    }
    const documentLoader = createDocumentLoader(this.didManager);
    const unsigned: Record<string, unknown> = { ...credential };
    delete unsigned.proof;
    const proof = await DataIntegrityProofManager.createProof(unsigned, {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-rdfc-2022',
      created: new Date().toISOString(),
      verificationMethod,
      proofPurpose: 'assertionMethod',
      privateKey: privateKeyMultibase,
      documentLoader
    });
    return proof as unknown as Proof;
  }

  private async signWithExternalSigner(
    credential: VerifiableCredential,
    signer: ExternalSigner,
    verificationMethod: string
  ): Promise<Proof> {
    const proofBase = {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-rdfc-2022',
      created: new Date().toISOString(),
      verificationMethod,
      proofPurpose: 'assertionMethod',
    };

    const unsignedCredential: Record<string, unknown> = { ...credential };
    delete unsignedCredential.proof;

    const { proofValue } = await signer.sign({
      document: unsignedCredential,
      proof: proofBase,
    });

    return { ...proofBase, proofValue };
  }

  /**
   * Verify one multi-sig proof. Every proof must be a Data Integrity
   * `eddsa-rdfc-2022` proof (the only format this SDK emits since the #239
   * rework); anything else fails closed — including the nonstandard
   * digest-based proofs emitted by earlier releases, which are intentionally
   * unsupported and require re-signing. The verification method is resolved
   * through the document loader (did:key offline, other DID methods via the
   * DIDManager — issue #239).
   */
  private async verifyProof(
    credential: VerifiableCredential,
    proof: Proof
  ): Promise<boolean> {
    try {
      const { proofValue, verificationMethod } = proof;
      if (!proofValue || !verificationMethod) return false;

      const cryptosuite = (proof as { cryptosuite?: unknown }).cryptosuite;
      if (cryptosuite !== 'eddsa-rdfc-2022' || !this.didManager) {
        return false;
      }
      // A multi-sig member proof must be an assertion; a proof made for
      // another purpose must not count toward the threshold (cross-purpose
      // signature reuse).
      if ((proof as { proofPurpose?: unknown }).proofPurpose !== 'assertionMethod') {
        return false;
      }
      const loader = createDocumentLoader(this.didManager);
      const result = await DataIntegrityProofManager.verifyProof(
        credential,
        proof as unknown as DataIntegrityProof,
        { documentLoader: loader }
      );
      return result.verified === true;
    } catch {
      return false;
    }
  }

  private extractProofs(credential: VerifiableCredential): Proof[] {
    if (!credential.proof) return [];
    return Array.isArray(credential.proof) ? credential.proof : [credential.proof];
  }

  private generateSessionId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
}
