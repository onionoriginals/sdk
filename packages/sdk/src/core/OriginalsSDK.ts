import { DIDManager } from '../did/DIDManager';
import { CredentialManager } from '../vc/CredentialManager';
import { LifecycleManager } from '../lifecycle/LifecycleManager';
import { BitcoinManager } from '../bitcoin/BitcoinManager';
import { OriginalsConfig, KeyStore, ExternalSigner, ExternalVerifier } from '../types';
import { DIDDocument, VerificationMethod, ServiceEndpoint } from '../types/did';
import { DEFAULT_WEBVH_NETWORK } from '../types/network';
import { emitTelemetry, StructuredError } from '../utils/telemetry';
import { Logger } from '../utils/Logger';
import { MetricsCollector } from '../utils/MetricsCollector';
import { EventLogger } from '../utils/EventLogger';
import { createDID } from 'didwebvh-ts';

// Type for DID log (from didwebvh-ts)
interface DIDLogEntry {
  versionId: string;
  versionTime: string;
  parameters: Record<string, unknown>;
  state: Record<string, unknown>;
  proof?: Record<string, unknown>[];
}

type DIDLog = DIDLogEntry[];

// Type for DID resolution metadata (from didwebvh-ts)
interface DIDResolutionMeta {
  versionId: string;
  created: string;
  updated: string;
  previousLogEntryHash?: string;
  updateKeys: string[];
  scid: string;
  prerotation: boolean;
  portable: boolean;
  nextKeyHashes: string[];
  deactivated: boolean;
  witness?: unknown;
  watchers?: string[] | null;
  error?: string;
  problemDetails?: unknown;
  latestVersionId?: string;
}

// Base result type for Original creation/update
export interface OriginalResult {
  did: string;
  doc: DIDDocument;
  log: DIDLog;
  meta: DIDResolutionMeta;
}

// DID-based Original creation options
export interface CreateDIDOriginalOptions {
  type: 'did';
  domain: string;
  signer: ExternalSigner;
  verifier?: ExternalVerifier;
  updateKeys: string[];
  verificationMethods: VerificationMethod[];
  paths?: string[];
  controller?: string;
  context?: string | string[] | object | object[];
  alsoKnownAs?: string[];
  portable?: boolean;
  nextKeyHashes?: string[];
  authentication?: string[];
  assertionMethod?: string[];
  keyAgreement?: string[];
  services?: ServiceEndpoint[];
}

// DID-based Original update options
export interface UpdateDIDOriginalOptions {
  type: 'did';
  log: DIDLog;
  signer: ExternalSigner;
  verifier?: ExternalVerifier;
  updateKeys?: string[];
  verificationMethods?: VerificationMethod[];
  services?: ServiceEndpoint[];
  controller?: string;
  context?: string | string[] | object | object[];
  alsoKnownAs?: string[];
  portable?: boolean;
  nextKeyHashes?: string[];
  authentication?: string[];
  assertionMethod?: string[];
  keyAgreement?: string[];
  domain?: string;
}

// Union type for all Original creation options
export type CreateOriginalOptions = CreateDIDOriginalOptions;

// Union type for all Original update options
export type UpdateOriginalOptions = UpdateDIDOriginalOptions;

export interface OriginalsSDKOptions extends Partial<OriginalsConfig> {
  keyStore?: KeyStore;
}

export class OriginalsSDK {
  public readonly did: DIDManager;
  public readonly credentials: CredentialManager;
  public readonly lifecycle: LifecycleManager;
  public readonly bitcoin: BitcoinManager;
  public readonly logger: Logger;
  public readonly metrics: MetricsCollector;
  private eventLogger: EventLogger;
  private config: OriginalsConfig;

  constructor(config: OriginalsConfig, keyStore?: KeyStore) {
    // Input validation
    if (!config || typeof config !== 'object') {
      throw new Error('Configuration object is required');
    }
    if (!config.network || !['mainnet', 'testnet', 'regtest', 'signet'].includes(config.network)) {
      throw new Error('Invalid network: must be mainnet, testnet, regtest, or signet');
    }
    if (!config.defaultKeyType || !['ES256K', 'Ed25519', 'ES256'].includes(config.defaultKeyType)) {
      throw new Error('Invalid defaultKeyType: must be ES256K, Ed25519, or ES256');
    }
    
    this.config = config;
    
    // Initialize logger and metrics
    this.logger = new Logger('SDK', config);
    this.metrics = new MetricsCollector();
    this.eventLogger = new EventLogger(this.logger.child('Events'), this.metrics);
    
    // Log SDK initialization
    this.logger.info('Initializing Originals SDK', { 
      network: config.network,
      keyType: config.defaultKeyType 
    });
    
    emitTelemetry(config.telemetry, { name: 'sdk.init', attributes: { network: config.network } });
    
    // Initialize managers
    this.did = new DIDManager(config);
    this.credentials = new CredentialManager(config, this.did);
    this.lifecycle = new LifecycleManager(config, this.did, this.credentials, undefined, keyStore);
    this.bitcoin = new BitcoinManager(config);
    
    // Set up event logging integration
    this.setupEventLogging();
    
    this.logger.info('SDK initialized successfully');
  }
  
