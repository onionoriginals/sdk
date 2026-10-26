import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { actionUpdateInputs } from './action-update.mjs';

test('action-update probe accepts only the requested reference upgrade and rejects unrelated changes', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'rev-action-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid');
    await mkdir(resolve(root, '.github/workflows'), { recursive: true });
    const path = resolve(root, '.github/workflows/ci.yml');
    const before = 'jobs:\n  test:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 24\n';
    await writeFile(path, before); git('add', '.'); git('commit', '-m', 'base'); const base = git('rev-parse', 'HEAD');
    const commit = async content => { await writeFile(path, content); git('add', '.'); git('commit', '-m', 'change'); return git('rev-parse', 'HEAD'); };
    const good = before.replace('checkout@v4', 'checkout@v7');
    const head = await commit(good);
    const probe = (revision = git('rev-parse', 'HEAD'), branch = 'dependabot/github_actions/actions/checkout-7') => actionUpdateInputs(root, base, revision, branch, ['tests']);
    const inputs = probe();
    assert.equal(JSON.parse(inputs.observation.content).replacements, 1);
    assert.deepEqual(inputs.contract.mappings, { '.github/workflows/ci.yml': ['action-update'] });
    assert.match(inputs.contract.request.text, /checkout to v7/);
    assert.throws(() => probe(base), /head-not-checked-out/);
    assert.throws(() => probe(head, 'dependabot/github_actions/untrusted/action-7'), /Unsupported/);
    for (const bad of [good.replace('24', '22'), good.replace('checkout@v7', 'checkout@v3'), good.replace('setup-node@v4', 'setup-node@v7'), good + 'permissions: write-all\n']) {
      git('reset', '--hard', head); await commit(bad);
      assert.throws(() => probe(), /unrelated|downgrade|structure/);
    }
    git('reset', '--hard', head); await writeFile(resolve(root, 'application.js'), 'unrelated'); git('add', '.'); git('commit', '-m', 'application');
    assert.throws(() => probe(), /outside workflows/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
