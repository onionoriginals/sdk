import { KeyManager } from './KeyManager.js';
import { multikey } from '../crypto/Multikey.js';
import { Ed25519Signer } from '../crypto/Signer.js';
import { DIDDocument, KeyPair, ExternalSigner, ExternalVerifier } from '../types/index.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base58 } from '@scure/base';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Compute the pre-rotation key hash for an update key.
 * Mirrors didwebvh-ts's internal `deriveNextKeyHash`:
 *   SHA-256(utf8(updateKey)) → prepend multihash header [0x12, 0x20] → base58btc encode (no multibase prefix).
 *
 * @param updateKey - The update key exactly as it will appear in `updateKeys`,
 *   i.e. a bare multikey string such as "z6Mk..." (didwebvh-ts >= 2.8 / did:webvh spec format)
 * @returns Base58btc-encoded multihash string suitable for use in `nextKeyHashes`
 */
export function computeNextKeyHash(updateKey: string): string {
  const data = new TextEncoder().encode(updateKey);
  const digest = sha256(data);
  // Multihash: 0x12 = sha2-256 code, 0x20 = 32 bytes (digest length)
  const multihash = new Uint8Array(2 + digest.length);
  multihash[0] = 0x12;
  multihash[1] = 0x20;
  multihash.set(digest, 2);
  return base58.encode(multihash);
}

/**
 * Normalize an update key to the bare multikey form required by
 * didwebvh-ts >= 2.8 (and the did:webvh spec): "z6Mk...".
 * Accepts legacy "did:key:z6Mk..." / "did:key:z6Mk...#z6Mk..." input and
 * strips the prefix and fragment.
 */
export function normalizeUpdateKey(key: string): string {
  if (key.startsWith('did:key:')) {
    return key.slice('did:key:'.length).split('#')[0];
  }
  return key;
}

/**
 * did:webvh log resolution in this SDK is Ed25519-only: DID-log proofs are
 * verified with Ed25519Verifier (see DIDManager.resolveDID), and per the
 * did:webvh spec each log entry must be signed by an updateKey. A DID whose
 * updateKeys are not Ed25519 would therefore sign successfully at create time
 * yet resolve to null everywhere — reject that up front.
 *
 * Note this deliberately checks ONLY updateKeys: a did:webvh document may
 * validly publish non-Ed25519 verification methods for other purposes
 * (e.g. X25519 keyAgreement) without affecting log resolvability.
 */
export function assertEd25519WebVHUpdateKeys(updateKeys: readonly string[] | undefined): void {
  for (const key of updateKeys ?? []) {
    let type: string;
    try {
      type = multikey.decodePublicKey(key).type;
    } catch {
      throw new Error(`did:webvh updateKey is not a valid public multikey: ${key}`);
    }
    if (type !== 'Ed25519') {
      throw new Error(
        `did:webvh only supports Ed25519 keys (resolution verifies DID logs with Ed25519); updateKey uses ${type}`
      );
    }
  }
}

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
  updateKeys?: string[]; // Pre-configured update keys as bare multikeys (e.g., ["z6Mk..."]); legacy "did:key:z6Mk..." values are normalized
  /**
   * Enable pre-rotation mode. When true, a second "next" key pair is generated
   * and its hash committed into `nextKeyHashes` of the initial log entry.
   * Each subsequent rotation must be signed by the pre-committed next key.
   * The generated `nextKeyPair` is returned in `CreateWebVHResult` and must be
   * persisted by the caller for use in the next `rotateDIDWebVHKeys` call.
   */
  prerotation?: boolean;
}

export interface CreateWebVHResult {
  did: string;
  didDocument: DIDDocument;
  log: DIDLog;
  keyPair: KeyPair;
  logPath?: string; // Path where the DID log was saved
  /**
   * Present only when `prerotation: true` was passed to `createDIDWebVH`.
   * This key pair is pre-committed (its hash stored in `nextKeyHashes`).
   * The caller MUST persist this and pass it as `currentKeyPair` in the
   * next `rotateDIDWebVHKeys` call to execute a valid pre-rotation.
   */
  nextKeyPair?: KeyPair;
}

