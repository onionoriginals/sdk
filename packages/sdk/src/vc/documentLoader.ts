import { DIDManager } from '../did/DIDManager';
import { PRELOADED_CONTEXTS } from '../utils/serialization';

type LoadedDocument = { document: unknown; documentUrl: string; contextUrl: string | null };

// Serve the full bundled context documents so canonicalization sees real term
// definitions. Stub contexts here previously caused every credential field to
// be dropped from the signed dataset (issue #167).
const CONTEXTS: Record<string, unknown> = PRELOADED_CONTEXTS;

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

