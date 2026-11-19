/**
 * Path-grant patterns (plan 049 phase 3, K7). The grammar and matching are
 * the Originals `paths` scope's (P14.23; originals-spec #66), implemented
 * once in `@originals/vh/originals` and reused here: a pattern is a relative,
 * `/`-separated path; in a segment `*` matches any run of characters other
 * than `/`; a segment that is exactly `**` matches zero or more whole
 * segments, and a final `**` one or more, so `packages/vh/**` covers
 * everything inside `packages/vh/` but not a file named `packages/vh`.
 * Nothing else is special: `?`, `[` and `\` are literal. The code profile
 * also refuses NUL, which no git path holds.
 */
import { OriginalsError } from "@originals/vh";
import { checkPathPattern, matchPathPattern } from "@originals/vh/originals";
import { codeError } from "./errors.js";

export function checkPattern(pattern: string): void {
  if (typeof pattern === "string" && pattern.includes("\u0000")) codeError("invalid-evidence", "GRANT_PATTERN", `path pattern ${JSON.stringify(pattern)} contains NUL`);
  try {
    checkPathPattern(pattern);
  } catch (error) {
    if (error instanceof OriginalsError) codeError("invalid-evidence", "GRANT_PATTERN", error.message);
    throw error;
  }
}

/** Whether the file path `path` is covered by `pattern`. */
export function matchPattern(pattern: string, path: string): boolean {
  checkPattern(pattern);
  return matchPathPattern(pattern, path);
}

/** The paths no pattern covers, in the order given; empty when all are covered. */
export function covers(patterns: readonly string[], paths: readonly string[]): string[] {
  return paths.filter((path) => !patterns.some((p) => matchPattern(p, path)));
}
