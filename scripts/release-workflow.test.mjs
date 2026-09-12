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

test('publish authenticates to npm via OIDC trusted publishing, not a long-lived token', () => {
  // id-token: write is what makes the OIDC exchange possible; it must stay set
  // at the workflow level for the publish job to authenticate at all.
  assert.match(workflow, /^permissions:\n(?:.*\n)*?\s*id-token: write/m);

  const publishSteps = steps(jobs.publish);
  const publish = publishSteps.findIndex(step => step.includes('uses: changesets/action@v2'));
  assert.ok(publish >= 0, 'publish job must run changesets/action@v2 to publish');
  assert.match(publishSteps.slice(0, publish + 1).join('\n'), /registry-url: "https:\/\/registry.npmjs.org"/);

  // NODE_AUTH_TOKEN on the publish step would make npm silently prefer token
  // auth over OIDC, defeating the trusted-publishing migration without any
  // visible failure. It must never reappear on the publish step.
  assert.doesNotMatch(publishSteps[publish], /NODE_AUTH_TOKEN/);
  assert.doesNotMatch(publishSteps[publish], /NPM_CONFIG_PROVENANCE/);
  // `npm whoami` only validates the old token path and cannot validate OIDC
  // trusted publishing, so there must be no preflight relying on it.
  assert.ok(!publishSteps.some(step => step.includes('npm whoami --registry=')));
});

test('publish refuses to run before a human confirms npm trusted publishing is registered', () => {
  const publishSteps = steps(jobs.publish);
  const gate = publishSteps.findIndex(step => step.includes("vars.NPM_TRUSTED_PUBLISHING_READY"));
  const publish = publishSteps.findIndex(step => step.includes('uses: changesets/action@v2'));
  assert.ok(gate >= 0, 'publish job must gate on the NPM_TRUSTED_PUBLISHING_READY repo variable');
  assert.equal(gate, 0, 'the readiness gate must be the first step, before any build work');
  assert.ok(gate < publish);
  assert.match(publishSteps[gate], /if: vars\.NPM_TRUSTED_PUBLISHING_READY != 'true'/);
  assert.match(publishSteps[gate], /exit 1/);
});
