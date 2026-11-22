/**
 * did:og `og:1.0-draft.1` (originals-spec PR 69 at 6e0e3f9): the method value,
 * the limits of P14.13 and the error every did:og check raises, which names
 * the rule it enforces so that a report can give it (P7.19, P14.25).
 */
import { OriginalsError, type ErrorCategory } from "../errors.js";

/** The only method value this implementation implements (P14.1). PROVISIONAL: `og:1.0-draft.N` until release. */
export const OG_METHOD = "og:1.0-draft.1";

/** P14.13. */
export const OG_LIMITS = Object.freeze({
  entries: 10_000,
  entryBytes: 65_536,
  editors: 32,
  supersedes: 8,
  publicationParts: 16,
  previewBytes: 8_192,
  signerVersions: 1_000,
  logFileBytes: 16 * 1024 * 1024,
  resourceBytes: 64 * 1024 * 1024,
  fetchMs: 15_000,
  /** P9.17: metadata and body of one inscription together. */
  inscriptionBytes: 350_000,
  /** P14.3, P5.7. */
  depth: 64,
});

/** A did:og check that failed, with the rule it enforces (P7.19). */
export class OgRuleError extends OriginalsError {
  constructor(
    public readonly rule: string,
    code: string,
    message: string,
    category: ErrorCategory = "invalid-evidence",
  ) {
    super(category, code, `${message} (${rule})`, { rule });
    this.name = "OgRuleError";
  }
}

export function reject(rule: string, code: string, message: string, category: ErrorCategory = "invalid-evidence"): never {
  throw new OgRuleError(rule, code, message, category);
}

/** The rule an error enforces: its own, or `fallback` for an error from a lower layer. */
export function ruleOf(error: unknown, fallback: string): string {
  if (error instanceof OgRuleError) return error.rule;
  return fallback;
}
