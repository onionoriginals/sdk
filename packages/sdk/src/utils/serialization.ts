import jsonld from 'jsonld';
import { DIDDocument, VerifiableCredential } from '../types';

type DocumentLoader = (url: string) => Promise<{
  documentUrl: string;
  document: any;
  contextUrl: string | null;
}>;

// Import context documents from src/contexts
import credentialsV1Context from '../contexts/credentials-v1.json';
import credentialsV2Context from '../contexts/credentials-v2.json';
import dataIntegrityV2Context from '../contexts/data-integrity-v2.json';
import didsContext from '../contexts/dids.json';
import ed255192020Context from '../contexts/ed255192020.json';
import ordinalsContext from '../contexts/ordinals-plus.json';
import originalsContext from '../contexts/originals.json';

// Full context documents for proper canonicalization
const PRELOADED_CONTEXTS: Record<string, any> = {
  // W3C and standard contexts
  'https://www.w3.org/2018/credentials/v1': credentialsV1Context,
  'https://www.w3.org/ns/credentials/v2': credentialsV2Context,
  'https://w3id.org/security/data-integrity/v2': dataIntegrityV2Context,
  'https://www.w3.org/ns/did/v1': didsContext,
  'https://w3id.org/security/suites/ed25519-2020/v1': ed255192020Context,

  // Custom contexts
  'https://ordinals.plus/vocab/v1': ordinalsContext,

  // Originals network contexts (all three networks use the same context document)
  'https://originals.build/context': originalsContext, // Legacy
  'https://pichu.originals.build/context': originalsContext, // Production
  'https://cleffa.originals.build/context': originalsContext, // Staging
  'https://magby.originals.build/context': originalsContext, // Development
};


const defaultDocumentLoader: DocumentLoader = async (url: string) => {
  const preloaded = PRELOADED_CONTEXTS[url];
  if (preloaded) {
    return { documentUrl: url, document: preloaded, contextUrl: null };
  }
  throw new Error(`Document not found in PRELOADED_CONTEXTS: ${url}`);
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
      rdfDirection: 'i18n-datatype',
      safe: false  // Disable safe mode to allow custom contexts
    } as any);
  } catch (error: any) {
    const message = error?.message ?? String(error);
    throw new Error(`Failed to canonicalize document: ${message}`);
  }
}


