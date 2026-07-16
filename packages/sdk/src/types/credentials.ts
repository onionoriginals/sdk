import { LayerType } from './common.js';

// Verifiable Credentials types
export interface VerifiableCredential {
  '@context': string[];
  type: string[];
  id?: string;
  issuer: string | Issuer;
  /**
   * VCDM 2.0 issuance timestamp. The SDK standardizes on VCDM 2.0 and emits
   * `validFrom` (issue #300). `issuanceDate` is retained (optional) only so
   * previously-issued VCDM 1.1 credentials can still be read/verified.
   */
  validFrom?: string;
  /** VCDM 2.0 expiry timestamp (replaces the 1.1 `expirationDate`). */
  validUntil?: string;
  /** @deprecated VCDM 1.1 issuance timestamp — read-only legacy field; emit `validFrom`. */
  issuanceDate?: string;
  /** @deprecated VCDM 1.1 expiry timestamp — read-only legacy field; emit `validUntil`. */
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

/**
 * W3C Bitstring Status List v1 types — used for credential revocation and
 * suspension. See https://www.w3.org/TR/vc-bitstring-status-list/.
 */
export type StatusPurpose = 'revocation' | 'suspension';

/** A `credentialStatus` entry pointing into a Bitstring Status List credential. */
export interface BitstringStatusListEntry {
  id?: string;
  type: 'BitstringStatusListEntry';
  statusPurpose: StatusPurpose;
  /** Bit index within the status list, serialized as a string per spec. */
  statusListIndex: string;
  /** URL/URN of the status list credential. */
  statusListCredential: string;
}

/** The `credentialSubject` of a Bitstring Status List credential. */
export interface BitstringStatusListSubject {
  id?: string;
  type: 'BitstringStatusList';
  statusPurpose: StatusPurpose;
  /** GZIP-compressed, base64url-encoded bitstring. */
  encodedList: string;
}


