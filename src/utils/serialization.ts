import { DIDDocument, VerifiableCredential } from '../types';

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

export function canonicalizeDocument(doc: any): string {
  // Canonicalize document for signing (RDF Dataset Canonicalization)
  // This is a simplified version - production should use proper RDF canonicalization
  const sorted = JSON.stringify(doc, Object.keys(doc).sort());
  return sorted;
}


