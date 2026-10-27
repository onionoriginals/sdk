import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests, runnerFor } from './run-tests.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = path => readFileSync(join(root, path), 'utf8');
// Only the jobs map: `on:` triggers share the same indentation.
const ci = read('.github/workflows/ci.yml').split('\njobs:\n')[1];
const jobNames = [...('\n' + ci).matchAll(/\n  ([\w-]+):\n/g)].map(m => m[1]);
const job = name => {
  const start = ci.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `missing job ${name}`);
  const next = ci.slice(start + 1).search(/\n  [\w-]+:\n/);
  return next < 0 ? ci.slice(start) : ci.slice(start, start + 1 + next);
};
const contract = JSON.parse(read('.rev/contract.json'));
const write = (dir, files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
};

describe('REV tests gate', () => {
  test('deletes the old evidence collector and leaves only the new gate files in .rev', () => {
    for (const path of ['scripts/rev-evidence.mjs', 'scripts/rev-evidence.test.mjs'])
      assert.equal(existsSync(join(root, path)), false, `${path} still exists`);
    assert.deepEqual(readdirSync(join(root, '.rev')).sort(), ['README.md', 'contract.json', 'run-tests.mjs', 'task.json', 'tests-gate.test.mjs']);
    assert.doesNotMatch(job('tests'), /rev-evidence|\.rev/);
  });

  test('no workflow references TypeSafe, an api-key input or the rev-evidence job', () => {
    const workflows = readdirSync(join(root, '.github/workflows')).filter(f => /\.ya?ml$/.test(f));
    assert.ok(workflows.includes('ci.yml'));
    for (const file of workflows)
      assert.doesNotMatch(read(`.github/workflows/${file}`), /TYPESAFE|TUPESAFE|typesafe\.ai|api-key:|rev-evidence/i, file);
  });

  test('REV job uses aviarytech/rev pinned to a full SHA in tests scope, and rev-tests checks out the same commit', () => {
    const pin = job('rev').match(/uses: aviarytech\/rev@([a-f0-9]{40})\n/);
    assert.ok(pin, 'REV must be pinned to a full commit SHA');
    assert.match(job('rev'), /\n\s+scope: tests\n/);
    assert.match(job('rev-tests'), new RegExp(`repository: aviarytech/rev\\n\\s+ref: ${pin[1]}\\n`));
  });

  test('REV job needs every other CI job, which are exactly the contract required checks', () => {
    const rev = job('rev');
    const needs = rev.match(/needs: \[([^\]]+)\]/)[1].split(',').map(x => x.trim()).sort();
    const others = jobNames.filter(name => name !== 'rev').sort();
    assert.deepEqual(needs, others);
    assert.deepEqual([...contract.requiredChecks].sort(), others);
    assert.match(rev, /if: \$\{\{ !cancelled\(\) && github\.event_name == 'pull_request' \}\}/);
  });

  test('REV job only downloads inputs, runs REV and uploads the report, with the PR contract variable and no secret', () => {
    const rev = job('rev');
    assert.deepEqual([...rev.matchAll(/uses: ([^@\s]+)@/g)].map(m => m[1]), ['actions/download-artifact', 'aviarytech/rev', 'actions/upload-artifact']);
    assert.doesNotMatch(rev, /run:|secrets\.|api-key/);
    assert.match(rev, /contract-sha256: \$\{\{ vars\[format\('REV_CONTRACT_PR_\{0\}', github\.event\.pull_request\.number\)\] \}\}/);
  });

  test('rev-tests runs the named tests on head sources and on a merge-base worktree', () => {
    const steps = job('rev-tests');
    const order = ['tests-change.js "$BASE_SHA" "$HEAD_SHA" .rev/contract.json .rev/task.json "$out/change.json"',
      'merge_base=$(git merge-base "$BASE_SHA" "$HEAD_SHA")',
      'node .rev/run-tests.mjs .rev/task.json . . "$HEAD_SHA" "$HEAD_SHA" "$out/head.json"',
      'git worktree add --detach "$RUNNER_TEMP/rev-base" "$merge_base"',
      'node .rev/run-tests.mjs .rev/task.json "$RUNNER_TEMP/rev-base" . "$merge_base" "$HEAD_SHA" "$out/base.json"'];
    const at = order.map(line => steps.indexOf(line));
    assert.ok(at.every(i => i >= 0), 'every collection step is present');
    assert.deepEqual([...at].sort((a, b) => a - b), at, 'steps run in order');
    assert.match(steps, /set -euo pipefail/);
    assert.match(steps, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}\n\s+fetch-depth: 0\n\s+persist-credentials: false/);
  });

  test('chooses Bun from the nearest package directory for TypeScript and Node from the root for JavaScript', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rev-runner-'));
    try {
      write(dir, { 'package.json': '{}', 'packages/a/package.json': '{}', 'packages/a/tests/deep/x.test.ts': '', 'tools/y.test.ts': '' });
      assert.deepEqual(runnerFor('packages/a/tests/deep/x.test.ts', dir),
        { cwd: join(dir, 'packages/a'), command: 'bun', args: ['test', '--reporter=junit'], path: 'tests/deep/x.test.ts' });
      assert.equal(runnerFor('tools/y.test.ts', dir).cwd, dir, 'falls back to the repository root package');
      for (const file of ['.rev/a.test.mjs', 'scripts/b.test.js'])
        assert.deepEqual(runnerFor(file, dir), { cwd: dir, command: 'node', args: ['--test', '--test-reporter=junit'], path: file });
      for (const file of ['src/a.ts', 'src/a.spec.ts', 'README.md']) assert.throws(() => runnerFor(file, dir), /unsupported/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('reports head passes and base failures, copying head tests onto base without aborting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rev-run-'));
    try {
      const [head, base] = ['head', 'base'].map(name => join(dir, name));
      for (const [path, value] of [[head, 2], [base, 1]]) write(path, {
        'lib.mjs': `export const value = ${value};\n`,
        'pkg/package.json': '{"name":"pkg","type":"module"}\n',
        // Base lacks the export the head Bun test imports, so that file cannot load on base.
        'pkg/value.ts': value === 2 ? 'export const added = true;\n' : 'export const other = 1;\n',
      });
      write(head, {
        't/lib.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../lib.mjs';\ntest('value is two', () => assert.equal(value, 2));\n",
        'pkg/tests/value.test.ts': "import { describe, expect, test } from 'bun:test';\nimport { added } from '../value.ts';\ndescribe('value', () => { test('is added', () => expect(added).toBe(true)); });\n",
      });
      const node = 't/lib.test.mjs > value is two', bun = 'pkg/tests/value.test.ts > value > is added';
      const fixture = { criteria: [{ tests: [node, bun] }] };
      const [h, b] = ['a', 'b'].map(c => c.repeat(40));
      assert.deepEqual(await runTests(fixture, head, head, h, h), { version: 1, sourceSha: h, testsSha: h,
        tests: [{ id: bun, status: 'passed' }, { id: node, status: 'passed' }] });
      const onBase = await runTests(fixture, base, head, b, h);
      assert.equal(onBase.sourceSha, b);
      assert.equal(onBase.testsSha, h);
      assert.deepEqual(onBase.tests.find(t => t.id === node), { id: node, status: 'failed' });
      assert.equal(onBase.tests.some(t => t.id === bun && t.status === 'passed'), false, 'unloadable Bun file has no passing entry');
      for (const file of ['t/lib.test.mjs', 'pkg/tests/value.test.ts'])
        assert.equal(readFileSync(join(base, file), 'utf8'), readFileSync(join(head, file), 'utf8'), `${file} copied onto base`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('REV guide shows the collect and review commands in the order the scripts accept', () => {
    const guide = read('.rev/README.md');
    assert.match(guide, /tests-change\.js BASE_SHA HEAD_SHA \.rev\/contract\.json \.rev\/task\.json \S+/);
    assert.match(guide, /TYPESAFE_API_KEY=\S* node \S*review-contract\.js \.rev\/task\.json \S+ --pin onionoriginals\/sdk PR_NUMBER/);
    assert.ok(guide.includes('Omit `--pin`'), 'dry run documented');
  });

  test('REV guide explains criteria, digest pinning and that Jev never runs per push', () => {
    const guide = read('.rev/README.md');
    for (const term of ['"version": 2', '`tests`', '`paths`', 'REV_CONTRACT_PR_<number>', 'Jev never runs per push', 'contract-mismatch'])
      assert.ok(guide.includes(term), term);
  });

  test('workflow README and PR template describe the gate and link the guide', () => {
    assert.match(read('.github/workflows/README.md'), /tests scope[\s\S]*no API key[\s\S]*Jev reviews each\s+PR's contract once[\s\S]*\.\.\/\.\.\/\.rev\/README\.md/);
    const template = read('.github/PULL_REQUEST_TEMPLATE.md');
    for (const term of ['.rev/task.json', 'path globs', 'fail without the change', 'review-contract.js', 'REV_CONTRACT_PR_<number>', '../.rev/README.md'])
      assert.ok(template.includes(term), term);
  });

  test('adds an empty changeset so no package is released', () => {
    assert.match(read('.changeset/rev-tests-gate.md'), /^---\n---\n/);
  });
});
