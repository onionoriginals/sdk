/**
 * What `asset.verify()` answers with.
 *
 * A bare `boolean` conflates two very different statements: "I checked, and the
 * proof does not hold" and "I could not check". For a product whose entire
 * claim is that the proof verifies, those must never look the same to a caller
 * — `false` with no reason sent developers hunting for a forgery when the real
 * answer was a missing ordinals provider (launch review, item 3).
 *
 * So every non-verified outcome names a machine-readable `code` and a message
 * that says what to do about it.
 */

/**
 * Why verification did not succeed. Stable identifiers — branch on these, not
 * on `message`.
 */
export type VerificationFailureCode =
  /**
   * The btco-anchored log carries a Bitcoin witness proof and no ordinals
   * provider was available to check it, so verification FAILED CLOSED without
   * looking. This is a configuration answer, not a provenance answer: configure
   * `ordinalsProvider` on the SDK, or pass one to `verify()`.
   */
  | 'ORDINALS_PROVIDER_REQUIRED'
  /** The signed CEL chain itself did not verify. `details.errors` carries the verifier's own reasons. */
  | 'CEL_LOG_INVALID'
  /** The log verified, but the asset's current resources do not match the digests recorded at genesis. */
  | 'GENESIS_RESOURCE_BINDING'
  /** The DID document is structurally invalid or names an unsupported method. */
  | 'DID_DOCUMENT_INVALID'
  /** A resource is structurally invalid (missing/!string id, type, contentType, or a non-hex hash). */
  | 'RESOURCE_INVALID'
  /** Inline or fetched content does not hash to the resource's declared hash. */
  | 'RESOURCE_HASH_MISMATCH'
  /** A hosted (URL-only) resource could not be fetched and hashed, so its integrity is unconfirmed. Fails closed. */
  | 'RESOURCE_UNVERIFIABLE'
  /** A credential is structurally invalid. */
  | 'CREDENTIAL_INVALID'
  /** A credential's signature did not verify. */
  | 'CREDENTIAL_UNVERIFIED'
  /** Verification threw. `details.error` carries the message. */
  | 'VERIFICATION_ERROR';

export interface VerificationReport {
  /** The answer. Check this, never the truthiness of the report itself. */
  verified: boolean;
  /** Absent when `verified`. */
  code?: VerificationFailureCode;
  /** Human-readable and actionable. Absent when `verified`. */
  message?: string;
  /** Whatever the failing check knew: the offending resource id, the CEL verifier's errors. */
  details?: Record<string, unknown>;
}

/** The verified answer. A single shared shape so callers can compare cheaply. */
export const VERIFIED: VerificationReport = Object.freeze({ verified: true });

export function verificationFailure(
  code: VerificationFailureCode,
  message: string,
  details?: Record<string, unknown>
): VerificationReport {
  return details ? { verified: false, code, message, details } : { verified: false, code, message };
}
