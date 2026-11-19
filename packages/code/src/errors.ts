/**
 * Errors at the public seams of `@originals/code` are `OriginalsError`s (a
 * `StructuredError`) with the section 6 categories, as in the SDK.
 */
import { OriginalsError, type ErrorCategory } from "@originals/vh";

export { OriginalsError };

export function codeError(category: ErrorCategory, code: string, message: string, details?: Record<string, unknown>): never {
  throw new OriginalsError(category, code, message, details);
}

/**
 * The author DID of a code Original's entry (K5), or undefined for a set
 * Original's (plan 050 W1). Code Originals are single-author until the code
 * profile moves onto signer sets (plan 050 §5, step 3).
 */
export function soleAuthorDid(state: { author: { did: string } | Array<{ did: string }> }): string | undefined {
  return Array.isArray(state.author) ? undefined : state.author.did;
}

/** `soleAuthorDid`, refusing a set Original as a profile this package does not support yet (plan 050 §5, step 3). */
export function requireSoleAuthor(state: { author: { did: string } | Array<{ did: string }> }): string {
  const did = soleAuthorDid(state);
  if (did === undefined) codeError("unsupported-profile", "SIGNER_SET_UNSUPPORTED", "code Originals are single-author; signer sets reach the code profile in plan 050 §5, step 3");
  return did;
}