export interface RotateWebVHKeysOptions {
  did: string;
  currentLog: DIDLog;
  /**
   * The key pair that signs the rotation entry.
   *
   * Non-pre-rotation mode (default): the key pair whose `did:key` is listed in
   * the previous entry's `updateKeys`.
   *
   * Pre-rotation mode (`prerotation: true`): the key pair whose hash was
   * pre-committed in the previous entry's `nextKeyHashes`. This key becomes
   * the new `updateKey` and signs the new entry.
   */
  currentKeyPair: KeyPair;
  /**
   * Non-pre-rotation mode only: optional replacement key pair; a fresh
   * Ed25519 pair is generated if omitted.
   * Ignored in pre-rotation mode — the next key is always freshly generated.
   */
  newKeyPair?: KeyPair;
  outputDir?: string;
  /**
   * Enable pre-rotation mode. When true, `currentKeyPair` must be the
   * pre-committed next key from the previous create/rotate result. A fresh
   * "next-next" key is generated, its hash committed in `nextKeyHashes`,
   * and returned as `nextKeyPair` in the result.
   */
  prerotation?: boolean;
}

export interface RotateWebVHKeysResult {
  log: DIDLog;
  didDocument: DIDDocument;
  newKeyPair: KeyPair;
  logPath?: string;
  /**
   * Present only when `prerotation: true`. The freshly generated key whose
   * hash was committed in this entry's `nextKeyHashes`. The caller MUST
   * persist this and pass it as `currentKeyPair` in the next rotation.
   */
  nextKeyPair?: KeyPair;
}

export interface RecoverWebVHOptions {
  did: string;
  currentLog: DIDLog;
  /** The current (possibly compromised) key pair used to authorize recovery. */
  signingKeyPair: KeyPair;
  /** Optional new key pair to recover to; a fresh Ed25519 pair is generated if omitted. */
  recoveryKeyPair?: KeyPair;
  outputDir?: string;
}

/** Minimal W3C VC documenting a key-compromise recovery. */
export interface KeyRecoveryCredential {
  '@context': string[];
  type: string[];
  issuer: string;
  issuanceDate: string;
  credentialSubject: {
    id: string;
    recoveredAt: string;
    recoveryReason: string;
    previousVerificationMethods: string[];
    newVerificationMethod: string;
  };
}

export interface RecoverWebVHResult {
  log: DIDLog;
  didDocument: DIDDocument;
  newKeyPair: KeyPair;
  recoveryCredential: KeyRecoveryCredential;
  logPath?: string;
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
      updateKeys: providedUpdateKeys,
      prerotation = false,
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

    // Pre-rotation is incompatible with externalSigner (which manages its own
    // key material externally). Check this up front, before the externalSigner
    // requirement validation below, so the clearer "not supported" error isn't
    // masked by a "verificationMethods are required" error the caller would hit
    // first only to then discover the combination is unsupported anyway.
    if (prerotation && externalSigner) {
      throw new Error('prerotation is not supported with externalSigner; manage nextKeyHashes externally');
    }

    // Use external signer if provided (e.g., Turnkey integration)
    if (externalSigner) {
      if (!providedVerificationMethods || providedVerificationMethods.length === 0) {
        throw new Error('verificationMethods are required when using externalSigner');
      }
      if (!providedUpdateKeys || providedUpdateKeys.length === 0) {
        throw new Error('updateKeys are required when using externalSigner');
      }


      signer = externalSigner;
      // An ExternalSigner has no verify(); silently casting it to a verifier
      // makes didwebvh-ts fail deep inside with "verifier.verify is not a
      // function". Accept the signer only if it actually implements verify().
      if (externalVerifier) {
        verifier = externalVerifier;
      } else if (typeof (externalSigner as unknown as { verify?: unknown }).verify === 'function') {
        verifier = externalSigner as unknown as ExternalVerifier;
      } else {
        throw new Error(
          'externalVerifier is required when the provided externalSigner does not implement verify()'
        );
      }
      verificationMethods = providedVerificationMethods;
      updateKeys = providedUpdateKeys.map(normalizeUpdateKey);
      assertEd25519WebVHUpdateKeys(updateKeys);
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
      // Bare multikey format per the did:webvh spec (didwebvh-ts >= 2.8)
      updateKeys = [keyPair.publicKey];
    }

