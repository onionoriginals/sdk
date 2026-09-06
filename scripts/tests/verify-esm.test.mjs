import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

for (const failImport of [false, true]) {
  test(`ESM verification restores installed packages after ${failImport ? 'failure' : 'success'}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'verify-esm-test-'));
    try {
      mkdirSync(join(root, 'scripts'));
      copyFileSync(new URL('../verify-esm.mjs', import.meta.url), join(root, 'scripts/verify-esm.mjs'));
      const scope = join(root, 'node_modules/@originals');
      mkdirSync(scope, { recursive: true });
      for (const name of ['cel', 'sdk', 'auth']) {
        const pkg = join(root, 'packages', name);
        mkdirSync(join(pkg, 'dist'), { recursive: true });
        writeFileSync(join(pkg, 'package.json'), JSON.stringify({
          name: `@originals/${name}`, type: 'module', exports: { '.': './dist/index.js' },
        }));
        writeFileSync(join(pkg, 'dist/index.js'), failImport && name === 'auth'
          ? 'throw new Error("intentional import failure");' : 'export const localBuild = true;');
      }
      // An installed directory, a workspace symlink and a dangling link must
      // all survive. None is allowed to substitute for the local build tested.
      mkdirSync(join(scope, 'auth'));
      writeFileSync(join(scope, 'auth/sentinel'), 'installed package');
      symlinkSync('../../packages/sdk', join(scope, 'sdk'));
      symlinkSync('/missing-cel-workspace', join(scope, 'cel'));
      const run = spawnSync(process.execPath, [join(root, 'scripts/verify-esm.mjs')], { encoding: 'utf8' });
      assert.equal(run.status, failImport ? 1 : 0, run.stderr);
      assert.equal(readFileSync(join(scope, 'auth/sentinel'), 'utf8'), 'installed package');
      assert.equal(readlinkSync(join(scope, 'sdk')), '../../packages/sdk');
      assert.equal(readlinkSync(join(scope, 'cel')), '/missing-cel-workspace');
      assert.deepEqual(readdirSync(dirname(scope)), ['@originals']);
      assert.equal(lstatSync(join(scope, 'cel')).isSymbolicLink(), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test('ESM verification removes only links it created for missing packages', () => {
  const root = mkdtempSync(join(tmpdir(), 'verify-esm-test-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(new URL('../verify-esm.mjs', import.meta.url), join(root, 'scripts/verify-esm.mjs'));
    for (const name of ['cel', 'sdk', 'auth']) {
      const pkg = join(root, 'packages', name);
      mkdirSync(join(pkg, 'dist'), { recursive: true });
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ type: 'module', exports: { '.': './dist/index.js' } }));
      writeFileSync(join(pkg, 'dist/index.js'), 'export const localBuild = true;');
    }
    const run = spawnSync(process.execPath, [join(root, 'scripts/verify-esm.mjs')], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    for (const name of ['cel', 'sdk', 'auth']) assert.equal(existsSync(join(root, 'node_modules/@originals', name)), false);
    assert.deepEqual(readdirSync(join(root, 'node_modules')), ['@originals']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
