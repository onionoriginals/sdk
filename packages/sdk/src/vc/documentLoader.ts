import { DIDManager } from '../did/DIDManager';

type LoadedDocument = { document: unknown; documentUrl: string; contextUrl: string | null };

interface ContextDocument {
  '@context': {
    '@version': number;
  };
}

const CONTEXTS: Record<string, ContextDocument> = {
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

    interface DIDDocWithContext {
      '@context'?: unknown;
      verificationMethod?: Array<{ id?: string }>;
    }

    const didDocTyped = didDoc as DIDDocWithContext;

    if (fragment) {
      // If a VM was registered explicitly, prefer it
      const cached = verificationMethodRegistry.get(didUrl);
      if (cached) {
        return {
          document: { '@context': didDocTyped['@context'], ...cached },
          documentUrl: didUrl,
          contextUrl: null
        };
      }
      const vms = didDocTyped.verificationMethod;
      const vm = vms?.find((m) => m.id === didUrl);
      if (vm) {
        return {
          document: { '@context': didDocTyped['@context'], ...vm },
          documentUrl: didUrl,
          contextUrl: null
        };
      }
      return {
        document: { '@context': didDocTyped['@context'], id: didUrl },
        documentUrl: didUrl,
        contextUrl: null
      };
    }
    return { document: didDoc, documentUrl: didUrl, contextUrl: null };
  }
}

export const createDocumentLoader = (didManager: DIDManager) =>
  (iri: string) => new DocumentLoader(didManager).load(iri);

export const verificationMethodRegistry: Map<string, Record<string, unknown>> = new Map();
export function registerVerificationMethod(vm: Record<string, unknown> & { id?: string }): void {
  if (vm?.id) verificationMethodRegistry.set(vm.id, vm);
}

