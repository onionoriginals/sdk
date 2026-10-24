import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { collect } from './rev-evidence.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'rev-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('commit', '--allow-empty', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  mkdirSync(join(root, '.rev'));
  const write = (path, value) => writeFileSync(join(root, path), value);
  write('.rev/task.json', JSON.stringify({ version: 1, task: 'Return 401', criteria: [{ id: 'anonymous', description: 'Anonymous requests return 401' }] }));
  write('.rev/sources.json', JSON.stringify([{ id: 'probe', kind: 'behavior', path: 'observations.txt' }]));
  write('observations.txt', 'Anonymous GET /export: 401');
  write('route.js', 'export const status = 401;');
  git('add', '.');
  git('commit', '-qm', 'task');
  return { root, base, head: git('rev-parse', 'HEAD'), git, write };
}

test('collects exact-head diff and concrete behavior with base provenance', t => {
  const f = fixture(t);
  const evidence = JSON.parse(collect(f.root, f.head, f.base));
  assert.equal(evidence.headSha, f.head);
  assert.equal(evidence.items[0].source, `${f.base}..${f.head}`);
  assert.match(evidence.items[0].content, /export const status = 401/);
  assert.equal(evidence.items[1].content, 'Anonymous GET /export: 401');
});

test('rejects a stale head label', t => {
  const f = fixture(t);
  assert.throws(() => collect(f.root, f.base, f.base), /Checkout does not match/);
});

test('rejects reusing an earlier task on a later PR', t => {
  const f = fixture(t);
  f.git('commit', '--allow-empty', '-qm', 'later PR');
  assert.throws(() => collect(f.root, f.git('rev-parse', 'HEAD'), f.head), /Update .rev\/task.json/);
});

test('rejects missing behavioral evidence and duplicate IDs', t => {
  const f = fixture(t);
  f.write('.rev/sources.json', '[]');
  assert.throws(() => collect(f.root, f.head, f.base), /Behavioral evidence/);
  f.write('.rev/sources.json', JSON.stringify([{ id: 'pr-diff', kind: 'behavior', path: 'observations.txt' }]));
  assert.throws(() => collect(f.root, f.head, f.base), /duplicate source ID/);
});

test('rejects source paths outside the repository', t => {
  const f = fixture(t);
  f.write('.rev/sources.json', JSON.stringify([{ id: 'outside', kind: 'behavior', path: '/etc/hosts' }]));
  assert.throws(() => collect(f.root, f.head, f.base), /Source escapes repository/);
});

test('rejects oversized evidence without truncation', t => {
  const f = fixture(t);
  f.write('observations.txt', 'x'.repeat(1024 * 1024));
  assert.throws(() => collect(f.root, f.head, f.base), /exceeds REV limit/);
});
