import { KeyManager } from './KeyManager';
import { multikey } from '../crypto/Multikey';
import { Ed25519Signer } from '../crypto/Signer';
import { DIDDocument, KeyPair } from '../types';
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
  document: any;
  proof: any;
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
  parameters: any;
  state: any;
  proof?: any[];
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
  private prepareDataForSigning: any;

  constructor(
    privateKeyMultibase: string,
    verificationMethod: VerificationMethod,
    prepareDataForSigning: any,
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
    const signature = await this.signer.sign(
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
    return this.signer.verify(
      Buffer.from(message),
      Buffer.from(signature),
      publicKeyMultibase
    );
  }

  getVerificationMethodId(): string {
    if (this.useStaticId) {
      return '#key-0';
    }
    return this.verificationMethod?.id || '#key-0';
  }
}

export interface CreateWebVHOptions {
  domain: string;
  keyPair?: KeyPair;
  paths?: string[];
  portable?: boolean;
  outputDir?: string; // Directory to save the DID log (did.jsonl)
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
   * @param options - Creation options including domain and optional key pair
   * @returns The created DID, document, log, and key pair
   */
  async createDIDWebVH(options: CreateWebVHOptions): Promise<CreateWebVHResult> {
    const { domain, keyPair: providedKeyPair, paths = [], portable = false, outputDir } = options;

    // Generate or use provided key pair (Ed25519 for did:webvh)
    const keyPair = providedKeyPair || await this.keyManager.generateKeyPair('Ed25519');

    // Decode the public key to get raw bytes
    const decodedPublicKey = multikey.decodePublicKey(keyPair.publicKey);
    const publicKeyBytes = decodedPublicKey.key;

    // Create verification methods
    const verificationMethods: VerificationMethod[] = [
      {
        type: 'Multikey',
        publicKeyMultibase: keyPair.publicKey,
      }
    ];

    // Dynamically import didwebvh-ts to avoid module resolution issues
    const mod: any = await import('didwebvh-ts');
    const { createDID, prepareDataForSigning } = mod;

    // Create signer using our adapter
    const signer = new OriginalsWebVHSigner(
      keyPair.privateKey,
      verificationMethods[0],
      prepareDataForSigning,
      { verificationMethod: verificationMethods[0] }
    );

    // Create the DID using didwebvh-ts
    const result = await createDID({
      domain,
      signer,
      updateKeys: [keyPair.publicKey], // Use the same key for updates
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

    // Save the log to did.jsonl if output directory is provided
    let logPath: string | undefined;
    if (outputDir) {
      logPath = await this.saveDIDLog(result.did, result.log, outputDir);
    }

    return {
      did: result.did,
      didDocument: result.doc as DIDDocument,
      log: result.log,
      keyPair,
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

    // Extract domain (handle URL-encoded ports like localhost%3A5000)
    const domainPart = decodeURIComponent(didParts[2]);
    
    // Extract path parts (everything after domain)
    const pathParts = didParts.slice(3);

    // Validate all path segments to prevent directory traversal
    for (const segment of pathParts) {
      if (!this.isValidPathSegment(segment)) {
        throw new Error(`Invalid path segment in DID: "${segment}". Path segments cannot contain '.', '..', path separators, or be absolute paths.`);
      }
    }

    // Construct the file path
    // For did:webvh:example.com:user:alice -> .well-known/did/user/alice/did.jsonl
    // For did:webvh:example.com:alice -> .well-known/did/alice/did.jsonl
    const didPath = pathParts.length > 0 
      ? path.join(baseDir, 'did', ...pathParts, 'did.jsonl')
      : path.join(baseDir, 'did', 'did.jsonl');

    // Verify the resolved path is still within baseDir (defense in depth)
    const resolvedPath = path.resolve(didPath);
    const resolvedBaseDir = path.resolve(baseDir);
    if (!resolvedPath.startsWith(resolvedBaseDir)) {
      throw new Error('Invalid DID path: resolved path is outside base directory');
    }

    // Create directories if they don't exist
    const dirPath = path.dirname(didPath);
    await fs.promises.mkdir(dirPath, { recursive: true });

    // Convert log to JSONL format (one JSON object per line)
    const jsonlContent = log.map((entry: any) => JSON.stringify(entry)).join('\n');

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
    return lines.map(line => JSON.parse(line));
  }
}
