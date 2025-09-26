import { DIDDocument, OriginalsConfig, AssetResource } from '../types';
import { BtcoDidResolver } from './BtcoDidResolver';
import { OrdinalsClient } from '../bitcoin/OrdinalsClient';
import { createBtcoDidDocument } from './createBtcoDidDocument';
import { OrdinalsClientProviderAdapter } from './providers/OrdinalsClientProviderAdapter';

export class DIDManager {
  constructor(private config: OriginalsConfig) {}

  async createDIDPeer(resources: AssetResource[]): Promise<DIDDocument> {
    return {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:peer:' + Date.now()
    };
  }

  async migrateToDIDWebVH(didDoc: DIDDocument, domain: string): Promise<DIDDocument> {
    return { ...didDoc, id: `did:webvh:${domain}:${didDoc.id.split(':').pop()}` };
  }

  async migrateToDIDBTCO(didDoc: DIDDocument, satoshi: string): Promise<DIDDocument> {
    return { ...didDoc, id: `did:btco:${satoshi}` };
  }

  async resolveDID(did: string): Promise<DIDDocument | null> {
    try {
      if (did.startsWith('did:btco:') || did.startsWith('did:btco:test:') || did.startsWith('did:btco:sig:')) {
        const rpcUrl = this.config.bitcoinRpcUrl || 'http://localhost:3000';
        const network = this.config.network || 'mainnet';
        const client = new OrdinalsClient(rpcUrl, network);
        const adapter = new OrdinalsClientProviderAdapter(client, rpcUrl);
        const resolver = new BtcoDidResolver({ provider: adapter });
        const result = await resolver.resolve(did);
        return result.didDocument || null;
      }
      return { '@context': ['https://www.w3.org/ns/did/v1'], id: did };
    } catch {
      return null;
    }
  }

  validateDIDDocument(didDoc: DIDDocument): boolean {
    return !!didDoc.id && Array.isArray(didDoc['@context']);
  }

  private getLayerFromDID(did: string): 'did:peer' | 'did:webvh' | 'did:btco' {
    if (did.startsWith('did:peer:')) return 'did:peer';
    if (did.startsWith('did:webvh:')) return 'did:webvh';
    if (did.startsWith('did:btco:')) return 'did:btco';
    throw new Error('Unsupported DID method');
  }

  createBtcoDidDocument(
    satNumber: number | string,
    network: 'mainnet' | 'testnet' | 'signet',
    options: Parameters<typeof createBtcoDidDocument>[2]
  ): DIDDocument {
    return createBtcoDidDocument(satNumber, network, options as any);
  }
}


