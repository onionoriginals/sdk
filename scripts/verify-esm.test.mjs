import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, symlinkSync, readlinkSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const existing of ['matching-link', 'different-link', 'directory']) {
  for (const importFails of [false, true]) {
    test(`ESM verification preserves ${existing} after ${importFails ? 'failed' : 'successful'} imports`, () => {
      const root = mkdtempSync(join(tmpdir(), 'originals-esm-'));
      try {
        mkdirSync(join(root, 'scripts'));
        copyFileSync(new URL('./verify-esm.mjs', import.meta.url), join(root, 'scripts/verify-esm.mjs'));
        mkdirSync(join(root, 'node_modules/@originals'), { recursive: true });
        writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
        for (const name of ['cel', 'sdk', 'auth']) {
          const pkg = join(root, 'packages', name);
          mkdirSync(join(pkg, 'dist'), { recursive: true });
          writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@originals/' + name, type: 'module', exports: { '.': './dist/index.js' } }));
          writeFileSync(join(pkg, 'dist/index.js'), importFails && name === 'auth' ? 'throw new Error("fixture import failure");' : 'export const currentWorkspace = true;');
        }
        const installed = join(root, 'node_modules/@originals/cel');
        if (existing === 'directory') {
          mkdirSync(installed); writeFileSync(join(installed, 'keep.txt'), 'installed package');
        } else {
          symlinkSync(existing === 'matching-link' ? '../../packages/cel' : '../../missing-old-package', installed, 'dir');
        }
        const result = spawnSync(process.execPath, [join(root, 'scripts/verify-esm.mjs')], { encoding: 'utf8' });
        assert.equal(result.status, importFails ? 1 : 0, result.stderr);
        if (existing === 'directory') assert.equal(readFileSync(join(installed, 'keep.txt'), 'utf8'), 'installed package');
        else assert.equal(readlinkSync(installed), existing === 'matching-link' ? '../../packages/cel' : '../../missing-old-package');
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}