    // Pre-rotation: generate the "next" key pair and commit its hash.
    // Not supported with externalSigner (which manages its own keys externally).
    let nextKeyPairForPrerotation: KeyPair | undefined;
    let nextKeyHashes: string[] | undefined;
    if (prerotation) {
      // (externalSigner + prerotation already rejected up front.)
      nextKeyPairForPrerotation = await this.keyManager.generateKeyPair('Ed25519');
      nextKeyHashes = [computeNextKeyHash(nextKeyPairForPrerotation.publicKey)];
    }

    // Create the DID using didwebvh-ts
    const createArgs: Record<string, unknown> = {
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
    };
    if (nextKeyHashes) {
      createArgs.nextKeyHashes = nextKeyHashes;
    }
    const result = await createDID(createArgs);

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
      ...(nextKeyPairForPrerotation ? { nextKeyPair: nextKeyPairForPrerotation } : {}),
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

    // updateDIDWebVH appends an ordinary (non-pre-rotation) entry. On a
    // pre-rotation chain that would set an un-committed updateKey and break
    // resolution, so refuse rather than silently corrupt the log. Document
    // updates on pre-rotation DIDs must go through the pre-rotation rotation path.
    if (this.logHasPendingPrerotation(currentLog)) {
      throw new Error(
        'updateDIDWebVH does not support DIDs on a pre-rotation chain (the latest log entry ' +
        'commits nextKeyHashes). Such DIDs require rotating to the pre-committed key for every ' +
        'new entry; use rotateDIDWebVHKeys with prerotation:true instead.'
      );
    }

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

  /**
   * Append a did:webvh log entry that rotates the signing key. The CURRENT key
   * pair (authorized by the latest entry's updateKeys) signs the rotation, and
   * the NEW key becomes both the verification method and the updateKey
   * authorized for the next rotation.
   */
  async rotateDIDWebVHKeys(options: RotateWebVHKeysOptions): Promise<RotateWebVHKeysResult> {
    const { did, currentLog, currentKeyPair, newKeyPair: providedNewKeyPair, outputDir, prerotation = false } = options;

    let rotationResult: { didDocument: DIDDocument; log: DIDLog };
    let newKeyPair: KeyPair;
    let nextKeyPairOut: KeyPair | undefined;

    if (prerotation) {
      // In pre-rotation mode:
      //   - currentKeyPair IS the pre-committed next key (signs + becomes updateKey).
      //   - A fresh "next-next" key is generated and its hash committed.
      //   - newKeyPair = currentKeyPair (the key that is now active).
      newKeyPair = currentKeyPair;
      const freshNextKeyPair = await this.keyManager.generateKeyPair('Ed25519');
      nextKeyPairOut = freshNextKeyPair;
      rotationResult = await this.appendKeyChangePrerotation(did, currentLog, currentKeyPair, freshNextKeyPair);
    } else {
      // Guard against silently corrupting a pre-rotation chain: if the latest
      // entry committed nextKeyHashes, a non-pre-rotation rotation would set an
      // un-committed updateKey and fail resolution. Require explicit opt-in
      // rather than auto-switching, because `currentKeyPair` has different
      // semantics in pre-rotation mode (it must be the pre-committed next key).
      if (this.logHasPendingPrerotation(currentLog)) {
        throw new Error(
          'This DID is on a pre-rotation chain (the latest log entry commits nextKeyHashes). ' +
          'Call rotateDIDWebVHKeys with prerotation:true and pass the pre-committed nextKeyPair ' +
          '(returned by the previous create/rotate) as currentKeyPair. A non-pre-rotation ' +
          'rotation would break verification and corrupt the DID history.'
        );
      }
      newKeyPair = providedNewKeyPair || await this.keyManager.generateKeyPair('Ed25519');
      rotationResult = await this.appendKeyChange(did, currentLog, currentKeyPair, newKeyPair);
    }

    let logPath: string | undefined;
    if (outputDir) {
      logPath = await this.saveDIDLog(did, rotationResult.log, outputDir);
    }

    return {
      log: rotationResult.log,
      didDocument: rotationResult.didDocument,
      newKeyPair,
      logPath,
      ...(nextKeyPairOut ? { nextKeyPair: nextKeyPairOut } : {}),
    };
  }

