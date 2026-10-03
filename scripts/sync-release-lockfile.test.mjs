import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncReleaseLockfile } from './sync-release-lockfile.mjs';

test('release synchronization updates workspace versions/ranges without changing resolved dependencies', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-lock-'));
  try {
    const manifests = {
      '': { name: 'repo', private: true },
      'packages/core': { name: '@test/core', version: '2.0.0' },
      'packages/sdk': { name: '@test/sdk', version: '4.0.0', dependencies: { '@test/core': '^2.0.0', external: '^1.0.0' } },
      'apps/private': { name: 'private', private: true, version: '0.2.1', dependencies: { '@test/sdk': 'workspace:*' } },
    };
    for (const [dir, pkg] of Object.entries(manifests)) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, 'package.json'), JSON.stringify(pkg));
    }
    const packages = { external: ['external@1.0.2', 'url,}', { marker: 'escaped"string,]' }, 'integrity'], '@test/core': ['@test/core@workspace:packages/core'] };
    writeFileSync(join(root, 'bun.lock'), JSON.stringify({ lockfileVersion: 1, configVersion: 1, workspaces: {
      '': { name: 'repo' },
      'packages/core': { name: '@test/core', version: '1.0.0' },
      'packages/sdk': { name: '@test/sdk', version: '3.0.0', dependencies: { '@test/core': '^1.0.0', external: '^1.0.0' } },
      'apps/private': { name: 'private', version: '0.2.0', dependencies: { '@test/sdk': 'workspace:*' } },
    }, packages }, null, 2).replace(/\n}/, ',\n}'));
    const original = readFileSync(join(root, 'bun.lock'), 'utf8');
    syncReleaseLockfile(root);
    const updated = JSON.parse(readFileSync(join(root, 'bun.lock'), 'utf8').replace(/,\n}$/, '\n}'));
    assert.equal(updated.workspaces['packages/core'].version, '2.0.0');
    assert.equal(updated.workspaces['packages/sdk'].version, '4.0.0');
    assert.deepEqual(updated.workspaces['packages/sdk'].dependencies, manifests['packages/sdk'].dependencies);
    assert.equal(updated.workspaces['apps/private'].version, '0.2.1');
    assert.equal(updated.workspaces['apps/private'].dependencies['@test/sdk'], 'workspace:*');
    assert.deepEqual(updated.packages, packages);
    assert.equal(updated.configVersion, 1);
    assert.equal(readFileSync(join(root, 'bun.lock'), 'utf8').split('  \"packages\":')[1], original.split('  \"packages\":')[1]);
    assert.equal(updated.workspaces[''].version, undefined);
    const first = readFileSync(join(root, 'bun.lock'), 'utf8');
    syncReleaseLockfile(root);
    assert.equal(readFileSync(join(root, 'bun.lock'), 'utf8'), first);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
