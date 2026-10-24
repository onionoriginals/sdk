import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const base = process.env.REV_BASE_SHA;
assert.match(base ?? '', /^[a-f0-9]{40}$/);
const read = p => readFileSync(p, 'utf8');
const parseLock = text => JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|,\s*(?=[}\]])/g, token => token.startsWith('"') ? token : ''));
const lock = parseLock(read('bun.lock'));
const oldLock = parseLock(git('show', base + ':bun.lock'));
for (const [dir, version] of Object.entries({'packages/sdk':'5.1.0','packages/vh':'0.3.0','packages/auth':'4.0.2','apps/landing':'0.4.0'})) {
  const pkg = JSON.parse(read(dir + '/package.json'));
  const old = JSON.parse(git('show', base + ':' + dir + '/package.json'));
  assert.equal(pkg.version, version);
  assert.equal(lock.workspaces[dir].version, version);
  assert.ok(read(dir + '/CHANGELOG.md').split('\n').includes('## ' + version));
  const normalized = structuredClone(pkg);
  for (const [name, version] of Object.entries({'@originals/sdk':'5.1.0','@originals/vh':'0.3.0','@originals/auth':'4.0.2'})) {
    for (const field of ['dependencies','devDependencies','peerDependencies','optionalDependencies']) {
      if (pkg[field]?.[name] !== old[field]?.[name]) {
        assert.equal(pkg[field]?.[name], '^' + version);
        assert.equal(lock.workspaces[dir][field]?.[name], pkg[field][name]);
        normalized[field][name] = old[field][name];
      }
    }
  }
  assert.deepEqual({...normalized, version:old.version}, old, dir + ' unexpected manifest changes');
  console.log(JSON.stringify({dir,expected:version,manifest:pkg.version,lock:lock.workspaces[dir].version,changelog:true}));
}
const files = git('diff','--name-only',base,'HEAD').trim().split('\n').filter(Boolean);
for (const file of files) {
  if (file.startsWith('.rev/')) continue;
  assert.ok(file === 'bun.lock' || /^(packages\/(sdk|vh|auth)|apps\/landing)\/(package.json|CHANGELOG.md)$/.test(file) || /^\.changeset\/[^/]+\.md$/.test(file), 'unexpected release change: '+file);
  if (file.startsWith('.changeset/')) assert.equal(git('diff','--diff-filter=D','--name-only',base,'HEAD','--',file).trim(),file);
}
delete lock.workspaces; delete oldLock.workspaces;
assert.deepEqual(lock,oldLock,'resolved dependency graph changed');
console.log('PASS: release-only diff; dependency resolution unchanged', JSON.stringify(files));
