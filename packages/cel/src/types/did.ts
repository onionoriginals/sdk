// W3C DID Document types
export interface DIDDocument {
  '@context': string[];
  id: string;
  verificationMethod?: VerificationMethod[];
  authentication?: (string | VerificationMethod)[];
  assertionMethod?: (string | VerificationMethod)[];
  keyAgreement?: (string | VerificationMethod)[];
  capabilityInvocation?: (string | VerificationMethod)[];
  capabilityDelegation?: (string | VerificationMethod)[];
  service?: ServiceEndpoint[];
  controller?: string[];
  alsoKnownAs?: string[];
}

export interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase: string;
  revoked?: string; // ISO 8601 timestamp when the key was revoked
  compromised?: string; // ISO 8601 timestamp when the key was marked as compromised
}

/**
 * Caller-supplied verification method for DID creation/update. `controller`
 * is optional here — the DID method's own normalization derives it as the
 * document's own id when omitted — even though a resolved `VerificationMethod`
 * on a `DIDDocument` always carries one (see issue #804: a caller that passed
 * `controller: ''` to satisfy the required field defeated that fallback,
 * since `??` only replaces `null`/`undefined`, not an empty string).
 */
export type VerificationMethodInput = Omit<VerificationMethod, 'controller'> & {
  controller?: string;
};

export interface ServiceEndpoint {
  id: string;
  type: string;
  serviceEndpoint: string | object;
}


