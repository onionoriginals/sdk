import { DIDDocument, OriginalsConfig, AssetResource, KeyPair, ExternalSigner, ExternalVerifier } from '../types';
import { getNetworkDomain, DEFAULT_WEBVH_NETWORK, getBitcoinNetworkForWebVH } from '../types/network';
import { BtcoDidResolver } from './BtcoDidResolver';
import { OrdinalsClient } from '../bitcoin/OrdinalsClient';
import { createBtcoDidDocument } from './createBtcoDidDocument';
import { OrdinalsClientProviderAdapter } from './providers/OrdinalsClientProviderAdapter';
import { multikey } from '../crypto/Multikey';
import { KeyManager } from './KeyManager';
import { Ed25519Signer } from '../crypto/Signer';
import { validateSatoshiNumber, MAX_SATOSHI_SUPPLY } from '../utils/satoshi-validation';
import * as fs from 'fs';
import * as path from 'path';

export class DIDManager {
  constructor(private config: OriginalsConfig) {}

  async createDIDPeer(resources: AssetResource[], returnKeyPair?: false): Promise<DIDDocument>;
  async createDIDPeer(resources: AssetResource[], returnKeyPair: true): Promise<{ didDocument: DIDDocument; keyPair: { privateKey: string; publicKey: string } }>;
  async createDIDPeer(resources: AssetResource[], returnKeyPair?: boolean): Promise<DIDDocument | { didDocument: DIDDocument; keyPair: { privateKey: string; publicKey: string } }> {
    // Generate a multikey keypair according to configured defaultKeyType
    const keyManager = new KeyManager();
    const desiredType = this.config.defaultKeyType || 'ES256K';
    const keyPair = await keyManager.generateKeyPair(desiredType);

    // Use @aviarytech/did-peer to create a did:peer (variant 4 long-form for full VM+context)
    const didPeerMod = await import('@aviarytech/did-peer') as {
      createNumAlgo4: (vms: unknown[], service?: unknown, extra?: unknown) => Promise<string>;
      resolve: (did: string) => Promise<Record<string, unknown>>;
    };
    const did: string = await didPeerMod.createNumAlgo4(
      [
        {
          // type validated by the library; controller/id not required
          type: 'Multikey',
          publicKeyMultibase: keyPair.publicKey
        }
      ],
      undefined,
      undefined
    );

    // Resolve to DID Document using the same library
    const rawResolved = await didPeerMod.resolve(did);
    // Type the resolved document properly
    const resolved = rawResolved as unknown as {
      id?: string;
      verificationMethod?: Array<Record<string, unknown>>;
      authentication?: string[];
      assertionMethod?: string[];
      [key: string]: unknown;
    };
    // Ensure controller is set on VM entries for compatibility
    if (resolved && Array.isArray(resolved.verificationMethod)) {
      resolved.verificationMethod = resolved.verificationMethod.map((vm) => ({
        controller: did,
        ...vm
      }));
    }
    // Ensure relationships exist and reference a VM
    const vmIds: string[] = Array.isArray(resolved?.verificationMethod)
      ? (resolved.verificationMethod as Array<{ id?: string }>).map((vm) => vm.id).filter(Boolean) as string[]
      : [];
    if (!resolved.authentication || resolved.authentication.length === 0) {
      if (vmIds.length > 0) resolved.authentication = [vmIds[0]];
    }
    if (!resolved.assertionMethod || resolved.assertionMethod.length === 0) {
      resolved.assertionMethod = resolved.authentication || (vmIds.length > 0 ? [vmIds[0]] : []);
    }

    if (returnKeyPair) {
      return { didDocument: resolved as unknown as DIDDocument, keyPair };
    }
    return resolved as unknown as DIDDocument;
  }

  async migrateToDIDWebVH(didDoc: DIDDocument, domain?: string): Promise<DIDDocument> {
    // Use provided domain or get default from configured network
    const network = this.config.webvhNetwork || DEFAULT_WEBVH_NETWORK;
    const targetDomain = domain || getNetworkDomain(network);

    // Flexible domain validation - allow development domains with ports
    const normalized = String(targetDomain || '').trim().toLowerCase();
    
    // Split domain and port if present
    const [domainPart, portPart] = normalized.split(':');
    
    // Validate port if present
    if (portPart && (!/^\d+$/.test(portPart) || parseInt(portPart) < 1 || parseInt(portPart) > 65535)) {
      throw new Error(`Invalid domain: ${domain} - invalid port`);
    }
    
    // Allow localhost and IP addresses for development
    const isLocalhost = domainPart === 'localhost';
    const isIP = /^(\d{1,3}\.){3}\d{1,3}$/.test(domainPart);
    
    if (!isLocalhost && !isIP) {
      // For non-localhost domains, require proper domain format
      const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
      const domainRegex = new RegExp(`^(?=.{1,253}$)(?:${label})(?:\\.(?:${label}))+?$`, 'i');
      if (!domainRegex.test(domainPart)) {
        throw new Error('Invalid domain');
      }
    }

    // Stable slug derived from original peer DID suffix (or last segment)
    const parts = (didDoc.id || '').split(':');
    const method = parts.slice(0, 2).join(':');
    const originalSuffix = method === 'did:peer' ? parts.slice(2).join(':') : parts[parts.length - 1];
    const slug = (originalSuffix || '')
      .toString()
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .toLowerCase();

    const migrated: DIDDocument = {
      ...didDoc,
      id: `did:webvh:${normalized}:${slug}`
    };
    return await Promise.resolve(migrated);
  }

