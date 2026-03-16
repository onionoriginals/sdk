import jsonld from 'jsonld';
import { DIDDocument, VerifiableCredential } from '../types';
import { StructuredError } from './telemetry';

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new StructuredError('INVALID_DID_DOCUMENT', 'Invalid DID Document JSON: malformed JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StructuredError('INVALID_DID_DOCUMENT', 'Invalid DID Document: must be a JSON object');
  }

  const obj = parsed as Record<string, unknown>;
  const errors: string[] = [];

  // @context is required and must be an array of strings
  if (!Array.isArray(obj['@context'])) {
    errors.push('@context must be an array');
  } else if (!obj['@context'].every((c: unknown) => typeof c === 'string')) {
    errors.push('@context must contain only strings');
  }

  // id is required and must be a string
  if (typeof obj.id !== 'string' || obj.id.length === 0) {
    errors.push('id must be a non-empty string');
  }

  // verificationMethod, if present, must be an array of objects with required fields
  if (obj.verificationMethod !== undefined) {
    if (!Array.isArray(obj.verificationMethod)) {
      errors.push('verificationMethod must be an array');
    } else {
      for (let i = 0; i < obj.verificationMethod.length; i++) {
        const vm = obj.verificationMethod[i];
        if (typeof vm !== 'object' || vm === null || Array.isArray(vm)) {
          errors.push(`verificationMethod[${i}] must be an object`);
          continue;
        }
        const vmObj = vm as Record<string, unknown>;
        if (typeof vmObj.id !== 'string') errors.push(`verificationMethod[${i}].id must be a string`);
        if (typeof vmObj.type !== 'string') errors.push(`verificationMethod[${i}].type must be a string`);
        if (typeof vmObj.controller !== 'string') errors.push(`verificationMethod[${i}].controller must be a string`);
        if (typeof vmObj.publicKeyMultibase !== 'string') errors.push(`verificationMethod[${i}].publicKeyMultibase must be a string`);
      }
    }
  }

  // Validate optional reference arrays (authentication, assertionMethod, etc.)
  const refArrayFields = ['authentication', 'assertionMethod', 'keyAgreement', 'capabilityInvocation', 'capabilityDelegation'];
  for (const field of refArrayFields) {
    if (obj[field] !== undefined && !Array.isArray(obj[field])) {
      errors.push(`${field} must be an array`);
    }
  }

  // service, if present, must be an array of objects with required fields
  if (obj.service !== undefined) {
    if (!Array.isArray(obj.service)) {
      errors.push('service must be an array');
    } else {
      for (let i = 0; i < obj.service.length; i++) {
        const svc = obj.service[i];
        if (typeof svc !== 'object' || svc === null || Array.isArray(svc)) {
          errors.push(`service[${i}] must be an object`);
          continue;
        }
        const svcObj = svc as Record<string, unknown>;
        if (typeof svcObj.id !== 'string') errors.push(`service[${i}].id must be a string`);
        if (typeof svcObj.type !== 'string') errors.push(`service[${i}].type must be a string`);
        if (svcObj.serviceEndpoint === undefined) errors.push(`service[${i}].serviceEndpoint is required`);
      }
    }
  }

  if (errors.length > 0) {
    throw new StructuredError('INVALID_DID_DOCUMENT', `Invalid DID Document: ${errors.join('; ')}`, { fields: errors });
  }

  return parsed as DIDDocument;
}

export function serializeCredential(vc: VerifiableCredential): string {
  // Serialize VC to JSON-LD
  return JSON.stringify(vc, null, 2);
}

export function deserializeCredential(data: string): VerifiableCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new StructuredError('INVALID_CREDENTIAL', 'Invalid Verifiable Credential JSON: malformed JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new StructuredError('INVALID_CREDENTIAL', 'Invalid Verifiable Credential: must be a JSON object');
  }

  const obj = parsed as Record<string, unknown>;
  const errors: string[] = [];

  // @context is required and must be an array of strings
  if (!Array.isArray(obj['@context'])) {
    errors.push('@context must be an array');
  } else if (!obj['@context'].every((c: unknown) => typeof c === 'string')) {
    errors.push('@context must contain only strings');
  }

  // type is required and must be an array of strings
  if (!Array.isArray(obj.type)) {
    errors.push('type must be an array');
  } else if (!obj.type.every((t: unknown) => typeof t === 'string')) {
    errors.push('type must contain only strings');
  }

  // issuer is required and must be a string or an object with id
  if (obj.issuer === undefined || obj.issuer === null) {
    errors.push('issuer is required');
  } else if (typeof obj.issuer !== 'string') {
    if (typeof obj.issuer !== 'object' || Array.isArray(obj.issuer)) {
      errors.push('issuer must be a string or an object with an id');
    } else {
      const issuerObj = obj.issuer as Record<string, unknown>;
      if (typeof issuerObj.id !== 'string') {
        errors.push('issuer.id must be a string');
      }
    }
  }

  // issuanceDate is required and must be a string
  if (typeof obj.issuanceDate !== 'string' || obj.issuanceDate.length === 0) {
    errors.push('issuanceDate must be a non-empty string');
  }

  // credentialSubject is required and must be an object
  if (typeof obj.credentialSubject !== 'object' || obj.credentialSubject === null || Array.isArray(obj.credentialSubject)) {
    errors.push('credentialSubject must be an object');
  }

  // proof, if present, must be an object or array of objects
  if (obj.proof !== undefined) {
    const proofs = Array.isArray(obj.proof) ? obj.proof : [obj.proof];
    for (let i = 0; i < proofs.length; i++) {
      const p = proofs[i];
      if (typeof p !== 'object' || p === null || Array.isArray(p)) {
        errors.push(`proof${Array.isArray(obj.proof) ? `[${i}]` : ''} must be an object`);
        continue;
      }
      const pObj = p as Record<string, unknown>;
      if (typeof pObj.type !== 'string') errors.push(`proof${Array.isArray(obj.proof) ? `[${i}]` : ''}.type must be a string`);
      if (typeof pObj.proofValue !== 'string') errors.push(`proof${Array.isArray(obj.proof) ? `[${i}]` : ''}.proofValue must be a string`);
    }
  }

  if (errors.length > 0) {
    throw new StructuredError('INVALID_CREDENTIAL', `Invalid Verifiable Credential: ${errors.join('; ')}`, { fields: errors });
  }

  return parsed as VerifiableCredential;
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


