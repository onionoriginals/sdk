/**
 * Errors at the public seams of `@originals/code` are `OriginalsError`s (a
 * `StructuredError`) with the section 6 categories, as in the SDK.
 */
import { OriginalsError, type ErrorCategory } from "@originals/vh";

export { OriginalsError };

export function codeError(category: ErrorCategory, code: string, message: string, details?: Record<string, unknown>): never {
  throw new OriginalsError(category, code, message, details);
}
