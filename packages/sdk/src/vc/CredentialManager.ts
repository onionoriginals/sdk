import { 
  VerifiableCredential, 
  VerifiablePresentation, 
  CredentialSubject, 
  OriginalsConfig,
  Proof,
  ExternalSigner,
  LayerType,
  AssetResource
} from '../types';
import { canonicalizeDocument } from '../utils/serialization';
import { encodeBase64UrlMultibase, decodeBase64UrlMultibase } from '../utils/encoding';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { Signer, ES256KSigner, Ed25519Signer, ES256Signer } from '../crypto/Signer';
import { DIDManager } from '../did/DIDManager';
import { Issuer, VerificationMethodLike } from './Issuer';
import { createDocumentLoader } from './documentLoader';
import { Verifier } from './Verifier';
import { BBSCryptosuiteUtils } from './cryptosuites/bbs';

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
  /** Optional credential status information */
  credentialStatus?: {
    id: string;
    type: string;
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
  constructor(private config: OriginalsConfig, private didManager?: DIDManager) {}

  async createResourceCredential(
    type: 'ResourceCreated' | 'ResourceUpdated' | 'ResourceMigrated',
    subject: CredentialSubject,
    issuer: string
  ): Promise<VerifiableCredential> {
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
    if (this.didManager && typeof verificationMethod === 'string' && verificationMethod.startsWith('did:')) {
      try {
        const loader = createDocumentLoader(this.didManager);
        const { document } = await loader(verificationMethod);
        if (document && document.publicKeyMultibase) {
          const vm: VerificationMethodLike = {
            id: verificationMethod,
            controller: typeof credential.issuer === 'string' ? credential.issuer : (credential.issuer as any)?.id,
            publicKeyMultibase: document.publicKeyMultibase,
            secretKeyMultibase: privateKeyMultibase,
            type: document.type || 'Multikey'
          } as any;
          const issuer = new Issuer(this.didManager, vm);
          const unsigned: any = { ...credential };
          delete unsigned['@context'];
          delete unsigned.proof;
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
    const verificationMethodId = await signer.getVerificationMethodId();
    
    // Create proof structure
    const proofBase = {
      type: 'DataIntegrityProof',
      cryptosuite: 'eddsa-rdfc-2022', // Or derive from signer type
      created: new Date().toISOString(),
      verificationMethod: verificationMethodId,
      proofPurpose: 'assertionMethod'
    };

    // Prepare unsigned credential
    const unsignedCredential: any = { ...credential };
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
  }

  async verifyCredential(credential: VerifiableCredential): Promise<boolean> {
    if (this.didManager) {
      const proofAny: any = (credential as any).proof;
      if (proofAny && (proofAny.cryptosuite || (Array.isArray(proofAny) && proofAny[0]?.cryptosuite))) {
        const verifier = new Verifier(this.didManager);
        const res = await verifier.verifyCredential(credential);
        return res.verified;
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

    const proofSansValue = { ...proof } as any;
    delete proofSansValue.proofValue;
    const proofInput: any = { ...proofSansValue };
    const credentialContext = (credential as any)['@context'];
    if (credentialContext && !proofInput['@context']) {
      proofInput['@context'] = credentialContext;
    }
    const unsignedCredential: any = { ...credential };
    delete unsignedCredential.proof;

    const c14nProof = await canonicalizeDocument(proofInput);
    const c14nCred = await canonicalizeDocument(unsignedCredential);
    const hProof = Buffer.from(sha256(Buffer.from(c14nProof, 'utf8')));
    const hCred = Buffer.from(sha256(Buffer.from(c14nCred, 'utf8')));
    const digest = Buffer.concat([hProof, hCred]);
    const signer = this.getSigner();
    try {
      const resolvedKey = (proof as any).publicKeyMultibase
        || await this.resolveVerificationMethodMultibase(verificationMethod);
      if (!resolvedKey) {
        return false;
      }
      return await signer.verify(Buffer.from(digest), Buffer.from(signature), resolvedKey);
    } catch {
      return false;
    }
  }

  async createPresentation(
    credentials: VerifiableCredential[],
    holder: string
  ): Promise<VerifiablePresentation> {
    return {
      '@context': ['https://www.w3.org/2018/credentials/v1'],
      type: ['VerifiablePresentation'],
      holder,
      verifiableCredential: credentials
    } as any;
  }

  private async generateProofValue(
    credential: VerifiableCredential, 
    privateKeyMultibase: string,
    proofBase: Proof
  ): Promise<string> {
    // Construct canonical digest including provided proof sans proofValue
    const proofSansValue = { ...proofBase } as any;
    delete proofSansValue.proofValue;
    const proofInput: any = { ...proofSansValue };
    const credentialContext = (credential as any)['@context'];
    if (credentialContext && !proofInput['@context']) {
      proofInput['@context'] = credentialContext;
    }
    const unsignedCredential: any = { ...credential };
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
      if (document && typeof document.publicKeyMultibase === 'string') {
        return document.publicKeyMultibase;
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
      const vms = (didDoc as any)?.verificationMethod;
      if (Array.isArray(vms)) {
        const vm = vms.find((m: any) => m?.id === verificationMethod);
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
  async issueResourceCredential(
    resource: AssetResource,
    assetDid: string,
    creatorDid: string,
    chainOptions?: CredentialChainOptions
  ): Promise<VerifiableCredential> {
    const subject: ResourceCreatedSubject = {
      id: assetDid,
      resourceId: resource.id,
      resourceType: resource.type,
      contentHash: resource.hash,
      contentType: resource.contentType,
      creator: creatorDid,
      createdAt: resource.createdAt || new Date().toISOString()
    };

    const credential = await this.createCredentialWithChain(
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
  async issueResourceUpdateCredential(
    resourceId: string,
    assetDid: string,
    previousHash: string,
    newHash: string,
    fromVersion: number,
    toVersion: number,
    updaterDid: string,
    updateReason?: string,
    chainOptions?: CredentialChainOptions
  ): Promise<VerifiableCredential> {
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

    const credential = await this.createCredentialWithChain(
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
  async issueMigrationCredential(
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
  ): Promise<VerifiableCredential> {
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

    const credential = await this.createCredentialWithChain(
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
  async issueOwnershipCredential(
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
  ): Promise<VerifiableCredential> {
    const subject: OwnershipSubject = {
      id: assetDid,
      previousOwner,
      newOwner,
      transferredAt: new Date().toISOString(),
      transactionId,
      ...(details?.satoshi && { satoshi: details.satoshi }),
      ...(details?.transferReason && { transferReason: details.transferReason })
    };

    const credential = await this.createCredentialWithChain(
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
  private async createCredentialWithChain(
    type: string,
    subject: CredentialSubject,
    issuer: string,
    chainOptions?: CredentialChainOptions
  ): Promise<VerifiableCredential> {
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
      (credential.credentialSubject as any).previousCredential = {
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
      // Fallback for environments without crypto.getRandomValues
      for (let i = 0; i < 16; i++) {
        randomBytes[i] = Math.floor(Math.random() * 256);
      }
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
    const canonicalized = await canonicalizeDocument(credential as any);
    const hash = sha256(Buffer.from(canonicalized, 'utf8'));
    return bytesToHex(hash);
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
      
      const previousCredRef = (current.credentialSubject as any)?.previousCredential;
      
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
   * This creates a base proof that can later be derived into a proof
   * that selectively discloses only certain fields.
   * 
   * Note: This requires BBS+ keys and is primarily used for privacy-preserving
   * credential presentations.
   * 
   * @param credential - The credential to prepare
   * @param options - Selective disclosure options
   * @returns The credential with BBS+ base proof metadata
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

    // Validate pointer format (JSON Pointers must start with /)
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

    // Add selective disclosure metadata to credential
    const enhancedCredential = {
      ...credential,
      // Store pointers in credential for later derivation
      // In a full implementation, this would involve creating a BBS+ base proof
    };

    return {
      credential: enhancedCredential,
      mandatoryPointers: options.mandatoryPointers,
      selectivePointers
    };
  }

  /**
   * Create a derived proof with selective disclosure
   * 
   * Given a credential with a BBS+ base proof, creates a derived proof
   * that only reveals the specified fields.
   * 
   * @param credential - The credential with BBS+ base proof
   * @param fieldsToDisclose - JSON Pointer paths to disclose
   * @param presentationHeader - Optional presentation-specific data
   * @returns The credential with derived proof
   */
  async deriveSelectiveProof(
    credential: VerifiableCredential,
    fieldsToDisclose: string[],
    presentationHeader?: Uint8Array
  ): Promise<DerivedProofResult> {
    // Validate that all disclosed fields are valid JSON pointers
    for (const field of fieldsToDisclose) {
      if (!field.startsWith('/')) {
        throw new Error(`Invalid JSON Pointer for disclosure: ${field}`);
      }
    }

    // Determine which fields will be hidden
    const allFields = this.extractFieldPaths(credential);
    const disclosedSet = new Set(fieldsToDisclose);
    const hiddenFields = allFields.filter(f => !disclosedSet.has(f));

    // In a full implementation, this would:
    // 1. Parse the base proof
    // 2. Create selective indexes from fieldsToDisclose
    // 3. Generate the derived BBS+ proof
    // For now, we return a structure showing what would be disclosed

    return {
      credential: {
        ...credential,
        // A real implementation would have a derived proof here
      },
      disclosedFields: fieldsToDisclose,
      hiddenFields
    };
  }

  /**
   * Extract all field paths from a credential as JSON Pointers
   */
  private extractFieldPaths(obj: any, prefix = ''): string[] {
    const paths: string[] = [];
    
    if (typeof obj !== 'object' || obj === null) {
      return paths;
    }

    for (const [key, value] of Object.entries(obj)) {
      const path = `${prefix}/${key}`;
      paths.push(path);
      
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        paths.push(...this.extractFieldPaths(value, path));
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
  getFieldByPointer(credential: VerifiableCredential, pointer: string): any {
    if (!pointer.startsWith('/')) {
      throw new Error('JSON Pointer must start with /');
    }

    const parts = pointer.slice(1).split('/');
    let current: any = credential;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      // Handle escaped characters in JSON Pointer
      const unescaped = part.replace(/~1/g, '/').replace(/~0/g, '~');
      current = current[unescaped];
    }

    return current;
  }
}


