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

export interface ServiceEndpoint {
  id: string;
  type: string;
  serviceEndpoint: string | object;
}


