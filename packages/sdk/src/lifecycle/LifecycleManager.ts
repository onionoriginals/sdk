import {
  OriginalsConfig,
  AssetResource,
  BitcoinTransaction,
  KeyStore,
  ExternalSigner,
  VerifiableCredential,
  LayerType
} from '../types/index.js';
import { BitcoinManager } from '../bitcoin/BitcoinManager.js';
import { DIDManager } from '../did/DIDManager.js';
import { CredentialManager } from '../vc/CredentialManager.js';
import { OriginalsAsset } from './OriginalsAsset.js';
import { encodeBase64UrlMultibase, hexToBytes } from '../utils/encoding.js';
import { validateBitcoinAddress } from '../utils/bitcoin-address.js';
import { parseSatoshiIdentifier } from '../utils/satoshi-validation.js';
import { btcoDidPrefix } from '../cel/btcoDid.js';
import { multikey } from '../crypto/Multikey.js';
import { EventEmitter } from '../events/EventEmitter.js';
import type { EventHandler, EventTypeMap } from '../events/types.js';
import { Logger } from '../utils/Logger.js';
import { StructuredError } from '../utils/telemetry.js';
import { MetricsCollector } from '../utils/MetricsCollector.js';
import {
  type BatchResult,
  type BatchOperationOptions,
  type BatchInscriptionOptions,
} from './BatchOperations.js';
import { BatchLifecycleOperations } from './BatchLifecycleOperations.js';
import { validateAndNormalizeDomain, tryValidateDomain, safeDecodeURIComponent } from './domainUtils.js';
import { 
  type OriginalKind, 
  type OriginalManifest, 
  type CreateTypedOriginalOptions,
  KindRegistry,
} from '../kinds/index.js';

/**
 * Cost estimation result for migration operations
 */
export interface CostEstimate {
  /** Total estimated cost in satoshis */
  totalSats: number;
  /** Breakdown of costs */
  breakdown: {
    /** Network fee in satoshis */
    networkFee: number;
    /** Data cost for inscription (sat/vB * size) */
    dataCost: number;
    /** Dust output value */
    dustValue: number;
  };
  /** Fee rate used for estimation (sat/vB) */
  feeRate: number;
  /** Data size in bytes */
  dataSize: number;
  /** Target layer for the migration */
  targetLayer: LayerType;
  /** Confidence level of estimate */
  confidence: 'low' | 'medium' | 'high';
}

/**
 * Migration validation result
 */
export interface MigrationValidation {
  /** Whether the migration is valid */
  valid: boolean;
  /** List of validation errors */
  errors: string[];
  /** List of warnings (non-blocking) */
  warnings: string[];
  /** Current layer of the asset */
  currentLayer: LayerType;
  /** Target layer for migration */
  targetLayer: LayerType;
  /** Checks performed */
  checks: {
    layerTransition: boolean;
    resourcesValid: boolean;
    credentialsValid: boolean;
    didDocumentValid: boolean;
    bitcoinReadiness?: boolean;
  };
}

/**
 * Progress callback for long-running operations
 */
export type ProgressCallback = (progress: LifecycleProgress) => void;

/**
 * Progress information for lifecycle operations
 */
export interface LifecycleProgress {
  /** Current operation phase */
  phase: 'preparing' | 'validating' | 'processing' | 'committing' | 'confirming' | 'complete' | 'failed';
  /** Progress percentage (0-100) */
  percentage: number;
  /** Human-readable message */
  message: string;
  /** Current operation details */
  details?: {
    currentStep?: number;
    totalSteps?: number;
    transactionId?: string;
    confirmations?: number;
  };
}

/**
 * Options for lifecycle operations with progress tracking
 */
export interface LifecycleOperationOptions {
  /** Fee rate for Bitcoin operations (sat/vB) */
  feeRate?: number;
  /** Progress callback for operation updates */
  onProgress?: ProgressCallback;
  /** Enable atomic rollback on failure (default: true) */
  atomicRollback?: boolean;
}

export class LifecycleManager {
  private eventEmitter: EventEmitter;
  private batchOps: BatchLifecycleOperations;
  private logger: Logger;
  private metrics: MetricsCollector;
  /**
   * Assets with an inscription or publication currently in flight, keyed by
   * asset id. Mutated synchronously before the first await so concurrent
   * calls for the same asset cannot both pass the layer guard and double-pay
   * for two inscriptions (issue #255).
   */
  private inFlightAssets = new Set<string>();

  constructor(
    private config: OriginalsConfig,
    private didManager: DIDManager,
    private credentialManager: CredentialManager,
    private deps?: { bitcoinManager?: BitcoinManager },
    private keyStore?: KeyStore,
    metrics?: MetricsCollector
  ) {
    this.eventEmitter = new EventEmitter();
    this.logger = new Logger('LifecycleManager', config);
    this.metrics = metrics || new MetricsCollector();
    // Batch operations delegate per-asset work back to this manager's core
    // methods, and emit through the same event emitter so subscribers via
    // `lifecycle.on(...)` receive batch events.
    this.batchOps = new BatchLifecycleOperations(config, this.eventEmitter, this, this.deps);
  }

  /**
   * Subscribe to a lifecycle event
   * @param eventType - The type of event to subscribe to
   * @param handler - The handler function to call when the event is emitted
   * @returns A function to unsubscribe from the event
   */
  on<K extends keyof EventTypeMap>(eventType: K, handler: EventHandler<EventTypeMap[K]>): () => void {
    return this.eventEmitter.on(eventType, handler);
  }

  /**
   * Subscribe to a lifecycle event once
   * @param eventType - The type of event to subscribe to
   * @param handler - The handler function to call when the event is emitted (will only fire once)
   * @returns A function to unsubscribe from the event
   */
  once<K extends keyof EventTypeMap>(eventType: K, handler: EventHandler<EventTypeMap[K]>): () => void {
    return this.eventEmitter.once(eventType, handler);
  }

  /**
   * Unsubscribe from a lifecycle event
   * @param eventType - The type of event to unsubscribe from
   * @param handler - The handler function to remove
   */
  off<K extends keyof EventTypeMap>(eventType: K, handler: EventHandler<EventTypeMap[K]>): void {
    this.eventEmitter.off(eventType, handler);
  }

  async registerKey(verificationMethodId: string, privateKey: string): Promise<void> {
    if (!this.keyStore) {
      throw new StructuredError('KEYSTORE_REQUIRED', 'KeyStore not configured. Provide keyStore to LifecycleManager constructor.');
    }

    // Validate verification method ID format
    if (!verificationMethodId || typeof verificationMethodId !== 'string') {
      throw new StructuredError('INVALID_INPUT', 'Invalid verificationMethodId: must be a non-empty string');
    }

    // Validate private key format (should be multibase encoded)
    if (!privateKey || typeof privateKey !== 'string') {
      throw new StructuredError('INVALID_INPUT', 'Invalid privateKey: must be a non-empty string');
    }

    // Validate that it's a valid multibase-encoded private key
    try {
      multikey.decodePrivateKey(privateKey);
    } catch (_err) {
      throw new StructuredError('INVALID_KEY', 'Invalid privateKey format: must be a valid multibase-encoded private key');
    }
    
    await this.keyStore.setPrivateKey(verificationMethodId, privateKey);
  }

