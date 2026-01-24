import { LayerType } from './common';

// Verifiable Credentials types
export interface VerifiableCredential {
  '@context': string[];
  type: string[];
  id?: string;
  issuer: string | Issuer;
  issuanceDate: string;
  expirationDate?: string;
  credentialSubject: CredentialSubject;
  credentialStatus?: CredentialStatus;
  proof?: Proof | Proof[];
}

export interface Issuer {
  id: string;
  name?: string;
}

export interface CredentialSubject {
  id?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export interface CredentialStatus {
  id: string;
  type: string;
}

export interface Proof {
  type: string;
  created: string;
  verificationMethod: string;
  proofPurpose: string;
  proofValue: string;
}

export interface VerifiablePresentation {
  '@context': string[];
  type: string[];
  id?: string;
  holder: string;
  verifiableCredential: VerifiableCredential[];
  proof?: Proof | Proof[];
}

export interface ResourceCreatedCredential extends VerifiableCredential {
  credentialSubject: {
    id: string;
    resourceId: string;
    resourceType: string;
    createdAt: string;
    creator: string;
  };
}

export interface ResourceUpdatedCredential extends VerifiableCredential {
  credentialSubject: {
    id: string;
    resourceId: string;
    updatedAt: string;
    updateReason?: string;
  };
}

export interface ResourceMigratedCredential extends VerifiableCredential {
  credentialSubject: {
    id: string;
    resourceId: string;
    fromLayer: LayerType;
    toLayer: LayerType;
    migratedAt: string;
    migrationReason?: string;
  };
}

export interface KeyRecoveryCredential extends VerifiableCredential {
  credentialSubject: {
    id: string; // DID that was recovered
    recoveredAt: string; // ISO 8601 timestamp
    recoveryReason: string; // "key_compromise" or other reason
    previousVerificationMethods: string[]; // IDs of compromised keys
    newVerificationMethod: string; // ID of new key
  };
}


