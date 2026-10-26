import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepare } from './prepare-pr.mjs';

const tool = process.env.REV_TOOL_PATH;
if (!tool) throw new Error('REV_TOOL_PATH must point to the pinned REV checkout');

test('PR evidence contains the complete committed change and actual observations, with exact revisions', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'rev-integration-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git('init'); git('config', 'user.name', 'REV fixture'); git('config', 'user.email', 'rev@example.invalid');
    await mkdir(resolve(dir, '.rev'));
    await writeFile(resolve(dir, 'source.js'), 'export const answer = 1;\n');
    await writeFile(resolve(dir, 'probe.json'), JSON.stringify({ expected: 2, observed: 2 }));
    await writeFile(resolve(dir, '.rev/pr-task.json'), JSON.stringify({ version: 1, task: 'Return two', criteria: [{ id: 'answer', description: 'answer is two' }] }));
    await writeFile(resolve(dir, '.rev/pr-contract.json'), JSON.stringify({ request: { source: 'fixture', text: 'Return two' }, requiredChecks: ['test'], mappings: { 'source.js': ['answer'] } }));
    await writeFile(resolve(dir, '.rev/pr-sources.json'), JSON.stringify([
      { id: 'code', kind: 'code', paths: ['source.js'] }, { id: 'observations', kind: 'behavior', paths: ['probe.json'] },
    ]));
    git('add', '.'); git('commit', '-m', 'base'); const base = git('rev-parse', 'HEAD');
    await writeFile(resolve(dir, 'source.js'), 'export const answer = 2;\n');
    git('add', '.'); git('commit', '-m', 'head'); const head = git('rev-parse', 'HEAD');
    const output = resolve(dir, 'output');
    const result = await prepare(dir, tool, base, head, output);
    assert.deepEqual(result.files, ['source.js']);
    const change = JSON.parse(await readFile(resolve(output, 'change.json'), 'utf8'));
    assert.equal(change.baseSha, base); assert.equal(change.headSha, head);
    assert.match(change.files[0].diff, /\+export const answer = 2/);
    const evidence = JSON.parse(await readFile(resolve(output, 'evidence.json'), 'utf8'));
    assert.equal(evidence.headSha, head);
    assert.match(evidence.items[1].content, /"expected":2,"observed":2/);
    await assert.rejects(prepare(dir, tool, base, base, output), /head-not-checked-out/);
    const sourceManifest = await readFile(resolve(dir, '.rev/pr-sources.json'), 'utf8');
    await symlink(tmpdir(), resolve(dir, 'outside'));
    await writeFile(resolve(dir, '.rev/pr-sources.json'), JSON.stringify([{ id: 'escape', kind: 'code', paths: ['outside'] }]));
    await assert.rejects(prepare(dir, tool, base, head, output), /Evidence source escapes repository/);
    await writeFile(resolve(dir, '.rev/pr-sources.json'), sourceManifest);
    await writeFile(resolve(dir, 'extra.js'), 'export const extra = true;\n');
    git('add', 'extra.js'); git('commit', '-m', 'unmapped');
    await assert.rejects(prepare(dir, tool, base, git('rev-parse', 'HEAD'), output), /Map every changed file/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('workflow requires full PR coverage with a pinned evaluator and trusted PR-specific digest', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  const evaluator = workflow.split('\n  rev:')[1].split(/\n  [a-zA-Z_][a-zA-Z_-]*:/)[0];
  assert.match(evaluator, /scope: pull-request/);
  assert.match(evaluator, /aviarytech\/rev@81686246e89f9dd93f58397b508a01925b5eb32d/);
  assert.match(evaluator, /change-file: rev-input\/change.json/);
  assert.match(evaluator, /vars\[format\('REV_CONTRACT_PR_\{0\}'/);
  assert.doesNotMatch(evaluator, /uses: actions\/checkout|run:/);
  for (const job of ["typecheck", "lint", "tests", "coverage", "esm-importable", "landing", "audit", "changeset", "rev-evidence"]) assert.ok(evaluator.includes(job), `Missing required job ${job}`);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /persist-credentials: false/);
});

test('SDK evaluator recognizes the existing secret spelling without exposing credentials', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  assert.ok(workflow.includes('secrets.TYPESAFE_API_KEY || secrets.TUPESAFE_API_KEY'));
});

test('operator procedure and PR manifest have valid criteria and evidence sources', async () => {
  const task = JSON.parse(await readFile('.rev/pr-task.json', 'utf8'));
  const contract = JSON.parse(await readFile('.rev/pr-contract.json', 'utf8'));
  const sources = JSON.parse(await readFile('.rev/pr-sources.json', 'utf8'));
  const docs = await readFile('.rev/PR-COVERAGE.md', 'utf8');
  for (const text of ['full original request', 'every', 'relevant evidence', 'independent review', 'REV_CONTRACT_PR_<number>', 'Never set it automatically', 'merge readiness', 'Never switch']) {
    assert.ok(docs.includes(text), `Missing operator instruction: ${text}`);
  }
  const ids = new Set(task.criteria.map(c => c.id));
  for (const [path, criteria] of Object.entries(contract.mappings)) {
    assert.ok(criteria.length > 0, path);
    for (const id of criteria) assert.ok(ids.has(id), `${path}: unknown criterion ${id}`);
  }
  const paths = sources.flatMap(s => s.paths);
  for (const path of ['.rev-tool/scripts/change.js', '.rev-tool/src/corpus.js', '.rev/pr-task.json', '.rev/pr-contract.json', '.rev/pr-observations.txt']) assert.ok(paths.includes(path), path);

});

test('reruns replace the REV report artifact', async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  assert.match(workflow, /name: rev-report\n\s+overwrite: true/);
});
test('recorded upstream validation has no mismatches and identifies the reviewed merged pin', async () => {
  const result = JSON.parse(await readFile('.rev/evaluator-validation.json', 'utf8'));
  assert.equal(result.pin, '81686246e89f9dd93f58397b508a01925b5eb32d');
  assert.equal(result.pinIsAncestorOfMergedMain, true);
  assert.equal(result.cases, 20);
  for (const field of ['falseApprovals', 'falseDenials', 'mismatches', 'errors']) assert.equal(result[field], 0);
  assert.match(result.run, /^https:\/\/github.com\/aviarytech\/tv\/actions\/runs\/40240205167$/);
});
