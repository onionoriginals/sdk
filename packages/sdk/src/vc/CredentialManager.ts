import {
  VerifiableCredential,
  VerifiablePresentation,
  CredentialSubject,
  OriginalsConfig,
  Proof,
  ExternalSigner,
  LayerType,
  AssetResource,
  BitstringStatusListEntry,
  MultiSigPolicy,
  MultiSigSignOptions,
  MultiSigVerificationResult,
} from '../types';
import { StatusListManager, type StatusCheckResult } from './StatusListManager';
import { canonicalizeDocument } from '../utils/serialization';
import { encodeBase64UrlMultibase, decodeBase64UrlMultibase } from '../utils/encoding';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Signer, ES256KSigner, Ed25519Signer, ES256Signer } from '../crypto/Signer';
import { DIDManager } from '../did/DIDManager';
import { Issuer, VerificationMethodLike } from './Issuer';
import { createDocumentLoader } from './documentLoader';
import { Verifier } from './Verifier';
import { MultiSigManager } from './MultiSigManager';
import type { MetricsCollector } from '../utils/MetricsCollector';

// ===== Credential Factory Types =====

/**
 * Subject data for a ResourceCreated credential
 */
export interface ResourceCreatedSubject {
  /** ID of the subject (typically the resource DID or asset DID) */
  id: string;
  /** Resource identifier */
  resourceId: string;
  /** Resource type (e.g., 'code', 'text', 'image') */
  resourceType: string;
  /** Content hash of the resource */
  contentHash: string;
  /** MIME content type */
  contentType: string;
  /** Creator DID */
  creator: string;
  /** Creation timestamp */
  createdAt: string;
}

/**
 * Subject data for a ResourceUpdated credential
 */
export interface ResourceUpdatedSubject {
  /** ID of the subject (typically the asset DID) */
  id: string;
  /** Resource identifier */
  resourceId: string;
  /** Previous content hash */
  previousHash: string;
  /** New content hash */
  newHash: string;
  /** Previous version number */
  fromVersion: number;
  /** New version number */
  toVersion: number;
  /** Update timestamp */
  updatedAt: string;
  /** Optional description of changes */
  updateReason?: string;
}

/**
 * Subject data for a MigrationCompleted credential
 */
export interface MigrationSubject {
  /** ID of the subject (typically the asset DID) */
  id: string;
  /** Source DID (before migration) */
  sourceDid: string;
  /** Target DID (after migration) */
  targetDid?: string;
  /** Layer migrated from */
  fromLayer: LayerType;
  /** Layer migrated to */
  toLayer: LayerType;
  /** Migration timestamp */
  migratedAt: string;
  /** Transaction ID (for Bitcoin migrations) */
  transactionId?: string;
  /** Inscription ID (for Bitcoin migrations) */
  inscriptionId?: string;
  /** Satoshi number (for Bitcoin migrations) */
  satoshi?: string;
  /** Optional reason for migration */
  migrationReason?: string;
}

/**
 * Subject data for an OwnershipTransferred credential
 */
export interface OwnershipSubject {
  /** ID of the subject (typically the asset DID) */
  id: string;
  /** Previous owner DID or address */
  previousOwner: string;
  /** New owner DID or address */
  newOwner: string;
  /** Transfer timestamp */
  transferredAt: string;
  /** Transaction ID for the transfer */
  transactionId: string;
  /** Satoshi number of the inscription */
  satoshi?: string;
  /** Optional transfer reason or notes */
  transferReason?: string;
}

/**
 * Options for creating credentials with chaining
 */
export interface CredentialChainOptions {
  /** Previous credential ID to chain from */
  previousCredentialId?: string;
  /** Hash of the previous credential for verification */
  previousCredentialHash?: string;
  /** Optional expiration date */
  expirationDate?: string;
  /** Optional credential status (e.g., BitstringStatusListEntry for revocation) */
  credentialStatus?: {
    id: string;
    type: string;
    [key: string]: unknown;
  };
}

/**
 * Options for BBS+ selective disclosure
 */
export interface SelectiveDisclosureOptions {
  /** JSON Pointer paths to fields that must always be disclosed */
  mandatoryPointers: string[];
  /** JSON Pointer paths to fields the holder can selectively disclose */
  selectivePointers?: string[];
  /** BBS+ private key (Uint8Array or multibase-encoded Bls12381G2 key) for signing */
  privateKey?: Uint8Array | string;
  /** BBS+ public key (Uint8Array or multibase-encoded Bls12381G2 key) */
  publicKey?: Uint8Array | string;
  /** Verification method ID for the BBS+ proof */
  verificationMethod?: string;
}

/**
 * Result of creating a derived proof with selective disclosure
 */
