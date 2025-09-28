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

export class LifecycleManager {
  constructor(
    private config: OriginalsConfig,
    private didManager: DIDManager,
    private credentialManager: CredentialManager
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
    const storage = new MemoryStorageAdapter();

    // Create a slug for this publication based on current peer id suffix
    const slug = asset.id.split(':').pop() as string;

    // Publish resources under content-addressed paths (for hosting outside DID log)
    const publishedResources = [] as { id: string; url: string; hash: string; contentType?: string }[];
    for (const res of asset.resources) {
      const hashBytes = hexToBytes(res.hash);
      const multibase = encodeBase64UrlMultibase(hashBytes);
      const resPath = `.well-known/webvh/${slug}/resources/${multibase}`;
      const data = res.content ? new (globalThis as any).TextEncoder().encode(res.content) : new (globalThis as any).TextEncoder().encode(res.hash);
      const url = await storage.putObject(domain, resPath, data);
      publishedResources.push({ id: res.id, url, hash: res.hash, contentType: res.contentType });
    }

    // New resource identifier for the web representation; the asset DID remains the same.
    const webDid = `did:webvh:${domain}:${slug}`;
    await asset.migrate('did:webvh');
    (asset as any).bindings = Object.assign({}, (asset as any).bindings, { 'did:webvh': webDid });
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
    const bitcoinManager = new BitcoinManager(this.config);
    const manifest = {
      assetId: asset.id,
      resources: asset.resources.map(res => ({ id: res.id, hash: res.hash, contentType: res.contentType, url: res.url })),
      timestamp: new Date().toISOString()
    };
    const payload = Buffer.from(JSON.stringify(manifest));
    const inscription = await bitcoinManager.inscribeData(payload, 'application/json', feeRate);
    const revealTxId = (inscription as any).revealTxId ?? inscription.txid;
    const commitTxId = (inscription as any).commitTxId;
    const usedFeeRate = (inscription as any).feeRate;

    await asset.migrate('did:btco', {
      transactionId: revealTxId,
      inscriptionId: inscription.inscriptionId,
      satoshi: inscription.satoshi,
      commitTxId,
      revealTxId,
      feeRate: typeof usedFeeRate === 'number' ? usedFeeRate : feeRate
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
    const bm = new BitcoinManager(this.config);
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


