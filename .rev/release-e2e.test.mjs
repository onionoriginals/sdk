import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { prepare } from './prepare-pr.mjs';

// Exercise the real Changesets CLI, lockfile synchronizer, default reproduction
// command and pinned REV collector, rather than injecting a version generator.
test('real Changesets release packages complete revision-bound evidence and refuses a tampered release', { timeout: 120000 }, async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'rev-release-e2e-'));
  const run = (cmd, ...args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024 });
  const git = (...args) => run('git', ...args).trim();
  const json = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
  try {
    git('init', '-b', 'main'); git('config', 'user.name', 'Release fixture'); git('config', 'user.email', 'release@example.invalid');
    for (const dir of ['.rev', '.changeset', 'scripts', 'packages/example']) await mkdir(resolve(root, dir), { recursive: true });
    await writeFile(resolve(root, '.gitignore'), 'node_modules/\n');
    const repoPackage = JSON.parse(await readFile('package.json', 'utf8'));
    await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'release-fixture', private: true, type: 'module', workspaces: ['packages/*'], scripts: { version: repoPackage.scripts.version }, devDependencies: { '@changesets/cli': repoPackage.devDependencies['@changesets/cli'] } }));
    await writeFile(resolve(root, 'packages/example/package.json'), JSON.stringify({ name: '@originals/release-fixture', version: '1.0.0', type: 'module' }));
    await writeFile(resolve(root, '.changeset/config.json'), JSON.stringify({ changelog: ['@changesets/cli/changelog', {}], commit: false, fixed: [], linked: [], access: 'public', baseBranch: 'main', updateInternalDependencies: 'patch', ignore: [] }));
    await writeFile(resolve(root, '.changeset/fixture.md'), '---\n"@originals/release-fixture": patch\n---\n\nExercise the real release command.\n');
    await writeFile(resolve(root, '.changeset/rev-pr-coverage.md'), '---\n---\n\nConsumed empty rollout changeset.\n');
    for (const path of ['scripts/sync-release-lockfile.mjs', '.rev/pr-contract.json', '.rev/release-task.json', '.rev/release-contract.json', '.rev/release-pr.mjs', '.rev/release-pr.test.mjs']) await copyFile(path, resolve(root, path));
    run('bun', 'install'); git('add', '.'); git('commit', '-m', 'base with pending release'); const base = git('rev-parse', 'HEAD');
    run('bun', 'run', 'version'); git('add', '-A'); git('commit', '-m', 'generated release'); const head = git('rev-parse', 'HEAD');
    assert.equal((await json('packages/example/package.json')).version, '1.0.1');
    await assert.rejects(readFile(resolve(root, '.changeset/fixture.md')), { code: 'ENOENT' });
    await assert.rejects(readFile(resolve(root, '.changeset/rev-pr-coverage.md')), { code: 'ENOENT' });
    const output = resolve(root, 'artifact');
    const result = await prepare(root, process.env.REV_TOOL_PATH, base, head, output, 'release');
    const change = await json('artifact/change.json');
    const evidence = await json('artifact/evidence.json');
    assert.equal(change.baseSha, base); assert.equal(change.headSha, head); assert.equal(evidence.headSha, head);
    assert.deepEqual(result.files, ['.changeset/fixture.md', '.changeset/rev-pr-coverage.md', 'bun.lock', 'packages/example/CHANGELOG.md', 'packages/example/package.json']);
    assert.ok(change.files.every(file => file.diff && file.criteria.includes('release-output')));
    const observation = JSON.parse(evidence.items.find(item => item.id === 'release-reproduction').content);
    assert.equal(observation.exactMatch, true); assert.equal(observation.head, head);
    // Generated artifacts are deliberately outside the committed release diff.
    await rm(output, { recursive: true, force: true });
    await writeFile(resolve(root, 'packages/example/package.json'), JSON.stringify({ name: '@originals/release-fixture', version: '9.0.0', type: 'module' }));
    git('add', 'packages/example/package.json'); git('commit', '-m', 'tampered release');
    await assert.rejects(prepare(root, process.env.REV_TOOL_PATH, base, git('rev-parse', 'HEAD'), output, 'release'), /differs from regenerated/);
    t.diagnostic(JSON.stringify({ command: repoPackage.scripts.version, expectedVersion: '1.0.1', observedVersion: '1.0.1', changedFiles: result.files, fullDiffsAndMappingsVerified: true, revisionsVerified: true, tamperedVersionRejected: true, consumedRolloutChangesetAccepted: true }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