  async migrateToDIDBTCO(didDoc: DIDDocument, satoshi: string): Promise<DIDDocument> {
    // Validate satoshi parameter
    const validation = validateSatoshiNumber(satoshi);
    if (!validation.valid) {
      throw new Error(`Invalid satoshi identifier: ${validation.error}`);
    }

    // Additional range validation for positive values within Bitcoin supply
    const satoshiNum = Number(satoshi);
    if (satoshiNum < 0) {
      throw new Error('Satoshi identifier must be positive (>= 0)');
    }
    if (satoshiNum > MAX_SATOSHI_SUPPLY) {
      throw new Error(`Satoshi identifier must be within Bitcoin's total supply (0 to ${MAX_SATOSHI_SUPPLY.toLocaleString()})`);
    }

    // Determine Bitcoin network from WebVH network configuration if available
    // This ensures consistent environment mapping: magby→regtest, cleffa→signet, pichu→mainnet
    let network: 'mainnet' | 'regtest' | 'signet';
    if (this.config.webvhNetwork) {
      network = getBitcoinNetworkForWebVH(this.config.webvhNetwork);
    } else {
      // Fall back to explicit network config
      network = this.config.network || 'mainnet';
    }

    // Try to carry over the first multikey VM if present
    const firstVm = didDoc.verificationMethod?.[0];
    let publicKey: Uint8Array | undefined;
    let keyType: Parameters<typeof createBtcoDidDocument>[2]['keyType'] | undefined;
    try {
      if (firstVm && firstVm.publicKeyMultibase) {
        const decoded = multikey.decodePublicKey(firstVm.publicKeyMultibase);
        publicKey = decoded.key;
        keyType = decoded.type;
      }
    } catch (err) {
      // Unable to decode public key from verification method; will proceed without key material
      if (this.config.enableLogging) {
        console.warn('Failed to decode verification method public key:', err);
      }
    }

    // If no key material is available, generate a minimal btco DID doc without keys
    let btcoDoc: DIDDocument;
    if (publicKey && keyType) {
      btcoDoc = createBtcoDidDocument(satoshi, network, { publicKey, keyType });
    } else {
      const prefix = network === 'mainnet' ? 'did:btco:' : network === 'regtest' ? 'did:btco:reg:' : 'did:btco:sig:';
      btcoDoc = {
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: prefix + String(satoshi)
      };
    }

    // Carry over service endpoints if present
    if (didDoc.service && didDoc.service.length > 0) {
      btcoDoc.service = didDoc.service;
    }
    return await Promise.resolve(btcoDoc);
  }

  async resolveDID(did: string): Promise<DIDDocument | null> {
    try {
      if (did.startsWith('did:peer:')) {
        try {
          const mod = await import('@aviarytech/did-peer') as { resolve: (did: string) => Promise<Record<string, unknown>> };
          const doc = await mod.resolve(did);
          return doc as unknown as DIDDocument;
        } catch (err) {
          // Failed to resolve did:peer; returning minimal document
          if (this.config.enableLogging) {
            console.warn('Failed to resolve did:peer:', err);
          }
        }
        return { '@context': ['https://www.w3.org/ns/did/v1'], id: did };
      }
      if (did.startsWith('did:btco:') || did.startsWith('did:btco:test:') || did.startsWith('did:btco:sig:')) {
        const rpcUrl = this.config.bitcoinRpcUrl || 'http://localhost:3000';
        const network = this.config.network || 'mainnet';
        const client = new OrdinalsClient(rpcUrl, network);
        const adapter = new OrdinalsClientProviderAdapter(client, rpcUrl);
        const resolver = new BtcoDidResolver({ provider: adapter });
        const result = await resolver.resolve(did);
        return result.didDocument || null;
      }
      if (did.startsWith('did:webvh:')) {
        try {
          const mod = await import('didwebvh-ts') as { resolveDID?: (did: string) => Promise<{ doc?: Record<string, unknown> }> };
          if (mod && typeof mod.resolveDID === 'function') {
            const result = await mod.resolveDID(did);
            if (result && result.doc) return result.doc as unknown as DIDDocument;
          }
        } catch (err) {
          // Failed to resolve did:webvh; returning minimal document
          if (this.config.enableLogging) {
            console.warn('Failed to resolve did:webvh:', err);
          }
        }
        return { '@context': ['https://www.w3.org/ns/did/v1'], id: did };
      }
      return { '@context': ['https://www.w3.org/ns/did/v1'], id: did };
    } catch (err) {
      // DID resolution failed
      if (this.config.enableLogging) {
        console.error('Failed to resolve DID:', err);
      }
      return null;
    }
  }

