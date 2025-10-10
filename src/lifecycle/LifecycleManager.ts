import {
  OriginalsConfig,
  AssetResource,
  BitcoinTransaction,
  KeyStore,
  ExternalSigner,
  VerifiableCredential
} from '../types';
import { BitcoinManager } from '../bitcoin/BitcoinManager';
import { DIDManager } from '../did/DIDManager';
import { CredentialManager } from '../vc/CredentialManager';
import { OriginalsAsset } from './OriginalsAsset';
import { MemoryStorageAdapter } from '../storage/MemoryStorageAdapter';
import { encodeBase64UrlMultibase, hexToBytes } from '../utils/encoding';
import { validateBitcoinAddress } from '../utils/bitcoin-address';
import { multikey } from '../crypto/Multikey';
import { EventEmitter } from '../events/EventEmitter';
import type { EventHandler, EventTypeMap } from '../events/types';
import { Logger } from '../utils/Logger';
import { MetricsCollector } from '../utils/MetricsCollector';
import { 
  BatchOperationExecutor, 
  BatchValidator,
  BatchError,
  type BatchResult,
  type BatchOperationOptions,
  type BatchInscriptionOptions,
} from './BatchOperations';

export class LifecycleManager {
  private eventEmitter: EventEmitter;
  private batchExecutor: BatchOperationExecutor;
  private batchValidator: BatchValidator;
  private logger: Logger;
  private metrics: MetricsCollector;

  constructor(
    private config: OriginalsConfig,
    private didManager: DIDManager,
    private credentialManager: CredentialManager,
    private deps?: { bitcoinManager?: BitcoinManager },
    private keyStore?: KeyStore
  ) {
    this.eventEmitter = new EventEmitter();
    this.batchExecutor = new BatchOperationExecutor();
    this.batchValidator = new BatchValidator();
    this.logger = new Logger('LifecycleManager', config);
    this.metrics = new MetricsCollector();
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
      throw new Error('KeyStore not configured. Provide keyStore to LifecycleManager constructor.');
    }
    
    // Validate verification method ID format
    if (!verificationMethodId || typeof verificationMethodId !== 'string') {
      throw new Error('Invalid verificationMethodId: must be a non-empty string');
    }
    
    // Validate private key format (should be multibase encoded)
    if (!privateKey || typeof privateKey !== 'string') {
      throw new Error('Invalid privateKey: must be a non-empty string');
    }
    
    // Validate that it's a valid multibase-encoded private key
    try {
      multikey.decodePrivateKey(privateKey);
    } catch (err) {
      throw new Error('Invalid privateKey format: must be a valid multibase-encoded private key');
    }
    
