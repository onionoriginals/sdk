import { describe, test, expect } from 'bun:test';
import { developers } from './content';

/**
 * The quickstart is a template literal, so nothing typechecks it. It shipped
 * once telling every visitor to import OrdMockProvider from '@originals/sdk'
 * after plan 043 moved it to '@originals/sdk/testing' (#470) — a dead import
 * on the page teaching it. This resolves each specifier the snippet names and
 * asserts the bindings it destructures actually exist.
 */

const IMPORT_RE = /import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+'([^']+)';/g;

function imports(source: string): Array<{ names: string[]; from: string }> {
  return [...source.matchAll(IMPORT_RE)].map((m) => ({
    names: m[1]
      .split(',')
      .map((n) => n.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0])
      .filter(Boolean),
    from: m[2]
  }));
}

describe('the rendered quickstart snippet', () => {
  const parsed = imports(developers.quickstart);

  test('has imports to check', () => {
    expect(parsed.length).toBeGreaterThan(0);
  });

  for (const { names, from } of parsed) {
    test(`every binding it takes from '${from}' exists`, async () => {
      const mod = (await import(from)) as Record<string, unknown>;
      for (const name of names) expect(mod).toHaveProperty(name);
    });
  }
});
