/**
 * Path-grant patterns (plan 049 phase 3, PROVISIONAL K7). A pattern is a
 * relative, `/`-separated path. In a segment, `*` matches any run of
 * characters other than `/`; a segment that is exactly `**` matches zero or
 * more whole segments, and a final `**` one or more, so `packages/vh/**`
 * covers everything inside `packages/vh/` but not a file named `packages/vh`
 * (as in gitignore). Nothing else is special: `?`, `[` and `\` are literal.
 * `**` inside a longer segment is refused rather than guessed at.
 */
import { codeError } from "./errors.js";

function bad(pattern: string, why: string): never {
  return codeError("invalid-evidence", "GRANT_PATTERN", `path pattern ${JSON.stringify(pattern)} ${why}`);
}

export function checkPattern(pattern: string): void {
  if (typeof pattern !== "string" || pattern.length === 0) bad(String(pattern), "is empty");
  if (pattern.includes("\u0000")) bad(pattern, "contains NUL");
  for (const segment of pattern.split("/")) {
    if (segment === "") bad(pattern, "has an empty segment (leading, trailing or doubled '/')");
    if (segment === "." || segment === "..") bad(pattern, "has a relative segment");
    if (segment !== "**" && segment.includes("**")) bad(pattern, "uses ** inside a segment; ** must be a whole segment");
  }
}

function segmentMatches(pattern: string, name: string): boolean {
  if (!pattern.includes("*")) return pattern === name;
  const parts = pattern.split("*");
  if (!name.startsWith(parts[0])) return false;
  let at = parts[0].length;
  for (let i = 1; i < parts.length - 1; i++) {
    const found = name.indexOf(parts[i], at);
    if (found < 0) return false;
    at = found + parts[i].length;
  }
  const last = parts[parts.length - 1];
  return name.length - at >= last.length && name.endsWith(last);
}

function matchFrom(p: string[], i: number, s: string[], j: number): boolean {
  if (i === p.length) return j === s.length;
  if (p[i] === "**") {
    const least = i === p.length - 1 ? j + 1 : j;
    for (let k = least; k <= s.length; k++) if (matchFrom(p, i + 1, s, k)) return true;
    return false;
  }
  return j < s.length && segmentMatches(p[i], s[j]) && matchFrom(p, i + 1, s, j + 1);
}

/** Whether the file path `path` is covered by `pattern`. */
export function matchPattern(pattern: string, path: string): boolean {
  checkPattern(pattern);
  return matchFrom(pattern.split("/"), 0, path.split("/"), 0);
}

/** The paths no pattern covers, in the order given; empty when all are covered. */
export function covers(patterns: readonly string[], paths: readonly string[]): string[] {
  return paths.filter((path) => !patterns.some((p) => matchPattern(p, path)));
}
