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
} from '../types';
import type { OriginalsConfig } from '../types/common';
import { canonicalizeDocument } from '../utils/serialization';
import { encodeBase64UrlMultibase, decodeBase64UrlMultibase } from '../utils/encoding';
import { sha256 } from '@noble/hashes/sha2.js';
import { Signer, ES256KSigner, Ed25519Signer, ES256Signer } from '../crypto/Signer';

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

  constructor(private config: OriginalsConfig) {}

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
    credential: VerifiableCredential,
    options: MultiSigSignOptions
  ): Promise<VerifiableCredential> {
    const { policy, privateKeys, externalSigners } = options;
    this.validatePolicy(policy);

    if (!this.isTimelockValid(policy)) {
      throw new Error('MultiSig signing is outside the allowed timelock window');
    }

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
    const signer = this.getSigner();
    const seenSigners = new Set<string>();
    for (const proof of proofs) {
      const vm = proof.verificationMethod;
      if (!policy.signerVerificationMethods.includes(vm)) {
        result.invalidSigners.push(vm);
        result.errors.push(`Signer ${vm} is not authorized by the policy`);
        continue;
      }

      // Reject duplicate proofs from the same signer
      if (seenSigners.has(vm)) {
        result.errors.push(`Duplicate proof from ${vm} (ignored)`);
        continue;
      }
      seenSigners.add(vm);

      const valid = await this.verifyProof(credential, proof, signer);
      if (valid) {
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
      document: { ...credential } as unknown as Record<string, unknown>,
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
  addContribution(sessionId: string, contribution: SignatureContribution): MultiSigSession {
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
    const proofBase: Proof = {
      type: 'DataIntegrityProof',
      created: new Date().toISOString(),
      verificationMethod,
      proofPurpose: 'assertionMethod',
      proofValue: '',
    };

    const digest = await this.computeDigest(credential, proofBase);
    const signer = this.getSigner();
    const sig = await signer.sign(Buffer.from(digest), privateKeyMultibase);
    const proofValue = encodeBase64UrlMultibase(sig);

    return { ...proofBase, proofValue };
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

  private async computeDigest(
    credential: VerifiableCredential,
    proofBase: Proof
  ): Promise<Uint8Array> {
    const proofSansValue = { ...proofBase } as Record<string, unknown>;
    delete proofSansValue.proofValue;

    const proofInput: Record<string, unknown> = { ...proofSansValue };
    const credentialContext = credential['@context'];
    if (credentialContext && !proofInput['@context']) {
      proofInput['@context'] = credentialContext;
    }

    const unsignedCredential: Record<string, unknown> = { ...credential };
    delete unsignedCredential.proof;

    const c14nProof = await canonicalizeDocument(proofInput);
    const c14nCred = await canonicalizeDocument(unsignedCredential);
    const hProof = sha256(Buffer.from(c14nProof, 'utf8'));
    const hCred = sha256(Buffer.from(c14nCred, 'utf8'));

    const digest = new Uint8Array(hProof.length + hCred.length);
    digest.set(hProof, 0);
    digest.set(hCred, hProof.length);
    return digest;
  }

  private async verifyProof(
    credential: VerifiableCredential,
    proof: Proof,
    signer: Signer
  ): Promise<boolean> {
    try {
      const { proofValue, verificationMethod } = proof;
      if (!proofValue || !verificationMethod) return false;

      const signature = decodeBase64UrlMultibase(proofValue);
      if (!signature) return false;

      const proofBase: Proof = { ...proof, proofValue: '' };
      const digest = await this.computeDigest(credential, proofBase);

      // Extract public key from verification method (did:key format)
      const publicKeyMultibase = this.extractPublicKeyFromVM(verificationMethod);
      if (!publicKeyMultibase) return false;

      return await signer.verify(Buffer.from(digest), Buffer.from(signature), publicKeyMultibase);
    } catch {
      return false;
    }
  }

  private extractPublicKeyFromVM(verificationMethod: string): string | null {
    // For did:key methods, the key is embedded in the DID
    if (verificationMethod.startsWith('did:key:')) {
      const keyPart = verificationMethod.split('#')[0];
      return keyPart.replace('did:key:', '');
    }
    return null;
  }

  private extractProofs(credential: VerifiableCredential): Proof[] {
    if (!credential.proof) return [];
    return Array.isArray(credential.proof) ? credential.proof : [credential.proof];
  }

  private getSigner(): Signer {
    switch (this.config.defaultKeyType) {
      case 'ES256K':
        return new ES256KSigner();
      case 'Ed25519':
        return new Ed25519Signer();
      case 'ES256':
        return new ES256Signer();
      default:
        return new ES256KSigner();
    }
  }

  private generateSessionId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
}
