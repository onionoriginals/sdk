import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const sdkExports = JSON.parse(readFileSync(new URL('../packages/sdk/package.json', import.meta.url), 'utf8')).exports;
const sdkEntries = Object.values(sdkExports)
  .filter((value) => typeof value === 'object' && value.import?.endsWith('.js'))
  .map((value) => `packages/sdk/${value.import.replace(/^\.\//, '')}`);
const additionalEntries = [
  'packages/sdk/dist/lifecycle/LifecycleManager.js',
  'packages/sdk/dist/lifecycle/OriginalsAsset.js',
  'packages/cel/dist/index.js',
  'packages/auth/dist/index.js',
  'packages/auth/dist/client/index.js',
];

function checkFixture(t, changedEntry, source) {
  const root = mkdtempSync(join(tmpdir(), 'originals-browser-safety-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  copyFileSync(new URL('./check-browser-safety.mjs', import.meta.url), join(root, 'scripts/check-browser-safety.mjs'));
  for (const entry of [...sdkEntries, ...additionalEntries]) {
    mkdirSync(dirname(join(root, entry)), { recursive: true });
    writeFileSync(join(root, entry), entry === changedEntry ? source : 'export const safe = true;');
  }
  return spawnSync(process.execPath, [join(root, 'scripts/check-browser-safety.mjs')], { encoding: 'utf8' });
}

test('browser gate inspects every SDK JavaScript export', (t) => {
  const result = checkFixture(t);
  assert.equal(result.status, 0, result.stderr);
  for (const entry of sdkEntries) assert.ok(result.stdout.includes(`✓ ${entry} —`), `uninspected export: ${entry}`);
});

for (const entry of ['v3/index.js', 'testing/index.js', 'types/public.js']) {
  const target = `packages/sdk/dist/${entry}`;
  test(`browser gate rejects an eager Node builtin in ${entry}`, (t) => {
    const result = checkFixture(t, target, "import 'node:fs';");
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stderr.includes(`✗ ${target}`));
    assert.ok(result.stderr.includes('node:fs'));
  });
  test(`browser gate rejects a Buffer-dependent import in ${entry}`, (t) => {
    const result = checkFixture(t, target, 'export const bytes = Buffer.from([1]);');
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(result.stderr.includes(`✗ ${target} — crashes on import with no global Buffer`));
  });
}
