/**
 * The shared proof envelope, with the field shape of W3C Data Integrity.
 * Used for VC credential proofs (`DataIntegrityProof` with `eddsa-rdfc-2022`
 * or `bbs-2023`). Read `type` and `cryptosuite` before assuming which proof
 * you have.
 *
 * @see https://www.w3.org/TR/vc-data-integrity/
 */
export interface DataIntegrityProof {
  /** The proof type, e.g. `DataIntegrityProof`. */
  type: string;
  /** The cryptosuite used (e.g. "eddsa-rdfc-2022") */
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
  /**
   * Reference to a previous proof (for proof chains). Retained on the shared
   * envelope for type/interop completeness only — no code in this SDK
   * creates, traverses, or verifies this dependency. `DataIntegrityProofManager
   * .createProof` rejects a caller-supplied value outright, and
   * `Verifier.verifyCredential`/`verifyPresentation` fail closed if an
   * incoming proof declares it (see onionoriginals/sdk#604).
   */
  previousProof?: string | string[];
}
