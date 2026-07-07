import { DIDManager } from '../did/DIDManager.js';
import { CredentialManager } from '../vc/CredentialManager.js';
import { LifecycleManager } from '../lifecycle/LifecycleManager.js';
import { BitcoinManager } from '../bitcoin/BitcoinManager.js';
import { StatusListManager } from '../vc/StatusListManager.js';
import { OriginalsConfig, KeyStore, ExternalSigner, ExternalVerifier } from '../types/index.js';
import { DIDDocument, VerificationMethod, ServiceEndpoint } from '../types/did.js';
import { DEFAULT_WEBVH_NETWORK, getBitcoinNetworkForWebVH, getWebVHNetworkForBitcoin } from '../types/network.js';
import { emitTelemetry, StructuredError } from '../utils/telemetry.js';
import { Logger } from '../utils/Logger.js';
import { MetricsCollector } from '../utils/MetricsCollector.js';
import { EventLogger } from '../utils/EventLogger.js';
import { createDID } from 'didwebvh-ts';
import { normalizeUpdateKey } from '../did/WebVHManager.js';

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
  /**
   * Update keys as bare multikeys (e.g. "z6Mk...", the did:webvh spec format
   * required by didwebvh-ts >= 2.8). Legacy "did:key:z6Mk..." values are
   * normalized automatically — except when `nextKeyHashes` is also provided:
   * pre-rotation hashes commit to the exact updateKey string, so combining
   * legacy-form updateKeys with pre-rotation is rejected (see nextKeyHashes).
   */
  updateKeys: string[];
  verificationMethods: VerificationMethod[];
  paths?: string[];
  controller?: string;
  context?: string | string[] | object | object[];
  alsoKnownAs?: string[];
  portable?: boolean;
  /**
   * Pre-rotation commitments. Each hash MUST be computed over the bare
   * multikey form of the future updateKey (e.g. `computeNextKeyHash('z6Mk...')`
   * from `@originals/sdk`), because didwebvh-ts hashes updateKeys verbatim
   * when validating the next entry. Hashes are opaque and cannot be
   * normalized after the fact.
   */
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
  /** Same format rules as {@link CreateDIDOriginalOptions.updateKeys}. */
  updateKeys?: string[];
  verificationMethods?: VerificationMethod[];
  services?: ServiceEndpoint[];
  controller?: string;
  context?: string | string[] | object | object[];
  alsoKnownAs?: string[];
  portable?: boolean;
  /** Same format rules as {@link CreateDIDOriginalOptions.nextKeyHashes}. */
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

/**
 * Guard for the pre-rotation footgun: `nextKeyHashes` commit to the exact
 * updateKey string didwebvh-ts will later hash, and the SDK normalizes
 * updateKeys to bare multikeys. A caller still using the legacy
 * "did:key:..." form for updateKeys has almost certainly computed its
 * nextKeyHashes over that same legacy form — the update would be accepted
 * but the committed hashes could never match a future (normalized) updateKey,
 * breaking the chain at the *next* rotation. Fail fast instead.
 */
function assertBareUpdateKeysForPrerotation(
  updateKeys: string[] | undefined,
  nextKeyHashes: string[] | undefined
): void {
  if (!nextKeyHashes || nextKeyHashes.length === 0 || !updateKeys) return;
  const legacy = updateKeys.filter(k => k !== normalizeUpdateKey(k));
  if (legacy.length > 0) {
    throw new Error(
      'Pre-rotation (nextKeyHashes) requires updateKeys in bare multikey form ("z6Mk..."), ' +
      `but got legacy did:key form: ${legacy.join(', ')}. nextKeyHashes commit to the exact ` +
      'updateKey string and cannot be normalized after hashing — pass bare multikeys and ' +
      'compute each hash as computeNextKeyHash(<bare multikey>).'
    );
  }
}