  validateDIDDocument(didDoc: DIDDocument): boolean {
    return !!didDoc.id && Array.isArray(didDoc['@context']);
  }

  private getLayerFromDID(did: string): 'did:peer' | 'did:webvh' | 'did:btco' {
    if (did.startsWith('did:peer:')) return 'did:peer';
    if (did.startsWith('did:webvh:')) return 'did:webvh';
    if (did.startsWith('did:btco:')) return 'did:btco';
    throw new Error('Unsupported DID method');
  }

  createBtcoDidDocument(
    satNumber: number | string,
    network: 'mainnet' | 'regtest' | 'signet',
    options: Parameters<typeof createBtcoDidDocument>[2]
  ): DIDDocument {
    return createBtcoDidDocument(satNumber, network, options);
  }

  // ========================================================================
  // DID:WebVH Methods
  // ========================================================================

  /**
   * Creates a new did:webvh DID with proper cryptographic signing
   * @param options - Creation options including domain and optional key pair or external signer
   * @returns The created DID, document, log, and key pair (if generated)
   */
  async createDIDWebVH(options: CreateWebVHOptions): Promise<CreateWebVHResult> {
    const {
      domain: providedDomain,
      keyPair: providedKeyPair,
      paths = [],
      portable = false,
      outputDir,
      externalSigner,
      externalVerifier,
      verificationMethods: providedVerificationMethods,
      updateKeys: providedUpdateKeys
    } = options;

    // Use provided domain or get default from configured network
    const network = this.config.webvhNetwork || DEFAULT_WEBVH_NETWORK;
    const domain = providedDomain || getNetworkDomain(network);

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
    let verificationMethods: WebVHVerificationMethod[];
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
      const keyManager = new KeyManager();
      keyPair = providedKeyPair || await keyManager.generateKeyPair('Ed25519');

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
    if (!this.validateDIDDocument(result.doc as unknown as DIDDocument)) {
      throw new Error('Invalid DID document returned from createDID');
    }

    // Save the log to did.jsonl if output directory is provided
    let logPath: string | undefined;
    if (outputDir) {
      logPath = await this.saveDIDLog(result.did, result.log, outputDir);
    }

    return {
      did: result.did,
      didDocument: result.doc as unknown as DIDDocument,
      log: result.log,
      keyPair: keyPair || { publicKey: '', privateKey: '' }, // Return empty keypair if using external signer
      logPath,
    };
  }

  /**
   * Updates a DID:WebVH document
   * @param options - Update options
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
      const verificationMethod: WebVHVerificationMethod = {
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
      verifier,
    });

    // Validate the returned DID document
    if (!this.validateDIDDocument(result.doc as unknown as DIDDocument)) {
      throw new Error('Invalid DID document returned from updateDID');
    }

    // Save the updated log if output directory is provided
    let logPath: string | undefined;
    if (outputDir) {
      logPath = await this.saveDIDLog(did, result.log, outputDir);
    }

    return {
      didDocument: result.doc as unknown as DIDDocument,
      log: result.log,
      logPath,
    };
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
}

// Type definitions for didwebvh-ts (to avoid module resolution issues)
interface WebVHVerificationMethod {
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
  verificationMethod?: WebVHVerificationMethod | null;
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

export interface CreateWebVHOptions {
  domain?: string; // Optional - defaults to configured webvhNetwork domain
  keyPair?: KeyPair;
  paths?: string[];
  portable?: boolean;
  outputDir?: string;
  externalSigner?: ExternalSigner;
  externalVerifier?: ExternalVerifier;
  verificationMethods?: WebVHVerificationMethod[];
  updateKeys?: string[];
}

export interface CreateWebVHResult {
  did: string;
  didDocument: DIDDocument;
  log: DIDLog;
  keyPair: KeyPair;
  logPath?: string;
}

/**
 * Adapter to use Originals SDK signers with didwebvh-ts
 */
class OriginalsWebVHSigner implements Signer, Verifier {
  private privateKeyMultibase: string;
  private signer: Ed25519Signer;
  protected verificationMethod?: WebVHVerificationMethod | null;
  protected useStaticId: boolean;
  private prepareDataForSigning: (document: Record<string, unknown>, proof: Record<string, unknown>) => Promise<Uint8Array>;

  constructor(
    privateKeyMultibase: string,
    verificationMethod: WebVHVerificationMethod,
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


