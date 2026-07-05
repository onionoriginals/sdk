import type { ReactNode } from 'react';

/**
 * Minimal TypeScript syntax highlighting — enough for the quickstart snippet,
 * with zero dependencies. Order matters: comments and strings win first.
 */
const TOKEN =
  /(\/\/[^\n]*)|('(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(import|from|const|await|new|async|function|return|export|let)\b|(\b[A-Z][A-Za-z0-9_]*\b)|(\b\d[\d_]*\b)/g;

const classFor = (groups: Array<string | undefined>): string => {
  if (groups[0] !== undefined) return 'tok-comment';
  if (groups[1] !== undefined) return 'tok-string';
  if (groups[2] !== undefined) return 'tok-keyword';
  if (groups[3] !== undefined) return 'tok-type';
  return 'tok-number';
};

export function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of code.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) out.push(code.slice(last, index));
    out.push(
      <span key={key++} className={classFor(match.slice(1))}>
        {match[0]}
      </span>
    );
    last = index + match[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}
