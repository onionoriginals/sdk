/**
 * Error contract for @originals/vh and the SDK built on it.
 *
 * `StructuredError` keeps the shape callers already handle (`code`, `message`,
 * optional `details`). `OriginalsError` adds the result category suggested by
 * the Originals Protocol, section 6, so a caller can tell invalid evidence from
 * missing evidence, an unsupported profile or a conflict without parsing codes.
 */
export class StructuredError extends Error {
  public readonly code: string;
  public readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "StructuredError";
    this.code = code;
    this.details = details;
  }
}

/** Result categories from the Originals Protocol, section 6 ("Observable results"). */
export type ErrorCategory =
  | "invalid-evidence"
  | "incomplete-evidence"
  | "unsupported-profile"
  | "unauthorized-key"
  | "author-binding"
  /** A change outside the editor's grant (section 6; P5.16). */
  | "outside-grant"
  | "stale-parent"
  | "fork"
  | "deactivated"
  | "unavailable-bytes"
  | "limit-exceeded";

export class OriginalsError extends StructuredError {
  constructor(
    public readonly category: ErrorCategory,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(code, message, details);
    this.name = "OriginalsError";
  }
}

export function fail(
  category: ErrorCategory,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new OriginalsError(category, code, message, details);
}