export class OriginalsSDK {
  public readonly did: DIDManager;
  public readonly credentials: CredentialManager;
  public readonly lifecycle: LifecycleManager;
  public readonly bitcoin: BitcoinManager;
  public readonly statusList: StatusListManager;
  public readonly logger: Logger;
  public readonly metrics: MetricsCollector;
  private eventLogger: EventLogger;
  private config: OriginalsConfig;

  constructor(config: OriginalsConfig, keyStore?: KeyStore) {
    // Input validation
    if (!config || typeof config !== 'object') {
      throw new Error('Configuration object is required');
    }
    if (!config.network || !['mainnet', 'regtest', 'signet'].includes(config.network)) {
      throw new Error('Invalid network: must be mainnet, regtest, or signet');
    }
    if (!config.defaultKeyType || !['ES256K', 'Ed25519', 'ES256'].includes(config.defaultKeyType)) {
      throw new Error('Invalid defaultKeyType: must be ES256K, Ed25519, or ES256');
    }
    if (config.webvhNetwork !== undefined && !['pichu', 'cleffa', 'magby'].includes(config.webvhNetwork)) {
      throw new Error('Invalid webvhNetwork: must be pichu, cleffa, or magby');
    }

    this.config = config;

    // Initialize logger and metrics
    this.logger = new Logger('SDK', config);
    this.metrics = new MetricsCollector();
    // EventLogger gets its own MetricsCollector so it doesn't double-count asset metrics
    // that LifecycleManager already records directly on sdk.metrics.
    this.eventLogger = new EventLogger(this.logger.child('Events'), new MetricsCollector());
    
    // Log SDK initialization
    this.logger.info('Initializing Originals SDK', {
      network: config.network,
      keyType: config.defaultKeyType
    });

    // The WebVH network tiers map to fixed Bitcoin networks (magby→regtest,
    // cleffa→signet, pichu→mainnet). A contradictory explicit `network` is
    // almost always a misconfiguration — surface it instead of failing far
    // from the cause during a did:btco migration.
    if (config.webvhNetwork) {
      const mappedNetwork = getBitcoinNetworkForWebVH(config.webvhNetwork);
      if (config.network && config.network !== mappedNetwork) {
        this.logger.warn('Configured network contradicts webvhNetwork mapping', {
          network: config.network,
          webvhNetwork: config.webvhNetwork,
          expectedNetwork: mappedNetwork
        });
      }
    }
    
    emitTelemetry(config.telemetry, { name: 'sdk.init', attributes: { network: config.network } });
    
    // Initialize managers
    this.did = new DIDManager(config, this.metrics);
    this.credentials = new CredentialManager(config, this.did, this.metrics);
    // Honor config.keyStore when no dedicated keyStore parameter is passed —
    // OriginalsConfig declares it, so silently dropping it would type-check
    // fine and only fail much later (credential:skipped / KEYSTORE_REQUIRED).
    this.lifecycle = new LifecycleManager(config, this.did, this.credentials, undefined, keyStore ?? config.keyStore, this.metrics);
    this.bitcoin = new BitcoinManager(config);
    this.statusList = new StatusListManager();
    
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

    // Subscribe to lifecycle events (for logging only — EventLogger has its own MetricsCollector)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
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
    // Honor a keyStore supplied on the config object too (config.keyStore),
    // not only the dedicated options.keyStore — otherwise it is silently
    // dropped and signing later fails with KEYSTORE_REQUIRED.
    const merged = { ...defaultConfig, ...configOptions };
    // When the caller selects a webvhNetwork tier but does not explicitly set a
    // Bitcoin network, derive the network from the tier's fixed mapping
    // (magby→regtest, cleffa→signet, pichu→mainnet). Otherwise `network` would
    // silently stay 'mainnet' and every Bitcoin op (inscribe/transfer) plus
    // did:btco resolution would run against mainnet while did:btco *creation*
    // used the tier's network — a real fund-loss footgun. An explicit,
    // contradicting `network` is preserved (and still warned about below).
    if (configOptions.webvhNetwork && configOptions.network === undefined) {
      merged.network = getBitcoinNetworkForWebVH(configOptions.webvhNetwork);
    } else if (configOptions.network && configOptions.webvhNetwork === undefined) {
      // Symmetric reverse derivation: when the caller sets an explicit Bitcoin
      // `network` but no webvhNetwork tier, derive the tier (regtest→magby,
      // signet→cleffa, mainnet→pichu) instead of leaving the default 'pichu'.
      // Otherwise `create({ network: 'regtest' })` would target the PRODUCTION
      // pichu domain while doing regtest Bitcoin — the same environment
      // mismatch the forward mapping prevents. If there is no tier for the
      // network, keep the default.
      const derivedTier = getWebVHNetworkForBitcoin(configOptions.network);
      if (derivedTier) {
        merged.webvhNetwork = derivedTier;
      }
    }
    return new OriginalsSDK(merged, keyStore ?? merged.keyStore);
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

    // Ed25519 public keys must be exactly 32 bytes. A 33-byte input is NOT a
    // "prefixed Ed25519 key": Ed25519 multicodec prefixes are 2 bytes
    // (0xed 0x01 → 34 bytes), while 33 bytes is the shape of a compressed
    // secp256k1 key. Stripping one byte and verifying against the remainder
    // verified against garbage — reject instead of guessing (issue #352).
    if (publicKey.length !== 32) {
      throw new Error(`Invalid Ed25519 public key length: ${publicKey.length} (expected 32 bytes)`);
    }

    // Verify using @noble/ed25519 with Uint8Array (browser-compatible)
    // ed25519.verifyAsync accepts Uint8Array directly
    try {
      return await ed25519Mod.verifyAsync(signature, message, publicKey);
    } catch (_error) {
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

    assertBareUpdateKeysForPrerotation(options.updateKeys, options.nextKeyHashes);

    // Create the DID using didwebvh-ts
    const createOptions: Record<string, unknown> = {
      domain: options.domain,
      signer: options.signer,
      verifier: options.verifier,
      paths: options.paths,
      // didwebvh-ts >= 2.8 requires bare multikey updateKeys (did:webvh spec);
      // accept legacy "did:key:..." input and normalize.
      updateKeys: options.updateKeys.map(normalizeUpdateKey),
      verificationMethods: options.verificationMethods,
      context: options.context || [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/multikey/v1'
      ],
    };
    if (options.controller !== undefined) createOptions.controller = options.controller;
    if (options.alsoKnownAs !== undefined) createOptions.alsoKnownAs = options.alsoKnownAs;
    if (options.portable !== undefined) createOptions.portable = options.portable;
    if (options.nextKeyHashes !== undefined) createOptions.nextKeyHashes = options.nextKeyHashes;
    if (options.authentication !== undefined) createOptions.authentication = options.authentication;
    if (options.assertionMethod !== undefined) createOptions.assertionMethod = options.assertionMethod;
    if (options.keyAgreement !== undefined) createOptions.keyAgreement = options.keyAgreement;
    if (options.services !== undefined) createOptions.services = options.services;
    const result = await createDID(createOptions as Parameters<typeof createDID>[0]);

    return {
      did: result.did,
      doc: result.doc as unknown as DIDDocument,
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
      default: {
        // TypeScript exhaustiveness check
        const _exhaustive: never = options as never;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
        throw new Error(`Unsupported Original type: ${(_exhaustive as any).type}`);
      }
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

    assertBareUpdateKeysForPrerotation(options.updateKeys, options.nextKeyHashes);

    // Prepare options for updateDID
    const updateOptions: Record<string, unknown> = {
      log: options.log,
      signer: options.signer,
      verifier: options.verifier || options.signer, // Use signer as verifier if not provided
    };

    // Add optional parameters
    if (options.updateKeys !== undefined) updateOptions.updateKeys = options.updateKeys.map(normalizeUpdateKey);
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