  /**
   * Set up event logging integration
   */
  private setupEventLogging(): void {
    // Configure event logging from config
    if (this.config.logging?.eventLogging) {
      this.eventLogger.configureEventLogging(this.config.logging.eventLogging);
    }
    
    // Subscribe to lifecycle events
    this.eventLogger.subscribeToEvents((this.lifecycle as any).eventEmitter);
  }


  /**
   * Validates that the SDK is properly configured for Bitcoin operations.
   * Throws a StructuredError if ordinalsProvider is not configured.
   * 
   * @throws {StructuredError} When ordinalsProvider is not configured
   */
  validateBitcoinConfig(): void {
    if (!this.config.ordinalsProvider) {
      throw new StructuredError(
        'ORD_PROVIDER_REQUIRED',
        'Bitcoin operations require an ordinalsProvider to be configured. ' +
        'Please provide an ordinalsProvider when creating the SDK. ' +
        'See README.md for configuration examples.'
      );
    }
  }

  static create(options?: OriginalsSDKOptions): OriginalsSDK {
    const { keyStore, ...configOptions } = options || {};
    const defaultConfig: OriginalsConfig = {
      network: 'mainnet',
      defaultKeyType: 'ES256K',
      enableLogging: false,
      webvhNetwork: DEFAULT_WEBVH_NETWORK, // Default to 'pichu' (production)
    };
    return new OriginalsSDK({ ...defaultConfig, ...configOptions }, keyStore);
  }

  /**
   * Prepare data for signing using didwebvh-ts's canonical approach
   * This is a public static helper method that wraps didwebvh-ts's prepareDataForSigning
   * to ensure didwebvh-ts is only imported within the SDK
   */
  static async prepareDIDDataForSigning(
    document: Record<string, unknown>,
    proof: Record<string, unknown>
  ): Promise<Uint8Array> {
    // Dynamically import didwebvh-ts to avoid module resolution issues
    const mod = await import('didwebvh-ts') as unknown as {
      prepareDataForSigning: (
        document: Record<string, unknown>,
        proof: Record<string, unknown>
      ) => Promise<Uint8Array>;
    };

    const { prepareDataForSigning } = mod;

    // Runtime validation
    if (typeof prepareDataForSigning !== 'function') {
      throw new Error('Failed to load didwebvh-ts: prepareDataForSigning is not a function');
    }

    return prepareDataForSigning(document, proof);
  }

  /**
   * Verify a DID signature using Ed25519
   * This is a public static helper method that provides browser-compatible Ed25519 verification
   * Works with Uint8Array inputs (no Buffer required)
   * 
   * @param signature - The signature bytes (Uint8Array)
   * @param message - The message bytes that were signed (Uint8Array)
   * @param publicKey - The public key bytes (Uint8Array, should be 32 bytes for Ed25519)
   * @returns True if the signature is valid
   */
  static async verifyDIDSignature(
    signature: Uint8Array,
    message: Uint8Array,
    publicKey: Uint8Array
  ): Promise<boolean> {
    // Dynamically import @noble/ed25519 to avoid module resolution issues
    const ed25519Mod = await import('@noble/ed25519');
    
    // Ed25519 public keys must be exactly 32 bytes
    // Some keys may have a version byte prefix, so remove it if present
    let ed25519PublicKey = publicKey;
    if (publicKey.length === 33) {
      ed25519PublicKey = publicKey.slice(1);
    } else if (publicKey.length !== 32) {
      throw new Error(`Invalid Ed25519 public key length: ${publicKey.length} (expected 32 bytes)`);
    }
    
    // Verify using @noble/ed25519 with Uint8Array (browser-compatible)
    // ed25519.verifyAsync accepts Uint8Array directly
    try {
      return await ed25519Mod.verifyAsync(signature, message, ed25519PublicKey);
    } catch (error) {
      // Verification failed or error occurred
      return false;
    }
  }

  /**
   * Create a new Original
   * This is a convenience proxy that routes to the appropriate specialized creation method.
   * Currently proxies to createDIDOriginal(), but can be extended for other Original types.
   * 
   * @param options - Creation options (discriminated union by type)
   * @returns Created DID, document, log, and metadata
   */
  static async createOriginal(options: CreateOriginalOptions): Promise<OriginalResult> {
    // Route based on type discriminator
    switch (options.type) {
      case 'did':
        return OriginalsSDK.createDIDOriginal(options);
      default:
        // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
        throw new Error(`Unsupported Original type: ${options.type}`);
    }
  }

