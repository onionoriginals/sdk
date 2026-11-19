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
 * The author DID of an entry naming one author, or undefined for a set
 * Original's entry (P5.19). In profile 0.2 the repo and release Originals
 * are set Originals and each branch Original has one author (K5, K15, K17).
 */
export function soleAuthorDid(state: { author: { did: string } | Array<{ did: string }> }): string | undefined {
  return Array.isArray(state.author) ? undefined : state.author.did;
}

/** `soleAuthorDid`, refusing a set Original's entry where one author is required: a branch Original is one delegate's (K4). */
export function requireSoleAuthor(state: { author: { did: string } | Array<{ did: string }> }): string {
  const did = soleAuthorDid(state);
  if (did === undefined) codeError("invalid-evidence", "BRANCH_SET_AUTHOR", "a branch Original has one author, its delegate or contributor; a signer set governs the repo and release Originals (K4)");
  return did;
}
