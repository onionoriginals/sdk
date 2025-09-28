import jsonld from 'jsonld';
import { DIDDocument, VerifiableCredential } from '../types';

type DocumentLoader = (url: string) => Promise<{
  documentUrl: string;
  document: any;
  contextUrl: string | null;
}>;

const PRELOADED_CONTEXTS: Record<string, any> = {
  'https://www.w3.org/2018/credentials/v1': { '@context': { '@version': 1.1 } },
  'https://www.w3.org/ns/credentials/v2': { '@context': { '@version': 1.1 } },
  'https://w3id.org/security/data-integrity/v2': { '@context': { '@version': 1.1 } }
};

const nodeDocumentLoader = jsonld.documentLoaders.node();

const defaultDocumentLoader: DocumentLoader = async (url: string) => {
  const preloaded = PRELOADED_CONTEXTS[url];
  if (preloaded) {
    return { documentUrl: url, document: preloaded, contextUrl: null };
  }
  return nodeDocumentLoader(url);
};

export function serializeDIDDocument(didDoc: DIDDocument): string {
  // Serialize to JSON-LD with proper context
  return JSON.stringify(didDoc, null, 2);
}

export function deserializeDIDDocument(data: string): DIDDocument {
  // Parse from JSON-LD
  try {
    const parsed = JSON.parse(data);
    return parsed as DIDDocument;
  } catch (error) {
    throw new Error('Invalid DID Document JSON');
  }
}

export function serializeCredential(vc: VerifiableCredential): string {
  // Serialize VC to JSON-LD
  return JSON.stringify(vc, null, 2);
}

export function deserializeCredential(data: string): VerifiableCredential {
  // Parse VC from JSON-LD
  try {
    const parsed = JSON.parse(data);
    return parsed as VerifiableCredential;
  } catch (error) {
    throw new Error('Invalid Verifiable Credential JSON');
  }
}

export async function canonicalizeDocument(
  doc: any,
  options: { documentLoader?: DocumentLoader } = {}
): Promise<string> {
  try {
    return await jsonld.canonize(doc, {
      algorithm: 'URDNA2015',
      format: 'application/n-quads',
      documentLoader: options.documentLoader ?? defaultDocumentLoader,
      useNative: false,
      rdfDirection: 'i18n-datatype'
    } as any);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    throw new Error(`Failed to canonicalize document: ${message}`);
  }
}


