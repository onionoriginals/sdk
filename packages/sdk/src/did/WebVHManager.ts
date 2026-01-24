import { KeyManager } from './KeyManager';
import { multikey } from '../crypto/Multikey';
import { Ed25519Signer } from '../crypto/Signer';
import { DIDDocument, KeyPair, ExternalSigner, ExternalVerifier } from '../types';
import * as fs from 'fs';
import * as path from 'path';

// Type definitions for didwebvh-ts (to avoid module resolution issues)
interface VerificationMethod {
  id?: string;
  type: string;
  controller?: string;
  publicKeyMultibase: string;
  secretKeyMultibase?: string;
  purpose?: 'authentication' | 'assertionMethod' | 'keyAgreement' | 'capabilityInvocation' | 'capabilityDelegation';
}

interface SigningInput {
  document: Record<string, unknown>;
  proof: Record<string, unknown>;
}

interface SigningOutput {
  proofValue: string;
}

interface SignerOptions {
  verificationMethod?: VerificationMethod | null;
  useStaticId?: boolean;
}

interface Signer {
  sign(input: SigningInput): Promise<SigningOutput>;
  getVerificationMethodId(): string;
}

interface Verifier {
  verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean>;
}

interface DIDLogEntry {
  versionId: string;
  versionTime: string;
  parameters: Record<string, unknown>;
  state: Record<string, unknown>;
  proof?: Record<string, unknown>[];
}

type DIDLog = DIDLogEntry[];

/**
 * Adapter to use Originals SDK signers with didwebvh-ts
 */
class OriginalsWebVHSigner implements Signer, Verifier {
  private privateKeyMultibase: string;
  private signer: Ed25519Signer;
  protected verificationMethod?: VerificationMethod | null;
  protected useStaticId: boolean;
  private prepareDataForSigning: (document: Record<string, unknown>, proof: Record<string, unknown>) => Promise<Uint8Array>;

  constructor(
    privateKeyMultibase: string,
    verificationMethod: VerificationMethod,
    prepareDataForSigning: (document: Record<string, unknown>, proof: Record<string, unknown>) => Promise<Uint8Array>,
    options: SignerOptions = {}
  ) {
    this.privateKeyMultibase = privateKeyMultibase;
    this.verificationMethod = options.verificationMethod || verificationMethod;
    this.useStaticId = options.useStaticId || false;
    this.signer = new Ed25519Signer();
    this.prepareDataForSigning = prepareDataForSigning;
  }

  async sign(input: SigningInput): Promise<SigningOutput> {
    // Prepare the data for signing using didwebvh-ts's canonical approach
    const dataToSign = await this.prepareDataForSigning(input.document, input.proof);
    
    // Sign using our Ed25519 signer
    const signature: Buffer = await this.signer.sign(
      Buffer.from(dataToSign),
      this.privateKeyMultibase
    );

    // Encode signature as multibase
    const proofValue = multikey.encodeMultibase(signature);

    return { proofValue };
  }

  async verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
    // Decode the public key to multibase format
    const publicKeyMultibase = multikey.encodePublicKey(publicKey, 'Ed25519');
    
    // Verify using our Ed25519 signer
    const messageBuffer: Buffer = Buffer.from(message);
    const signatureBuffer: Buffer = Buffer.from(signature);
    
    return this.signer.verify(
      messageBuffer,
      signatureBuffer,
      publicKeyMultibase
    );
  }

  getVerificationMethodId(): string {
    // didwebvh-ts requires verification method to be a did:key: identifier
    // Extract the multibase key from the verification method
    const publicKeyMultibase = this.verificationMethod?.publicKeyMultibase;
    if (!publicKeyMultibase) {
      throw new Error('Verification method must have publicKeyMultibase');
    }
    // Return as did:key format which didwebvh-ts expects
    return `did:key:${publicKeyMultibase}`;
  }
}

