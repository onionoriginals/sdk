import { DIDDocument, OriginalsConfig, AssetResource } from '../types';

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
    return { '@context': ['https://www.w3.org/ns/did/v1'], id: did };
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
}


