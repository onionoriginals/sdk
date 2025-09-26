import { DIDDocument, VerifiableCredential } from '../types';

export function validateDID(did: string): boolean {
  // Validate DID format according to W3C DID spec
  const didRegex = /^did:([a-z0-9]+):(.*)/;
  
  if (!didRegex.test(did)) {
    return false;
  }

  const match = did.match(didRegex);
  if (!match) {
    return false;
  }
  const method = match[1];
  
  // Validate supported methods
  const supportedMethods = ['peer', 'webvh', 'btco'];
  if (!supportedMethods.includes(method)) {
    return false;
  }

  return true;
}

export function validateCredential(vc: VerifiableCredential): boolean {
  // Validate VC structure according to W3C VC spec
  if (!vc['@context'] || !Array.isArray(vc['@context'])) {
    return false;
  }

  if (!vc.type || !Array.isArray(vc.type)) {
    return false;
  }

  if (!vc.type.includes('VerifiableCredential')) {
    return false;
  }

  if (!vc.issuer || (!vc.issuanceDate)) {
    return false;
  }

  if (!vc.credentialSubject) {
    return false;
  }

  return true;
}

export function validateDIDDocument(didDoc: DIDDocument): boolean {
  // Validate DID Document structure
  if (!didDoc['@context'] || !Array.isArray(didDoc['@context'])) {
    return false;
  }

  if (!didDoc.id || !validateDID(didDoc.id)) {
    return false;
  }

  // Validate verification methods
  /* istanbul ignore next */
  if (didDoc.verificationMethod) {
    for (const vm of didDoc.verificationMethod) {
      if (!vm.id || !vm.type || !vm.controller || !vm.publicKeyMultibase) {
        return false;
      }
    }
  }

  return true;
}

export function hashResource(content: Buffer): string {
  // Generate SHA-256 hash
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(content).digest('hex');
}


