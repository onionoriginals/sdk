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
import { checkPathPattern, matchPathPattern, type EditorGrant } from "@originals/vh/originals";
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

/**
 * K7 (revised for plan 050 W3): a path grant is an editor grant in the repo
 * Original's `editors` (P5.15) with a `paths` scope (P5.28, P14.23), which
 * every branch inherits through its pin (P5.24). It allows `metadata` (each
 * branch entry names its commit there) and `resource` within the patterns,
 * never the name. Patterns are sorted and unique, as P14.23 requires.
 */
export function pathGrant(did: string, paths: readonly string[]): EditorGrant {
  for (const p of paths) checkPattern(p);
  const sorted = [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (sorted.length === 0) codeError("invalid-evidence", "GRANT_PATTERN", "a path grant lists one or more patterns");
  return { did, name: false, metadata: true, resource: true, scope: { type: "paths", paths: sorted } };
}

/**
 * The path grants a repo state's `editors` hold (K7): each grant's DID and
 * patterns. A grant without a scope allows every path (`**`); one with a scope
 * of another type is left out, since it allows no path this profile can name.
 */
export function pathGrantsOf(editors: readonly EditorGrant[] | undefined): Array<{ did: string; paths: string[] }> {
  const out: Array<{ did: string; paths: string[] }> = [];
  for (const g of editors ?? []) {
    if (!g.resource) continue;
    if (!g.scope) out.push({ did: g.did, paths: ["**"] });
    else if (g.scope.type === "paths" && Array.isArray(g.scope.paths)) out.push({ did: g.did, paths: [...(g.scope.paths as string[])] });
  }
  return out;
}