  /**
   * Recover a did:webvh after key compromise. Behaves like a rotation (the
   * compromised key authorizes the recovery entry, a new key takes over) and
   * additionally emits a W3C KeyRecoveryCredential documenting the event.
   */
  async recoverDIDWebVH(options: RecoverWebVHOptions): Promise<RecoverWebVHResult> {
    const { did, currentLog, signingKeyPair, recoveryKeyPair: providedRecoveryKeyPair, outputDir } = options;

    // recoverDIDWebVH appends an ordinary key-change entry; on a pre-rotation
    // chain that breaks the committed-key invariant and fails resolution.
    if (this.logHasPendingPrerotation(currentLog)) {
      throw new Error(
        'recoverDIDWebVH does not support DIDs on a pre-rotation chain (the latest log entry ' +
        'commits nextKeyHashes); a recovery entry would violate the pre-rotation invariant. ' +
        'Rotate to the pre-committed key via rotateDIDWebVHKeys with prerotation:true.'
      );
    }

    const newKeyPair = providedRecoveryKeyPair || await this.keyManager.generateKeyPair('Ed25519');

    const previousVerificationMethods = this.extractVerificationMethodIds(currentLog, signingKeyPair);
    const result = await this.appendKeyChange(did, currentLog, signingKeyPair, newKeyPair);
    const newVerificationMethod = this.extractVerificationMethodIds(result.log, newKeyPair)[0]
      || `did:key:${newKeyPair.publicKey}`;

    const now = new Date().toISOString();
    const recoveryCredential: KeyRecoveryCredential = {
      '@context': [
        'https://www.w3.org/2018/credentials/v1',
        'https://w3id.org/security/multikey/v1'
      ],
      type: ['VerifiableCredential', 'KeyRecoveryCredential'],
      issuer: did,
      issuanceDate: now,
      credentialSubject: {
        id: did,
        recoveredAt: now,
        recoveryReason: 'key_compromise',
        previousVerificationMethods,
        newVerificationMethod,
      },
    };

    let logPath: string | undefined;
    if (outputDir) {
      logPath = await this.saveDIDLog(did, result.log, outputDir);
    }

    return { log: result.log, didDocument: result.didDocument, newKeyPair, recoveryCredential, logPath };
  }

  /**
   * True when the latest log entry commits a non-empty `nextKeyHashes`, i.e. the
   * DID is on a pre-rotation chain. The next entry MUST be produced via the
   * pre-rotation path (signed by, and authorizing, the pre-committed key);
   * appending an ordinary key-change/update entry would set an un-committed
   * updateKey, fail `newKeysAreInNextKeys` during resolution, and silently
   * corrupt the log. Callers that would append a non-pre-rotation entry use this
   * to fail fast with a clear error instead.
   */
  private logHasPendingPrerotation(currentLog: DIDLog): boolean {
    if (currentLog.length === 0) return false;
    const last = currentLog[currentLog.length - 1];
    const hashes = (last.parameters as { nextKeyHashes?: string[] }).nextKeyHashes;
    return Array.isArray(hashes) && hashes.length > 0;
  }

  /**
   * Shared primitive: append a signed did:webvh log entry that replaces the
   * verification method and updateKey with `newKeyPair`, signed by
   * `currentKeyPair`.
   */
  private async appendKeyChange(
    did: string,
    currentLog: DIDLog,
    currentKeyPair: KeyPair,
    newKeyPair: KeyPair
  ): Promise<{ didDocument: DIDDocument; log: DIDLog }> {
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

    const currentVerificationMethod: VerificationMethod = {
      type: 'Multikey',
      publicKeyMultibase: currentKeyPair.publicKey,
    };
    const signer = new OriginalsWebVHSigner(
      currentKeyPair.privateKey,
      currentVerificationMethod,
      prepareDataForSigning,
      { verificationMethod: currentVerificationMethod }
    );

    const newVerificationMethod: VerificationMethod = {
      type: 'Multikey',
      publicKeyMultibase: newKeyPair.publicKey,
    };

    const result = await updateDID({
      log: currentLog,
      signer,
      verifier: signer,
      updateKeys: [newKeyPair.publicKey],
      verificationMethods: [newVerificationMethod],
      authentication: ['#key-0'],
      assertionMethod: ['#key-0'],
    });

    if (!this.isDIDDocument(result.doc)) {
      throw new Error('Invalid DID document returned from updateDID');
    }

    return { didDocument: result.doc, log: result.log };
  }

