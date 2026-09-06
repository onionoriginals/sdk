/**
 * Drift guard: every test file must be reachable from the `test` script.
 *
 * The script enumerates paths (four separate `bun test` invocations, deliberately
 * — see plan 046 item 5) rather than running `bun test` over the whole tree. That
 * enumeration silently stopped covering `tests/mocks`, `tests/performance`,
 * `tests/index.test.ts` and `tests/sdk.test.ts`: 75 tests that CI never ran, two
 * of which had been failing on main unnoticed.
 *
 * Adding a test directory is easy; remembering to widen a shell string in
 * package.json is not. This asserts the two stay in sync, so the next new
 * directory fails here instead of going unrun.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

const pkgRoot = resolve(import.meta.dir, '..', '..');
const testsRoot = join(pkgRoot, 'tests');

/** Paths the `test` script hands to `bun test`, package-root-relative. */
function scriptTestPaths(): string[] {
  const script = (JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }).scripts.test;
  return script
    .split('&&')
    .flatMap((invocation) => {
      const m = invocation.trim().match(/^bun test\s+(.*)$/);
      if (!m) return [];
      // Args only — this script passes no flags, but ignore any that appear.
      return m[1].split(/\s+/).filter((a) => a && !a.startsWith('-'));
    })
    .map((p) => p.replace(/\/$/, ''));
}

function testFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) testFiles(full, acc);
    else if (entry.name.endsWith('.test.ts')) acc.push(relative(pkgRoot, full));
  }
  return acc;
}

describe('the `test` script covers the whole tests tree', () => {
  test('every *.test.ts file is reachable from a `bun test` argument', () => {
    const paths = scriptTestPaths();
    expect(paths.length).toBeGreaterThan(0);

    const uncovered = testFiles(testsRoot).filter(
      (file) => !paths.some((p) => file === p || file.startsWith(p + sep))
    );

    expect(
      uncovered,
      `These test files are never run by \`bun run test\`. Add their path to the ` +
        `"test" script in packages/sdk/package.json:\n  ${uncovered.join('\n  ')}`
    ).toEqual([]);
  });
});