export interface DerivedProofResult {
  /** The credential with derived proof */
  credential: VerifiableCredential;
  /** Fields that were disclosed */
  disclosedFields: string[];
  /** Fields that were hidden */
  hiddenFields: string[];
}

export class CredentialManager {
  private readonly metrics?: MetricsCollector;
  public readonly statusList: StatusListManager;

  constructor(private config: OriginalsConfig, private didManager?: DIDManager, metrics?: MetricsCollector) {
    this.metrics = metrics;
    this.statusList = new StatusListManager();
  }

  private tracked<T>(op: string, fn: () => Promise<T>): Promise<T> {
    return this.metrics ? this.metrics.track(op, fn) : fn();
  }

  createResourceCredential(
    type: 'ResourceCreated' | 'ResourceUpdated' | 'ResourceMigrated',
    subject: CredentialSubject,
    issuer: string
  ): VerifiableCredential {
    return {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiableCredential', type],
      issuer,
      issuanceDate: new Date().toISOString(),
      credentialSubject: subject
    };
  }

  async signCredential(
    credential: VerifiableCredential,
    privateKeyMultibase: string,
    verificationMethod: string
  ): Promise<VerifiableCredential> {
    return this.tracked('credential.sign', async () => {
    if (this.didManager && typeof verificationMethod === 'string' && verificationMethod.startsWith('did:')) {
      try {
        const loader = createDocumentLoader(this.didManager);
        const { document } = await loader(verificationMethod);
        interface DocumentWithKey {
          publicKeyMultibase?: string;
          type?: string;
        }
        const docWithKey = document as DocumentWithKey;
        if (docWithKey && docWithKey.publicKeyMultibase) {
          const vm: VerificationMethodLike = {
            id: verificationMethod,
            controller: typeof credential.issuer === 'string' ? credential.issuer : (credential.issuer as { id?: string })?.id ?? '',
            publicKeyMultibase: docWithKey.publicKeyMultibase,
            secretKeyMultibase: privateKeyMultibase,
            type: docWithKey.type || 'Multikey'
          };
          const issuer = new Issuer(this.didManager, vm);
          const unsigned = { ...credential };
          delete (unsigned as Partial<VerifiableCredential>)['@context'];
          delete (unsigned as Partial<VerifiableCredential>).proof;
          return issuer.issueCredential(unsigned, { proofPurpose: 'assertionMethod' });
        }
      } catch {
        // fall through to legacy signing
      }
    }

    // fallback to legacy local signer
    const proofBase: Proof = {
      type: 'DataIntegrityProof',
      created: new Date().toISOString(),
      verificationMethod,
      proofPurpose: 'assertionMethod',
      proofValue: ''
    };
    const proofValue = await this.generateProofValue(credential, privateKeyMultibase, proofBase);
    const proof: Proof = { ...proofBase, proofValue };
    return { ...credential, proof };
    }); // end tracked
  }

  /**
   * Sign a credential using an external signer (e.g., hardware wallet, Turnkey)
   * @param credential - The unsigned credential
   * @param signer - External signer implementation
   * @returns Signed verifiable credential
   */
  async signCredentialWithExternalSigner(
    credential: VerifiableCredential,
    signer: ExternalSigner
  ): Promise<VerifiableCredential> {
    return this.tracked('credential.signExternal', async () => {
    const verificationMethodId = signer.getVerificationMethodId();

    // Create proof structure
    const proofBase = {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-rdfc-2022', // Or derive from signer type
      created: new Date().toISOString(),
      verificationMethod: verificationMethodId,
      proofPurpose: 'assertionMethod'
    };

    // Prepare unsigned credential
    const unsignedCredential: Record<string, unknown> = { ...credential };
    delete unsignedCredential.proof;

    // Use external signer to sign
    const { proofValue } = await signer.sign({
      document: unsignedCredential,
      proof: proofBase
    });

    // Return signed credential
    return {
      ...credential,
      proof: {
        ...proofBase,
        proofValue
      }
    };
    }); // end tracked
  }

