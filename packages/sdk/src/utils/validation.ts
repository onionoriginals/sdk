import { DIDDocument, VerifiableCredential } from '../types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

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

  // Require VC v1 context presence
  const contextValues = vc['@context'];
  const hasVcV1 = contextValues.includes('https://www.w3.org/2018/credentials/v1');
  if (!hasVcV1) {
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

  // issuer must be a DID string or an object with DID id
  const issuerIsValidDid = (iss: any): boolean => {
    if (typeof iss === 'string') return validateDID(iss);
    if (iss && typeof iss.id === 'string') return validateDID(iss.id);
    return false;
  };
  if (!issuerIsValidDid(vc.issuer as any)) {
    return false;
  }

  // issuanceDate should be a valid ISO timestamp
  if (typeof vc.issuanceDate !== 'string' || Number.isNaN(Date.parse(vc.issuanceDate))) {
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
  if (didDoc.verificationMethod) {
    for (const vm of didDoc.verificationMethod) {
      if (!vm.id || !vm.type || !vm.controller || !vm.publicKeyMultibase) {
        return false;
      }
      // controller should be a valid DID
      if (typeof vm.controller !== 'string' || !validateDID(vm.controller)) {
        return false;
      }
      // multibase key presence: require base58-btc multibase indicator 'z'
      if (typeof vm.publicKeyMultibase !== 'string' || !vm.publicKeyMultibase.startsWith('z')) {
        return false;
      }
    }
  }

  // If controller array present on the DID Document, validate entries are DIDs
  if (Array.isArray((didDoc as any).controller)) {
    const ctrls = (didDoc as any).controller as string[];
    if (!ctrls.every((c) => typeof c === 'string' && validateDID(c))) {
      return false;
    }
  }

  return true;
}

export function hashResource(content: Uint8Array): string {
  // Generate SHA-256 hash
  const hash = sha256(content);
  return bytesToHex(hash);
}