  /**
   * Create a new DID-based Original (DID document/log)
   * This wraps didwebvh-ts's createDID function to ensure didwebvh-ts is only imported within the SDK.
   * 
   * A DID-based Original represents a decentralized identity that can be used as the foundation
   * for other Originals (e.g., asset Originals, credential Originals, etc.).
   * 
   * @param options - Creation options matching didwebvh-ts createDID interface
   * @returns Created DID, document, log, and metadata
   */
  static async createDIDOriginal(options: CreateDIDOriginalOptions): Promise<OriginalResult> {
    // Dynamically import didwebvh-ts to avoid module resolution issues
    // const mod = await import('didwebvh-ts') as unknown as {
    //   createDID: (options: Record<string, unknown>) => Promise<{
    //     did: string;
    //     doc: Record<string, unknown>;
    //     log: DIDLog;
    //     meta: DIDResolutionMeta;
    //   }>;
    // };

    // const { createDID } = mod;

    // Runtime validation
    if (typeof createDID !== 'function') {
      throw new Error('Failed to load didwebvh-ts: createDID is not a function');
    }

    // Create the DID using didwebvh-ts
    const result = await createDID({
      domain: options.domain,
      signer: options.signer,
      verifier: options.verifier,
      paths: options.paths,
      updateKeys: options.updateKeys,
      verificationMethods: options.verificationMethods,
      context: options.context || [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/multikey/v1'
      ],
    });

    return {
      did: result.did,
      doc: result.doc,
      log: result.log as unknown as DIDLog,
      meta: result.meta
    };
  }

  /**
   * Update an existing Original
   * This is a convenience proxy that routes to the appropriate specialized update method.
   * Currently proxies to updateDIDOriginal(), but can be extended for other Original types.
   * 
   * @param options - Update options (discriminated union by type)
   * @returns Updated DID, document, log, and metadata
   */
  static async updateOriginal(options: UpdateOriginalOptions): Promise<OriginalResult> {
    // Route based on type discriminator
    switch (options.type) {
      case 'did':
        return OriginalsSDK.updateDIDOriginal(options);
      default:
        // TypeScript exhaustiveness check
        const _exhaustive: never = options as never;
        throw new Error(`Unsupported Original type: ${(_exhaustive as any).type}`);
    }
  }

  /**
   * Update an existing DID-based Original (DID document/log)
   * This wraps didwebvh-ts's updateDID function to ensure didwebvh-ts is only imported within the SDK.
   * 
   * @param options - Update options matching didwebvh-ts updateDID interface
   * @returns Updated DID, document, log, and metadata
   */
  static async updateDIDOriginal(options: UpdateDIDOriginalOptions): Promise<OriginalResult> {
    // Dynamically import didwebvh-ts to avoid module resolution issues
    const mod = await import('didwebvh-ts') as unknown as {
      updateDID: (options: Record<string, unknown>) => Promise<{
        did: string;
        doc: Record<string, unknown>;
        log: DIDLog;
        meta: DIDResolutionMeta;
      }>;
    };

    const { updateDID } = mod;

    // Runtime validation
    if (typeof updateDID !== 'function') {
      throw new Error('Failed to load didwebvh-ts: updateDID is not a function');
    }

    // Prepare options for updateDID
    const updateOptions: Record<string, unknown> = {
      log: options.log,
      signer: options.signer,
      verifier: options.verifier || options.signer, // Use signer as verifier if not provided
    };

    // Add optional parameters
    if (options.updateKeys !== undefined) updateOptions.updateKeys = options.updateKeys;
    if (options.verificationMethods !== undefined) updateOptions.verificationMethods = options.verificationMethods;
    if (options.services !== undefined) updateOptions.services = options.services;
    if (options.controller !== undefined) updateOptions.controller = options.controller;
    if (options.context !== undefined) updateOptions.context = options.context;
    if (options.alsoKnownAs !== undefined) updateOptions.alsoKnownAs = options.alsoKnownAs;
    if (options.portable !== undefined) updateOptions.portable = options.portable;
    if (options.nextKeyHashes !== undefined) updateOptions.nextKeyHashes = options.nextKeyHashes;
    if (options.authentication !== undefined) updateOptions.authentication = options.authentication;
    if (options.assertionMethod !== undefined) updateOptions.assertionMethod = options.assertionMethod;
    if (options.keyAgreement !== undefined) updateOptions.keyAgreement = options.keyAgreement;
    if (options.domain !== undefined) updateOptions.domain = options.domain;

    // Update the DID using didwebvh-ts
    const result = await updateDID(updateOptions);

      // Extract DID from the log if not returned directly
      let did: string;
      if (result.did) {
        did = result.did;
      } else if (result.log && result.log.length > 0) {
        // Extract DID from the document in the log
        const latestDoc = result.log[result.log.length - 1]?.state as unknown as DIDDocument | undefined;
        did = latestDoc?.id || '';
      } else {
        throw new Error('Cannot determine DID from update result');
      }

    return {
      did,
      doc: result.doc as unknown as DIDDocument,
      log: result.log,
      meta: result.meta
    };
  }
}


