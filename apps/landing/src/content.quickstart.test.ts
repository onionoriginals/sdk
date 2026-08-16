import { describe, test, expect } from 'bun:test';
import { developers } from './content';

/**
 * The quickstart is a template literal, so nothing typechecks it. It shipped
 * once telling every visitor to import OrdMockProvider from '@originals/sdk'
 * after plan 043 moved it to '@originals/sdk/testing' (#470) — a dead import
 * on the page teaching it. This resolves each specifier the snippet names and
 * asserts the bindings it destructures actually exist — and fails closed if the
 * parser does not account for every import statement, so no form slips past.
 */

/** Any top-level import: default, namespace, named, side-effect; either quote, optional semicolon. */
const IMPORT_RE = /^[ \t]*import\s+(?:type\s+)?(?:([\s\S]*?)\s+from\s+)?['"]([^'"]+)['"];?/gm;
/** Same anchor, used to prove the parser saw every statement rather than skipping unknown forms. */
const IMPORT_START_RE = /^[ \t]*import[\s'"]/gm;

type ParsedImport = { names: string[]; from: string };

/** Binding names to assert on the module namespace; `* as ns` binds the namespace itself, so it yields none. */
function bindings(clause: string | undefined): string[] {
  if (!clause) return [];
  const named = clause.match(/\{([\s\S]*)\}/)?.[1];
  const head = clause.replace(/\{[\s\S]*\}/, '').replace(/,\s*$/, '').trim();
  const names: string[] = [];
  if (head && !/^\*\s+as\s+/.test(head)) names.push('default');
  if (named) {
    for (const entry of named.split(',')) {
      const name = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0];
      if (name) names.push(name);
    }
  }
  return names;
}

function imports(source: string): ParsedImport[] {
  return [...source.matchAll(IMPORT_RE)].map((m) => ({ names: bindings(m[1]), from: m[2] }));
}

describe('the rendered quickstart snippet', () => {
  const parsed = imports(developers.quickstart);

  test('has imports to check', () => {
    expect(parsed.length).toBeGreaterThan(0);
  });

  test('parses every import statement in the snippet', () => {
    expect(parsed.length).toBe(developers.quickstart.match(IMPORT_START_RE)?.length ?? 0);
  });

  for (const { names, from } of parsed) {
    test(`every binding it takes from '${from}' exists`, async () => {
      const mod = (await import(from)) as Record<string, unknown>;
      for (const name of names) expect(mod).toHaveProperty(name);
    });
  }
});

describe('the quickstart import parser', () => {
  // A form the parser misses is a dead import that ships unnoticed, so pin the forms.
  test('covers default, namespace, double-quoted and semicolon-free imports', () => {
    const source = [
      `import Def from "a"`,
      `import * as ns from 'b';`,
      `import Def2, { x, y as z, type T } from 'c'`,
      `import {\n  Multi,\n  Line\n} from "d";`,
      `import 'e';`
    ].join('\n');
    expect(imports(source)).toEqual([
      { names: ['default'], from: 'a' },
      { names: [], from: 'b' },
      { names: ['default', 'x', 'y', 'T'], from: 'c' },
      { names: ['Multi', 'Line'], from: 'd' },
      { names: [], from: 'e' }
    ]);
    expect(source.match(IMPORT_START_RE)?.length).toBe(5);
  });
});
