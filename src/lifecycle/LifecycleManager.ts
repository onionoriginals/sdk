import {
  OriginalsConfig,
  AssetResource,
  BitcoinTransaction,
  KeyStore
} from '../types';
import { BitcoinManager } from '../bitcoin/BitcoinManager';
import { DIDManager } from '../did/DIDManager';
import { CredentialManager } from '../vc/CredentialManager';
import { OriginalsAsset } from './OriginalsAsset';
import { MemoryStorageAdapter } from '../storage/MemoryStorageAdapter';
import { encodeBase64UrlMultibase, hexToBytes } from '../utils/encoding';
import { KeyManager } from '../did/KeyManager';
import { validateBitcoinAddress } from '../utils/bitcoin-address';
import { multikey } from '../crypto/Multikey';
import { EventEmitter } from '../events/EventEmitter';
import type { EventHandler, EventTypeMap } from '../events/types';
import { Logger } from '../utils/Logger';
import { MetricsCollector } from '../utils/MetricsCollector';

export class LifecycleManager {
  private eventEmitter: EventEmitter;
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
    domain: string
  ): Promise<OriginalsAsset> {
    const stopTimer = this.logger.startTimer('publishToWeb');
    this.logger.info('Publishing asset to web', { assetId: asset.id, domain });
    
    try {
      // Input validation
      if (!asset || typeof asset !== 'object') {
        throw new Error('Invalid asset: must be a valid OriginalsAsset');
      }
      if (!domain || typeof domain !== 'string') {
        throw new Error('Invalid domain: must be a non-empty string');
      }
    
    // Validate domain format
    const normalized = domain.trim().toLowerCase();
    const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
    const domainRegex = new RegExp(`^(?=.{1,253}$)(?:${label})(?:\\.(?:${label}))+?$`, 'i');
    if (!domainRegex.test(normalized)) {
      throw new Error(`Invalid domain format: ${domain}`);
    }
    
    if (typeof (asset as any).migrate !== 'function') {
      throw new Error('Not implemented');
    }
    if (asset.currentLayer !== 'did:peer') {
      throw new Error('Not implemented');
    }
    const configuredAdapter: any = (this.config as any).storageAdapter;
    const storage = new MemoryStorageAdapter();

    // Create a slug for this publication based on current peer id suffix
    const slug = asset.id.split(':').pop() as string;

    // Publish resources under content-addressed paths (for hosting outside DID log)
    for (const res of asset.resources) {
      const hashBytes = hexToBytes(res.hash);
      const multibase = encodeBase64UrlMultibase(hashBytes);
      const relativePath = `.well-known/webvh/${slug}/resources/${multibase}`;

      let url: string;
      if (configuredAdapter && typeof configuredAdapter.put === 'function') {
        const objectKey = `${domain}/${relativePath}`;
        const data = typeof res.content === 'string' ? Buffer.from(res.content) : Buffer.from(res.hash);
        url = await configuredAdapter.put(objectKey, data, { contentType: res.contentType });
      } else {
        const data = res.content ? new (globalThis as any).TextEncoder().encode(res.content) : new (globalThis as any).TextEncoder().encode(res.hash);
        url = await storage.putObject(domain, relativePath, data);
      }

      // Non-breaking: preserve id/hash/contentType, add url
      (res as any).url = url;
      
      // Emit resource published event
      const resourceEvent = {
        type: 'resource:published' as const,
        timestamp: new Date().toISOString(),
        asset: {
          id: asset.id
        },
        resource: {
          id: res.id,
          url,
          contentType: res.contentType,
          hash: res.hash
        },
        domain
      };
      
      // Emit from both LifecycleManager and asset emitters
      try {
        await Promise.all([
          this.eventEmitter.emit(resourceEvent),
          asset._internalEmit(resourceEvent)
        ]);
      } catch (err) {
        if (this.config.enableLogging) {
          console.error('Event handler error during resource:published:', err);
        }
        // Continue execution despite handler errors
      }
    }

    // New resource identifier for the web representation; the asset DID remains the same.
    const webDid = `did:webvh:${domain}:${slug}`;
    await asset.migrate('did:webvh');
    (asset as any).bindings = Object.assign({}, (asset as any).bindings, { 'did:webvh': webDid });

    // Issue a publication credential for the migration
    try {
      const type: 'ResourceMigrated' | 'ResourceCreated' = 'ResourceMigrated';
      const issuer = asset.id;
      const subject = {
        id: webDid,
        resourceId: asset.resources[0]?.id,
        fromLayer: 'did:peer',
        toLayer: 'did:webvh',
        migratedAt: new Date().toISOString()
      } as any;

      const unsigned = await this.credentialManager.createResourceCredential(type, subject, issuer);

      // Resolve the DID and extract verification method
      const didDoc = await this.didManager.resolveDID(issuer);
      if (!didDoc || !didDoc.verificationMethod || didDoc.verificationMethod.length === 0) {
        throw new Error('No verification method found in DID document');
      }

      const vm = didDoc.verificationMethod[0];
      let verificationMethod = vm.id;
      
      // Ensure VM ID is absolute (not just a fragment like #key-0)
      if (verificationMethod.startsWith('#')) {
        verificationMethod = `${issuer}${verificationMethod}`;
      }

      // Retrieve private key from keyStore
      if (!this.keyStore) {
        throw new Error('Private key not available for signing. Provide keyStore to LifecycleManager.');
      }

      const privateKey = await this.keyStore.getPrivateKey(verificationMethod);
      if (!privateKey) {
        throw new Error('Private key not available for signing. Provide keyStore to LifecycleManager.');
      }

      const signed = await this.credentialManager.signCredential(unsigned, privateKey, verificationMethod);
      (asset as any).credentials.push(signed);

      const credentialEvent = {
        type: 'credential:issued' as const,
        timestamp: new Date().toISOString(),
        asset: {
          id: asset.id
        },
        credential: {
          type: signed.type,
          issuer: typeof signed.issuer === 'string' ? signed.issuer : signed.issuer.id
        }
      };

      // Emit from both LifecycleManager and asset emitters
      await Promise.all([
        this.eventEmitter.emit(credentialEvent),
        asset._internalEmit(credentialEvent)
      ]);
    } catch (err) {
      // Best-effort: if issuance fails, continue without blocking publish
      // Log the error for debugging purposes
      if (this.config.enableLogging) {
        console.error('Failed to issue credential during publish:', err);
      }
    }
    
    stopTimer();
    this.logger.info('Asset published to web successfully', { 
      assetId: asset.id, 
      domain, 
      resourceCount: asset.resources.length 
    });
    this.metrics.recordMigration('did:peer', 'did:webvh');
    
    return asset;
    } catch (error) {
      stopTimer();
      this.logger.error('Publish to web failed', error as Error, { assetId: asset.id, domain });
      this.metrics.recordError('PUBLISH_FAILED', 'publishToWeb');
      throw error;
    }
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
    
    // Note: asset.currentLayer is updated after migrate() call above
    // Migration should be from the layer before migration (webvh or peer) to btco
    // Since we already migrated, we need to infer the fromLayer
    // The inscribeOnBitcoin validation ensures currentLayer is webvh or peer before migration
    this.metrics.recordMigration('did:webvh', 'did:btco');
    
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
}


