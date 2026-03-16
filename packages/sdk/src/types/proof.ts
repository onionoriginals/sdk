/**
 * Canonical Data Integrity Proof types.
 *
 * Based on the W3C Data Integrity specification.
 * This is the single source of truth — all modules (CEL, VC cryptosuites, etc.)
 * MUST import from here instead of defining their own copies.
 *
 * @see https://www.w3.org/TR/vc-data-integrity/
 */

/**
 * Data Integrity Proof as defined in W3C Data Integrity spec.
 * Used for signing credentials, events, and witness attestations.
 */
export interface DataIntegrityProof {
  /** The type of proof (e.g., "DataIntegrityProof") */
  type: string;
  /** The cryptosuite used (e.g., "eddsa-jcs-2022", "eddsa-rdfc-2022") */
  cryptosuite: string;
  /** ISO 8601 timestamp when the proof was created */
  created?: string;
  /** DID URL of the verification method used to create the proof */
  verificationMethod: string;
  /** The purpose of the proof (e.g., "assertionMethod") */
  proofPurpose: string;
  /** The multibase-encoded proof value */
  proofValue: string;
  /** Optional proof identifier */
  id?: string;
  /** Reference to a previous proof (for proof chains) */
  previousProof?: string | string[];
}
