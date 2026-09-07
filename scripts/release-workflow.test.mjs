import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
// Inspect the repository's block-style steps without adding a YAML runtime dependency.
const jobs = Object.fromEntries([...workflow.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/gm)].map(match => [match[1], match[2]]));
const steps = body => body.split(/^      - /m).slice(1);
const actionSteps = Object.values(jobs).flatMap(steps).filter(step => step.includes('uses: changesets/action@v2'));
// Public API from https://github.com/changesets/action/blob/v2/action.yml.
const inputs = new Set(['github-token', 'publish-script', 'version-script', 'commit-message', 'pr-title', 'pr-draft', 'pr-base-branch', 'create-github-releases', 'push-git-tags', 'push-with-git-cli', 'cwd']);

test('all Changesets v2 inputs use its documented API and explicit GitHub credentials', () => {
  assert.equal(actionSteps.length, 2);
  for (const step of actionSteps) {
    const block = step.match(/^        with:\n((?:^          .*\n)*)/m)?.[1] ?? '';
    for (const match of block.matchAll(/^          ([\w-]+):/gm)) assert.ok(inputs.has(match[1]), `unsupported Changesets v2 input: ${match[1]}`);
    assert.match(block, /^          github-token: /m);
  }
  assert.match(actionSteps[0], /version-script: bun run version/);
  assert.match(actionSteps[1], /publish-script: bun run release/);
});

test('release decisions consume the v2 has-changesets output', () => {
  assert.doesNotMatch(workflow, /steps\.changesets\.outputs\.hasChangesets/);
  assert.match(jobs.version, /hasChangesets: \$\{\{ steps\.changesets\.outputs\['has-changesets'\] \}\}/);
  assert.match(jobs['check-publish'], /if: needs\.version\.outputs\.hasChangesets == 'false'/);
  assert.match(jobs.publish, /if: needs\.check-publish\.outputs\.shouldPublish == 'true'/);
});

test('Changesets CLI runs on supported Node while consumer imports still exercise Node 20', () => {
  for (const name of ['version', 'publish']) {
    let node;
    for (const step of steps(jobs[name])) {
      if (step.includes('uses: actions/setup-node@')) node = step.match(/node-version: ["']?([\d.]+)/)?.[1];
      if (step.includes('uses: changesets/action@v2')) assert.equal(node, '24', `${name} must select Node 24 before Changesets CLI`);
      if (step.includes('run: node scripts/verify-esm.mjs')) assert.equal(node, '20.10.0');
    }
  }
});

test('token preflight precedes publishing and uses setup-node registry authentication', () => {
  const publishSteps = steps(jobs.publish);
  const preflight = publishSteps.findIndex(step => step.includes('npm whoami --registry='));
  const publish = publishSteps.findIndex(step => step.includes('uses: changesets/action@v2'));
  assert.ok(preflight >= 0 && preflight < publish);
  assert.match(publishSteps.slice(0, preflight).join('\n'), /registry-url: "https:\/\/registry.npmjs.org"/);
  assert.match(publishSteps[publish], /NODE_AUTH_TOKEN: \$\{\{ secrets.NPM_TOKEN \}\}/);
});
