import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { actionUpdateInputs } from './action-update.mjs';
import { releaseInputs } from './release-pr.mjs';
import { pathToFileURL } from 'node:url';

// This runs without secrets. The evaluator consumes only the resulting JSON.
export async function prepare(root, toolPath, base, head, output, profile = 'pr', branch = '', prNumber = '') {
  const read = path => readFile(resolve(root, path), 'utf8');
  if (!['pr', 'release', 'action-update'].includes(profile)) throw new Error('Unknown evidence profile');
  const generic = JSON.parse(await read('.rev/pr-contract.json'));
  if (profile === 'pr' && prNumber && String(generic.pullRequest) !== String(prNumber)) {
    throw new Error(`PR #${prNumber} needs its own reviewed .rev/pr-task.json, pr-contract.json (pullRequest), and pr-sources.json; inherited rollout contracts cannot evaluate another PR`);
  }
  const release = profile === 'release' ? await releaseInputs(root, base, head)
    : profile === 'action-update' ? actionUpdateInputs(root, base, head, branch, generic.requiredChecks) : null;
  const task = release?.task ?? JSON.parse(await read('.rev/pr-task.json'));
  const contract = release?.contract ?? JSON.parse(await read('.rev/pr-contract.json'));
  const { collectChange } = await import(pathToFileURL(resolve(toolPath, 'scripts/change.js')));
  const { buildCorpus } = await import(pathToFileURL(resolve(toolPath, 'src/corpus.js')));
  const { change, digest } = collectChange(base, head, contract, task, root);
  if (change.files.some(file => !file.criteria.length)) throw new Error('Map every changed file to relevant PR criteria');
  const sources = profile === 'action-update' ? [{ id: 'action-update-implementation', kind: 'code', paths: ['.rev/action-update.mjs', '.rev/action-update.test.mjs'] }] : release ? [{ id: 'release-probe', kind: 'code', paths: ['.rev/release-pr.mjs', '.rev/release-task.json', '.rev/release-contract.json', '.rev/release-pr.test.mjs'] }] : JSON.parse(await read('.rev/pr-sources.json'));
  const rootPath = await realpath(root);
  const items = release ? [release.observation] : [];
  for (const source of sources) {
    const content = [];
    for (const path of source.paths) {
      const absolute = await realpath(resolve(root, path));
      if (!absolute.startsWith(rootPath + sep)) throw new Error('Evidence source escapes repository');
      content.push(`File: ${path}\n${await readFile(absolute, 'utf8')}`);
    }
    items.push({ id: source.id, kind: source.kind, source: source.paths.join(', '), content: content.join('\n\n') });
  }
  const evidence = { version: 1, headSha: head, items };
  // Validate format/limits here. This candidate digest is NOT the trusted approval.
  // The evaluator separately compares against the PR-specific repository variable.
  buildCorpus(task, evidence, { 'head-sha': head, 'base-sha': base, 'contract-sha256': digest }, {}, change);
  await mkdir(output, { recursive: true });
  for (const [name, data] of Object.entries({ task, change, evidence })) {
    await writeFile(resolve(output, `${name}.json`), JSON.stringify(data, null, 2) + '\n');
  }
  await writeFile(resolve(output, 'candidate-contract.sha256'), digest + '\n');
  return { digest, files: change.files.map(file => file.path) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { REV_TOOL_PATH, REV_BASE_SHA, REV_HEAD_SHA, RUNNER_TEMP } = process.env;
  if (!REV_TOOL_PATH || !RUNNER_TEMP) throw new Error('Expected pinned tool path and runner temp');
  console.log(JSON.stringify(await prepare(process.cwd(), REV_TOOL_PATH, REV_BASE_SHA, REV_HEAD_SHA, resolve(RUNNER_TEMP, 'rev-pr-input'), process.env.REV_PR_BRANCH === 'changeset-release/main' ? 'release' : process.env.REV_PR_BRANCH?.startsWith('dependabot/github_actions/') ? 'action-update' : 'pr', process.env.REV_PR_BRANCH, process.env.REV_PR_NUMBER)));
}
