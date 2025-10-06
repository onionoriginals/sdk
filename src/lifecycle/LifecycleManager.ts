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

export class LifecycleManager {
  constructor(
    private config: OriginalsConfig,
    private didManager: DIDManager,
    private credentialManager: CredentialManager,
    private deps?: { bitcoinManager?: BitcoinManager },
    private keyStore?: KeyStore
  ) {}

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
      
      // Emit asset created event
      asset.on('asset:created', () => {}); // Initialize event emitter
      await (asset as any).eventEmitter.emit({
        type: 'asset:created',
        timestamp: new Date().toISOString(),
        asset: {
          id: asset.id,
          layer: asset.currentLayer,
          resourceCount: resources.length,
          createdAt: asset.getProvenance().createdAt
        }
      });
      
      return asset;
    } else {
      // No keyStore, just create the DID document
      const didDoc = await this.didManager.createDIDPeer(resources);
      const asset = new OriginalsAsset(resources, didDoc, []);
      
      // Emit asset created event
      await (asset as any).eventEmitter.emit({
        type: 'asset:created',
        timestamp: new Date().toISOString(),
        asset: {
          id: asset.id,
          layer: asset.currentLayer,
          resourceCount: resources.length,
          createdAt: asset.getProvenance().createdAt
        }
      });
      
      return asset;
    }
  }

  async publishToWeb(
    asset: OriginalsAsset,
    domain: string
  ): Promise<OriginalsAsset> {
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
      await (asset as any).eventEmitter.emit({
        type: 'resource:published',
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
      });
    }

    // New resource identifier for the web representation; the asset DID remains the same.
    const webDid = `did:webvh:${domain}:${slug}`;
    asset.migrate('did:webvh');
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
      
      // Emit credential issued event
      await (asset as any).eventEmitter.emit({
        type: 'credential:issued',
        timestamp: new Date().toISOString(),
        asset: {
          id: asset.id
        },
        credential: {
          type: signed.type,
          issuer: signed.issuer
        }
      });
    } catch (err) {
      // Best-effort: if issuance fails, continue without blocking publish
      // Log the error for debugging purposes
      if (this.config.enableLogging) {
        console.error('Failed to issue credential during publish:', err);
      }
    }
    return asset;
  }

  async inscribeOnBitcoin(
    asset: OriginalsAsset,
    feeRate?: number
  ): Promise<OriginalsAsset> {
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

    asset.migrate('did:btco', {
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
    return asset;
  }

  async transferOwnership(
    asset: OriginalsAsset,
    newOwner: string
  ): Promise<BitcoinTransaction> {
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
    asset.recordTransfer(asset.id, newOwner, tx.txid);
    return tx;
  }
}


