import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('trusted workflow keeps PR artifacts away from executable code and credentials',async()=>{
  const workflow=await readFile('.github/workflows/rev-trusted.yml','utf8');
  assert.match(workflow,/workflow_run:/);
  assert.doesNotMatch(workflow,/pull_request_target:|\n  pull_request:/);
  assert.match(workflow,/repository: aviarytech\/rev\n\s+ref: [a-f0-9]{40}/);
  for(const match of workflow.matchAll(/uses: (\S+)/g)) assert.match(match[1],/@[a-f0-9]{40}$/);
  const commands=[...workflow.matchAll(/run: (.+)/g)].map(m=>m[1]);
  assert.deepEqual(commands,['node .rev-trusted-tool/scripts/github-review.js','node .rev-trusted-tool/scripts/github-review.js']);
  assert.doesNotMatch(workflow,/uses: .*cache|bun install|npm install|checkout.*head_sha/);
  assert.match(workflow,/artifact-ids: \$\{\{ steps.prepare.outputs.artifact_id \}\}/);
  assert.match(workflow,/needs: \$\{\{ steps.prepare.outputs.needs \}\}/);
  assert.match(workflow,/head-sha: \$\{\{ steps.prepare.outputs.head_sha \}\}/);
  assert.match(workflow,/base-sha: \$\{\{ steps.prepare.outputs.base_sha \}\}/);
  assert.match(workflow,/path: \$\{\{ runner.temp \}\}\/rev-untrusted-input/);
  assert.match(workflow,/report-file: \$\{\{ runner.temp \}\}\/rev-trusted-report.json/);
  assert.equal((workflow.match(/secrets\.TYPESAFE_API_KEY/g)||[]).length,1);
  assert.match(workflow,/REV_CHECK_NAME: REV trusted/);
  const ci=await readFile('.github/workflows/ci.yml','utf8');
  assert.match(ci,/name: rev-acceptance-evidence\n\s+overwrite: true/);
  assert.match(ci,/\n  rev:\n/); // Retain the existing gate during deployment.
});
