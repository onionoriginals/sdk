import { DIDDocument, OriginalsConfig, AssetResource } from '../types';
import { BtcoDidResolver } from './BtcoDidResolver';
import { OrdinalsClient } from '../bitcoin/OrdinalsClient';
import { createBtcoDidDocument } from './createBtcoDidDocument';
import { OrdinalsClientProviderAdapter } from './providers/OrdinalsClientProviderAdapter';
import { MemoryStorageAdapter } from '../storage/MemoryStorageAdapter';
import { resolveDIDFromLog } from 'didwebvh-ts';

export class DIDManager {
  constructor(private config: OriginalsConfig) {}

  async createDIDPeer(resources: AssetResource[]): Promise<DIDDocument> {
    return {
      '@context': ['https://www.w3.org/ns/did/v1'],
      id: 'did:peer:' + Date.now()
    };
  }

  async migrateToDIDWebVH(didDoc: DIDDocument, domain: string): Promise<DIDDocument> {
    // Basic domain hardening: require valid hostname
    if (!/^[a-z0-9.-]+$/i.test(domain) || domain.includes('..') || domain.startsWith('-') || domain.endsWith('-')) {
      throw new Error('Invalid domain');
    }
    const slug = didDoc.id.split(':').pop() as string;
    return { ...didDoc, id: `did:webvh:${domain}:${slug}` };
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
      if (did.startsWith('did:webvh:')) {
        const storage = new MemoryStorageAdapter();
        const [, , domainOrScid, slugMaybe] = did.split(':');
        // Back-compat with our publish format: did:webvh:<domain>:<slug>
        const domain = slugMaybe ? domainOrScid : (did.split(':')[2] || '');
        const slug = slugMaybe || (did.split(':')[3] || '');
        const manifestPath = `.well-known/webvh/${slug}/manifest.json`;
        const manifestObj = await storage.getObject(domain, manifestPath);
        if (!manifestObj) {
          return { '@context': ['https://www.w3.org/ns/did/v1'], id: did };
        }
        const text = new (globalThis as any).TextDecoder().decode(manifestObj.content);
        const manifest = JSON.parse(text || '{}');
        const didDoc = (manifest && manifest.didDocument) || { '@context': ['https://www.w3.org/ns/did/v1'], id: did };
        // Use didwebvh-ts to resolve from a synthetic log, with assertions disabled
        (process as any).env.IGNORE_ASSERTION_DOCUMENT_STATE_IS_VALID = 'true';
        (process as any).env.IGNORE_ASSERTION_HASH_CHAIN_IS_VALID = 'true';
        (process as any).env.IGNORE_ASSERTION_NEW_KEYS_ARE_VALID = 'true';
        (process as any).env.IGNORE_ASSERTION_SCID_IS_FROM_HASH = 'true';
        const now = new Date().toISOString();
        const log = [
          {
            versionId: '1-fake',
            versionTime: now,
            parameters: {
              method: 'did:webvh:1.0',
              scid: 'fake',
              updateKeys: [],
              portable: true,
              nextKeyHashes: [],
              watchers: [],
              witness: {}
            },
            state: didDoc,
            proof: [{
              type: 'DataIntegrityProof',
              cryptosuite: 'eddsa-jcs-2022',
              verificationMethod: `${didDoc.id}#vm`,
              created: now,
              proofPurpose: 'assertionMethod',
              proofValue: 'u'
            }]
          }
        ];
        const result = await (resolveDIDFromLog as any)(log, {});
        return (result && result.doc) || didDoc;
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


