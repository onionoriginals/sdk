import { DIDDocument, VerifiableCredential } from '../types/index.js';
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
  const supportedMethods = ['peer', 'webvh', 'btco', 'cel'];
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

  // Require the W3C VCDM 2.0 credentials context. The SDK standardizes on
  // VCDM 2.0 and no longer accepts the 1.1 (`2018/credentials/v1`) context
  // (issue #300). A credential presenting only the 1.1 context is rejected.
  const contextValues = vc['@context'];
  const hasVcV2 = contextValues.includes('https://www.w3.org/ns/credentials/v2');
  if (!hasVcV2) {
    return false;
  }

  if (!vc.type || !Array.isArray(vc.type)) {
    return false;
  }

  if (!vc.type.includes('VerifiableCredential')) {
    return false;
  }

  // VC 2.0 uses validFrom; still accept a legacy issuanceDate when reading
  // previously-issued credentials.
  const issuanceTimestamp =
    (vc as { validFrom?: unknown }).validFrom ?? vc.issuanceDate;
  if (!vc.issuer || issuanceTimestamp === undefined) {
    return false;
  }

  // issuer must be a DID string or an object with DID id
  const issuerIsValidDid = (iss: unknown): boolean => {
    if (typeof iss === 'string') return validateDID(iss);
    if (iss && typeof iss === 'object' && 'id' in iss) {
      const issObj = iss;
      if (typeof issObj.id === 'string') return validateDID(issObj.id);
    }
    return false;
  };
  if (!issuerIsValidDid(vc.issuer)) {
    return false;
  }

  // issuanceDate / validFrom should be a valid ISO timestamp
  if (typeof issuanceTimestamp !== 'string' || Number.isNaN(Date.parse(issuanceTimestamp))) {
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
  const didDocWithController = didDoc as DIDDocument & { controller?: unknown };
  if (Array.isArray(didDocWithController.controller)) {
    const ctrls = didDocWithController.controller;
    if (!ctrls.every((c: unknown) => typeof c === 'string' && validateDID(c))) {
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