    await this.keyStore.setPrivateKey(verificationMethodId, privateKey);
  }

  async createAsset(resources: AssetResource[]): Promise<OriginalsAsset> {
    const stopTimer = this.logger.startTimer('createAsset');
    this.logger.info('Creating asset', { resourceCount: resources.length });
    
    try {
      // Input validation
      if (!Array.isArray(resources)) {
        throw new Error('Resources must be an array');
      }
      if (resources.length === 0) {
        throw new Error('At least one resource is required');
      }
      
      // Validate each resource
      for (const resource of resources) {
        if (!resource || typeof resource !== 'object') {
          throw new Error('Invalid resource: must be an object');
        }
        if (!resource.id || typeof resource.id !== 'string') {
          throw new Error('Invalid resource: missing or invalid id');
        }
        if (!resource.type || typeof resource.type !== 'string') {
          throw new Error('Invalid resource: missing or invalid type');
        }
        if (!resource.contentType || typeof resource.contentType !== 'string') {
          throw new Error('Invalid resource: missing or invalid contentType');
        }
        if (!resource.hash || typeof resource.hash !== 'string' || !/^[0-9a-fA-F]+$/.test(resource.hash)) {
          throw new Error('Invalid resource: missing or invalid hash (must be hex string)');
        }
        // Validate contentType is a valid MIME type
        if (!/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}$/.test(resource.contentType)) {
          throw new Error(`Invalid resource: invalid contentType MIME format: ${resource.contentType}`);
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
        this.eventEmitter.emit(event);
        (asset as any).eventEmitter.emit(event);
      });
      
      stopTimer();
      this.logger.info('Asset created successfully', { assetId: asset.id });
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
        this.eventEmitter.emit(event);
        (asset as any).eventEmitter.emit(event);
      });
      
      stopTimer();
      this.logger.info('Asset created successfully', { assetId: asset.id });
      this.metrics.recordAssetCreated();
      
      return asset;
    }
    } catch (error) {
      stopTimer();
      this.logger.error('Asset creation failed', error as Error, { resourceCount: resources.length });
      this.metrics.recordError('ASSET_CREATION_FAILED', 'createAsset');
      throw error;
    }
  }

  async publishToWeb(
    asset: OriginalsAsset,
    publisherDidOrSigner: string | ExternalSigner
  ): Promise<OriginalsAsset> {
    const stopTimer = this.logger.startTimer('publishToWeb');
    
    try {
      if (asset.currentLayer !== 'did:peer') {
        throw new Error('Asset must be in did:peer layer to publish to web');
      }
      
      const { publisherDid, signer } = await this.extractPublisherInfo(publisherDidOrSigner);
      const { domain, userPath } = this.parseWebVHDid(publisherDid);
      
      this.logger.info('Publishing asset to web', { assetId: asset.id, publisherDid });
      
      // Publish resources to storage
      await this.publishResources(asset, publisherDid, domain, userPath);
      
      // Migrate asset to did:webvh layer
      await asset.migrate('did:webvh');
      asset.bindings = { ...(asset as any).bindings, 'did:webvh': publisherDid };
      
      // Issue publication credential (best-effort)
      await this.issuePublicationCredential(asset, publisherDid, signer);
      
      stopTimer();
      this.logger.info('Asset published to web successfully', { 
        assetId: asset.id, 
        publisherDid, 
        resourceCount: asset.resources.length 
      });
      this.metrics.recordMigration('did:peer', 'did:webvh');
      
      return asset;
    } catch (error) {
      stopTimer();
      this.logger.error('Publish to web failed', error as Error, { assetId: asset.id });
      this.metrics.recordError('PUBLISH_FAILED', 'publishToWeb');
      throw error;
    }
  }

  private async extractPublisherInfo(publisherDidOrSigner: string | ExternalSigner): Promise<{
    publisherDid: string;
    signer?: ExternalSigner;
  }> {
    if (typeof publisherDidOrSigner === 'string') {
      if (!publisherDidOrSigner.startsWith('did:webvh:')) {
        throw new Error('Publisher DID must be a did:webvh identifier');
      }
      return { publisherDid: publisherDidOrSigner };
    }
    
    const signer = publisherDidOrSigner;
    const vmId = await signer.getVerificationMethodId();
    const publisherDid = vmId.includes('#') ? vmId.split('#')[0] : vmId;
    
    if (!publisherDid.startsWith('did:webvh:')) {
      throw new Error('Signer must be associated with a did:webvh identifier');
    }
    
    return { publisherDid, signer };
  }

  private parseWebVHDid(did: string): { domain: string; userPath: string } {
    const parts = did.split(':');
    if (parts.length < 4) {
      throw new Error('Invalid did:webvh format: must include domain and user path');
    }
    
    const domain = decodeURIComponent(parts[2]);
    const userPath = parts.slice(3).join('/');
    
    return { domain, userPath };
  }

  private async publishResources(
    asset: OriginalsAsset,
    publisherDid: string,
    domain: string,
    userPath: string
  ): Promise<void> {
    const storage = (this.config as any).storageAdapter || new MemoryStorageAdapter();
    
    for (const resource of asset.resources) {
      const hashBytes = hexToBytes(resource.hash);
      const multibase = encodeBase64UrlMultibase(hashBytes);
      const resourceUrl = `${publisherDid}/resources/${multibase}`;
      const relativePath = `${userPath}/resources/${multibase}`;
      
      // Store resource content
      const data = resource.content 
        ? Buffer.from(resource.content)
        : Buffer.from(resource.hash);
        
      if (typeof storage.put === 'function') {
        await storage.put(`${domain}/${relativePath}`, data, { contentType: resource.contentType });
      } else {
        const encoded = new TextEncoder().encode(resource.content || resource.hash);
        await storage.putObject(domain, relativePath, encoded);
      }
      
      (resource as any).url = resourceUrl;
      
      await this.emitResourcePublishedEvent(asset.id, resource, resourceUrl, publisherDid);
    }
  }

  private async emitResourcePublishedEvent(
    assetId: string,
    resource: AssetResource,
    resourceUrl: string,
    publisherDid: string
  ): Promise<void> {
    const event = {
      type: 'resource:published' as const,
      timestamp: new Date().toISOString(),
      asset: { id: assetId },
      resource: {
        id: resource.id,
        url: resourceUrl,
        contentType: resource.contentType,
        hash: resource.hash
      },
      publisherDid
    };
    
    try {
      await this.eventEmitter.emit(event);
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
      const subject = {
        id: asset.id,
        publishedAs: publisherDid,
        resourceId: asset.resources[0]?.id,
        fromLayer: 'did:peer' as const,
        toLayer: 'did:webvh' as const,
        migratedAt: new Date().toISOString()
      };
      
      const unsigned = await this.credentialManager.createResourceCredential(
        'ResourceMigrated',
        subject,
        publisherDid
      );
      
      const signed = signer
        ? await this.credentialManager.signCredentialWithExternalSigner(unsigned, signer)
        : await this.signWithKeyStore(unsigned, publisherDid);
      
      asset.credentials.push(signed);
      
      await this.eventEmitter.emit({
        type: 'credential:issued' as const,
        timestamp: new Date().toISOString(),
        asset: { id: asset.id },
        credential: {
          type: signed.type,
          issuer: typeof signed.issuer === 'string' ? signed.issuer : signed.issuer.id
        }
      });
    } catch (err) {
      this.logger.error('Failed to issue credential during publish', err as Error);
    }
  }

  private async signWithKeyStore(
    credential: VerifiableCredential,
    issuer: string
  ): Promise<VerifiableCredential> {
    if (!this.keyStore) {
      throw new Error('KeyStore required for signing. Provide keyStore or external signer.');
    }
    
    const didDoc = await this.didManager.resolveDID(issuer);
    if (!didDoc?.verificationMethod?.[0]) {
      throw new Error('No verification method found in publisher DID document');
    }
    
    let vmId = didDoc.verificationMethod[0].id;
    if (vmId.startsWith('#')) {
      vmId = `${issuer}${vmId}`;
    }
    
    const privateKey = await this.keyStore.getPrivateKey(vmId);
    if (!privateKey) {
      throw new Error('Private key not found in keyStore');
    }
    
    return this.credentialManager.signCredential(credential, privateKey, vmId);
  }

  async inscribeOnBitcoin(
    asset: OriginalsAsset,
    feeRate?: number
  ): Promise<OriginalsAsset> {
    const stopTimer = this.logger.startTimer('inscribeOnBitcoin');
    this.logger.info('Inscribing asset on Bitcoin', { assetId: asset.id, feeRate });
    
    try {
      // Input validation
      if (!asset || typeof asset !== 'object') {
        throw new Error('Invalid asset: must be a valid OriginalsAsset');
      }
      if (feeRate !== undefined) {
        if (typeof feeRate !== 'number' || feeRate <= 0 || !Number.isFinite(feeRate)) {
          throw new Error('Invalid feeRate: must be a positive number');
        }
        if (feeRate < 1 || feeRate > 1000000) {
          throw new Error('Invalid feeRate: must be between 1 and 1000000 sat/vB');
        }
      }
    
    if (typeof (asset as any).migrate !== 'function') {
      throw new Error('Not implemented');
    }
    if (asset.currentLayer !== 'did:webvh' && asset.currentLayer !== 'did:peer') {
      throw new Error('Not implemented');
    }
    const bitcoinManager = this.deps?.bitcoinManager ?? new BitcoinManager(this.config);
    const manifest = {
      assetId: asset.id,
      resources: asset.resources.map(res => ({ id: res.id, hash: res.hash, contentType: res.contentType, url: res.url })),
      timestamp: new Date().toISOString()
    };
    const payload = Buffer.from(JSON.stringify(manifest));
    const inscription: any = await bitcoinManager.inscribeData(payload, 'application/json', feeRate);
    const revealTxId = inscription.revealTxId ?? inscription.txid;
    const commitTxId = inscription.commitTxId;
    const usedFeeRate = typeof inscription.feeRate === 'number' ? inscription.feeRate : feeRate;

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

    const bindingValue = inscription.satoshi
      ? `did:btco:${inscription.satoshi}`
      : `did:btco:${inscription.inscriptionId}`;
    (asset as any).bindings = Object.assign({}, (asset as any).bindings, { 'did:btco': bindingValue });
    
    stopTimer();
    this.logger.info('Asset inscribed on Bitcoin successfully', { 
      assetId: asset.id, 
      inscriptionId: inscription.inscriptionId,
      transactionId: revealTxId
    });
    this.metrics.recordMigration(fromLayer, 'did:btco');
    
    return asset;
    } catch (error) {
      stopTimer();
      this.logger.error('Bitcoin inscription failed', error as Error, { assetId: asset.id, feeRate });
      this.metrics.recordError('INSCRIPTION_FAILED', 'inscribeOnBitcoin');
      throw error;
    }
  }

  async transferOwnership(
    asset: OriginalsAsset,
    newOwner: string
  ): Promise<BitcoinTransaction> {
    const stopTimer = this.logger.startTimer('transferOwnership');
    this.logger.info('Transferring asset ownership', { assetId: asset.id, newOwner });
    
    try {
      // Input validation
      if (!asset || typeof asset !== 'object') {
        throw new Error('Invalid asset: must be a valid OriginalsAsset');
      }
      if (!newOwner || typeof newOwner !== 'string') {
        throw new Error('Invalid newOwner: must be a non-empty string');
      }
      
      // Validate Bitcoin address format and checksum
      try {
        validateBitcoinAddress(newOwner, this.config.network);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid Bitcoin address';
        throw new Error(`Invalid Bitcoin address for ownership transfer: ${message}`);
      }
    
    // Transfer Bitcoin-anchored asset ownership
    // Only works for assets in did:btco layer
    if (asset.currentLayer !== 'did:btco') {
      throw new Error('Asset must be inscribed on Bitcoin before transfer');
    }
    const bm = this.deps?.bitcoinManager ?? new BitcoinManager(this.config);
    const provenance = asset.getProvenance();
    const latestMigration = provenance.migrations[provenance.migrations.length - 1];
    const satoshi = latestMigration?.satoshi ?? (asset.id.startsWith('did:btco:') ? asset.id.split(':')[2] : '');
    const inscription = {
      satoshi,
      inscriptionId: latestMigration?.inscriptionId ?? `insc-${satoshi || 'unknown'}`,
      content: Buffer.alloc(0),
      contentType: 'application/octet-stream',
      txid: latestMigration?.transactionId ?? 'unknown-tx',
      vout: 0
    };
    const tx = await bm.transferInscription(inscription as any, newOwner);
    await asset.recordTransfer(asset.id, newOwner, tx.txid);
    
    stopTimer();
    this.logger.info('Asset ownership transferred successfully', { 
      assetId: asset.id, 
      newOwner, 
      transactionId: tx.txid 
    });
    this.metrics.recordTransfer();
    
    return tx;
    } catch (error) {
      stopTimer();
      this.logger.error('Ownership transfer failed', error as Error, { assetId: asset.id, newOwner });
      this.metrics.recordError('TRANSFER_FAILED', 'transferOwnership');
      throw error;
    }
  }

  /**
   * Create multiple assets in batch
   * 
   * @param resourcesList - Array of resource arrays, one per asset to create
   * @param options - Batch operation options
   * @returns BatchResult with created assets
   */
  async batchCreateAssets(
    resourcesList: AssetResource[][],
    options?: BatchOperationOptions
  ): Promise<BatchResult<OriginalsAsset>> {
    const batchId = this.batchExecutor.generateBatchId();
    
    // Validate first if requested
    if (options?.validateFirst !== false) {
      const validationResults = this.batchValidator.validateBatchCreate(resourcesList);
      const invalid = validationResults.filter(r => !r.isValid);
      if (invalid.length > 0) {
        const errors = invalid.flatMap(r => r.errors).join('; ');
        throw new Error(`Batch validation failed: ${errors}`);
      }
    }
    
    // Emit batch:started event
    await this.eventEmitter.emit({
      type: 'batch:started',
      timestamp: new Date().toISOString(),
      operation: 'create',
      batchId,
      itemCount: resourcesList.length
    });
    
    try {
      // Use batch executor to process all asset creations
      const result = await this.batchExecutor.execute(
        resourcesList,
        async (resources, index) => {
          const asset = await this.createAsset(resources);
          return asset;
        },
        options,
        batchId // Pass the pre-generated batchId for event correlation
      );
      
      // Emit batch:completed event
      await this.eventEmitter.emit({
        type: 'batch:completed',
        timestamp: new Date().toISOString(),
        batchId,
        operation: 'create',
        results: {
          successful: result.successful.length,
          failed: result.failed.length,
          totalDuration: result.totalDuration
        }
      });
      
      return result;
    } catch (error) {
      // Emit batch:failed event
      await this.eventEmitter.emit({
        type: 'batch:failed',
        timestamp: new Date().toISOString(),
        batchId,
        operation: 'create',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    }
  }

  /**
   * Publish multiple assets to web storage in batch
   * 
   * @param assets - Array of assets to publish
   * @param domain - Domain to publish to
   * @param options - Batch operation options
   * @returns BatchResult with published assets
   */
  async batchPublishToWeb(
    assets: OriginalsAsset[],
    domain: string,
    options?: BatchOperationOptions
  ): Promise<BatchResult<OriginalsAsset>> {
    const batchId = this.batchExecutor.generateBatchId();
    
    // Validate domain once
    if (!domain || typeof domain !== 'string') {
      throw new Error('Invalid domain: must be a non-empty string');
    }
    
    const normalized = domain.trim().toLowerCase();
    
    // Split domain and port if present
    const [domainPart, portPart] = normalized.split(':');
    
    // Validate port if present
    if (portPart && (!/^\d+$/.test(portPart) || parseInt(portPart) < 1 || parseInt(portPart) > 65535)) {
      throw new Error(`Invalid domain format: ${domain} - invalid port`);
    }
    
    // Allow localhost and IP addresses for development
    const isLocalhost = domainPart === 'localhost';
    const isIP = /^(\d{1,3}\.){3}\d{1,3}$/.test(domainPart);
    
    if (!isLocalhost && !isIP) {
      // For non-localhost domains, require proper domain format
      const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
      const domainRegex = new RegExp(`^(?=.{1,253}$)(?:${label})(?:\\.(?:${label}))+?$`, 'i');
      if (!domainRegex.test(domainPart)) {
        throw new Error(`Invalid domain format: ${domain}`);
      }
    }
    
    // Emit batch:started event
    await this.eventEmitter.emit({
      type: 'batch:started',
      timestamp: new Date().toISOString(),
      operation: 'publish',
      batchId,
      itemCount: assets.length
    });
    
    try {
      const result = await this.batchExecutor.execute(
        assets,
        async (asset, index) => {
          return await this.publishToWeb(asset, domain);
        },
        options,
        batchId // Pass the pre-generated batchId for event correlation
      );
      
      // Emit batch:completed event
      await this.eventEmitter.emit({
        type: 'batch:completed',
        timestamp: new Date().toISOString(),
        batchId,
        operation: 'publish',
        results: {
          successful: result.successful.length,
          failed: result.failed.length,
          totalDuration: result.totalDuration
        }
      });
      
      return result;
    } catch (error) {
      // Emit batch:failed event
      await this.eventEmitter.emit({
        type: 'batch:failed',
        timestamp: new Date().toISOString(),
        batchId,
        operation: 'publish',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    }
  }

  /**
   * Inscribe multiple assets on Bitcoin with cost optimization
   * KEY FEATURE: singleTransaction option for 30%+ cost savings
   * 
   * @param assets - Array of assets to inscribe
   * @param options - Batch inscription options
   * @returns BatchResult with inscribed assets
   */
  async batchInscribeOnBitcoin(
    assets: OriginalsAsset[],
    options?: BatchInscriptionOptions
  ): Promise<BatchResult<OriginalsAsset>> {
    // Validate first if requested
    if (options?.validateFirst !== false) {
      const validationResults = this.batchValidator.validateBatchInscription(assets);
      const invalid = validationResults.filter(r => !r.isValid);
      if (invalid.length > 0) {
        const errors = invalid.flatMap(r => r.errors).join('; ');
        throw new Error(`Batch validation failed: ${errors}`);
      }
    }
    
    if (options?.singleTransaction) {
      return this.batchInscribeSingleTransaction(assets, options);
    } else {
      return this.batchInscribeIndividualTransactions(assets, options);
    }
  }

  /**
   * CORE INNOVATION: Single-transaction batch inscription
   * Combines multiple assets into one Bitcoin transaction for 30%+ cost savings
   * 
   * @param assets - Array of assets to inscribe
   * @param options - Batch inscription options
   * @returns BatchResult with inscribed assets and cost savings data
   */
  private async batchInscribeSingleTransaction(
    assets: OriginalsAsset[],
    options?: BatchInscriptionOptions
  ): Promise<BatchResult<OriginalsAsset>> {
    const batchId = this.batchExecutor.generateBatchId();
    const startTime = Date.now();
    const startedAt = new Date().toISOString();
    
    // Emit batch:started event
    await this.eventEmitter.emit({
      type: 'batch:started',
      timestamp: startedAt,
      operation: 'inscribe',
      batchId,
      itemCount: assets.length
    });
    
    try {
      // Calculate total data size for all assets
      const totalDataSize = this.calculateTotalDataSize(assets);
      
      // Estimate savings from batch inscription
      const estimatedSavings = await this.estimateBatchSavings(assets, options?.feeRate);
      
      // Create manifests for all assets
      const manifests = assets.map(asset => ({
        assetId: asset.id,
        resources: asset.resources.map(res => ({
          id: res.id,
          hash: res.hash,
          contentType: res.contentType,
          url: res.url
        })),
        timestamp: new Date().toISOString()
      }));
      
      // Combine all manifests into a single batch payload
      const batchManifest = {
        batchId,
        assets: manifests,
        timestamp: new Date().toISOString()
      };
      
      const payload = Buffer.from(JSON.stringify(batchManifest));
      
      // Inscribe the batch manifest as a single transaction
      const bitcoinManager = this.deps?.bitcoinManager ?? new BitcoinManager(this.config);
      const inscription: any = await bitcoinManager.inscribeData(
        payload,
        'application/json',
        options?.feeRate
      );
      
      const revealTxId = inscription.revealTxId ?? inscription.txid;
      const commitTxId = inscription.commitTxId;
      const usedFeeRate = typeof inscription.feeRate === 'number' ? inscription.feeRate : options?.feeRate;
      
      // Calculate fee per asset (split proportionally by data size)
      // Include both metadata and resource content size for accurate fee distribution
      const assetSizes = assets.map(asset => {
        // Calculate metadata size
        const metadataSize = JSON.stringify({
          assetId: asset.id,
          resources: asset.resources.map(r => ({
            id: r.id,
            hash: r.hash,
            contentType: r.contentType,
            url: r.url
          }))
        }).length;
        
        // Add resource content sizes
        const contentSize = asset.resources.reduce((sum, r) => {
          const content = (r as any).content;
          if (content) {
            return sum + (typeof content === 'string' ? Buffer.byteLength(content) : content.length || 0);
          }
          return sum;
        }, 0);
        
        return metadataSize + contentSize;
      });
      const totalSize = assetSizes.reduce((sum, size) => sum + size, 0);
      
      // Calculate total fee from batch transaction size and fee rate
      // Estimate transaction size: base overhead (200 bytes) + batch payload size
      const batchTxSize = 200 + totalDataSize;
      const effectiveFeeRate = usedFeeRate ?? 10;
      const totalFee = batchTxSize * effectiveFeeRate;
      
      // Split fees proportionally by asset data size
      const feePerAsset = assetSizes.map(size => 
        Math.floor(totalFee * (size / totalSize))
      );
      
      // Update all assets with batch inscription data
      const individualInscriptionIds: string[] = [];
      const successful: BatchResult<OriginalsAsset>['successful'] = [];
      
      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i];
        // For batch inscriptions, use the base inscription ID for all assets
        // The batch index is stored as metadata, not in the ID
        const individualInscriptionId = inscription.inscriptionId;
        individualInscriptionIds.push(individualInscriptionId);
        
        await asset.migrate('did:btco', {
          transactionId: revealTxId,
          inscriptionId: individualInscriptionId,
          satoshi: inscription.satoshi,
          commitTxId,
          revealTxId,
          feeRate: usedFeeRate
        });
        
        // Add batch metadata to provenance
        const provenance = asset.getProvenance();
        const latestMigration = provenance.migrations[provenance.migrations.length - 1];
        (latestMigration as any).batchId = batchId;
        (latestMigration as any).batchInscription = true;
        (latestMigration as any).batchIndex = i; // Store index as metadata
        (latestMigration as any).feePaid = feePerAsset[i];
        
        const bindingValue = inscription.satoshi
          ? `did:btco:${inscription.satoshi}`
          : `did:btco:${individualInscriptionId}`;
        (asset as any).bindings = Object.assign({}, (asset as any).bindings, { 'did:btco': bindingValue });
        
        successful.push({
          index: i,
          result: asset,
          duration: Date.now() - startTime
        });
      }
      
      const totalDuration = Date.now() - startTime;
      const completedAt = new Date().toISOString();
      
      // Emit batch:completed event with cost savings
      await this.eventEmitter.emit({
        type: 'batch:completed',
        timestamp: completedAt,
        batchId,
        operation: 'inscribe',
        results: {
          successful: successful.length,
          failed: 0,
          totalDuration,
          costSavings: {
            amount: estimatedSavings.savings,
            percentage: estimatedSavings.savingsPercentage
          }
        }
      });
      
      return {
        successful,
        failed: [],
        totalProcessed: assets.length,
        totalDuration,
        batchId,
        startedAt,
        completedAt
      };
    } catch (error) {
      // Emit batch:failed event
      await this.eventEmitter.emit({
        type: 'batch:failed',
        timestamp: new Date().toISOString(),
        batchId,
        operation: 'inscribe',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw new BatchError(
        batchId,
        'inscribe',
        { successful: 0, failed: assets.length },
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  /**
   * Individual transaction batch inscription (fallback mode)
   * Each asset is inscribed in its own transaction
   * 
   * @param assets - Array of assets to inscribe
   * @param options - Batch inscription options
   * @returns BatchResult with inscribed assets
   */
  private async batchInscribeIndividualTransactions(
    assets: OriginalsAsset[],
    options?: BatchInscriptionOptions
  ): Promise<BatchResult<OriginalsAsset>> {
    const batchId = this.batchExecutor.generateBatchId();
    
    // Emit batch:started event
    await this.eventEmitter.emit({
      type: 'batch:started',
      timestamp: new Date().toISOString(),
      operation: 'inscribe',
      batchId,
      itemCount: assets.length
    });
    
    try {
      const result = await this.batchExecutor.execute(
        assets,
        async (asset, index) => {
          return await this.inscribeOnBitcoin(asset, options?.feeRate);
        },
        options,
        batchId // Pass the pre-generated batchId for event correlation
      );
      
      // Emit batch:completed event
      await this.eventEmitter.emit({
        type: 'batch:completed',
        timestamp: new Date().toISOString(),
        batchId,
        operation: 'inscribe',
        results: {
          successful: result.successful.length,
          failed: result.failed.length,
          totalDuration: result.totalDuration
        }
      });
      
      return result;
    } catch (error) {
      // Emit batch:failed event
      await this.eventEmitter.emit({
        type: 'batch:failed',
        timestamp: new Date().toISOString(),
        batchId,
        operation: 'inscribe',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    }
  }

  /**
   * Transfer ownership of multiple assets in batch
   * 
   * @param transfers - Array of transfer operations
   * @param options - Batch operation options
   * @returns BatchResult with transaction results
   */
  async batchTransferOwnership(
    transfers: Array<{ asset: OriginalsAsset; to: string }>,
    options?: BatchOperationOptions
  ): Promise<BatchResult<BitcoinTransaction>> {
    const batchId = this.batchExecutor.generateBatchId();
    
    // Validate first if requested
    if (options?.validateFirst !== false) {
      const validationResults = this.batchValidator.validateBatchTransfer(transfers);
      const invalid = validationResults.filter(r => !r.isValid);
      if (invalid.length > 0) {
        const errors = invalid.flatMap(r => r.errors).join('; ');
        throw new Error(`Batch validation failed: ${errors}`);
      }
      
      // Validate all Bitcoin addresses
      for (let i = 0; i < transfers.length; i++) {
        try {
          validateBitcoinAddress(transfers[i].to, this.config.network);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Invalid Bitcoin address';
          throw new Error(`Transfer ${i}: Invalid Bitcoin address: ${message}`);
        }
      }
    }
    
    // Emit batch:started event
    await this.eventEmitter.emit({
      type: 'batch:started',
      timestamp: new Date().toISOString(),
      operation: 'transfer',
      batchId,
      itemCount: transfers.length
    });
    
    try {
      const result = await this.batchExecutor.execute(
        transfers,
        async (transfer, index) => {
          return await this.transferOwnership(transfer.asset, transfer.to);
        },
        options,
        batchId // Pass the pre-generated batchId for event correlation
      );
      
      // Emit batch:completed event
      await this.eventEmitter.emit({
        type: 'batch:completed',
        timestamp: new Date().toISOString(),
        batchId,
        operation: 'transfer',
        results: {
          successful: result.successful.length,
          failed: result.failed.length,
          totalDuration: result.totalDuration
        }
      });
      
      return result;
    } catch (error) {
      // Emit batch:failed event
      await this.eventEmitter.emit({
        type: 'batch:failed',
        timestamp: new Date().toISOString(),
        batchId,
        operation: 'transfer',
        error: error instanceof Error ? error.message : String(error)
      });
      
      throw error;
    }
  }

  /**
   * Calculate total data size for all assets in a batch
   */
  private calculateTotalDataSize(assets: OriginalsAsset[]): number {
    return assets.reduce((total, asset) => {
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
      return total + JSON.stringify(manifest).length;
    }, 0);
  }

  /**
   * Estimate cost savings from batch inscription vs individual inscriptions
   */
  private async estimateBatchSavings(
    assets: OriginalsAsset[],
    feeRate?: number
  ): Promise<{
    batchFee: number;
    individualFees: number;
    savings: number;
    savingsPercentage: number;
  }> {
    // Calculate total size for batch
    const batchSize = this.calculateTotalDataSize(assets);
    
    // Estimate individual sizes
    const individualSizes = assets.map(asset => 
      JSON.stringify({
        assetId: asset.id,
        resources: asset.resources.map(r => ({
          id: r.id,
          hash: r.hash,
          contentType: r.contentType,
          url: r.url
        }))
      }).length
    );
    
    // Realistic fee estimation based on Bitcoin transaction structure
    // Base transaction overhead: ~200 bytes (inputs, outputs, etc.)
    // Per inscription witness overhead: ~120 bytes (script, envelope, etc.)
    // In batch mode: shared transaction overhead + minimal per-asset overhead
    const effectiveFeeRate = feeRate ?? 10; // default 10 sat/vB
    
    // Batch: one transaction overhead + batch data + minimal per-asset overhead
    // The batch manifest is more efficient as it shares structure
    const batchTxSize = 200 + batchSize + (assets.length * 5); // 5 bytes per asset for array/object overhead
    const batchFee = batchTxSize * effectiveFeeRate;
    
    // Individual: each inscription needs full transaction overhead + witness overhead + data
    const individualFees = individualSizes.reduce((total, size) => {
      // Each individual inscription has:
      // - Full transaction overhead: 200 bytes
      // - Witness/inscription overhead: 122 bytes
      // - Asset data: size bytes
      const txSize = 200 + 122 + size;
      return total + (txSize * effectiveFeeRate);
    }, 0);
    
    const savings = individualFees - batchFee;
    const savingsPercentage = (savings / individualFees) * 100;
    
    return {
      batchFee,
      individualFees,
      savings,
      savingsPercentage
    };
  }
}