export interface CreateWebVHOptions {
  domain: string;
  keyPair?: KeyPair;
  paths?: string[];
  portable?: boolean;
  outputDir?: string; // Directory to save the DID log (did.jsonl)
  externalSigner?: ExternalSigner; // External signer (e.g., Turnkey integration)
  externalVerifier?: ExternalVerifier; // External verifier
  verificationMethods?: VerificationMethod[]; // Pre-configured verification methods
  updateKeys?: string[]; // Pre-configured update keys (e.g., ["did:key:z6Mk..."])
}

export interface CreateWebVHResult {
  did: string;
  didDocument: DIDDocument;
  log: DIDLog;
  keyPair: KeyPair;
  logPath?: string; // Path where the DID log was saved
}

/**
 * WebVH DID Manager for creating and managing did:webvh identifiers
 */
export class WebVHManager {
  private keyManager: KeyManager;

  constructor() {
    this.keyManager = new KeyManager();
  }

  /**
   * Creates a new did:webvh DID with proper cryptographic signing
   * @param options - Creation options including domain and optional key pair or external signer
   * @returns The created DID, document, log, and key pair (if generated)
   */
  async createDIDWebVH(options: CreateWebVHOptions): Promise<CreateWebVHResult> {
    const { 
      domain, 
      keyPair: providedKeyPair, 
      paths = [], 
      portable = false, 
      outputDir,
      externalSigner,
      externalVerifier,
      verificationMethods: providedVerificationMethods,
      updateKeys: providedUpdateKeys
    } = options;

    // Validate path segments before creating DID to prevent directory traversal
    if (paths && paths.length > 0) {
      for (const segment of paths) {
        if (!this.isValidPathSegment(segment)) {
          throw new Error(`Invalid path segment in DID: "${segment}". Path segments cannot contain '.', '..', path separators, or be absolute paths.`);
        }
      }
    }

    // Dynamically import didwebvh-ts to avoid module resolution issues
    const mod = await import('didwebvh-ts') as unknown as {
      createDID: (options: Record<string, unknown>) => Promise<{
        did: string;
        doc: Record<string, unknown>;
        log: DIDLog;
      }>;
      prepareDataForSigning: (
        document: Record<string, unknown>,
        proof: Record<string, unknown>
      ) => Promise<Uint8Array>;
    };
    const { createDID, prepareDataForSigning } = mod;

    // Runtime validation of imported module
    if (typeof createDID !== 'function' || typeof prepareDataForSigning !== 'function') {
      throw new Error('Failed to load didwebvh-ts: invalid module exports');
    }

    let signer: Signer | ExternalSigner;
    let verifier: Verifier | ExternalVerifier;
    let keyPair: KeyPair | undefined;
    let verificationMethods: VerificationMethod[];
    let updateKeys: string[];

    // Use external signer if provided (e.g., Turnkey integration)
    if (externalSigner) {
      if (!providedVerificationMethods || providedVerificationMethods.length === 0) {
        throw new Error('verificationMethods are required when using externalSigner');
      }
      if (!providedUpdateKeys || providedUpdateKeys.length === 0) {
        throw new Error('updateKeys are required when using externalSigner');
      }


      signer = externalSigner;
      verifier = externalVerifier || (externalSigner as unknown as ExternalVerifier); // Use signer as verifier if not provided
      verificationMethods = providedVerificationMethods;
      updateKeys = providedUpdateKeys;
      keyPair = undefined; // No key pair when using external signer
    } else {
      // Generate or use provided key pair (Ed25519 for did:webvh)
      keyPair = providedKeyPair || await this.keyManager.generateKeyPair('Ed25519');

      // Create verification methods
      verificationMethods = [
        {
          type: 'Multikey',
          publicKeyMultibase: keyPair.publicKey,
        }
      ];

      // Create signer using our adapter
      const internalSigner = new OriginalsWebVHSigner(
        keyPair.privateKey,
        verificationMethods[0],
        prepareDataForSigning,
        { verificationMethod: verificationMethods[0] }
      );

      signer = internalSigner;
      verifier = internalSigner; // Use the same signer as verifier
      updateKeys = [`did:key:${keyPair.publicKey}`]; // Use did:key format for authorization
    }

    // Create the DID using didwebvh-ts
    const result = await createDID({
      domain,
      signer,
      verifier,
      updateKeys,
      verificationMethods,
      context: [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/multikey/v1'
      ],
      paths,
      portable,
      authentication: ['#key-0'],
      assertionMethod: ['#key-0'],
    });

    // Validate the returned DID document
    if (!this.isDIDDocument(result.doc)) {
      throw new Error('Invalid DID document returned from createDID');
    }

    // Save the log to did.jsonl if output directory is provided
    let logPath: string | undefined;
    if (outputDir) {
      logPath = await this.saveDIDLog(result.did, result.log, outputDir);
    }

    return {
      did: result.did,
      didDocument: result.doc,
      log: result.log,
      keyPair: keyPair || { publicKey: '', privateKey: '' }, // Return empty keypair if using external signer
      logPath,
    };
  }

