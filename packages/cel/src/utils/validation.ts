import type { DIDDocument } from '../types/did.js';

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
