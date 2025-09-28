import { DIDDocument, OriginalsConfig, AssetResource, VerificationMethod } from '../types';
import { BtcoDidResolver } from './BtcoDidResolver';
import { OrdinalsClient } from '../bitcoin/OrdinalsClient';
import { createBtcoDidDocument } from './createBtcoDidDocument';
import { OrdinalsClientProviderAdapter } from './providers/OrdinalsClientProviderAdapter';
import { multikey } from '../crypto/Multikey';
import { KeyManager } from './KeyManager';
import { sha256Bytes } from '../utils/hash';

export class DIDManager {
  constructor(private config: OriginalsConfig) {}

  async createDIDPeer(resources: AssetResource[]): Promise<DIDDocument> {
    // Generate a multikey keypair according to configured defaultKeyType
    const keyManager = new KeyManager();
    const desiredType = this.config.defaultKeyType || 'ES256K';
    let keyTypeToUse = desiredType;
    if (desiredType === 'ES256') {
      // Fallback since ES256 is not yet supported by KeyManager.generateKeyPair
      keyTypeToUse = 'Ed25519';
    }
    const keyPair = await keyManager.generateKeyPair(keyTypeToUse as any);

    // Stable peer DID suffix derived from public key (truncated hash for readability)
    const pub = keyPair.publicKey;
    const pubBytes = multikey.decodePublicKey(pub).key;
    const hash = await sha256Bytes(pubBytes);
    const suffix = Array.from(hash)
      .slice(0, 10)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const did = `did:peer:${suffix}`;

    const vmId = `${did}#0`;
    const document: DIDDocument = {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/multikey/v1'
      ],
      id: did,
      verificationMethod: [
        {
          id: vmId,
          type: 'Multikey',
          controller: did,
          publicKeyMultibase: keyPair.publicKey
        }
      ],
      authentication: [vmId],
      assertionMethod: [vmId]
    };

    return document;
  }

  async migrateToDIDWebVH(didDoc: DIDDocument, domain: string): Promise<DIDDocument> {
    // Rigorous domain validation per RFC-like constraints
    const normalized = String(domain || '').trim().toLowerCase();
    const label = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
    const domainRegex = new RegExp(`^(?=.{1,253}$)(?:${label})(?:\\.(?:${label}))+?$`, 'i');
    if (!domainRegex.test(normalized)) {
      throw new Error('Invalid domain');
    }

    // Stable slug derived from original peer DID suffix (or last segment)
    const parts = (didDoc.id || '').split(':');
    const method = parts.slice(0, 2).join(':');
    const originalSuffix = method === 'did:peer' ? parts.slice(2).join(':') : parts[parts.length - 1];
    const slug = (originalSuffix || '')
      .toString()
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .toLowerCase();

    const migrated: DIDDocument = {
      ...didDoc,
      id: `did:webvh:${normalized}:${slug}`
    };
    return migrated;
  }

  async migrateToDIDBTCO(didDoc: DIDDocument, satoshi: string): Promise<DIDDocument> {
    if (!/^[0-9]+$/.test(String(satoshi))) {
      throw new Error('Invalid satoshi identifier');
    }
    const net = this.config.network || 'mainnet';
    const network = (net === 'regtest' ? 'signet' : net) as any;

    // Try to carry over the first multikey VM if present
    const firstVm = (didDoc.verificationMethod && didDoc.verificationMethod[0]) as VerificationMethod | undefined;
    let publicKey: Uint8Array | undefined;
    let keyType: Parameters<typeof createBtcoDidDocument>[2]['keyType'] | undefined;
    try {
      if (firstVm && firstVm.publicKeyMultibase) {
        const decoded = multikey.decodePublicKey(firstVm.publicKeyMultibase);
        publicKey = decoded.key;
        keyType = decoded.type;
      }
    } catch {}

    // If no key material is available, generate a minimal btco DID doc without keys
    let btcoDoc: DIDDocument;
    if (publicKey && keyType) {
      btcoDoc = createBtcoDidDocument(satoshi, network as any, { publicKey, keyType });
    } else {
      const prefix = network === 'mainnet' ? 'did:btco:' : network === 'testnet' ? 'did:btco:test:' : 'did:btco:sig:';
      btcoDoc = {
        '@context': ['https://www.w3.org/ns/did/v1'],
        id: prefix + String(satoshi)
      };
    }

    // Carry over service endpoints if present
    if (didDoc.service && didDoc.service.length > 0) {
      btcoDoc.service = didDoc.service;
    }
    return btcoDoc;
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
        try {
          const mod: any = await import('didwebvh-ts');
          if (mod && typeof mod.resolveDID === 'function') {
            const result = await mod.resolveDID(did);
            if (result && result.doc) return result.doc as DIDDocument;
          }
        } catch {}
        return { '@context': ['https://www.w3.org/ns/did/v1'], id: did };
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