  async verifyCredential(credential: VerifiableCredential): Promise<boolean> {
    return this.tracked('credential.verify', async () => {
    if (this.didManager) {
      interface ProofWithCryptosuite {
        cryptosuite?: string;
      }
      const proofValue = credential.proof;
      const proofWithSuite = proofValue as ProofWithCryptosuite | ProofWithCryptosuite[] | undefined;
      if (proofWithSuite) {
        const hasCryptosuite = Array.isArray(proofWithSuite)
          ? proofWithSuite[0]?.cryptosuite
          : proofWithSuite.cryptosuite;
        if (hasCryptosuite) {
          const verifier = new Verifier(this.didManager);
          const res = await verifier.verifyCredential(credential);
          return res.verified;
        }
      }
    }

    const proof = credential.proof as Proof | undefined;
    if (!proof) {
      return false;
    }

    const { proofValue, verificationMethod } = proof;
    if (!proofValue || !verificationMethod) return false;

    const signature = this.decodeMultibase(proofValue);
    if (!signature) return false;

    const proofSansValue = { ...proof } as Record<string, unknown>;
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
    const hProof = Buffer.from(sha256(Buffer.from(c14nProof, 'utf8')));
    const hCred = Buffer.from(sha256(Buffer.from(c14nCred, 'utf8')));
    const digest = Buffer.concat([hProof, hCred]);
    const signer = this.getSigner();
    try {
      const proofWithKey = proof as Proof & { publicKeyMultibase?: string };
      const resolvedKey = proofWithKey.publicKeyMultibase
        || await this.resolveVerificationMethodMultibase(verificationMethod);
      if (!resolvedKey) {
        return false;
      }
      return await signer.verify(Buffer.from(digest), Buffer.from(signature), resolvedKey);
    } catch {
      return false;
    }
    }); // end tracked
  }

  /**
   * Verify a credential's signature and check its revocation status.
   *
   * If the credential has a `credentialStatus` of type `BitstringStatusListEntry`,
   * the status is checked against the provided status list credential.
   *
   * @param credential - The credential to verify
   * @param statusListCredential - The resolved status list credential (required if credential has credentialStatus)
   * @returns Result with signature validity and revocation status
   */
  async verifyCredentialWithStatus(
    credential: VerifiableCredential,
    statusListCredential?: VerifiableCredential
  ): Promise<{
    verified: boolean;
    revoked: boolean;
    suspended: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];
    let verified = false;
    let revoked = false;
    let suspended = false;

