import jsonld from 'jsonld';
import { DIDDocument, VerifiableCredential } from '../types';
import { validateDIDDocument, validateCredential } from './validation';

type DocumentLoader = (url: string) => Promise<{
  documentUrl: string;
  document: unknown;
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
const PRELOADED_CONTEXTS: Record<string, unknown> = {
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


const defaultDocumentLoader: DocumentLoader = (url: string) => {
  const preloaded = PRELOADED_CONTEXTS[url];
  if (preloaded) {
    return Promise.resolve({ documentUrl: url, document: preloaded, contextUrl: null });
  }
  return Promise.reject(new Error(`Document not found in PRELOADED_CONTEXTS: ${url}`));
};

export function serializeDIDDocument(didDoc: DIDDocument): string {
  // Serialize to JSON-LD with proper context
  return JSON.stringify(didDoc, null, 2);
}

export function deserializeDIDDocument(data: string): DIDDocument {
  // Parse from JSON-LD
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new Error('Invalid DID Document JSON');
  }

  // Runtime shape validation
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid DID Document: expected a JSON object');
  }

  const obj = parsed as Record<string, unknown>;
  const errors: string[] = [];

  // Pre-validate shape before calling validateDIDDocument (which assumes correct types)
  if (!Array.isArray(obj['@context']) || obj['@context'].length === 0) {
    errors.push('@context must be a non-empty array of strings');
  } else if (!obj['@context'].every((c: unknown) => typeof c === 'string')) {
    errors.push('@context must contain only strings');
  }
  if (typeof obj.id !== 'string' || obj.id === '') {
    errors.push('id must be a valid DID string');
  }
  if (errors.length > 0) {
    throw new Error(`Invalid DID Document: ${errors.join('; ')}`);
  }

  const doc = parsed as DIDDocument;
  if (!validateDIDDocument(doc)) {
    throw new Error('Invalid DID Document: failed validation');
  }

  return doc;
}

export function serializeCredential(vc: VerifiableCredential): string {
  // Serialize VC to JSON-LD
  return JSON.stringify(vc, null, 2);
}

export function deserializeCredential(data: string): VerifiableCredential {
  // Parse VC from JSON-LD
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new Error('Invalid Verifiable Credential JSON');
  }

  // Runtime shape validation
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Verifiable Credential: expected a JSON object');
  }

  const obj = parsed as Record<string, unknown>;
  const errors: string[] = [];

  // Pre-validate shape before calling validateCredential (which assumes correct types)
  if (!Array.isArray(obj['@context']) || obj['@context'].length === 0) {
    errors.push('@context must be a non-empty array of strings');
  } else if (!obj['@context'].includes('https://www.w3.org/2018/credentials/v1')) {
    errors.push('@context must include W3C VC v1 context');
  }
  if (!Array.isArray(obj.type) || obj.type.length === 0) {
    errors.push('type must be a non-empty array of strings');
  } else if (!obj.type.includes('VerifiableCredential')) {
    errors.push('type must include "VerifiableCredential"');
  }
  if (obj.issuer === undefined || obj.issuer === null) {
    errors.push('issuer is required');
  }
  if (typeof obj.issuanceDate !== 'string') {
    errors.push('issuanceDate is required');
  }
  if (!obj.credentialSubject || typeof obj.credentialSubject !== 'object' || Array.isArray(obj.credentialSubject)) {
    errors.push('credentialSubject must be a non-null object');
  }
  if (errors.length > 0) {
    throw new Error(`Invalid Verifiable Credential: ${errors.join('; ')}`);
  }

  const vc = parsed as VerifiableCredential;
  if (!validateCredential(vc)) {
    throw new Error('Invalid Verifiable Credential: failed validation');
  }

  return vc;
}

export async function canonicalizeDocument(
  doc: unknown,
  options: { documentLoader?: DocumentLoader } = {}
): Promise<string> {
  try {
    // Type assertion needed due to jsonld library's loose typing
    interface JsonLdModule {
      canonize: (doc: unknown, options: Record<string, unknown>) => Promise<string>;
    }
    const jsonldTyped = jsonld as unknown as JsonLdModule;
    const result = await jsonldTyped.canonize(doc, {
      algorithm: 'URDNA2015',
      format: 'application/n-quads',
      documentLoader: options.documentLoader ?? defaultDocumentLoader,
      useNative: false,
      rdfDirection: 'i18n-datatype',
      safe: false  // Disable safe mode to allow custom contexts
    });
    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to canonicalize document: ${message}`);
  }
}


