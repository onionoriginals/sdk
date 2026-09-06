/**
 * The shared proof ENVELOPE — the field shape borrowed from W3C Data
 * Integrity, not a promise of conformance to it.
 *
 * This is the single source of truth — all modules (CEL, VC cryptosuites, etc.)
 * MUST import from here instead of defining their own copies. It therefore
 * spans two very different things, and the `type`/`cryptosuite` pair is what
 * tells them apart:
 *
 * - VC credential proofs (`DataIntegrityProof` + `eddsa-rdfc-2022`/`bbs-2023`)
 *   really are W3C Data Integrity, and a conforming verifier can check them.
 * - CEL proofs (`OriginalsCelProof` + `originals-cel-ed25519-jcs-v1`, and the
 *   `bitcoin-ordinals-2024` witness attestations) are Originals constructions.
 *   Their hashing mirrors Data Integrity's, but the suites are unregistered
 *   and the payload is canonicalized with plain JCS rather than RDF, so no
 *   conforming implementation can verify one. They are named accordingly —
 *   see CEL_PROOF_TYPE in `proofVerification.ts` for why the old
 *   `DataIntegrityProof` label was a claim this code never implemented.
 *
 * @see https://www.w3.org/TR/vc-data-integrity/ — for the VC proofs only.
 */

/**
 * A proof envelope. Used for credentials, CEL events, and witness attestations
 * alike; read `type` and `cryptosuite` before assuming which one you have.
 */
export interface DataIntegrityProof {
  /**
   * The proof type: `DataIntegrityProof` for genuine W3C Data Integrity
   * credential proofs, `OriginalsCelProof` for CEL log proofs (which also
   * accept the legacy `DataIntegrityProof` on read).
   */
  type: string;
  /** The cryptosuite used (e.g., "originals-cel-ed25519-jcs-v1", "eddsa-rdfc-2022") */
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
