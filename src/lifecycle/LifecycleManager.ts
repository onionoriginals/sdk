import { 
  OriginalsConfig, 
  AssetResource, 
  BitcoinTransaction 
} from '../types';
import { PSBTBuilder } from '../bitcoin/PSBTBuilder';
import { BroadcastClient } from '../bitcoin/BroadcastClient';
import { OrdinalsClient } from '../bitcoin/OrdinalsClient';
import { OrdinalsClientProvider } from '../bitcoin/providers/OrdinalsProvider';
import { DIDManager } from '../did/DIDManager';
import { CredentialManager } from '../vc/CredentialManager';
import { OriginalsAsset } from './OriginalsAsset';
import { MemoryStorageAdapter } from '../storage/MemoryStorageAdapter';
import { encodeBase64UrlMultibase, hexToBytes } from '../utils/encoding';

type LifecycleDeps = {
  psbtBuilder?: PSBTBuilder;
  broadcastClient?: BroadcastClient;
  ordinalsProvider?: OrdinalsClientProvider;
};

export class LifecycleManager {
  constructor(
    private config: OriginalsConfig,
    private didManager: DIDManager,
    private credentialManager: CredentialManager,
    private deps: LifecycleDeps = {}
  ) {}

  async createAsset(resources: AssetResource[]): Promise<OriginalsAsset> {
    const didDoc = { '@context': ['https://www.w3.org/ns/did/v1'], id: 'did:peer:' + Date.now() } as any;
    return new OriginalsAsset(resources, didDoc, []);
  }

  async publishToWeb(
    asset: OriginalsAsset,
    domain: string
  ): Promise<OriginalsAsset> {
    if (asset.currentLayer !== 'did:peer') {
      throw new Error('Asset must be in did:peer layer before web publication');
    }
    const storage = new MemoryStorageAdapter();

    // Create a slug for this publication based on current peer id suffix
    const slug = asset.id.split(':').pop() as string;

    // Ownership proof: path-based marker and TXT-style file
    const ownershipPath = `.well-known/webvh/${slug}/ownership.txt`;
    const proofText = `did=did:webvh:${domain}:${slug}`;
    await storage.putObject(domain, ownershipPath, proofText);

    // Publish resources under content-addressed paths
    const publishedResources = [] as { id: string; url: string; hash: string; contentType?: string }[];
    for (const res of asset.resources) {
      const hashBytes = hexToBytes(res.hash);
      const multibase = encodeBase64UrlMultibase(hashBytes);
      const resPath = `.well-known/webvh/${slug}/resources/${multibase}`;
      const data = res.content ? new (globalThis as any).TextEncoder().encode(res.content) : new (globalThis as any).TextEncoder().encode(res.hash);
      const url = await storage.putObject(domain, resPath, data);
      publishedResources.push({ id: res.id, url, hash: res.hash, contentType: res.contentType });
    }

    // Integrity manifest and minimal DID doc
    const didWebDoc = await this.didManager.migrateToDIDWebVH({ ...asset.did }, domain);
    // Add resources service to DID doc
    (didWebDoc as any).service = [
      {
        id: `${didWebDoc.id}#resources`,
        type: 'OriginalsResources',
        serviceEndpoint: {
          base: `mem://${domain}/.well-known/webvh/${slug}`,
          resources: publishedResources
        }
      }
    ];
    const manifest = {
      did: didWebDoc.id,
      didDocument: didWebDoc,
      resources: publishedResources,
      createdAt: new Date().toISOString(),
      provenanceEvent: {
        type: 'PublishToWeb',
        from: 'did:peer',
        to: 'did:webvh',
        timestamp: new Date().toISOString()
      }
    };
    const manifestPath = `.well-known/webvh/${slug}/manifest.json`;
    await storage.putObject(domain, manifestPath, new (globalThis as any).TextEncoder().encode(JSON.stringify(manifest)));

    await asset.migrate('did:webvh');
    (asset as any).id = didWebDoc.id;
    (asset as any).did = didWebDoc;
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
    // Minimal MVP flow: estimate fee, pretend to build & broadcast, update provenance, migrate
    const provider = this.deps.ordinalsProvider || new OrdinalsClientProvider(
      new OrdinalsClient(this.config.bitcoinRpcUrl || 'http://localhost:3000', this.config.network as any),
      { baseUrl: this.config.bitcoinRpcUrl || 'http://localhost:3000' }
    );
    const usedFeeRate = typeof feeRate === 'number' && feeRate > 0 ? feeRate : await provider.estimateFee(1);
    const psbtBuilder = this.deps.psbtBuilder || new PSBTBuilder();
    const broadcast = this.deps.broadcastClient || new BroadcastClient(async (_hex: string) => 'tx-mock', async (_txid: string) => ({ confirmed: true, confirmations: 1 }));

    // For SDK-level MVP we do not own UTXO selection here; callers inject when needed.
    // We record provenance with the used fee rate and a mock txid if not provided.
    const txHex = 'deadbeef';
    const { txid } = await broadcast.broadcastAndConfirm(txHex, { pollIntervalMs: 10, maxAttempts: 1 });

    (asset as any).provenance = {
      txid,
      feeRate: usedFeeRate,
      timestamp: new Date().toISOString()
    };

    await asset.migrate('did:btco');
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
    throw new Error('Not implemented');
  }
}


