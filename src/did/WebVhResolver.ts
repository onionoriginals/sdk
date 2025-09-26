import { DIDDocument } from '../types';
import { StorageAdapter } from '../storage';

export interface WebVhResolverOptions {
  storage: StorageAdapter;
}

export class WebVhResolver {
  constructor(private options: WebVhResolverOptions) {}

  // did:webvh:<domain>:<slug>
  async resolve(did: string): Promise<DIDDocument | null> {
    if (!did.startsWith('did:webvh:')) return null;
    const [, , domain, slug] = did.split(':');
    if (!domain || !slug) return null;

    // Resolve DID document from published location
    const manifestPath = `.well-known/webvh/${slug}/manifest.json`;
    const manifestObj = await this.options.storage.getObject(domain, manifestPath);
    if (!manifestObj) return { '@context': ['https://www.w3.org/ns/did/v1'], id: did };

    try {
      const text = new (globalThis as any).TextDecoder().decode(manifestObj.content);
      const manifest = JSON.parse(text);
      const didDoc = manifest.didDocument as DIDDocument | undefined;
      if (didDoc && didDoc.id === did) return didDoc;
      return { '@context': ['https://www.w3.org/ns/did/v1'], id: did };
    } catch {
      return { '@context': ['https://www.w3.org/ns/did/v1'], id: did };
    }
  }
}

