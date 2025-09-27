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

    const prov = (asset as any).provenance || (asset as any).getProvenance?.() || {};
    prov.txid = txid;
    prov.feeRate = usedFeeRate;
    prov.timestamp = new Date().toISOString();
    (asset as any).provenance = prov;

    // Only resources migrate; retain original DID identity. Track btco binding.
    await asset.migrate('did:btco');
    (asset as any).bindings = Object.assign({}, (asset as any).bindings, { 'did:btco': `did:btco:${String(txid)}` });
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


