import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { reproduceRelease } from './release-pr.mjs';

test('release reproduction accepts generated metadata and consumed changesets, rejects tampering and cleans up', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'rev-release-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const generate = async dir => {
    await writeFile(resolve(dir, 'package.json'), '{"version":"1.1.0"}\n');
    await rm(resolve(dir, '.changeset/rev-pr-coverage.md'));
    await writeFile(resolve(dir, 'CHANGELOG.md'), '# 1.1.0\n\nRelease\n');
  };
  try {
    git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    await mkdir(resolve(root, '.changeset'));
    await writeFile(resolve(root, '.changeset/rev-pr-coverage.md'), '---\n---\n');
    await writeFile(resolve(root, 'package.json'), '{"version":"1.0.0"}\n');
    git('add', '.'); git('commit', '-m', 'base'); const base = git('rev-parse', 'HEAD');
    await generate(root);
    git('add', '-A'); git('commit', '-m', 'release'); const head = git('rev-parse', 'HEAD');
    const result = await reproduceRelease(root, base, head, generate);
    assert.equal(result.exactMatch, true);
    assert.deepEqual(result.files, ['.changeset/rev-pr-coverage.md', 'CHANGELOG.md', 'package.json']);
    await assert.rejects(reproduceRelease(root, base, base, generate), /head-not-checked-out/);
    await writeFile(resolve(root, 'package.json'), '{"version":"9.0.0"}\n');
    git('add', '.'); git('commit', '-m', 'tampered version');
    await assert.rejects(reproduceRelease(root, base, git('rev-parse', 'HEAD'), generate), /differs from regenerated/);
    git('reset', '--hard', head);
    await writeFile(resolve(root, 'application.js'), 'unrelated\n');
    git('add', '.'); git('commit', '-m', 'unrelated code');
    await assert.rejects(reproduceRelease(root, base, git('rev-parse', 'HEAD'), generate), /differs from regenerated/);
    await assert.rejects(reproduceRelease(root, base, git('rev-parse', 'HEAD'), () => { throw new Error('generation failed'); }), /generation failed/);
    assert.equal(git('worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