  async createAsset(resources: AssetResource[]): Promise<OriginalsAsset> {
    const stopTimer = this.logger.startTimer('createAsset');
    const metricsStart = performance.now();
    this.logger.info('Creating asset', { resourceCount: resources.length });
    
    try {
      // Input validation
      if (!Array.isArray(resources)) {
        throw new StructuredError('INVALID_INPUT', 'Resources must be an array. Provide an array of AssetResource objects.');
      }
      if (resources.length === 0) {
        throw new StructuredError('INVALID_INPUT', 'At least one resource is required');
      }

      // Validate each resource
      for (const resource of resources) {
        if (!resource || typeof resource !== 'object') {
          throw new StructuredError('INVALID_RESOURCE', 'Invalid resource: must be an object');
        }
        if (!resource.id || typeof resource.id !== 'string') {
          throw new StructuredError('INVALID_RESOURCE', 'Invalid resource: missing or invalid id');
        }
        if (!resource.type || typeof resource.type !== 'string') {
          throw new StructuredError('INVALID_RESOURCE', 'Invalid resource: missing or invalid type');
        }
        if (!resource.contentType || typeof resource.contentType !== 'string') {
          throw new StructuredError('INVALID_RESOURCE', 'Invalid resource: missing or invalid contentType');
        }
        if (!resource.hash || typeof resource.hash !== 'string' || !/^[0-9a-fA-F]+$/.test(resource.hash)) {
          throw new StructuredError('INVALID_RESOURCE', 'Invalid resource: missing or invalid hash (must be hex string)');
        }
        // Validate contentType is a valid MIME type
        if (!/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}$/.test(resource.contentType)) {
          throw new StructuredError('INVALID_RESOURCE', `Invalid resource: invalid contentType MIME format: ${resource.contentType}`);
        }
      }
    
    // Create a proper DID:peer document with verification methods
    // If keyStore is provided, request the key pair to be returned
    if (this.keyStore) {
      const result = await this.didManager.createDIDPeer(resources, true);
      const didDoc = result.didDocument;
      const keyPair = result.keyPair;
      
      // Register the private key in the keyStore
      if (didDoc.verificationMethod && didDoc.verificationMethod.length > 0) {
        let verificationMethodId = didDoc.verificationMethod[0].id;
        
        // Ensure VM ID is absolute (not just a fragment like #key-0)
        if (verificationMethodId.startsWith('#')) {
          verificationMethodId = `${didDoc.id}${verificationMethodId}`;
        }
        
        await this.keyStore.setPrivateKey(verificationMethodId, keyPair.privateKey);
      }
      
      const asset = new OriginalsAsset(resources, didDoc, []);
      
      // Defer asset:created event emission to next microtask so callers can subscribe first
      queueMicrotask(() => {
        const event = {
          type: 'asset:created' as const,
          timestamp: new Date().toISOString(),
          asset: {
            id: asset.id,
            layer: asset.currentLayer,
            resourceCount: resources.length,
            createdAt: asset.getProvenance().createdAt
          }
        };

        // Emit from both LifecycleManager and asset emitters
        void this.eventEmitter.emit(event);
        void (asset as unknown as { eventEmitter: EventEmitter }).eventEmitter.emit(event);
      });
      
      stopTimer();
      this.logger.info('Asset created successfully', { assetId: asset.id });
      this.metrics.recordOperation('lifecycle.createAsset', performance.now() - metricsStart, true);
      this.metrics.recordAssetCreated();

      return asset;
    } else {
      // No keyStore, just create the DID document
      const didDoc = await this.didManager.createDIDPeer(resources);
      const asset = new OriginalsAsset(resources, didDoc, []);
      
      // Defer asset:created event emission to next microtask so callers can subscribe first
      queueMicrotask(() => {
        const event = {
          type: 'asset:created' as const,
          timestamp: new Date().toISOString(),
          asset: {
            id: asset.id,
            layer: asset.currentLayer,
            resourceCount: resources.length,
            createdAt: asset.getProvenance().createdAt
          }
        };

        // Emit from both LifecycleManager and asset emitters
        void this.eventEmitter.emit(event);
        void (asset as unknown as { eventEmitter: EventEmitter }).eventEmitter.emit(event);
      });
      
      stopTimer();
      this.logger.info('Asset created successfully', { assetId: asset.id });
      this.metrics.recordOperation('lifecycle.createAsset', performance.now() - metricsStart, true);
      this.metrics.recordAssetCreated();

      return asset;
    }
    } catch (error) {
      stopTimer();
      this.logger.error('Asset creation failed', error as Error, { resourceCount: resources.length });
      this.metrics.recordOperation('lifecycle.createAsset', performance.now() - metricsStart, false);
      this.metrics.recordError('ASSET_CREATION_FAILED', 'createAsset');
      throw error;
    }
  }

  /**
   * Create a typed Original with kind-specific validation
   * 
   * This is the recommended way to create Originals with proper typing and validation.
   * Each kind (App, Agent, Module, Dataset, Media, Document) has specific metadata
   * requirements that are validated before creation.
   * 
   * @param kind - The kind of Original to create
   * @param manifest - The manifest containing name, version, resources, and kind-specific metadata
   * @param options - Optional creation options (skipValidation, strictMode)
   * @returns The created OriginalsAsset
   * @throws Error if validation fails (unless skipValidation is true)
   * 
   * @example
   * ```typescript
   * // Create a Module Original
   * const moduleAsset = await sdk.lifecycle.createTypedOriginal(
   *   OriginalKind.Module,
   *   {
   *     kind: OriginalKind.Module,
   *     name: 'my-utility',
   *     version: '1.0.0',
   *     resources: [{ id: 'index.js', type: 'code', hash: '...', contentType: 'application/javascript' }],
   *     metadata: {
   *       format: 'esm',
   *       main: 'index.js',
   *     }
   *   }
   * );
   * ```
   */
  async createTypedOriginal<K extends OriginalKind>(
    kind: K,
    manifest: OriginalManifest<K>,
    options?: CreateTypedOriginalOptions
  ): Promise<OriginalsAsset> {
    const stopTimer = this.logger.startTimer('createTypedOriginal');
    this.logger.info('Creating typed Original', { kind, name: manifest.name, version: manifest.version });
    
    try {
      // Verify kind matches
      if (manifest.kind !== kind) {
        throw new StructuredError('INVALID_INPUT', `Manifest kind "${manifest.kind}" does not match requested kind "${kind}"`);
      }
      
      // Validate manifest using KindRegistry
      const registry = KindRegistry.getInstance();
      registry.validateOrThrow(manifest, options);
      
      // Log warnings if any
      if (!options?.skipValidation) {
        const validationResult = registry.validate(manifest, options);
        if (validationResult.warnings.length > 0) {
          for (const warning of validationResult.warnings) {
            this.logger.warn(`[${warning.code}] ${warning.message}`, { path: warning.path });
          }
        }
      }
      
      // Create the asset using existing createAsset method
      const asset = await this.createAsset(manifest.resources);
      
      // Store the manifest metadata on the asset for future reference
      // We attach it as a non-enumerable property to avoid serialization issues
      Object.defineProperty(asset, '_manifest', {
        value: manifest,
        writable: false,
        enumerable: false,
        configurable: false,
      });
      
      // createAsset already emitted asset:created and recorded the metric for
      // this asset; emitting/recording again here made every typed Original
      // double-fire the event and double-count in metrics.

      stopTimer();
      this.logger.info('Typed Original created successfully', {
        assetId: asset.id,
        kind,
        name: manifest.name,
        version: manifest.version,
      });
      
      return asset;
    } catch (error) {
      stopTimer();
      this.logger.error('Typed Original creation failed', error as Error, { 
        kind,
        name: manifest.name,
        version: manifest.version,
      });
      this.metrics.recordError('TYPED_ASSET_CREATION_FAILED', 'createTypedOriginal');
      throw error;
    }
  }

  /**
   * Get the manifest from a typed Original asset
   * Returns undefined if the asset was not created with createTypedOriginal
   * 
   * @param asset - The OriginalsAsset to get manifest from
   * @returns The manifest or undefined
   */
  getManifest<K extends OriginalKind>(asset: OriginalsAsset): OriginalManifest<K> | undefined {
    return (asset as { _manifest?: OriginalManifest<K> })._manifest;
  }

  /**
   * Estimate the cost of creating a typed Original
   * Useful for showing users estimated fees before creation
   * 
   * @param manifest - The manifest to estimate
   * @param targetLayer - The target layer (did:webvh or did:btco)
   * @param feeRate - Optional fee rate override (sat/vB)
   * @returns Cost estimate including fees
   */
  async estimateTypedOriginalCost<K extends OriginalKind>(
    manifest: OriginalManifest<K>,
    targetLayer: LayerType,
    feeRate?: number
  ): Promise<CostEstimate> {
    // For webvh, costs are minimal
    if (targetLayer === 'did:webvh') {
      return {
        totalSats: 0,
        breakdown: {
          networkFee: 0,
          dataCost: 0,
          dustValue: 0
        },
        feeRate: 0,
        dataSize: 0,
        targetLayer,
        confidence: 'high'
      };
    }
    
    // Calculate total data size including manifest metadata
    let dataSize = 0;
    for (const resource of manifest.resources) {
      if (resource.size) {
        dataSize += resource.size;
      } else if (resource.content) {
        dataSize += Buffer.from(resource.content).length;
      } else {
        // Estimate based on hash length (assume average resource size)
        dataSize += 1000;
      }
    }
    
    // Add inscription manifest overhead
    const inscriptionManifest = {
      assetId: `did:peer:placeholder`,
      kind: manifest.kind,
      name: manifest.name,
      version: manifest.version,
      resources: manifest.resources.map(r => ({
        id: r.id,
        hash: r.hash,
        contentType: r.contentType,
      })),
      metadata: manifest.metadata,
      timestamp: new Date().toISOString()
    };
    dataSize += Buffer.from(JSON.stringify(inscriptionManifest)).length;
    
    // Get fee rate from oracle or use provided/default
    let effectiveFeeRate = feeRate;
    let confidence: 'low' | 'medium' | 'high' = 'medium';
    
    if (!effectiveFeeRate) {
      if (this.config.feeOracle) {
        try {
          effectiveFeeRate = await this.config.feeOracle.estimateFeeRate(1);
          confidence = 'high';
        } catch {
          // Fallback to default
        }
      }
      
      if (!effectiveFeeRate && this.config.ordinalsProvider) {
        try {
          effectiveFeeRate = await this.config.ordinalsProvider.estimateFee(1);
          confidence = 'medium';
        } catch {
          // Fallback to default
        }
      }
      
      if (!effectiveFeeRate) {
        effectiveFeeRate = 10;
        confidence = 'low';
      }
    }
    
    // Transaction overhead (commit + reveal structure)
    const txOverhead = 200 + 122; // Base tx + inscription overhead
    const totalVbytes = txOverhead + Math.ceil(dataSize / 4); // Witness data is ~1/4 weight
    
    const networkFee = totalVbytes * effectiveFeeRate;
    const dustValue = 330; // Minimum output value
    
    return {
      totalSats: networkFee + dustValue,
      breakdown: {
        networkFee,
        dataCost: Math.ceil(dataSize / 4) * effectiveFeeRate,
        dustValue
      },
      feeRate: effectiveFeeRate,
      dataSize,
      targetLayer,
      confidence
    };
  }

  async publishToWeb(
    asset: OriginalsAsset,
    publisherDidOrSigner: string | ExternalSigner
  ): Promise<OriginalsAsset> {
    const stopTimer = this.logger.startTimer('publishToWeb');
    const metricsStart = performance.now();

    try {
      if (asset.currentLayer !== 'did:peer') {
        throw new StructuredError('INVALID_STATE', 'Asset must be in did:peer layer to publish to web. Assets can only be published from the did:peer layer.');
      }

      // Concurrency guard (issue #255): the layer check above is
      // check-then-act across awaits — overlapping publishes would both pass
      // it and duplicate storage writes/credentials.
      if (this.inFlightAssets.has(asset.id)) {
        throw new StructuredError(
          'OPERATION_IN_PROGRESS',
          `An inscription or publication for asset ${asset.id} is already in progress.`
        );
      }
      this.inFlightAssets.add(asset.id);
      try {
      const { publisherDid, signer } = this.extractPublisherInfo(publisherDidOrSigner);
      const { domain, userPath } = this.parseWebVHDid(publisherDid);
      
      this.logger.info('Publishing asset to web', { assetId: asset.id, publisherDid });
      
      // Publish resources to storage
      await this.publishResources(asset, publisherDid, domain, userPath);
      
      // Store the original did:peer ID before migration
      const originalPeerDid = asset.id;
      
      // Migrate asset to did:webvh layer
      await asset.migrate('did:webvh');
      asset.bindings = { ...(asset.bindings || {}), 'did:peer': originalPeerDid, 'did:webvh': publisherDid };
      
      // Issue publication credential (best-effort)
      await this.issuePublicationCredential(asset, publisherDid, signer);
      
      stopTimer();
      this.logger.info('Asset published to web successfully', { 
        assetId: asset.id, 
        publisherDid, 
        resourceCount: asset.resources.length 
      });
      this.metrics.recordOperation('lifecycle.publishToWeb', performance.now() - metricsStart, true);
      this.metrics.recordMigration('did:peer', 'did:webvh');

      return asset;
      } finally {
        this.inFlightAssets.delete(asset.id);
      }
    } catch (error) {
      stopTimer();
      this.logger.error('Publish to web failed', error as Error, { assetId: asset.id });
      this.metrics.recordOperation('lifecycle.publishToWeb', performance.now() - metricsStart, false);
      this.metrics.recordError('PUBLISH_FAILED', 'publishToWeb');
      throw error;
    }
  }

  private extractPublisherInfo(publisherDidOrSigner: string | ExternalSigner): {
    publisherDid: string;
    signer?: ExternalSigner;
  } {
    if (typeof publisherDidOrSigner === 'string') {
      // If it's already a did:webvh DID, use it as-is
      if (publisherDidOrSigner.startsWith('did:webvh:')) {
        return { publisherDid: publisherDidOrSigner };
      }

      // Otherwise, treat it as a domain and construct a did:webvh DID.
      // Validate AND normalize before encoding so the DID is built from the
      // same normalized form that validation checked (avoids whitespace/case
      // drift between validation and the value actually encoded).
      const normalizedDomain = validateAndNormalizeDomain(publisherDidOrSigner);
      // Encode the domain to handle ports (e.g., localhost:5000 -> localhost%3A5000)
      const encodedDomain = encodeURIComponent(normalizedDomain);
      const publisherDid = `did:webvh:${encodedDomain}:user`;
      return { publisherDid };
    }

    const signer = publisherDidOrSigner;
    const resolvedVmId = signer.getVerificationMethodId();
    const publisherDid = resolvedVmId.includes('#') ? resolvedVmId.split('#')[0] : resolvedVmId;

    if (!publisherDid.startsWith('did:webvh:')) {
      throw new StructuredError('INVALID_INPUT', 'Signer must be associated with a did:webvh identifier');
    }

    return { publisherDid, signer };
  }

  private parseWebVHDid(did: string): { domain: string; userPath: string } {
    if (!did.startsWith('did:webvh:')) {
      throw new StructuredError('INVALID_DID', 'Invalid did:webvh format: must start with did:webvh:');
    }
    const parts = did.split(':');
    if (parts.length < 4) {
      throw new StructuredError('INVALID_DID', 'Invalid did:webvh format: must include domain and user path');
    }

    // Two shapes reach this method and the domain lives in a different
    // position in each:
    //   - canonical resolved/migrated DID: did:webvh:{SCID}:{domain}[:paths]
    //     (the SCID at parts[2] is a dotless multibase string, never a domain)
    //   - the domain shorthand built by extractPublisherInfo:
    //     did:webvh:{domain}:user
    // Disambiguate by asking whether parts[2] is itself a valid domain: a real
    // domain has a dot or is `localhost`, so it validates; a SCID does not.
    // This keeps the storage layout aligned with WebVHManager.saveDIDLog
    // (domain-first, SCID excluded), which the old parts[2]-is-domain
    // assumption broke.
    let domainIndex: number;
    let normalizedDomain: string;
    const decodedSegment2 = safeDecodeURIComponent(parts[2]);
    const domainFromSegment2 = tryValidateDomain(decodedSegment2);
    if (domainFromSegment2 !== null) {
      domainIndex = 2;
      normalizedDomain = domainFromSegment2;
    } else {
      // parts[2] is a SCID; the domain is the next segment.
      normalizedDomain = validateAndNormalizeDomain(safeDecodeURIComponent(parts[3]));
      domainIndex = 3;
    }

    // Every path segment after the domain feeds directly into storage keys
    // (`${domain}/${userPath}/...`), so validate each the same way
    // WebVHManager.saveDIDLog does (issue #274). Without this, a DID like
    // did:webvh:{SCID}:example.com:..:..:x — or a segment that percent-decodes
    // to `..` — lets path-hierarchy-backed storage adapters write outside
    // their root.
    const segments = parts.slice(domainIndex + 1);
    for (const rawSegment of segments) {
      const segment = safeDecodeURIComponent(rawSegment);
      if (
        rawSegment === '' ||
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        segment.includes('/') ||
        segment.includes('\\') ||
        segment.includes('\0')
      ) {
        throw new StructuredError('INVALID_DID', `Invalid did:webvh path segment: ${rawSegment}`);
      }
    }
    const userPath = segments.join('/');

    return { domain: normalizedDomain, userPath };
  }

  private async publishResources(
    asset: OriginalsAsset,
    publisherDid: string,
    domain: string,
    userPath: string
  ): Promise<void> {
    // Publication must actually host content somewhere. Falling back to a
    // method-local MemoryStorageAdapter (whose contents are garbage-collected
    // the moment this call returns) — or writing nothing because the adapter
    // implements neither put() nor putObject() — would still migrate the
    // asset and issue a publication credential asserting content is hosted
    // when it is not (issue #244). The requirement applies only when there is
    // inline content to write: an asset whose resources are all hash-only
    // (content hosted elsewhere) performs no storage writes and remains
    // publishable without an adapter.
    const storage = (this.config as { storageAdapter?: unknown }).storageAdapter;
    const hasInlineContent = asset.resources.some(
      (r) => r.content !== undefined && r.content !== null
    );
    if (hasInlineContent) {
      if (!storage) {
        throw new StructuredError(
          'STORAGE_REQUIRED',
          'A storageAdapter must be configured to publish to web: resource content has to be hosted somewhere. ' +
          'Provide config.storageAdapter (e.g. MemoryStorageAdapter for tests, LocalStorageAdapter, or a custom adapter).'
        );
      }
      const storageWithPutCheck = storage as { put?: unknown; putObject?: unknown };
      if (typeof storageWithPutCheck.put !== 'function' && typeof storageWithPutCheck.putObject !== 'function') {
        throw new StructuredError(
          'STORAGE_REQUIRED',
          'The configured storageAdapter implements neither put() nor putObject(); resources cannot be published.'
        );
      }
    }

    for (const resource of asset.resources) {
      const hashBytes = hexToBytes(resource.hash);
      const multibase = encodeBase64UrlMultibase(hashBytes);
      const resourceUrl = `${publisherDid}/resources/${multibase}`;
      // A canonical did:webvh with no user path (did:webvh:{SCID}:{domain})
      // yields an empty userPath; omit it so the storage key is
      // `${domain}/resources/...` rather than `${domain}//resources/...`.
      const relativePath = userPath
        ? `${userPath}/resources/${multibase}`
        : `resources/${multibase}`;

      // Hash-only resources (content hosted elsewhere) cannot be published:
      // writing the hash string as the body would serve bytes that fail the
      // resource's own integrity check. Skip them instead of corrupting.
      if (resource.content === undefined || resource.content === null) {
        this.logger.warn('Skipping publish of hash-only resource (no content available)', {
          resourceId: resource.id,
          hash: resource.hash
        });
        continue;
      }

      const data = Buffer.from(resource.content);

      const storageWithPut = storage as { put?: (key: string, data: Buffer, options: { contentType: string }) => Promise<void> };
      const storageWithPutObject = storage as { putObject?: (domain: string, path: string, data: Uint8Array) => Promise<void> };

      if (typeof storageWithPut.put === 'function') {
        await storageWithPut.put(`${domain}/${relativePath}`, data, { contentType: resource.contentType });
      } else if (typeof storageWithPutObject.putObject === 'function') {
        await storageWithPutObject.putObject(domain, relativePath, new TextEncoder().encode(resource.content));
      }

      (resource as { url?: string }).url = resourceUrl;

      await this.emitResourcePublishedEvent(asset, resource, resourceUrl, publisherDid, domain);
    }
  }

  private async emitResourcePublishedEvent(
    asset: OriginalsAsset,
    resource: AssetResource,
    resourceUrl: string,
    publisherDid: string,
    domain: string
  ): Promise<void> {
    const event = {
      type: 'resource:published' as const,
      timestamp: new Date().toISOString(),
      asset: { id: asset.id },
      resource: {
        id: resource.id,
        url: resourceUrl,
        contentType: resource.contentType,
        hash: resource.hash
      },
      publisherDid,
      domain
    };
    
    try {
      // Emit from both LifecycleManager and asset emitters
      await this.eventEmitter.emit(event);
      await (asset as unknown as { eventEmitter: EventEmitter }).eventEmitter.emit(event);
    } catch (err) {
      this.logger.error('Event handler error', err as Error, { event: event.type });
    }
  }

  private async issuePublicationCredential(
    asset: OriginalsAsset,
    publisherDid: string,
    signer?: ExternalSigner
  ): Promise<void> {
    try {
      if (!asset.resources.length || !asset.resources[0].id) {
        throw new StructuredError(
          'EMPTY_RESOURCE_LIST',
          'Cannot issue publication credential: asset has no resources'
        );
      }

      const subject = {
        id: asset.id,
        publishedAs: publisherDid,
        resourceId: asset.resources[0].id,
        fromLayer: 'did:peer' as const,
        toLayer: 'did:webvh' as const,
        migratedAt: new Date().toISOString()
      };
      
      const unsigned = this.credentialManager.createResourceCredential(
        'ResourceMigrated',
        subject,
        publisherDid
      );

      const signed = signer
        ? await this.credentialManager.signCredentialWithExternalSigner(unsigned, signer)
        : await this.signWithKeyStore(unsigned, publisherDid);
      
      asset.credentials.push(signed);
      
      const event = {
        type: 'credential:issued' as const,
        timestamp: new Date().toISOString(),
        asset: { id: asset.id },
        credential: {
          type: signed.type,
          issuer: typeof signed.issuer === 'string' ? signed.issuer : signed.issuer.id
        }
      };
      
      // Emit from both LifecycleManager and asset emitters
      await this.eventEmitter.emit(event);
      await (asset as unknown as { eventEmitter: EventEmitter }).eventEmitter.emit(event);
    } catch (err) {
      // Non-fatal by design: publish succeeds without a publication
      // credential (e.g. keyStore-less setups). Surface the reason via a
      // credential:skipped event so callers can detect it programmatically
      // instead of only via logs.
      this.logger.error('Failed to issue credential during publish', err as Error);
      await this.eventEmitter.emit({
        type: 'credential:skipped',
        timestamp: new Date().toISOString(),
        asset: { id: asset.id },
        reason: err instanceof StructuredError ? err.code : 'CREDENTIAL_ISSUANCE_FAILED',
        message: (err as Error)?.message ?? String(err)
      });
    }
  }

  private async signWithKeyStore(
    credential: VerifiableCredential,
    issuer: string
  ): Promise<VerifiableCredential> {
    if (!this.keyStore) {
      throw new StructuredError('KEYSTORE_REQUIRED', 'KeyStore required for signing. Provide keyStore to LifecycleManager constructor or use an external signer.');
    }

    // Resolve the issuer DID document up front so we can consult the retirement
    // status of each candidate verification method. After a key rotation or
    // compromise recovery, KeyManager stamps the OLD verification methods with
    // a `revoked`/`compromised` timestamp and appends the new active key LAST
    // (document = [...retiredVMs, newActiveVM]). Selecting a VM without
    // checking these fields would sign with a retired (possibly compromised)
    // key, breaking the integrity of the provenance chain.
    const didDoc = await this.didManager.resolveDID(issuer);
    const docVms = Array.isArray(didDoc?.verificationMethod) ? didDoc.verificationMethod : [];

    // Normalize a VM id to its absolute form so keyStore lookups and document
    // comparisons line up regardless of whether the document stored relative
    // (`#frag`) ids.
    const absoluteVmId = (id: string): string => (id.startsWith('#') ? `${issuer}${id}` : id);

    // A candidate VM is usable unless the DID document explicitly marks it as
    // retired. VM ids absent from the document (e.g. legacy keys only present
    // in the keyStore) are not disqualified — only an explicit
    // `revoked`/`compromised` timestamp retires a key.
    const isRetiredVmId = (id: string): boolean => {
      const abs = absoluteVmId(id);
      const entry = docVms.find(vm => absoluteVmId(vm.id) === abs);
      return !!entry && (!!entry.revoked || !!entry.compromised);
    };

    let privateKey: string | null = null;
    let vmId: string | null = null;

    const tryCandidate = async (candidateVmId: string): Promise<boolean> => {
      if (isRetiredVmId(candidateVmId)) {
        return false;
      }
      const key = await this.keyStore!.getPrivateKey(candidateVmId);
      if (key) {
        privateKey = key;
        vmId = candidateVmId;
        return true;
      }
      return false;
    };

    // First try common verification method patterns: #key-0, #keys-1, etc.
    const commonVmIds = [
      `${issuer}#key-0`,
      `${issuer}#keys-1`,
      `${issuer}#authentication`,
    ];

    for (const testVmId of commonVmIds) {
      if (await tryCandidate(testVmId)) {
        break;
      }
    }

    // If not found, try to find ANY active key that starts with the issuer DID
    const keyStoreWithGetAll = this.keyStore as { getAllVerificationMethodIds?: () => string[] };
    if (!privateKey && typeof keyStoreWithGetAll.getAllVerificationMethodIds === 'function') {
      const allVmIds = keyStoreWithGetAll.getAllVerificationMethodIds();
      for (const testVmId of allVmIds) {
        if (testVmId.startsWith(issuer) && (await tryCandidate(testVmId))) {
          break;
        }
      }
    }

    // If no key found in common patterns / keyStore scan, fall back to the DID
    // document. Select the first ACTIVE verification method (skipping retired
    // ones), never blindly verificationMethod[0].
    if (!privateKey) {
      if (docVms.length === 0) {
        throw new StructuredError('INVALID_DID_DOCUMENT', 'No verification method found in publisher DID document. Ensure the DID document includes at least one verificationMethod.');
      }

      const activeVm = docVms.find(vm => !vm.revoked && !vm.compromised);
      if (!activeVm) {
        throw new StructuredError('INVALID_DID_DOCUMENT', 'No active verification method found in publisher DID document. All verification methods have been revoked or marked compromised; rotate to a new key before signing.');
      }

      const candidateVmId = absoluteVmId(activeVm.id);
      const key = await this.keyStore.getPrivateKey(candidateVmId);
      if (!key) {
        throw new StructuredError('KEYSTORE_REQUIRED', 'Private key not found in keyStore. Register the key with lifecycle.registerKey() before signing.');
      }
      privateKey = key;
      vmId = candidateVmId;
    }

    if (!vmId) {
      throw new StructuredError('INVALID_DID_DOCUMENT', 'Verification method ID could not be determined from the DID document. Ensure the DID document contains a verificationMethod with an id field.');
    }

    return this.credentialManager.signCredential(credential, privateKey, vmId);
  }

  async inscribeOnBitcoin(
    asset: OriginalsAsset,
    feeRate?: number
  ): Promise<OriginalsAsset> {
    const stopTimer = this.logger.startTimer('inscribeOnBitcoin');
    const metricsStart = performance.now();
    this.logger.info('Inscribing asset on Bitcoin', { assetId: asset.id, feeRate });
    
    try {
      // Input validation
      if (!asset || typeof asset !== 'object') {
        throw new StructuredError('INVALID_INPUT', 'Invalid asset: must be a valid OriginalsAsset');
      }
      if (feeRate !== undefined) {
        if (typeof feeRate !== 'number' || feeRate <= 0 || !Number.isFinite(feeRate)) {
          throw new StructuredError('INVALID_INPUT', 'Invalid feeRate: must be a positive number');
        }
        if (feeRate < 1 || feeRate > 1000000) {
          throw new StructuredError('INVALID_INPUT', 'Invalid feeRate: must be between 1 and 1000000 sat/vB');
        }
      }

    if (typeof asset.migrate !== 'function') {
      throw new StructuredError('NOT_IMPLEMENTED', 'Asset inscription is not yet implemented for this asset type. Use a standard OriginalsAsset created via lifecycle.createAsset().');
    }
    if (asset.currentLayer !== 'did:webvh' && asset.currentLayer !== 'did:peer') {
      throw new StructuredError('NOT_IMPLEMENTED', 'Asset inscription is not yet implemented for this layer. Assets must be in did:peer or did:webvh layer to inscribe.');
    }
    // Concurrency guard (issue #255): the layer check above is check-then-act
    // across the awaits below — two overlapping calls would both pass it,
    // both broadcast paid commit/reveal pairs, and the loser's inscription
    // would be orphaned. Claim the asset synchronously before the first await.
    if (this.inFlightAssets.has(asset.id)) {
      throw new StructuredError(
        'OPERATION_IN_PROGRESS',
        `An inscription or publication for asset ${asset.id} is already in progress; concurrent operations on the same asset would double-pay for duplicate inscriptions.`
      );
    }
    this.inFlightAssets.add(asset.id);
    try {
    const bitcoinManager = this.deps?.bitcoinManager ?? new BitcoinManager(this.config);
    const manifest = {
      assetId: asset.id,
      resources: asset.resources.map(res => ({ id: res.id, hash: res.hash, contentType: res.contentType, url: res.url })),
      timestamp: new Date().toISOString()
    };
    const payload = Buffer.from(JSON.stringify(manifest));
    const inscription = await bitcoinManager.inscribeData(payload, 'application/json', feeRate) as {
      revealTxId?: string;
      txid: string;
      commitTxId?: string;
      inscriptionId: string;
      satoshi?: string;
      feeRate?: number;
    };
    const revealTxId = inscription.revealTxId ?? inscription.txid;
    const commitTxId = inscription.commitTxId;
    const usedFeeRate = typeof inscription.feeRate === 'number' ? inscription.feeRate : feeRate;

    // did:btco identity is satoshi-scoped. inscribeData now guarantees a
    // non-empty, validated satoshi (issue #256); check before migrating so a
    // missing satoshi cannot leave the asset half-migrated. An inscription id
    // is never a valid did:btco identifier, so there is no fallback.
    if (!inscription.satoshi) {
      throw new StructuredError(
        'ORD_SATOSHI_UNKNOWN',
        'Inscription completed but no satoshi was returned; cannot derive a did:btco binding.',
        { inscriptionId: inscription.inscriptionId, txid: revealTxId }
      );
    }

    // Capture the layer before migration for accurate metrics
    const fromLayer = asset.currentLayer;

    await asset.migrate('did:btco', {
      transactionId: revealTxId,
      inscriptionId: inscription.inscriptionId,
      satoshi: inscription.satoshi,
      commitTxId,
      revealTxId,
      feeRate: usedFeeRate
    });

    // The binding must be network-prefixed: a regtest/signet satoshi recorded
    // in bare mainnet form would collide with (and resolve to) whoever owns
    // that satoshi on mainnet (issue #247).
    const bindingValue = `${btcoDidPrefix(this.config.network || 'mainnet')}:${inscription.satoshi}`;
    asset.bindings = Object.assign({}, asset.bindings || {}, { 'did:btco': bindingValue });
    
    stopTimer();
    this.logger.info('Asset inscribed on Bitcoin successfully', { 
      assetId: asset.id, 
      inscriptionId: inscription.inscriptionId,
      transactionId: revealTxId
    });
    this.metrics.recordOperation('lifecycle.inscribeOnBitcoin', performance.now() - metricsStart, true);
    this.metrics.recordMigration(fromLayer, 'did:btco');

    return asset;
    } finally {
      this.inFlightAssets.delete(asset.id);
    }
    } catch (error) {
      stopTimer();
      this.logger.error('Bitcoin inscription failed', error as Error, { assetId: asset.id, feeRate });
      this.metrics.recordOperation('lifecycle.inscribeOnBitcoin', performance.now() - metricsStart, false);
      this.metrics.recordError('INSCRIPTION_FAILED', 'inscribeOnBitcoin');
      throw error;
    }
  }

  async transferOwnership(
    asset: OriginalsAsset,
    newOwner: string
  ): Promise<BitcoinTransaction> {
    const stopTimer = this.logger.startTimer('transferOwnership');
    const metricsStart = performance.now();
    this.logger.info('Transferring asset ownership', { assetId: asset.id, newOwner });
    
    try {
      // Input validation
      if (!asset || typeof asset !== 'object') {
        throw new StructuredError('INVALID_INPUT', 'Invalid asset: must be a valid OriginalsAsset');
      }
      if (!newOwner || typeof newOwner !== 'string') {
        throw new StructuredError('INVALID_INPUT', 'Invalid newOwner: must be a non-empty string');
      }

      // Validate Bitcoin address format and checksum
      try {
        validateBitcoinAddress(newOwner, this.config.network);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid Bitcoin address';
        throw new StructuredError('INVALID_ADDRESS', `Invalid Bitcoin address for ownership transfer: ${message}`);
      }

    // Transfer Bitcoin-anchored asset ownership
    // Only works for assets in did:btco layer
    if (asset.currentLayer !== 'did:btco') {
      throw new StructuredError('INVALID_STATE', 'Asset must be inscribed on Bitcoin before transfer. Migrate to did:btco first.');
    }
    const bm = this.deps?.bitcoinManager ?? new BitcoinManager(this.config);
    const provenance = asset.getProvenance();
    const latestMigration = provenance.migrations[provenance.migrations.length - 1];
    // Fall back to the satoshi encoded in the DID when no migration record is
    // present. A plain `split(':')[2]` is network-blind — for a regtest/signet
    // DID (`did:btco:reg:<sat>` / `did:btco:sig:<sat>`) index 2 is the network
    // tag, not the satoshi. parseSatoshiIdentifier handles every network prefix.
    let satoshi = latestMigration?.satoshi ?? '';
    if (!satoshi && asset.id.startsWith('did:btco:')) {
      try {
        satoshi = String(parseSatoshiIdentifier(asset.id));
      } catch {
        satoshi = '';
      }
    }
    // Determine the inscription that backs this transfer. When a migration
    // record exists we trust its inscription id; otherwise (e.g. an asset
    // rehydrated from a did:btco document, whose provenance starts empty) we
    // must resolve the REAL inscription on the satoshi via the provider rather
    // than fabricating `insc-<sat>` / `unknown-tx` placeholders — those write
    // invented backing-transaction data into provenance, and a real provider
    // rejects the transfer with a confusing "inscription not found".
    let inscriptionId = latestMigration?.inscriptionId;
    if (!inscriptionId) {
      if (!satoshi) {
        throw new StructuredError(
          'INSCRIPTION_NOT_FOUND',
          `Cannot transfer ${asset.id}: no migration record and no satoshi could be derived from the DID to locate its inscription.`
        );
      }
      inscriptionId = await bm.getInscriptionIdBySatoshi(satoshi) ?? undefined;
      if (!inscriptionId) {
        throw new StructuredError(
          'INSCRIPTION_NOT_FOUND',
          `Cannot transfer ${asset.id}: no inscription found on satoshi ${satoshi} to back the transfer.`
        );
      }
    }
    const inscription = {
      satoshi,
      inscriptionId,
      content: Buffer.alloc(0),
      contentType: 'application/octet-stream',
      // Not used by transferInscription (which reads only inscriptionId); kept
      // for shape. Empty rather than a fabricated 'unknown-tx'.
      txid: latestMigration?.transactionId ?? '',
      vout: 0
    } as const;

    const tx = await bm.transferInscription(inscription, newOwner);
    // Record the actual chain of custody: the current owner (the last
    // transfer's recipient) hands off to newOwner. Recording the asset DID
    // as `from` on every transfer broke getTransfersFrom and produced a
    // provenance chain where nobody ever transferred to anybody.
    const priorTransfers = provenance.transfers;
    const currentOwner = priorTransfers.length > 0
      ? priorTransfers[priorTransfers.length - 1].to
      : asset.id;
    await asset.recordTransfer(currentOwner, newOwner, tx.txid);
    
    stopTimer();
    this.logger.info('Asset ownership transferred successfully', { 
      assetId: asset.id, 
      newOwner, 
      transactionId: tx.txid 
    });
    this.metrics.recordOperation('lifecycle.transferOwnership', performance.now() - metricsStart, true);
    this.metrics.recordTransfer();

    return tx;
    } catch (error) {
      stopTimer();
      this.logger.error('Ownership transfer failed', error as Error, { assetId: asset.id, newOwner });
      this.metrics.recordOperation('lifecycle.transferOwnership', performance.now() - metricsStart, false);
      this.metrics.recordError('TRANSFER_FAILED', 'transferOwnership');
      throw error;
    }
  }

  /**
  /**
   * Create multiple assets in batch
   */
  async batchCreateAssets(
    resourcesList: AssetResource[][],
    options?: BatchOperationOptions
  ): Promise<BatchResult<OriginalsAsset>> {
    return this.batchOps.batchCreateAssets(resourcesList, options);
  }

  /**
   * Publish multiple assets to web storage in batch
   */
  async batchPublishToWeb(
    assets: OriginalsAsset[],
    domain: string,
    options?: BatchOperationOptions
  ): Promise<BatchResult<OriginalsAsset>> {
    return this.batchOps.batchPublishToWeb(assets, domain, options);
  }

  /**
   * Inscribe multiple assets on Bitcoin with cost optimization
   * KEY FEATURE: singleTransaction option for 30%+ cost savings
   */
  async batchInscribeOnBitcoin(
    assets: OriginalsAsset[],
    options?: BatchInscriptionOptions
  ): Promise<BatchResult<OriginalsAsset>> {
    return this.batchOps.batchInscribeOnBitcoin(assets, options);
  }

  /**
   * Transfer ownership of multiple assets in batch
   */
  async batchTransferOwnership(
    transfers: Array<{ asset: OriginalsAsset; to: string }>,
    options?: BatchOperationOptions
  ): Promise<BatchResult<BitcoinTransaction>> {
    return this.batchOps.batchTransferOwnership(transfers, options);
  }

  // ===== Clean Lifecycle API =====
  // These methods provide a cleaner, more intuitive API while maintaining
  // backward compatibility with the existing methods.

  /**
   * Create a draft asset (did:peer layer)
   * 
   * This is the entry point for creating new Originals. Draft assets are
   * stored locally and can be published or inscribed later.
   * 
   * @param resources - Array of resources to include in the asset
   * @param options - Optional configuration including progress callback
   * @returns The newly created OriginalsAsset in did:peer layer
   * 
   * @example
   * ```typescript
   * const draft = await sdk.lifecycle.createDraft([
   *   { id: 'main', type: 'code', contentType: 'text/javascript', hash: '...' }
   * ], {
   *   onProgress: (p) => console.log(p.message)
   * });
   * ```
   */
  async createDraft(
    resources: AssetResource[],
    options?: LifecycleOperationOptions
  ): Promise<OriginalsAsset> {
    const onProgress = options?.onProgress;
    
    onProgress?.({
      phase: 'preparing',
      percentage: 0,
      message: 'Preparing draft asset...'
    });
    
    onProgress?.({
      phase: 'validating',
      percentage: 20,
      message: 'Validating resources...'
    });
    
    try {
      onProgress?.({
        phase: 'processing',
        percentage: 50,
        message: 'Creating DID document...'
      });
      
      const asset = await this.createAsset(resources);
      
      onProgress?.({
        phase: 'complete',
        percentage: 100,
        message: 'Draft asset created successfully'
      });
      
      return asset;
    } catch (error) {
      onProgress?.({
        phase: 'failed',
        percentage: 0,
        message: `Failed to create draft: ${error instanceof Error ? error.message : String(error)}`
      });
      throw error;
    }
  }

  /**
   * Publish an asset to the web (did:webvh layer)
   * 
   * Migrates a draft asset from did:peer to did:webvh, making it publicly
   * discoverable via HTTPS.
   * 
   * @param asset - The asset to publish (must be in did:peer layer)
   * @param publisherDidOrSigner - Publisher's DID or external signer
   * @param options - Optional configuration including progress callback
   * @returns The published OriginalsAsset in did:webvh layer
   * 
   * @example
   * ```typescript
   * const published = await sdk.lifecycle.publish(draft, 'did:webvh:example.com:user');
   * ```
   */
  async publish(
    asset: OriginalsAsset,
    publisherDidOrSigner: string | ExternalSigner,
    options?: LifecycleOperationOptions
  ): Promise<OriginalsAsset> {
    const onProgress = options?.onProgress;
    
    onProgress?.({
      phase: 'preparing',
      percentage: 0,
      message: 'Preparing to publish...'
    });
    
    onProgress?.({
      phase: 'validating',
      percentage: 10,
      message: 'Validating migration...'
    });
    
    // Pre-flight validation
    const validation = this.validateMigration(asset, 'did:webvh');
    if (!validation.valid) {
      onProgress?.({
        phase: 'failed',
        percentage: 0,
        message: `Validation failed: ${validation.errors.join(', ')}`
      });
      throw new StructuredError('MIGRATION_VALIDATION_FAILED', `Migration validation failed: ${validation.errors.join(', ')}`);
    }
    
    try {
      onProgress?.({
        phase: 'processing',
        percentage: 30,
        message: 'Publishing resources...'
      });
      
      onProgress?.({
        phase: 'committing',
        percentage: 70,
        message: 'Finalizing publication...'
      });
      
      const published = await this.publishToWeb(asset, publisherDidOrSigner);
      
      onProgress?.({
        phase: 'complete',
        percentage: 100,
        message: 'Asset published successfully'
      });
      
      return published;
    } catch (error) {
      onProgress?.({
        phase: 'failed',
        percentage: 0,
        message: `Failed to publish: ${error instanceof Error ? error.message : String(error)}`
      });
      throw error;
    }
  }

  /**
   * Inscribe an asset on Bitcoin (did:btco layer)
   * 
   * Permanently anchors an asset on the Bitcoin blockchain via Ordinals inscription.
   * This is an irreversible operation.
   * 
   * @param asset - The asset to inscribe (must be in did:peer or did:webvh layer)
   * @param options - Optional configuration including fee rate and progress callback
   * @returns The inscribed OriginalsAsset in did:btco layer
   * 
   * @example
   * ```typescript
   * const inscribed = await sdk.lifecycle.inscribe(published, {
   *   feeRate: 15,
   *   onProgress: (p) => console.log(`${p.percentage}%: ${p.message}`)
   * });
   * ```
   */
  async inscribe(
    asset: OriginalsAsset,
    options?: LifecycleOperationOptions
  ): Promise<OriginalsAsset> {
    const onProgress = options?.onProgress;
    const feeRate = options?.feeRate;
    
    onProgress?.({
      phase: 'preparing',
      percentage: 0,
      message: 'Preparing inscription...'
    });
    
    onProgress?.({
      phase: 'validating',
      percentage: 10,
      message: 'Validating migration...'
    });
    
    // Pre-flight validation
    const validation = this.validateMigration(asset, 'did:btco');
    if (!validation.valid) {
      onProgress?.({
        phase: 'failed',
        percentage: 0,
        message: `Validation failed: ${validation.errors.join(', ')}`
      });
      throw new StructuredError('MIGRATION_VALIDATION_FAILED', `Migration validation failed: ${validation.errors.join(', ')}`);
    }
    
    // Show cost estimate
    if (onProgress) {
      const estimate = await this.estimateCost(asset, 'did:btco', feeRate);
      onProgress({
        phase: 'preparing',
        percentage: 20,
        message: `Estimated cost: ${estimate.totalSats} sats (${estimate.feeRate} sat/vB)`
      });
    }
    
    try {
      onProgress?.({
        phase: 'processing',
        percentage: 30,
        message: 'Creating commit transaction...',
        details: { currentStep: 1, totalSteps: 3 }
      });
      
      onProgress?.({
        phase: 'committing',
        percentage: 60,
        message: 'Broadcasting reveal transaction...',
        details: { currentStep: 2, totalSteps: 3 }
      });
      
      const inscribed = await this.inscribeOnBitcoin(asset, feeRate);
      
      onProgress?.({
        phase: 'confirming',
        percentage: 90,
        message: 'Waiting for confirmation...',
        details: { currentStep: 3, totalSteps: 3 }
      });
      
      onProgress?.({
        phase: 'complete',
        percentage: 100,
        message: 'Asset inscribed successfully'
      });
      
      return inscribed;
    } catch (error) {
      onProgress?.({
        phase: 'failed',
        percentage: 0,
        message: `Failed to inscribe: ${error instanceof Error ? error.message : String(error)}`
      });
      throw error;
    }
  }

  /**
   * Transfer ownership of a Bitcoin-inscribed asset
   * 
   * Transfers an inscribed asset to a new owner. Only works for assets
   * in the did:btco layer.
   * 
   * @param asset - The asset to transfer (must be in did:btco layer)
   * @param newOwnerAddress - Bitcoin address of the new owner
   * @param options - Optional configuration including progress callback
   * @returns The Bitcoin transaction for the transfer
   * 
   * @example
   * ```typescript
   * const tx = await sdk.lifecycle.transfer(inscribed, 'bc1q...newowner');
   * console.log('Transfer txid:', tx.txid);
   * ```
   */
  async transfer(
    asset: OriginalsAsset,
    newOwnerAddress: string,
    options?: LifecycleOperationOptions
  ): Promise<BitcoinTransaction> {
    const onProgress = options?.onProgress;
    
    onProgress?.({
      phase: 'preparing',
      percentage: 0,
      message: 'Preparing transfer...'
    });
    
    onProgress?.({
      phase: 'validating',
      percentage: 10,
      message: 'Validating transfer...'
    });
    
    // Validate asset is in correct layer
    if (asset.currentLayer !== 'did:btco') {
      onProgress?.({
        phase: 'failed',
        percentage: 0,
        message: 'Asset must be inscribed on Bitcoin before transfer'
      });
      throw new StructuredError('INVALID_STATE', 'Asset must be inscribed on Bitcoin before transfer. Migrate to did:btco first.');
    }
    
    try {
      onProgress?.({
        phase: 'processing',
        percentage: 30,
        message: 'Creating transfer transaction...'
      });
      
      onProgress?.({
        phase: 'committing',
        percentage: 60,
        message: 'Broadcasting transaction...'
      });
      
      const tx = await this.transferOwnership(asset, newOwnerAddress);
      
      onProgress?.({
        phase: 'confirming',
        percentage: 90,
        message: 'Waiting for confirmation...',
        details: { transactionId: tx.txid }
      });
      
      onProgress?.({
        phase: 'complete',
        percentage: 100,
        message: 'Transfer complete',
        details: { transactionId: tx.txid }
      });
      
      return tx;
    } catch (error) {
      onProgress?.({
        phase: 'failed',
        percentage: 0,
        message: `Failed to transfer: ${error instanceof Error ? error.message : String(error)}`
      });
      throw error;
    }
  }

  // ===== Cost Estimation =====

  /**
   * Estimate the cost of migrating an asset to a target layer
   * 
   * Returns a detailed breakdown of expected costs for Bitcoin operations.
   * For did:webvh migrations, costs are minimal (only hosting).
   * 
   * @param asset - The asset to estimate costs for
   * @param targetLayer - The target layer for migration
   * @param feeRate - Optional fee rate override (sat/vB)
   * @returns Detailed cost estimate
   * 
   * @example
   * ```typescript
   * const cost = await sdk.lifecycle.estimateCost(draft, 'did:btco', 10);
   * console.log(`Estimated cost: ${cost.totalSats} sats`);
   * ```
   */
  async estimateCost(
    asset: OriginalsAsset,
    targetLayer: LayerType,
    feeRate?: number
  ): Promise<CostEstimate> {
    // For webvh, costs are minimal (just hosting costs not applicable here)
    if (targetLayer === 'did:webvh') {
      return {
        totalSats: 0,
        breakdown: {
          networkFee: 0,
          dataCost: 0,
          dustValue: 0
        },
        feeRate: 0,
        dataSize: 0,
        targetLayer,
        confidence: 'high'
      };
    }
    
    // For btco, calculate inscription costs
    if (targetLayer === 'did:btco') {
      // Calculate manifest size
      const manifest = {
        assetId: asset.id,
        resources: asset.resources.map(res => ({
          id: res.id,
          hash: res.hash,
          contentType: res.contentType,
          url: res.url
        })),
        timestamp: new Date().toISOString()
      };
      const dataSize = Buffer.from(JSON.stringify(manifest)).length;
      
      // Get fee rate from oracle or use provided/default
      let effectiveFeeRate = feeRate;
      let confidence: 'low' | 'medium' | 'high' = 'medium';
      
      if (!effectiveFeeRate) {
        // Try to get from fee oracle
        if (this.config.feeOracle) {
          try {
            effectiveFeeRate = await this.config.feeOracle.estimateFeeRate(1);
            confidence = 'high';
          } catch {
            // Fallback to default
          }
        }
        
        // Try ordinals provider
        if (!effectiveFeeRate && this.config.ordinalsProvider) {
          try {
            effectiveFeeRate = await this.config.ordinalsProvider.estimateFee(1);
            confidence = 'medium';
          } catch {
            // Fallback to default
          }
        }
        
        // Use default if no oracle available
        if (!effectiveFeeRate) {
          effectiveFeeRate = 10; // Conservative default
          confidence = 'low';
        }
      }
      
      // Transaction structure estimation:
      // - Commit transaction: ~200 vB base + input overhead
      // - Reveal transaction: ~200 vB base + inscription envelope + data
      // Inscription envelope overhead: ~122 bytes
      const commitTxSize = 200;
      const revealTxSize = 200 + 122 + dataSize;
      const totalSize = commitTxSize + revealTxSize;
      
      const networkFee = totalSize * effectiveFeeRate;
      const dustValue = 546; // Standard dust limit for P2TR
      const totalSats = networkFee + dustValue;
      
      return {
        totalSats,
        breakdown: {
          networkFee,
          dataCost: dataSize * effectiveFeeRate,
          dustValue
        },
        feeRate: effectiveFeeRate,
        dataSize,
        targetLayer,
        confidence
      };
    }
    
    // For peer layer (no migration needed)
    return {
      totalSats: 0,
      breakdown: {
        networkFee: 0,
        dataCost: 0,
        dustValue: 0
      },
      feeRate: 0,
      dataSize: 0,
      targetLayer,
      confidence: 'high'
    };
  }

  // ===== Migration Validation =====

  /**
   * Validate whether an asset can be migrated to a target layer
   *
   * Performs comprehensive pre-flight checks including:
   * - Valid layer transition
   * - Resource integrity
   * - Credential validity
   * - DID document structure
   * - Bitcoin readiness (for did:btco)
   *
   * @param asset - The asset to validate
   * @param targetLayer - The target layer for migration
   * @returns Detailed validation result
   *
   * @example
   * ```typescript
   * const validation = await sdk.lifecycle.validateMigration(draft, 'did:webvh');
   * if (!validation.valid) {
   *   console.error('Cannot migrate:', validation.errors);
   * }
   * ```
   */
  validateMigration(
    asset: OriginalsAsset,
    targetLayer: LayerType
  ): MigrationValidation {
    const errors: string[] = [];
    const warnings: string[] = [];
    const checks = {
      layerTransition: false,
      resourcesValid: false,
      credentialsValid: false,
      didDocumentValid: false,
      bitcoinReadiness: undefined as boolean | undefined
    };
    
    // Check layer transition validity
    const validTransitions: Record<LayerType, LayerType[]> = {
      'did:peer': ['did:webvh', 'did:btco'],
      'did:webvh': ['did:btco'],
      'did:btco': []
    };
    
    if (validTransitions[asset.currentLayer].includes(targetLayer)) {
      checks.layerTransition = true;
    } else {
      errors.push(`Invalid migration from ${asset.currentLayer} to ${targetLayer}`);
    }
    
    // Validate resources
    if (asset.resources.length === 0) {
      errors.push('Asset must have at least one resource');
    } else {
      let resourcesValid = true;
      for (const resource of asset.resources) {
        if (!resource.id || !resource.type || !resource.contentType || !resource.hash) {
          resourcesValid = false;
          errors.push(`Resource ${resource.id || 'unknown'} is missing required fields`);
        }
        if (resource.hash && !/^[0-9a-fA-F]+$/.test(resource.hash)) {
          resourcesValid = false;
          errors.push(`Resource ${resource.id} has invalid hash format`);
        }
      }
      checks.resourcesValid = resourcesValid;
    }
    
    // Validate DID document
    if (asset.did && asset.did.id) {
      checks.didDocumentValid = true;
    } else {
      errors.push('Asset has invalid or missing DID document');
    }
    
    // Validate credentials (structural check)
    if (asset.credentials.length > 0) {
      let credentialsValid = true;
      for (const cred of asset.credentials) {
        if (!cred.type || !cred.issuer || !cred.issuanceDate) {
          credentialsValid = false;
          warnings.push('Asset has credentials with missing fields');
        }
      }
      checks.credentialsValid = credentialsValid;
    } else {
      checks.credentialsValid = true; // No credentials is valid
    }
    
    // Bitcoin-specific checks
    if (targetLayer === 'did:btco') {
      checks.bitcoinReadiness = true;
      
      // Check if ordinals provider is configured
      if (!this.config.ordinalsProvider) {
        checks.bitcoinReadiness = false;
        errors.push('Bitcoin inscription requires an ordinalsProvider to be configured');
      }
      
      // Warn about large data sizes
      const manifestSize = JSON.stringify({
        assetId: asset.id,
        resources: asset.resources.map(r => ({
          id: r.id,
          hash: r.hash,
          contentType: r.contentType
        }))
      }).length;
      
      if (manifestSize > 100000) {
        warnings.push(`Large manifest size (${manifestSize} bytes) may result in high inscription costs`);
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings,
      currentLayer: asset.currentLayer,
      targetLayer,
      checks
    };
  }
}


