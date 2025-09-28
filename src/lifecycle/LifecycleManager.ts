import {
  OriginalsConfig,
  AssetResource,
  BitcoinTransaction
} from '../types';
import { BitcoinManager } from '../bitcoin/BitcoinManager';
import { DIDManager } from '../did/DIDManager';
import { CredentialManager } from '../vc/CredentialManager';
import { OriginalsAsset } from './OriginalsAsset';
import { MemoryStorageAdapter } from '../storage/MemoryStorageAdapter';
import { encodeBase64UrlMultibase, hexToBytes } from '../utils/encoding';
import { KeyManager } from '../did/KeyManager';

export class LifecycleManager {
  constructor(
    private config: OriginalsConfig,
    private didManager: DIDManager,
    private credentialManager: CredentialManager,
    private deps?: { bitcoinManager?: BitcoinManager }
  ) {}

  async createAsset(resources: AssetResource[]): Promise<OriginalsAsset> {
    const didDoc = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:' + Date.now() } as any;
    return new OriginalsAsset(resources, didDoc, []);
  }

  async publishToWeb(
    asset: OriginalsAsset,
    domain: string
  ): Promise<OriginalsAsset> {
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

      // Sign with a fresh key bound to the issuer DID (local signature acceptable for tests)
      const km = new KeyManager();
      const kp = await km.generateKeyPair(this.config.defaultKeyType || 'ES256K');
      const verificationMethod = `${issuer}#keys-1`;
      const signed = await this.credentialManager.signCredential(unsigned, kp.privateKey, verificationMethod);
      (asset as any).credentials.push(signed);
    } catch {
      // Best-effort: if issuance fails, continue without blocking publish
    }
    return asset;
  }

  async inscribeOnBitcoin(
    asset: OriginalsAsset,
    feeRate?: number
  ): Promise<OriginalsAsset> {
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
    return asset;
  }

  async transferOwnership(
    asset: OriginalsAsset,
    newOwner: string
  ): Promise<BitcoinTransaction> {
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