    // Verify signature
    try {
      verified = await this.verifyCredential(credential);
      if (!verified) {
        errors.push('Credential signature verification failed');
      }
    } catch (err) {
      errors.push(`Signature verification error: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Check revocation status if applicable
    const status = credential.credentialStatus as BitstringStatusListEntry | undefined;
    if (status?.type === 'BitstringStatusListEntry') {
      if (!statusListCredential) {
        errors.push('Credential has a BitstringStatusListEntry but no status list credential was provided');
      } else {
        try {
          const result = this.statusList.checkStatus(status, statusListCredential);
          if (result.isSet) {
            if (result.statusPurpose === 'revocation') {
              revoked = true;
              errors.push('Credential has been revoked');
            } else {
              suspended = true;
              errors.push('Credential has been suspended');
            }
          }
        } catch (err) {
          errors.push(`Status check error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    return { verified, revoked, suspended, errors };
  }

  createPresentation(
    credentials: VerifiableCredential[],
    holder: string
  ): VerifiablePresentation {
    return {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation'],
      holder,
      verifiableCredential: credentials
    } as VerifiablePresentation;
  }

  private async generateProofValue(
    credential: VerifiableCredential,
    privateKeyMultibase: string,
    proofBase: Proof
  ): Promise<string> {
    // Construct canonical digest including provided proof sans proofValue
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
    const hProof = Buffer.from(sha256(Buffer.from(c14nProof, 'utf8')));
    const hCred = Buffer.from(sha256(Buffer.from(c14nCred, 'utf8')));
    const digest = Buffer.concat([hProof, hCred]);
    const signer = this.getSigner();
    const sig = await signer.sign(Buffer.from(digest), privateKeyMultibase);
    return encodeBase64UrlMultibase(sig);
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

  private async resolveVerificationMethodMultibase(
    verificationMethod: string
  ): Promise<string | null> {
    if (typeof verificationMethod === 'string' && verificationMethod.startsWith('z')) {
      return verificationMethod;
    }

    if (!this.didManager || typeof verificationMethod !== 'string' || !verificationMethod.startsWith('did:')) {
      return null;
    }

    const loader = createDocumentLoader(this.didManager);
    try {
      const { document } = await loader(verificationMethod);
      interface DocWithKey {
        publicKeyMultibase?: unknown;
      }
      const docWithKey = document as DocWithKey;
      if (docWithKey && typeof docWithKey.publicKeyMultibase === 'string') {
        return docWithKey.publicKeyMultibase;
      }
    } catch (err) {
      // Document loader failed; will try alternative resolution method
      if (this.config.enableLogging) {
        console.warn('Failed to load verification method via document loader:', err);
      }
    }

    try {
      const did = verificationMethod.split('#')[0];
      if (!did) {
        return null;
      }
      const didDoc = await this.didManager.resolveDID(did);
      interface DIDDocWithVMs {
        verificationMethod?: Array<{ id?: string; publicKeyMultibase?: unknown }>;
      }
      const docWithVMs = didDoc as DIDDocWithVMs;
      const vms = docWithVMs?.verificationMethod;
      if (Array.isArray(vms)) {
        const vm = vms.find((m) => m?.id === verificationMethod);
        if (vm && typeof vm.publicKeyMultibase === 'string') {
          return vm.publicKeyMultibase;
        }
      }
    } catch (err) {
      // Failed to resolve DID document
      if (this.config.enableLogging) {
        console.warn('Failed to resolve DID for verification method:', err);
      }
    }

    return null;
  }

  private decodeMultibase(s: string): Uint8Array | null {
    try {
      return decodeBase64UrlMultibase(s);
    } catch {
      return null;
    }
  }

  // ===== Credential Factory Methods =====

  /**
   * Issue a ResourceCreated credential for a newly created resource
   * 
   * @param resource - The created resource
   * @param assetDid - The DID of the asset containing the resource
   * @param creatorDid - The DID of the creator
   * @param chainOptions - Optional chaining options for linking to previous credentials
   * @returns Unsigned verifiable credential
   * 
   * @example
   * ```typescript
   * const credential = await credentialManager.issueResourceCredential(
   *   resource,
   *   'did:peer:abc...',
   *   'did:peer:creator...'
   * );
   * // Sign the credential with your key
   * const signed = await credentialManager.signCredential(credential, privateKey, vmId);
   * ```
   */
  issueResourceCredential(
    resource: AssetResource,
    assetDid: string,
    creatorDid: string,
    chainOptions?: CredentialChainOptions
  ): VerifiableCredential {
    const subject: ResourceCreatedSubject = {
      id: assetDid,
      resourceId: resource.id,
      resourceType: resource.type,
      contentHash: resource.hash,
      contentType: resource.contentType,
      creator: creatorDid,
      createdAt: resource.createdAt || new Date().toISOString()
    };

    const credential = this.createCredentialWithChain(
      'ResourceCreated',
      subject,
      creatorDid,
      chainOptions
    );

    return credential;
  }

  /**
   * Issue a ResourceUpdated credential for a resource version update
   * 
   * @param resourceId - The logical resource ID
   * @param assetDid - The DID of the asset
   * @param previousHash - Hash of the previous version
   * @param newHash - Hash of the new version
   * @param fromVersion - Previous version number
   * @param toVersion - New version number
   * @param updaterDid - DID of the entity performing the update
   * @param updateReason - Optional reason for the update
   * @param chainOptions - Optional chaining options
   * @returns Unsigned verifiable credential
   * 
   * @example
   * ```typescript
   * const credential = await credentialManager.issueResourceUpdateCredential(
   *   'main.js',
   *   'did:webvh:example.com:asset',
   *   'abc123...',
   *   'def456...',
   *   1,
   *   2,
   *   'did:webvh:example.com:user',
   *   'Bug fix'
   * );
   * ```
   */
  issueResourceUpdateCredential(
    resourceId: string,
    assetDid: string,
    previousHash: string,
    newHash: string,
    fromVersion: number,
    toVersion: number,
    updaterDid: string,
    updateReason?: string,
    chainOptions?: CredentialChainOptions
  ): VerifiableCredential {
    const subject: ResourceUpdatedSubject = {
      id: assetDid,
      resourceId,
      previousHash,
      newHash,
      fromVersion,
      toVersion,
      updatedAt: new Date().toISOString(),
      ...(updateReason && { updateReason })
    };

    const credential = this.createCredentialWithChain(
      'ResourceUpdated',
      subject,
      updaterDid,
      chainOptions
    );

    return credential;
  }

  /**
   * Issue a MigrationCompleted credential for layer migrations
   * 
   * Records the migration of an asset between Originals layers (peer -> webvh -> btco).
   * 
   * @param sourceDid - The source DID (before migration)
   * @param targetDid - The target DID (after migration, if different)
   * @param fromLayer - The source layer
   * @param toLayer - The target layer
   * @param issuerDid - The DID issuing this credential
   * @param details - Optional migration details (transactionId, inscriptionId, satoshi)
   * @param chainOptions - Optional chaining options
   * @returns Unsigned verifiable credential
   * 
   * @example
   * ```typescript
   * const credential = await credentialManager.issueMigrationCredential(
   *   'did:peer:abc...',
   *   'did:webvh:example.com:asset',
   *   'did:peer',
   *   'did:webvh',
   *   'did:webvh:example.com:publisher'
   * );
   * ```
   */
  issueMigrationCredential(
    sourceDid: string,
    targetDid: string | undefined,
    fromLayer: LayerType,
    toLayer: LayerType,
    issuerDid: string,
    details?: {
      transactionId?: string;
      inscriptionId?: string;
      satoshi?: string;
      migrationReason?: string;
    },
    chainOptions?: CredentialChainOptions
  ): VerifiableCredential {
    const subject: MigrationSubject = {
      id: targetDid || sourceDid,
      sourceDid,
      ...(targetDid && { targetDid }),
      fromLayer,
      toLayer,
      migratedAt: new Date().toISOString(),
      ...(details?.transactionId && { transactionId: details.transactionId }),
      ...(details?.inscriptionId && { inscriptionId: details.inscriptionId }),
      ...(details?.satoshi && { satoshi: details.satoshi }),
      ...(details?.migrationReason && { migrationReason: details.migrationReason })
    };

    const credential = this.createCredentialWithChain(
      'MigrationCompleted',
      subject,
      issuerDid,
      chainOptions
    );

    return credential;
  }

  /**
   * Issue an OwnershipTransferred credential for Bitcoin-anchored asset transfers
   * 
   * Records the transfer of ownership of a did:btco asset to a new owner.
   * 
   * @param assetDid - The DID of the asset being transferred
   * @param previousOwner - The previous owner (DID or Bitcoin address)
   * @param newOwner - The new owner (Bitcoin address)
   * @param transactionId - The Bitcoin transaction ID
   * @param issuerDid - The DID issuing this credential
   * @param details - Optional additional details
   * @param chainOptions - Optional chaining options
   * @returns Unsigned verifiable credential
   * 
   * @example
   * ```typescript
   * const credential = await credentialManager.issueOwnershipCredential(
   *   'did:btco:12345',
   *   'bc1q...oldowner',
   *   'bc1q...newowner',
   *   'abc123...txid',
   *   'did:btco:12345'
   * );
   * ```
   */
  issueOwnershipCredential(
    assetDid: string,
    previousOwner: string,
    newOwner: string,
    transactionId: string,
    issuerDid: string,
    details?: {
      satoshi?: string;
      transferReason?: string;
    },
    chainOptions?: CredentialChainOptions
  ): VerifiableCredential {
    const subject: OwnershipSubject = {
      id: assetDid,
      previousOwner,
      newOwner,
      transferredAt: new Date().toISOString(),
      transactionId,
      ...(details?.satoshi && { satoshi: details.satoshi }),
      ...(details?.transferReason && { transferReason: details.transferReason })
    };

    const credential = this.createCredentialWithChain(
      'OwnershipTransferred',
      subject,
      issuerDid,
      chainOptions
    );

    return credential;
  }

  /**
   * Create a credential with optional chaining to a previous credential
   * 
   * Credential chaining creates a verifiable provenance chain by linking
   * credentials together through their IDs and hashes.
   * 
   * @param type - The credential type
   * @param subject - The credential subject
   * @param issuer - The issuer DID
   * @param chainOptions - Optional chaining options
   * @returns Unsigned verifiable credential with chain metadata
   */
  private createCredentialWithChain(
    type: string,
    subject: CredentialSubject,
    issuer: string,
    chainOptions?: CredentialChainOptions
  ): VerifiableCredential {
    const credential: VerifiableCredential = {
      '@context': [
        'https://www.w3.org/2018/credentials/v1',
        'https://w3id.org/security/data-integrity/v2'
      ],
      type: ['VerifiableCredential', type],
      id: this.generateCredentialId(),
      issuer,
      issuanceDate: new Date().toISOString(),
      credentialSubject: subject
    };

    // Add expiration if specified
    if (chainOptions?.expirationDate) {
      credential.expirationDate = chainOptions.expirationDate;
    }

    // Add credential status if specified
    if (chainOptions?.credentialStatus) {
      credential.credentialStatus = chainOptions.credentialStatus;
    }

    // Add chaining metadata if provided
    if (chainOptions?.previousCredentialId || chainOptions?.previousCredentialHash) {
      interface SubjectWithPrevious {
        previousCredential?: {
          id?: string;
          hash?: string;
        };
      }
      const subjectWithPrev = credential.credentialSubject as CredentialSubject & SubjectWithPrevious;
      subjectWithPrev.previousCredential = {
        ...(chainOptions.previousCredentialId && { id: chainOptions.previousCredentialId }),
        ...(chainOptions.previousCredentialHash && { hash: chainOptions.previousCredentialHash })
      };
    }

    return credential;
  }

  /**
   * Generate a unique credential ID
   */
  private generateCredentialId(): string {
    const timestamp = Date.now();
    const randomBytes = new Uint8Array(16);
    if (typeof globalThis.crypto?.getRandomValues === 'function') {
      globalThis.crypto.getRandomValues(randomBytes);
    } else {
      throw new Error('crypto.getRandomValues is required for secure credential ID generation. Ensure your runtime supports the Web Crypto API.');
    }
    const randomHex = bytesToHex(randomBytes);
    return `urn:uuid:${timestamp}-${randomHex.substring(0, 8)}-${randomHex.substring(8, 16)}`;
  }

  /**
   * Compute the hash of a credential for chaining purposes
   * 
   * @param credential - The credential to hash
   * @returns SHA-256 hash of the canonicalized credential
   */
  async computeCredentialHash(credential: VerifiableCredential): Promise<string> {
    return this.tracked('credential.computeHash', async () => {
    const canonicalized = await canonicalizeDocument(credential as unknown as Record<string, unknown>);
    const hash = sha256(Buffer.from(canonicalized, 'utf8'));
    return bytesToHex(hash);
    }); // end tracked
  }

  /**
   * Verify a credential chain by checking all previous credential links
   * 
   * @param credentials - Array of credentials in chain order (oldest first)
   * @returns Verification result with chain integrity status
   */
  async verifyCredentialChain(credentials: VerifiableCredential[]): Promise<{
    valid: boolean;
    errors: string[];
    chainLength: number;
  }> {
    const errors: string[] = [];
    
    if (credentials.length === 0) {
      return { valid: true, errors: [], chainLength: 0 };
    }

    // Verify each credential individually
    for (let i = 0; i < credentials.length; i++) {
      const isValid = await this.verifyCredential(credentials[i]);
      if (!isValid) {
        errors.push(`Credential at index ${i} failed verification`);
      }
    }

    // Verify chain links
    for (let i = 1; i < credentials.length; i++) {
      const current = credentials[i];
      const previous = credentials[i - 1];

      interface SubjectWithPrevious {
        previousCredential?: {
          id?: string;
          hash?: string;
        };
      }
      const currentSubject = current.credentialSubject as CredentialSubject & SubjectWithPrevious;
      const previousCredRef = currentSubject?.previousCredential;

      if (previousCredRef) {
        // Verify ID link
        if (previousCredRef.id && previousCredRef.id !== previous.id) {
          errors.push(`Chain broken at index ${i}: previousCredential.id doesn't match`);
        }

        // Verify hash link
        if (previousCredRef.hash) {
          const expectedHash = await this.computeCredentialHash(previous);
          if (previousCredRef.hash !== expectedHash) {
            errors.push(`Chain broken at index ${i}: previousCredential.hash doesn't match`);
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      chainLength: credentials.length
    };
  }

  // ===== BBS+ Selective Disclosure =====

  /**
   * Prepare a credential for BBS+ selective disclosure
   *
   * Signs the credential with a BBS+ proof, enabling later derivation
   * of selective disclosure proofs that reveal only chosen fields.
   *
   * @param credential - The credential to prepare
   * @param options - Selective disclosure options including BBS+ key pair
   * @returns The credential with BBS+ base proof and pointer metadata
   */
  async prepareSelectiveDisclosure(
    credential: VerifiableCredential,
    options: SelectiveDisclosureOptions
  ): Promise<{
    credential: VerifiableCredential;
    mandatoryPointers: string[];
    selectivePointers: string[];
  }> {
    // Validate mandatory pointers
    if (!options.mandatoryPointers || options.mandatoryPointers.length === 0) {
      throw new Error('At least one mandatory pointer is required for selective disclosure');
    }

    for (const pointer of options.mandatoryPointers) {
      if (!pointer.startsWith('/')) {
        throw new Error(`Invalid JSON Pointer: ${pointer} (must start with /)`);
      }
    }

    const selectivePointers = options.selectivePointers || [];
    for (const pointer of selectivePointers) {
      if (!pointer.startsWith('/')) {
        throw new Error(`Invalid JSON Pointer: ${pointer} (must start with /)`);
      }
    }

    // If BBS+ key pair provided, create a real BBS+ base proof
    if (options.privateKey) {
      const { BBSCryptosuiteManager } = await import('./cryptosuites/bbsCryptosuite');
      const documentLoader = this.didManager ? createDocumentLoader(this.didManager) : undefined;

      const bbsProof = await BBSCryptosuiteManager.createProof(credential, {
        verificationMethod: options.verificationMethod || '',
        proofPurpose: 'assertionMethod',
        privateKey: options.privateKey,
        publicKey: options.publicKey,
        documentLoader,
        mandatoryPointers: options.mandatoryPointers,
      });

      const enhancedCredential: VerifiableCredential = {
        ...credential,
        proof: {
          ...bbsProof,
          created: bbsProof.created || new Date().toISOString(),
        },
      };

      return {
        credential: enhancedCredential,
        mandatoryPointers: options.mandatoryPointers,
        selectivePointers,
      };
    }

    // Fallback: return credential with metadata only (no BBS+ key provided)
    return {
      credential: { ...credential },
      mandatoryPointers: options.mandatoryPointers,
      selectivePointers,
    };
  }

  /**
   * Create a derived proof with selective disclosure
   *
   * Given a credential with a BBS+ base proof, creates a derived proof
   * that only reveals the specified fields while cryptographically proving
   * the hidden fields exist in the original credential.
   *
   * @param credential - The credential with BBS+ base proof
   * @param fieldsToDisclose - JSON Pointer paths to disclose
   * @param presentationHeader - Optional presentation-specific data
   * @returns The credential with derived proof and field visibility info
   */
  async deriveSelectiveProof(
    credential: VerifiableCredential,
    fieldsToDisclose: string[],
    presentationHeader?: Uint8Array
  ): Promise<DerivedProofResult> {
    for (const field of fieldsToDisclose) {
      if (!field.startsWith('/')) {
        throw new Error(`Invalid JSON Pointer for disclosure: ${field}`);
      }
    }

    const allFields = this.extractFieldPaths(credential as unknown as Record<string, unknown>);
    const disclosedSet = new Set(fieldsToDisclose);
    const hiddenFields = allFields.filter(f => !disclosedSet.has(f));

    // If the credential has a BBS+ proof, derive a real selective disclosure proof
    const proof = credential.proof as any;
    if (proof && proof.cryptosuite === 'bbs-2023') {
      const { BBSCryptosuiteManager } = await import('./cryptosuites/bbsCryptosuite');
      const documentLoader = this.didManager ? createDocumentLoader(this.didManager) : undefined;

      const derived = await BBSCryptosuiteManager.deriveProof(
        credential,
        proof,
        {
          documentLoader,
          presentationHeader,
          selectivePointers: fieldsToDisclose,
        }
      );

      return {
        credential: {
          ...derived.document,
          proof: derived.proof,
        } as VerifiableCredential,
        disclosedFields: fieldsToDisclose,
        hiddenFields,
      };
    }

    // Fallback for non-BBS+ credentials
    return {
      credential: { ...credential },
      disclosedFields: fieldsToDisclose,
      hiddenFields,
    };
  }

  /**
   * Extract all field paths from a credential as JSON Pointers
   */
  private extractFieldPaths(obj: Record<string, unknown>, prefix = ''): string[] {
    const paths: string[] = [];

    if (typeof obj !== 'object' || obj === null) {
      return paths;
    }

    for (const [key, value] of Object.entries(obj)) {
      const path = `${prefix}/${key}`;
      paths.push(path);

      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        paths.push(...this.extractFieldPaths(value as Record<string, unknown>, path));
      }
    }

    return paths;
  }

  /**
   * Get field value from credential using JSON Pointer
   * 
   * @param credential - The credential to read from
   * @param pointer - JSON Pointer path (e.g., /credentialSubject/name)
   * @returns The value at the pointer path, or undefined if not found
   */
  getFieldByPointer(credential: VerifiableCredential, pointer: string): unknown {
    if (!pointer.startsWith('/')) {
      throw new Error('JSON Pointer must start with /');
    }

    const parts = pointer.slice(1).split('/');
    let current: unknown = credential;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      // Handle escaped characters in JSON Pointer
      const unescaped = part.replace(/~1/g, '/').replace(/~0/g, '~');
      const currentObj = current as Record<string, unknown>;
      current = currentObj[unescaped];
    }

    return current;
  }

  // ===== Credential Revocation Convenience Methods =====

  /**
   * Revoke a credential by setting its status bit in the status list credential.
   *
   * The credential must have a `credentialStatus` of type `BitstringStatusListEntry`.
   * Revocation is permanent — once revoked, a credential cannot be un-revoked.
   *
   * @param credential - The credential to revoke (must have credentialStatus)
   * @param statusListCredential - The status list credential to update
   * @returns Updated status list credential with the revocation bit set
   */
  revokeCredential(
    credential: VerifiableCredential,
    statusListCredential: VerifiableCredential
  ): VerifiableCredential {
    const entry = this.extractStatusEntry(credential);
    if (entry.statusPurpose !== 'revocation') {
      throw new Error(
        `Cannot revoke: credential status purpose is '${entry.statusPurpose}', expected 'revocation'`
      );
    }
    const manager = new StatusListManager();
    const index = parseInt(entry.statusListIndex, 10);
    return manager.setStatus(statusListCredential, index, true);
  }

  /**
   * Suspend a credential by setting its status bit in the status list credential.
   *
   * The credential must have a `credentialStatus` with statusPurpose 'suspension'.
   * Unlike revocation, suspension is reversible via `unsuspendCredential()`.
   *
   * @param credential - The credential to suspend (must have credentialStatus)
   * @param statusListCredential - The status list credential to update
   * @returns Updated status list credential with the suspension bit set
   */
  suspendCredential(
    credential: VerifiableCredential,
    statusListCredential: VerifiableCredential
  ): VerifiableCredential {
    const entry = this.extractStatusEntry(credential);
    if (entry.statusPurpose !== 'suspension') {
      throw new Error(
        `Cannot suspend: credential status purpose is '${entry.statusPurpose}', expected 'suspension'`
      );
    }
    const manager = new StatusListManager();
    const index = parseInt(entry.statusListIndex, 10);
    return manager.setStatus(statusListCredential, index, true);
  }

  /**
   * Unsuspend a previously suspended credential.
   *
   * Clears the suspension bit in the status list credential. Only works with
   * credentials whose statusPurpose is 'suspension' (not 'revocation').
   *
   * @param credential - The credential to unsuspend (must have credentialStatus)
   * @param statusListCredential - The status list credential to update
   * @returns Updated status list credential with the suspension bit cleared
   */
  unsuspendCredential(
    credential: VerifiableCredential,
    statusListCredential: VerifiableCredential
  ): VerifiableCredential {
    const entry = this.extractStatusEntry(credential);
    if (entry.statusPurpose !== 'suspension') {
      throw new Error(
        `Cannot unsuspend: credential status purpose is '${entry.statusPurpose}', expected 'suspension'`
      );
    }
    const manager = new StatusListManager();
    const index = parseInt(entry.statusListIndex, 10);
    return manager.setStatus(statusListCredential, index, false);
  }

  /**
   * Check the revocation or suspension status of a credential.
   *
   * @param credential - The credential to check (must have credentialStatus)
   * @param statusListCredential - The resolved status list credential
   * @returns Status check result with isSet, statusPurpose, and statusListIndex
   */
  checkRevocationStatus(
    credential: VerifiableCredential,
    statusListCredential: VerifiableCredential
  ): StatusCheckResult {
    const entry = this.extractStatusEntry(credential);
    const manager = new StatusListManager();
    return manager.checkStatus(entry, statusListCredential);
  }

  /**
   * Check whether a credential is revoked.
   *
   * Convenience method that returns a simple boolean. The credential must have
   * a credentialStatus with statusPurpose 'revocation'.
   *
   * @param credential - The credential to check
   * @param statusListCredential - The resolved status list credential
   * @returns true if the credential is revoked
   */
  isRevoked(
    credential: VerifiableCredential,
    statusListCredential: VerifiableCredential
  ): boolean {
    const result = this.checkRevocationStatus(credential, statusListCredential);
    return result.isSet;
  }

  /**
   * Extract and validate the BitstringStatusListEntry from a credential.
   */
  private extractStatusEntry(credential: VerifiableCredential): BitstringStatusListEntry {
    const status = credential.credentialStatus;
    if (!status) {
      throw new Error('Credential has no credentialStatus field');
    }
    if (status.type !== 'BitstringStatusListEntry') {
      throw new Error(
        `Unsupported credentialStatus type: '${status.type}'. Expected 'BitstringStatusListEntry'`
      );
    }
    return status as BitstringStatusListEntry;
  }

  // ===== Multi-Signature Methods =====

  /**
   * Get a MultiSigManager instance for multi-signature operations.
   *
   * @returns A MultiSigManager configured with this credential manager's config
   *
   * @example
   * ```typescript
   * const multiSig = credentialManager.multiSig();
   *
   * // Sign with 2-of-3 threshold
   * const signed = await multiSig.signCredentialMultiSig(credential, {
   *   policy: { required: 2, total: 3, signerVerificationMethods: [vm1, vm2, vm3] },
   *   privateKeys: new Map([[vm1, key1], [vm2, key2]])
   * });
   *
   * // Verify against policy
   * const result = await multiSig.verifyMultiSig(signed, policy);
   * ```
   */
  multiSig(): MultiSigManager {
    return new MultiSigManager(this.config);
  }

  /**
   * Sign a credential with multiple signers to meet a threshold policy.
   * Convenience wrapper around MultiSigManager.signCredentialMultiSig().
   *
   * @param credential - The unsigned credential
   * @param options - Signing options including policy and keys/signers
   * @returns The credential with multiple proofs attached
   */
  async signCredentialMultiSig(
    credential: VerifiableCredential,
    options: MultiSigSignOptions
  ): Promise<VerifiableCredential> {
    return this.tracked('credential.signMultiSig', async () => {
      const manager = new MultiSigManager(this.config);
      return manager.signCredentialMultiSig(credential, options);
    });
  }

  /**
   * Verify a multi-sig credential against a threshold policy.
   * Convenience wrapper around MultiSigManager.verifyMultiSig().
   *
   * @param credential - The credential with multiple proofs
   * @param policy - The multi-sig policy to verify against
   * @returns Detailed verification result
   */
  async verifyCredentialMultiSig(
    credential: VerifiableCredential,
    policy: MultiSigPolicy
  ): Promise<MultiSigVerificationResult> {
    return this.tracked('credential.verifyMultiSig', async () => {
      const manager = new MultiSigManager(this.config);
      return manager.verifyMultiSig(credential, policy);
    });
  }
}


