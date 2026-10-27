import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    for (const path of ['scripts/rev-evidence.mjs', 'scripts/rev-evidence.test.mjs'])
      assert.equal(existsSync(join(root, path)), false, path);
    // Only the new gate's files remain in .rev/.
    assert.deepEqual(readdirSync(join(root, '.rev')).sort(), ['README.md', 'contract.json', 'run-tests.mjs', 'task.json', 'tests-gate.test.mjs']);
    for (const file of readdirSync(join(root, '.github/workflows')).filter(f => /\.ya?ml$/.test(f))) {
      assert.doesNotMatch(read(`.github/workflows/${file}`), /TYPESAFE|TUPESAFE|typesafe\.ai|api-key:|rev-evidence/i, file);
    }
    assert.doesNotMatch(job('tests'), /rev-evidence|\.rev/);
  });

  test('runs pinned REV in tests scope after every CI job, from artifacts only, without an API key', () => {
    const rev = job('rev');
    const pin = rev.match(/uses: aviarytech\/rev@([a-f0-9]{40})\n/);
    assert.ok(pin, 'REV must be pinned to a full commit SHA');
    assert.match(job('rev-tests'), new RegExp(`repository: aviarytech/rev\\n\\s+ref: ${pin[1]}\\n`));
    assert.match(rev, /scope: tests\n/);
    assert.match(rev, /if: \$\{\{ !cancelled\(\) && github\.event_name == 'pull_request' \}\}/);
    assert.match(rev, /contract-sha256: \$\{\{ vars\[format\('REV_CONTRACT_PR_\{0\}', github\.event\.pull_request\.number\)\] \}\}/);
    const needs = rev.match(/needs: \[([^\]]+)\]/)[1].split(',').map(x => x.trim());
    const jobs = [...('\n' + ci).matchAll(/\n  ([\w-]+):\n/g)].map(m => m[1]).filter(name => name !== 'rev');
    assert.deepEqual([...needs].sort(), [...jobs].sort());
    assert.deepEqual([...contract.requiredChecks].sort(), [...jobs].sort());
    // Exactly: download inputs, evaluate, upload the report. Nothing runs PR code or reads a secret.
    assert.deepEqual([...rev.matchAll(/uses: ([^@\s]+)@/g)].map(m => m[1]), ['actions/download-artifact', 'aviarytech/rev', 'actions/upload-artifact']);
    assert.doesNotMatch(rev, /run:|secrets\.|api-key/);
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

  test('runs Node and Bun named tests on head and base, copying head tests onto base sources', async () => {
    assert.equal(runnerFor('.rev/a.test.mjs', '/r').command, 'node');
    assert.throws(() => runnerFor('src/a.ts', '/r'), /unsupported/);
    assert.ok(testFiles(task).includes('.rev/tests-gate.test.mjs'));

    const dir = mkdtempSync(join(tmpdir(), 'rev-run-'));
    try {
      const [head, base] = ['head', 'base'].map(name => join(dir, name));
      for (const [path, value] of [[head, 2], [base, 1]]) {
        mkdirSync(join(path, 't'), { recursive: true });
        mkdirSync(join(path, 'pkg/tests'), { recursive: true });
        writeFileSync(join(path, 'lib.mjs'), `export const value = ${value};\n`);
        writeFileSync(join(path, 'pkg/package.json'), '{"name":"pkg","type":"module"}\n');
        // Base lacks the export the head test imports, so the Bun file cannot load there.
        writeFileSync(join(path, 'pkg/value.ts'), value === 2 ? 'export const added = true;\n' : 'export const other = 1;\n');
      }
      writeFileSync(join(head, 't/lib.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../lib.mjs';\ntest('value is two', () => assert.equal(value, 2));\n");
      writeFileSync(join(head, 'pkg/tests/value.test.ts'), "import { describe, expect, test } from 'bun:test';\nimport { added } from '../value.ts';\ndescribe('value', () => { test('is added', () => expect(added).toBe(true)); });\n");
      const node = 't/lib.test.mjs > value is two', bun = 'pkg/tests/value.test.ts > value > is added';
      assert.deepEqual(runnerFor('pkg/tests/value.test.ts', head),
        { cwd: join(head, 'pkg'), command: 'bun', args: ['test', '--reporter=junit'], path: 'tests/value.test.ts' });
      const fixture = { criteria: [{ tests: [node, bun] }] };
      const [h, b] = ['a', 'b'].map(c => c.repeat(40));
      assert.deepEqual(await runTests(fixture, head, head, h, h), { version: 1, sourceSha: h, testsSha: h,
        tests: [{ id: bun, status: 'passed' }, { id: node, status: 'passed' }] });
      const onBase = await runTests(fixture, base, head, b, h);
      assert.equal(onBase.sourceSha, b);
      assert.equal(onBase.testsSha, h);
      assert.deepEqual(onBase.tests.filter(t => [node, bun].includes(t.id) && t.status === 'passed'), []);
      assert.deepEqual(onBase.tests.find(t => t.id === node), { id: node, status: 'failed' });
      for (const file of ['t/lib.test.mjs', 'pkg/tests/value.test.ts']) assert.ok(existsSync(join(base, file)), `${file} copied onto base`);
      await assert.rejects(runTests({ criteria: [{ tests: ['src/a.ts > x'] }] }, head, head, h, h), /unsupported/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('documents per-PR criteria, Jev contract review and digest pinning', () => {
    const guide = read('.rev/README.md');
    // Commands match the argument order the pinned REV scripts accept.
    assert.match(guide, /tests-change\.js BASE_SHA HEAD_SHA \.rev\/contract\.json \.rev\/task\.json \S+/);
    assert.match(guide, /TYPESAFE_API_KEY=\S* node \S*review-contract\.js \.rev\/task\.json \S+ --pin onionoriginals\/sdk PR_NUMBER/);
    for (const term of ['"version": 2', '`tests`', '`paths`', 'REV_CONTRACT_PR_<number>', 'Jev never runs per push', 'contract-mismatch', 'Omit `--pin`'])
      assert.ok(guide.includes(term), term);
    assert.match(read('.github/workflows/README.md'), /tests scope[\s\S]*no API key[\s\S]*Jev reviews each\s+PR's contract once[\s\S]*\.\.\/\.\.\/\.rev\/README\.md/);
    const template = read('.github/PULL_REQUEST_TEMPLATE.md');
    for (const term of ['.rev/task.json', 'path globs', 'fail without the change', 'review-contract.js', 'REV_CONTRACT_PR_<number>', '../.rev/README.md'])
      assert.ok(template.includes(term), term);
  });

  test('adds an empty changeset so no package is released', () => {
    assert.match(read('.changeset/rev-tests-gate.md'), /^---\n---\n/);
  });
});
