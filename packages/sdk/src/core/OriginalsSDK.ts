/** @internal Preceding asset processor retained for application transition and baseline tests. */
import { DIDManager } from '../did/DIDManager.js';
import { CredentialManager } from '../vc/CredentialManager.js';
import { LifecycleManager } from '../lifecycle/LifecycleManager.js';
import { BitcoinManager } from '../bitcoin/BitcoinManager.js';
import { StatusListManager } from '../vc/StatusListManager.js';
import { OriginalsConfig, KeyStore } from '../types/index.js';
import { DEFAULT_WEBVH_NETWORK, getBitcoinNetworkForWebVH, getWebVHNetworkForBitcoin } from '../types/network.js';
import { emitTelemetry, StructuredError } from '@originals/cel';
import { Logger } from '../utils/Logger.js';
import { MetricsCollector } from '../utils/MetricsCollector.js';
import { EventLogger } from '../utils/EventLogger.js';
import { OperationLock } from '../utils/OperationLock.js';
import * as identityOperations from '../did/identity-operations.js';
export type { OriginalResult, CreateOriginalOptions, UpdateOriginalOptions, CreateDIDOriginalOptions, UpdateDIDOriginalOptions } from '../did/identity-operations.js';

export interface OriginalsSDKOptions extends Partial<OriginalsConfig> {
  keyStore?: KeyStore;
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
    if (!config.network || !['mainnet', 'testnet', 'regtest', 'signet'].includes(config.network)) {
      throw new Error('Invalid network: must be mainnet, testnet, regtest, or signet');
    }
    if (!config.defaultKeyType || !['ES256K', 'Ed25519', 'ES256'].includes(config.defaultKeyType)) {
      throw new Error('Invalid defaultKeyType: must be ES256K, Ed25519, or ES256');
    }
    if (config.webvhNetwork !== undefined && !['pichu', 'cleffa', 'magby'].includes(config.webvhNetwork)) {
      throw new Error('Invalid webvhNetwork: must be pichu, cleffa, or magby');
    }

    // One shared inscription lock for every manager built from this config, so
    // a LifecycleManager inscribe and a MigrationManager migrate of the same
    // DID coordinate on the same keyed mutex instead of separate Sets (#303).
    if (!config.operationLock) {
      config.operationLock = new OperationLock();
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
    this.did = new DIDManager(config, this.metrics, async (did, resolveKey) => {
      const sat = did.match(/^did:btco:(?:(?:reg|sig|test):)?(\d+)$/)?.[1];
      if (!sat) return null;
      const { asset } = await this.lifecycle.resolveAssetFromSat(sat, { resolveKey });
      const document = asset.serialize().didDocuments['did:btco'];
      return document?.id === did ? document : null;
    });
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
    // Keep the resolved keyStore ON the config, not only in the constructor
    // argument. Stripping it made `config.keyStore` undefined everywhere
    // downstream, so anything reading custody from the config (or any manager
    // constructed directly from it) saw none.
    const merged: OriginalsConfig = {
      ...defaultConfig,
      ...configOptions,
      ...(keyStore ? { keyStore } : {}),
    };
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

  static prepareDIDDataForSigning = identityOperations.prepareDIDDataForSigning;
  static verifyDIDSignature = identityOperations.verifyDIDSignature;
  static createOriginal = identityOperations.createOriginal;
  static createDIDOriginal = identityOperations.createDIDOriginal;
  static updateOriginal = identityOperations.updateOriginal;
  static updateDIDOriginal = identityOperations.updateDIDOriginal;
}
