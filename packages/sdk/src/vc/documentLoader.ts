import { DIDManager } from '../did/DIDManager';

type LoadedDocument = { document: any; documentUrl: string; contextUrl: string | null };

const CONTEXTS: Record<string, any> = {
  // Provide 1.1-compatible stubs for jsonld canonize
  'https://www.w3.org/ns/credentials/v2': { '@context': { '@version': 1.1 } },
  'https://w3id.org/security/data-integrity/v2': { '@context': { '@version': 1.1 } }
};

export class DocumentLoader {
  constructor(private didManager: DIDManager) {}

  async load(iri: string): Promise<LoadedDocument> {
    if (iri.startsWith('did:')) {
      return this.resolveDID(iri);
    }
    const doc = CONTEXTS[iri];
    if (doc) {
      return { document: doc, documentUrl: iri, contextUrl: null };
    }
    throw new Error(`Document not found: ${iri}`);
  }

  private async resolveDID(didUrl: string): Promise<LoadedDocument> {
    const [did, fragment] = didUrl.split('#');
    const didDoc = await this.didManager.resolveDID(did);
    if (!didDoc) {
      throw new Error(`DID not resolved: ${did}`);
    }
    if (fragment) {
      // If a VM was registered explicitly, prefer it
      const cached = verificationMethodRegistry.get(didUrl);
      if (cached) {
        return {
          document: { '@context': (didDoc as any)['@context'], ...cached },
          documentUrl: didUrl,
          contextUrl: null
        };
      }
      const vms = (didDoc as any).verificationMethod as any[] | undefined;
      const vm = vms?.find((m) => m.id === didUrl);
      if (vm) {
        return {
          document: { '@context': (didDoc as any)['@context'], ...vm },
          documentUrl: didUrl,
          contextUrl: null
        };
      }
      return {
        document: { '@context': (didDoc as any)['@context'], id: didUrl },
        documentUrl: didUrl,
        contextUrl: null
      };
    }
    return { document: didDoc, documentUrl: didUrl, contextUrl: null };
  }
}

export const createDocumentLoader = (didManager: DIDManager) =>
  (iri: string) => new DocumentLoader(didManager).load(iri);

export const verificationMethodRegistry: Map<string, any> = new Map();
export function registerVerificationMethod(vm: any) {
  if (vm?.id) verificationMethodRegistry.set(vm.id, vm);
}