  /**
   * Validates a path segment to prevent directory traversal attacks
   * @param segment - Path segment to validate
   * @returns true if valid, false otherwise
   */
  private isValidPathSegment(segment: string): boolean {
    // Reject empty segments, dots, or segments with path separators
    if (!segment || segment === '.' || segment === '..') {
      return false;
    }
    
    // Reject segments containing path separators or other dangerous characters
    if (segment.includes('/') || segment.includes('\\') || segment.includes('\0')) {
      return false;
    }
    
    // Reject absolute paths (starting with / or drive letter on Windows)
    if (path.isAbsolute(segment)) {
      return false;
    }
    
    return true;
  }

  /**
   * Type guard to validate a DID document structure
   * @param doc - Object to validate
   * @returns true if the object is a valid DIDDocument
   */
  private isDIDDocument(doc: unknown): doc is DIDDocument {
    if (!doc || typeof doc !== 'object') {
      return false;
    }
    
    const d = doc as Record<string, unknown>;
    
    // Check required fields
    if (!Array.isArray(d['@context']) || d['@context'].length === 0) {
      return false;
    }
    
    if (typeof d.id !== 'string' || !d.id.startsWith('did:')) {
      return false;
    }
    
    return true;
  }

  /**
   * Saves the DID log to the appropriate did.jsonl path
   * @param did - The DID identifier
   * @param log - The DID log to save
   * @param baseDir - Base directory for saving (e.g., public/.well-known)
   * @returns The full path where the log was saved
   */
  async saveDIDLog(did: string, log: DIDLog, baseDir: string): Promise<string> {
    // Parse the DID to extract domain and path components
    // Format: did:webvh:domain[:port]:path1:path2...
    const didParts = did.split(':');
    if (didParts.length < 3 || didParts[0] !== 'did' || didParts[1] !== 'webvh') {
      throw new Error('Invalid did:webvh format');
    }

    // Extract path parts (everything after domain)
    const pathParts = didParts.slice(3);

    // Validate all path segments to prevent directory traversal
    for (const segment of pathParts) {
      if (!this.isValidPathSegment(segment)) {
        throw new Error(`Invalid path segment in DID: "${segment}". Path segments cannot contain '.', '..', path separators, or be absolute paths.`);
      }
    }

    // Extract and sanitize domain for filesystem safety
    const rawDomain = decodeURIComponent(didParts[2]);
    // Normalize: lowercase and replace any characters not in [a-z0-9._-] with '_'
    const safeDomain = rawDomain
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '_');
    
    // Validate the sanitized domain (reject '..' and other dangerous patterns)
    if (!this.isValidPathSegment(safeDomain)) {
      throw new Error(`Invalid domain segment in DID: "${rawDomain}"`);
    }

    // Construct the file path with domain isolation
    // For did:webvh:example.com:user:alice -> baseDir/did/example.com/user/alice/did.jsonl
    // For did:webvh:example.com:alice -> baseDir/did/example.com/alice/did.jsonl
    const segments = [safeDomain, ...pathParts];
    const didPath = path.join(baseDir, 'did', ...segments, 'did.jsonl');

    // Verify the resolved path is still within baseDir (defense in depth)
    const resolvedBaseDir = path.resolve(baseDir);
    const resolvedPath = path.resolve(didPath);
    const relativePath = path.relative(resolvedBaseDir, resolvedPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('Invalid DID path: resolved path is outside base directory');
    }

