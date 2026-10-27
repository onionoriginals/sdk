import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests, runnerFor, testFiles } from './run-tests.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = path => readFileSync(join(root, path), 'utf8');
// Only the jobs map: `on:` triggers share the same indentation.
const ci = read('.github/workflows/ci.yml').split('\njobs:\n')[1];
const job = name => {
  const start = ci.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `missing job ${name}`);
  const next = ci.slice(start + 1).search(/\n  [\w-]+:\n/);
  return next < 0 ? ci.slice(start) : ci.slice(start, start + 1 + next);
};
const task = JSON.parse(read('.rev/task.json'));
const contract = JSON.parse(read('.rev/contract.json'));

describe('REV tests gate', () => {
  test('removes the per-push Jev gate and its evidence collector', () => {
    for (const path of ['scripts/rev-evidence.mjs', 'scripts/rev-evidence.test.mjs', '.rev/prepare-pr.mjs', '.rev/collect.sh',
      '.rev/pr-contract.json', '.rev/pr-task.json', '.rev/pr-sources.json', '.rev/sources.json', '.rev/pr-coverage.test.mjs',
      '.rev/evaluator-validation.json', '.rev/PR-COVERAGE.md']) assert.equal(existsSync(join(root, path)), false, path);
    assert.doesNotMatch(ci, /TYPESAFE_API_KEY|TUPESAFE_API_KEY|api-key:|rev-evidence/);
  });

  test('runs pinned REV in tests scope after every CI job, from artifacts only, without an API key', () => {
    const rev = job('rev');
    const pin = rev.match(/uses: aviarytech\/rev@([a-f0-9]{40})\n/);
    assert.ok(pin, 'REV must be pinned to a full commit SHA');
    assert.match(job('rev-tests'), new RegExp(`repository: aviarytech/rev\\n\\s+ref: ${pin[1]}\\n`));
    assert.match(rev, /scope: tests\n/);
    assert.match(rev, /contract-sha256: \$\{\{ vars\[format\('REV_CONTRACT_PR_\{0\}', github\.event\.pull_request\.number\)\] \}\}/);
    const needs = rev.match(/needs: \[([^\]]+)\]/)[1].split(',').map(x => x.trim());
    const jobs = [...('\n' + ci).matchAll(/\n  ([\w-]+):\n/g)].map(m => m[1]).filter(name => name !== 'rev');
    assert.deepEqual([...needs].sort(), [...jobs].sort());
    assert.deepEqual([...contract.requiredChecks].sort(), [...jobs].sort());
    assert.doesNotMatch(rev, /actions\/checkout|bun install|run:|secrets\./);
  });

  test('runs named tests on head and on merge-base sources with head tests copied in', async () => {
    assert.deepEqual(runnerFor('packages/sdk/tests/unit/a.test.ts', root.replace(/\/$/, '')),
      { cwd: join(root, 'packages/sdk'), command: 'bun', args: ['test', '--reporter=junit'], path: 'tests/unit/a.test.ts' });
    assert.equal(runnerFor('.rev/a.test.mjs', '/r').command, 'node');
    assert.throws(() => runnerFor('src/a.ts', '/r'), /unsupported/);
    assert.ok(testFiles(task).includes('.rev/tests-gate.test.mjs'));

    const dir = mkdtempSync(join(tmpdir(), 'rev-run-'));
    try {
      const [head, base] = ['head', 'base'].map(name => join(dir, name));
      for (const [path, value] of [[head, 2], [base, 1]]) {
        mkdirSync(join(path, 't'), { recursive: true });
        writeFileSync(join(path, 'lib.mjs'), `export const value = ${value};\n`);
      }
      writeFileSync(join(head, 't/lib.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../lib.mjs';\ntest('value is two', () => assert.equal(value, 2));\n");
      const fixture = { criteria: [{ tests: ['t/lib.test.mjs > value is two'] }] };
      const [h, b] = ['a', 'b'].map(c => c.repeat(40));
      assert.deepEqual(await runTests(fixture, head, head, h, h), { version: 1, sourceSha: h, testsSha: h,
        tests: [{ id: 't/lib.test.mjs > value is two', status: 'passed' }] });
      assert.deepEqual((await runTests(fixture, base, head, b, h)).tests, [{ id: 't/lib.test.mjs > value is two', status: 'failed' }]);
      assert.ok(existsSync(join(base, 't/lib.test.mjs')), 'head test file is copied onto base sources');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('documents per-PR criteria, Jev contract review and digest pinning', () => {
    const guide = read('.rev/README.md');
    for (const term of ['tests', 'paths', 'tests-change.js', 'review-contract.js', '--pin', 'REV_CONTRACT_PR_', 'never runs per push'])
      assert.ok(guide.includes(term), term);
    assert.match(read('.github/workflows/README.md'), /tests scope[\s\S]*no API key[\s\S]*\.rev\/README\.md/);
    assert.match(read('.github/PULL_REQUEST_TEMPLATE.md'), /\.rev\/task\.json[\s\S]*review-contract\.js/);
  });

  test('adds an empty changeset so no package is released', () => {
    assert.match(read('.changeset/rev-tests-gate.md'), /^---\n---\n/);
  });
});