  /**
   * Pre-rotation variant of appendKeyChange.
   *
   * In pre-rotation mode the key that was previously hashed into `nextKeyHashes`
   * (`activeKeyPair`) becomes both:
   *   - the signer of the new log entry (proving possession of the pre-committed key), and
   *   - the new `updateKey` for future entries.
   *
   * A fresh `nextKeyPair` is generated and its hash committed in `nextKeyHashes`,
   * continuing the pre-rotation chain.
   *
   * didwebvh-ts enforces this invariant: when the previous entry has non-empty
   * `nextKeyHashes`, verification uses the new entry's `updateKeys` (not the
   * previous ones) to check the proof. So the signer MUST be `activeKeyPair`.
   */
  private async appendKeyChangePrerotation(
    did: string,
    currentLog: DIDLog,
    activeKeyPair: KeyPair,
    nextKeyPair: KeyPair
  ): Promise<{ didDocument: DIDDocument; log: DIDLog }> {
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

    // Enforce the pre-rotation invariant at SDK level:
    // The activeKeyPair's hash must appear in the previous entry's nextKeyHashes.
    // (didwebvh-ts only checks this during log resolution, not at updateDID time.)
    if (currentLog.length === 0) {
      throw new Error('Cannot perform pre-rotation on an empty DID log');
    }
    const lastEntry = currentLog[currentLog.length - 1];
    const prevNextKeyHashes = (lastEntry.parameters as { nextKeyHashes?: string[] }).nextKeyHashes ?? [];
    if (prevNextKeyHashes.length === 0) {
      throw new Error(
        'Pre-rotation rotation requires the current log to have nextKeyHashes committed. ' +
        'The DID was not created with prerotation:true or the chain is broken.'
      );
    }
    const activeKeyHash = computeNextKeyHash(activeKeyPair.publicKey);
    if (!prevNextKeyHashes.includes(activeKeyHash)) {
      throw new Error(
        `Pre-rotation violation: currentKeyPair hash (${activeKeyHash}) is not in the ` +
        `previous entry's nextKeyHashes (${prevNextKeyHashes.join(', ')}). ` +
        'Pass the nextKeyPair returned from the previous create/rotate call.'
      );
    }

    // The active (pre-committed) key signs the entry and becomes updateKey.
    const activeVerificationMethod: VerificationMethod = {
      type: 'Multikey',
      publicKeyMultibase: activeKeyPair.publicKey,
    };
    const signer = new OriginalsWebVHSigner(
      activeKeyPair.privateKey,
      activeVerificationMethod,
      prepareDataForSigning,
      { verificationMethod: activeVerificationMethod }
    );

    // Commit the hash of the next key to continue the pre-rotation chain.
    const nextKeyHashes = [computeNextKeyHash(nextKeyPair.publicKey)];

    const result = await updateDID({
      log: currentLog,
      signer,
      verifier: signer,
      updateKeys: [activeKeyPair.publicKey],
      nextKeyHashes,
      verificationMethods: [activeVerificationMethod],
      authentication: ['#key-0'],
      assertionMethod: ['#key-0'],
    });

    if (!this.isDIDDocument(result.doc)) {
      throw new Error('Invalid DID document returned from updateDID');
    }

    return { didDocument: result.doc, log: result.log };
  }

  /**
   * Extract verification method identifiers from the latest log entry's DID
   * document, falling back to the did:key form of the supplied key pair.
   */
  private extractVerificationMethodIds(log: DIDLog, keyPair: KeyPair): string[] {
    const lastEntry = log[log.length - 1];
    const state = lastEntry?.state as { verificationMethod?: Array<{ id?: string }> } | undefined;
    const vms = state?.verificationMethod;
    if (Array.isArray(vms) && vms.length > 0) {
      const ids = vms.map(vm => vm?.id).filter((id): id is string => typeof id === 'string');
      if (ids.length > 0) {
        return ids;
      }
    }
    return [`did:key:${keyPair.publicKey}`];
  }
}