    // Create directories if they don't exist
    const dirPath = path.dirname(didPath);
    await fs.promises.mkdir(dirPath, { recursive: true });

    // Convert log to JSONL format (one JSON object per line)
    const jsonlContent = log.map((entry: DIDLogEntry) => JSON.stringify(entry)).join('\n');

    // Write the log file
    await fs.promises.writeFile(didPath, jsonlContent, 'utf8');

    return didPath;
  }

  /**
   * Loads a DID log from a did.jsonl file
   * @param logPath - Path to the did.jsonl file
   * @returns The loaded DID log
   */
  async loadDIDLog(logPath: string): Promise<DIDLog> {
    const content = await fs.promises.readFile(logPath, 'utf8');
    const lines = content.trim().split('\n');
    return lines.map(line => JSON.parse(line) as DIDLogEntry);
  }

  /**
   * Updates a DID:WebVH document
   * @param did - The DID to update
   * @param currentLog - The current DID log
   * @param updates - Updates to apply to the DID document
   * @param signer - The signer to use (must be authorized in updateKeys)
   * @param verifier - Optional verifier
   * @param outputDir - Optional directory to save the updated log
   * @returns Updated DID document and log
   */
  async updateDIDWebVH(options: {
    did: string;
    currentLog: DIDLog;
    updates: Partial<DIDDocument>;
    signer: ExternalSigner | { privateKey: string; publicKey: string };
    verifier?: ExternalVerifier;
    outputDir?: string;
  }): Promise<{ didDocument: DIDDocument; log: DIDLog; logPath?: string }> {
    const { did, currentLog, updates, signer: providedSigner, verifier: providedVerifier, outputDir } = options;

    // Dynamically import didwebvh-ts
    const mod = await import('didwebvh-ts') as unknown as {
      updateDID: (options: Record<string, unknown>) => Promise<{
        doc: Record<string, unknown>;
        log: DIDLog;
      }>;
      prepareDataForSigning: (
        document: Record<string, unknown>,
        proof: Record<string, unknown>
      ) => Promise<Uint8Array>;
    };
    const { updateDID, prepareDataForSigning } = mod;

    if (typeof updateDID !== 'function') {
      throw new Error('Failed to load didwebvh-ts: invalid module exports');
    }

    let signer: Signer | ExternalSigner;
    let verifier: Verifier | ExternalVerifier | undefined;

    // Check if using external signer or internal keypair
    if ('sign' in providedSigner && 'getVerificationMethodId' in providedSigner) {
      // External signer
      signer = providedSigner;
      verifier = providedVerifier;
    } else {
      // Internal signer with keypair
      const keyPair = providedSigner;
      const verificationMethod: VerificationMethod = {
        type: 'Multikey',
        publicKeyMultibase: keyPair.publicKey,
      };
      
      const internalSigner = new OriginalsWebVHSigner(
        keyPair.privateKey,
        verificationMethod,
        prepareDataForSigning,
        { verificationMethod }
      );
      
      signer = internalSigner;
      verifier = internalSigner;
    }

    // Get the current document from the log
    const currentEntry = currentLog[currentLog.length - 1];
    const currentDoc = currentEntry.state as unknown as DIDDocument;

    // Merge updates with current document
    const updatedDoc = {
      ...currentDoc,
      ...updates,
      id: did, // Ensure ID doesn't change
    };

    // Update the DID using didwebvh-ts
    const result = await updateDID({
      log: currentLog,
      doc: updatedDoc,
      signer,
      verifier: verifier || undefined,
    });

    // Validate the returned DID document
    if (!this.isDIDDocument(result.doc)) {
      throw new Error('Invalid DID document returned from updateDID');
    }

    // Save the updated log if output directory is provided
    let logPath: string | undefined;
    if (outputDir) {
      logPath = await this.saveDIDLog(did, result.log, outputDir);
    }

    return {
      didDocument: result.doc,
      log: result.log,
      logPath,
    };
  }
}
