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
  [key: string]: unknown;
}

export interface CredentialStatus {
  id: string;
  type: string;
}

/**
 * W3C Bitstring Status List Entry - embedded in credentials to reference their
 * position in a status list. See: https://www.w3.org/TR/vc-bitstring-status-list/
 */
export interface BitstringStatusListEntry extends CredentialStatus {
  type: 'BitstringStatusListEntry';
  /** The purpose of the status entry (e.g., 'revocation', 'suspension') */
  statusPurpose: StatusPurpose;
  /** The index position in the status list bitstring */
  statusListIndex: string;
  /** URL or ID of the BitstringStatusListCredential */
  statusListCredential: string;
}

/**
 * W3C Bitstring Status List Credential - a credential containing a compressed
 * bitstring where each bit represents a credential's status.
 */
export interface BitstringStatusListCredential extends VerifiableCredential {
  type: ['VerifiableCredential', 'BitstringStatusListCredential'];
  credentialSubject: BitstringStatusListSubject;
}

export interface BitstringStatusListSubject {
  id?: string;
  type: 'BitstringStatusList';
  /** The purpose of this status list */
  statusPurpose: StatusPurpose;
  /** GZIP-compressed, base64-encoded bitstring */
  encodedList: string;
}

/** Supported status purposes per W3C spec */
export type StatusPurpose = 'revocation' | 'suspension';

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


